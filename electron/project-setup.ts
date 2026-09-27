import type { ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runGit, spawnGit } from "./git-service.js";
import { isBranchNameSafe } from "./llm-plan.js";
import { errorText, volumeRoot } from "./workspace-restore.js";
import { folderNameProblem, parseCloneUrl } from "../shared/clone-source.js";
import type {
  CloneFailureReason, ClonePreview, FolderBlock, FolderPreview, FolderProblem, GitignoreSuggestion
} from "../shared/types.js";

/**
 * Getting a first project into GitCat without a terminal: opening a folder that is not a repository
 * yet, turning it into one, or copying one from an address. Every function here reads the folder
 * first and says what it found; the only writes are `git init` in a folder the person confirmed and
 * a clone into a folder GitCat creates for it. Nothing here builds a command from model output.
 */

export type FolderInspection =
  | { kind: "repository"; path: string; root: string }
  | { kind: "inside_repository"; path: string; root: string }
  | { kind: "folder"; preview: FolderPreview }
  | { kind: "invalid"; path: string; problem: FolderProblem; detail?: string };

type FolderState = Exclude<FolderInspection, { kind: "folder" }> | { kind: "folder"; path: string; blocked?: FolderBlock };

export type InspectFolderOptions = {
  /** Whose home folder must never become a repository as a whole; injectable for tests. */
  home?: string;
  /** Stops counting at this many files, so a huge folder answers quickly. */
  countLimit?: number;
  countTimeoutMs?: number;
};

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function realpath(path: string) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function invalid(path: string, problem: FolderProblem, detail?: string): FolderState {
  return { kind: "invalid", path, problem, ...(detail ? { detail } : {}) };
}

/**
 * Folders that are never a project on their own: the root of a disk, the home folder and the folder
 * that holds every home folder. Turning one of those into a repository would list everything a
 * person owns as changes, which is never what "start tracking this folder" means.
 */
export function isProtectedFolder(path: string, home = homedir()) {
  const real = realpath(path);
  const realHome = realpath(home);
  return dirname(real) === real || volumeRoot(real) === real || real === realHome || real === dirname(realHome);
}

async function folderState(input: string, options: InspectFolderOptions): Promise<FolderState> {
  const path = resolve(input);
  try {
    if (!statSync(path).isDirectory()) return invalid(path, "not_folder");
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    const code = errorCode(error);
    return invalid(path, code === "EACCES" || code === "EPERM" ? "permission" : "missing", errorText(error));
  }
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runGit(path, ["rev-parse", "--show-toplevel"], 15_000);
  } catch (error) {
    return invalid(path, "tool", errorText(error));
  }
  if (result.code === 0) {
    const root = resolve(result.stdout.trim());
    return realpath(path) === realpath(root) ? { kind: "repository", path, root } : { kind: "inside_repository", path, root };
  }
  const detail = (result.stderr || result.stdout).trim().slice(0, 500);
  if (!/not a git repository/i.test(detail)) {
    return invalid(path, /permission denied|dubious ownership|unsafe repository/i.test(detail) ? "permission" : "tool", detail);
  }
  // A .git that Git cannot read is a repository in trouble, not a plain folder; `git init` would paper over it.
  if (existsSync(join(path, ".git"))) return { kind: "folder", path, blocked: "broken_repository" };
  if (isProtectedFolder(path, options.home)) return { kind: "folder", path, blocked: "protected" };
  return { kind: "folder", path };
}

/** The first branch's name: the person's own init.defaultBranch when it is a safe name, main otherwise. */
export async function defaultBranchName(cwd: string) {
  const configured = await runGit(cwd, ["config", "--get", "init.defaultBranch"], 10_000).catch(() => undefined);
  const name = configured?.code === 0 ? configured.stdout.trim() : "";
  return name && isBranchNameSafe(name) ? name : "main";
}

type SuggestionRule = { kind: GitignoreSuggestion["kind"]; match: (segments: string[], name: string) => string | undefined };

/** Things people usually leave out of a first save. Each rule names the line it would suggest. */
const suggestionRules: SuggestionRule[] = [
  { kind: "dependencies", match: (segments) => segments.slice(0, -1).includes("node_modules") ? "node_modules/" : undefined },
  { kind: "system_files", match: (_segments, name) => name === ".DS_Store" || name === "Thumbs.db" ? name : undefined },
  { kind: "secrets", match: (_segments, name) => name === ".env" || (/^\.env\.[\w.-]+$/.test(name) && !/\.(example|sample|template)$/i.test(name)) ? name : undefined },
  { kind: "python_cache", match: (segments) => segments.slice(0, -1).includes("__pycache__") ? "__pycache__/" : undefined },
  { kind: "virtualenv", match: (segments) => segments.length > 1 && (segments[0] === ".venv" || segments[0] === "venv") ? `${segments[0]}/` : undefined },
  { kind: "logs", match: (_segments, name) => name.endsWith(".log") ? "*.log" : undefined },
  { kind: "build_output", match: (segments) => segments.length > 1 && (segments[0] === "dist" || segments[0] === "build") ? `${segments[0]}/` : undefined },
  { kind: "editor", match: (segments) => segments.length > 1 && segments[0] === ".idea" ? ".idea/" : undefined }
];

function noteSuggestion(found: Map<string, GitignoreSuggestion>, file: string) {
  const segments = file.replace(/\/$/, "").split("/");
  const name = segments.at(-1) ?? "";
  for (const rule of suggestionRules) {
    const pattern = rule.match(segments, name);
    if (!pattern) continue;
    const entry = found.get(pattern);
    if (entry) entry.files += 1;
    else if (found.size < 12) found.set(pattern, { pattern, kind: rule.kind, files: 1 });
    return;
  }
}

type FileCount = { files?: number; capped: boolean; suggestions: GitignoreSuggestion[] };

/**
 * How many files the first save would list, read the way Git will read them: with the folder's own
 * .gitignore and the person's global excludes. Git answers against a throwaway repository in the
 * temporary folder, so the folder itself is not touched to count it.
 */
async function countNewFiles(path: string, limit: number, timeoutMs: number): Promise<FileCount> {
  const scratch = mkdtempSync(join(tmpdir(), "gitcat-count-"));
  try {
    const init = await runGit(scratch, ["init", "-q"], 15_000).catch(() => undefined);
    if (init?.code !== 0) return { capped: false, suggestions: [] };
    const child = await spawnGit(path, ["--git-dir", join(scratch, ".git"), "--work-tree", path, "ls-files", "--others", "--exclude-standard", "-z"]);
    return await new Promise<FileCount>((resolvePromise) => {
      const found = new Map<string, GitignoreSuggestion>();
      let files = 0;
      let rest = "";
      let settled = false;
      const finish = (value: FileCount) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ capped: false, suggestions: [...found.values()] }); }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        const parts = (rest + chunk).split("\0");
        rest = parts.pop() ?? "";
        for (const file of parts) {
          if (!file) continue;
          files += 1;
          noteSuggestion(found, file);
          if (files >= limit) {
            child.kill("SIGKILL");
            finish({ files, capped: true, suggestions: [...found.values()] });
            return;
          }
        }
      });
      child.stderr.resume();
      child.on("error", () => finish({ capped: false, suggestions: [] }));
      child.on("close", (code) => finish(code === 0 ? { files, capped: false, suggestions: [...found.values()] } : { capped: false, suggestions: [] }));
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function folderPreview(path: string, blocked: FolderBlock | undefined, options: InspectFolderOptions): Promise<FolderPreview> {
  // A protected folder is not counted: the answer would take long and could only ever be "too many".
  const count = blocked ? { capped: false, suggestions: [] } : await countNewFiles(path, options.countLimit ?? 100_000, options.countTimeoutMs ?? 20_000);
  return {
    path,
    name: basename(path) || path,
    ...(count.files === undefined ? {} : { files: count.files }),
    filesCapped: count.capped,
    branch: await defaultBranchName(path),
    hasGitignore: existsSync(join(path, ".gitignore")),
    suggestions: count.suggestions.sort((a, b) => b.files - a.files),
    ...(blocked ? { blocked } : {})
  };
}

/** What a chosen folder is: a repository, a folder inside one, an ordinary folder (with what starting would do), or unusable. */
export async function inspectFolder(input: string, options: InspectFolderOptions = {}): Promise<FolderInspection> {
  const state = await folderState(input, options);
  if (state.kind !== "folder") return state;
  return { kind: "folder", preview: await folderPreview(state.path, state.blocked, options) };
}

export type StartTrackingOutcome =
  | { status: "started"; root: string }
  | { status: "changed"; inspection: FolderInspection }
  | { status: "failed"; detail: string; cleaned: boolean };

/**
 * Turns a previewed folder into a repository: `git init` with the branch the preview named, and
 * nothing else. Files are not added, staged or changed; they appear as changes for the first save.
 * The folder is checked again first, and anything different from the preview stops here unwritten.
 */
export async function startTracking(input: string, expected: { branch: string }, options: InspectFolderOptions = {}): Promise<StartTrackingOutcome> {
  const state = await folderState(input, options);
  const branch = state.kind === "folder" && !state.blocked ? await defaultBranchName(state.path) : undefined;
  if (state.kind !== "folder" || state.blocked || branch !== expected.branch) {
    return { status: "changed", inspection: state.kind === "folder" ? { kind: "folder", preview: await folderPreview(state.path, state.blocked, options) } : state };
  }
  const path = state.path;
  const gitDir = join(path, ".git");
  let failure: string | undefined;
  try {
    const result = await runGit(path, ["init", "-q", `--initial-branch=${branch}`], 30_000);
    if (result.code !== 0) failure = (result.stderr || result.stdout).trim() || `git init exited with ${result.code}`;
  } catch (error) {
    failure = errorText(error);
  }
  if (!failure) {
    const check = await runGit(path, ["rev-parse", "--show-toplevel"], 15_000).catch(() => undefined);
    if (check?.code === 0 && realpath(check.stdout.trim()) === realpath(path)) return { status: "started", root: resolve(check.stdout.trim()) };
    failure = (check?.stderr || "").trim() || "Git did not report the new repository.";
  }
  // The folder had no .git a moment ago, so one left behind by a failed init holds nothing of the person's.
  let cleaned = !existsSync(gitDir);
  if (!cleaned) {
    try { rmSync(gitDir, { recursive: true, force: true }); cleaned = true; } catch { cleaned = false; }
  }
  return { status: "failed", detail: failure.slice(0, 1000), cleaned };
}

export type CloneRequest = { url: string; parent: string; name: string };

export type CloneOptions = {
  onProgress?: (progress: { phase: string; percent: number }) => void;
  signal?: AbortSignal;
  /**
   * Test-only: accept an absolute path to a local repository as the source, so clones can be
   * exercised without a network. The IPC handler never sets it; people only get the strict check.
   */
  allowLocalSource?: boolean;
  /** Stops a clone that has said nothing for this long. */
  idleTimeoutMs?: number;
  /** Stops any clone after this long, however busy. */
  totalTimeoutMs?: number;
};

function checkSource(url: string, allowLocalSource: boolean): { url: string; host: string; protocol: "https" | "ssh" | "local" } | { problem: ClonePreview & { ok: false } } {
  if (allowLocalSource && isAbsolute(url) && existsSync(url)) return { url, host: "local", protocol: "local" };
  const check = parseCloneUrl(url);
  if (!check.ok) return { problem: { ok: false, problem: check.problem } };
  return { url: check.source.url, host: check.source.host, protocol: check.source.protocol };
}

/**
 * Where a clone would go and whether it can go there, before anything is created. A folder that is
 * already there is only used when it is empty; anything in it is the person's and is never mixed in.
 */
export async function previewClone(request: CloneRequest, options: Pick<CloneOptions, "allowLocalSource"> = {}): Promise<ClonePreview> {
  const source = checkSource(typeof request.url === "string" ? request.url.trim() : "", Boolean(options.allowLocalSource));
  if ("problem" in source) return source.problem;
  if (folderNameProblem(request.name)) return { ok: false, problem: "name_invalid" };
  const name = request.name.trim();
  const parent = resolve(request.parent);
  try {
    if (!statSync(parent).isDirectory()) return { ok: false, problem: "parent_missing" };
  } catch (error) {
    return { ok: false, problem: "parent_missing", detail: errorText(error) };
  }
  try { accessSync(parent, constants.W_OK | constants.X_OK); } catch (error) { return { ok: false, problem: "parent_not_writable", detail: errorText(error) }; }
  const destination = join(parent, name);
  let destinationState: "new" | "empty" = "new";
  try {
    const stat = lstatSync(destination);
    if (!stat.isDirectory()) return { ok: false, problem: "destination_is_file" };
    if (readdirSync(destination).length > 0) return { ok: false, problem: "destination_not_empty" };
    destinationState = "empty";
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return { ok: false, problem: "parent_not_writable", detail: errorText(error) };
  }
  const around = await runGit(parent, ["rev-parse", "--show-toplevel"], 15_000).catch(() => undefined);
  return {
    ok: true, url: source.url, host: source.host, protocol: source.protocol, parent, name, destination, destinationState,
    ...(around?.code === 0 && around.stdout.trim() ? { insideRepository: resolve(around.stdout.trim()) } : {})
  };
}

/** What a failed clone means, from what Git said. The raw text stays available as the detail. */
export function classifyCloneFailure(detail: string): CloneFailureReason {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* not (?:known|verified)/i.test(detail)) return "host_key";
  if (/Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(publickey|Invalid username or password|returned error: 40[13]|Permission to \S+ denied|access denied|HTTP Basic: Access denied/i.test(detail)) return "auth";
  if (/Repository not found|repository '.*' not found|returned error: 404|does not appear to be a git repository|project you were looking for could not be found/i.test(detail)) return "not_found";
  if (/Could not resolve host|Could not resolve hostname|Connection refused|Connection timed out|Operation timed out|Network is unreachable|Failed to connect|Connection reset|No route to host|SSL|TLS|early EOF|RPC failed|unable to access/i.test(detail)) return "network";
  if (/No space left|Read-only file system|File name too long|could not create (?:work tree|leading directories)|Permission denied/i.test(detail)) return "destination";
  return "unknown";
}

export type CloneOutcome =
  | { status: "cloned"; path: string; empty: boolean }
  | { status: "cancelled"; cleaned: boolean; leftAt?: string }
  | { status: "failed"; reason: CloneFailureReason; detail: string; cleaned: boolean; leftAt?: string }
  | { status: "invalid"; problem: Extract<ClonePreview, { ok: false }>["problem"]; detail?: string };

/** Stops Git and every helper it started: they share the group Git was started in. */
function signal(child: ChildProcess, name: NodeJS.Signals) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
    else child.kill(name);
  } catch {
    child.kill(name);
  }
}

/** Removes the folder GitCat made for this clone, and only that folder. */
function removeStaging(staging: string) {
  try { rmSync(staging, { recursive: true, force: true }); } catch { /* reported below */ }
  return !existsSync(staging);
}

/**
 * Copies a repository into a new folder. Git runs with no shell, no prompts and the address after
 * `--`, into a hidden folder GitCat creates next to the destination; only a finished copy is moved
 * into place. A cancelled, failed or timed-out copy removes that hidden folder and nothing else, so
 * what was in the parent folder before stays exactly as it was.
 */
export async function cloneRepository(request: CloneRequest, options: CloneOptions = {}): Promise<CloneOutcome> {
  const preview = await previewClone(request, options);
  if (!preview.ok) return { status: "invalid", problem: preview.problem, ...(preview.detail ? { detail: preview.detail } : {}) };
  if (options.signal?.aborted) return { status: "cancelled", cleaned: true };
  let staging: string;
  try {
    staging = mkdtempSync(join(preview.parent, `.${preview.name.slice(0, 60)}.gitcat-clone-`));
  } catch (error) {
    return { status: "failed", reason: "destination", detail: errorText(error), cleaned: true };
  }
  // A person's clone never reads local repositories or runs transport helpers, whatever the address says.
  const guard = preview.protocol === "local" ? [] : ["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never"];
  const ended = await new Promise<{ code: number | null; output: string; stop?: "cancelled" | "timeout"; error?: string }>((resolvePromise) => {
    let output = "";
    let stop: "cancelled" | "timeout" | undefined;
    let settled = false;
    let idle: NodeJS.Timeout | undefined;
    let child: Awaited<ReturnType<typeof spawnGit>> | undefined;
    const finish = (value: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(total);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ ...value, output, stop });
    };
    const halt = (reason: "cancelled" | "timeout") => {
      stop ??= reason;
      // Before Git has started there is nothing to stop yet; it is stopped as soon as it exists.
      if (!child) return;
      signal(child, "SIGTERM");
      setTimeout(() => { if (!settled && child) signal(child, "SIGKILL"); }, 3_000).unref();
    };
    const onAbort = () => halt("cancelled");
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => halt("timeout"), options.idleTimeoutMs ?? 120_000);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const total = setTimeout(() => halt("timeout"), options.totalTimeoutMs ?? 60 * 60_000);
    touch();
    spawnGit(preview.parent, [...guard, "clone", "--progress", "--", preview.url, staging], { group: true }).then((spawned) => {
      child = spawned;
      const keep = (chunk: Buffer) => {
        touch(); output = (output + chunk.toString()).slice(-20_000);
        // Only known Git counters cross IPC, never raw remote output or credentials.
        const matches = [...chunk.toString().matchAll(/(Receiving objects|Resolving deltas|Updating files|Counting objects|Compressing objects):\s+(\d+)%/g)];
        const match = matches[matches.length - 1];
        if (match) options.onProgress?.({ phase: match[1], percent: Math.min(100, Number(match[2])) });
      };
      spawned.stdout.on("data", keep);
      spawned.stderr.on("data", keep);
      spawned.on("error", (error) => finish({ code: null, error: errorText(error) }));
      spawned.on("close", (code) => finish({ code }));
      if (stop) halt(stop);
    }, (error) => finish({ code: null, error: errorText(error) }));
  });
  if (ended.stop || ended.code !== 0) {
    const cleaned = removeStaging(staging);
    const leftAt = cleaned ? {} : { leftAt: staging };
    if (ended.stop === "cancelled") return { status: "cancelled", cleaned, ...leftAt };
    const detail = (ended.error ?? ended.output).trim().slice(-2_000);
    const reason = ended.stop === "timeout" ? "timeout" : ended.error ? "tool" : classifyCloneFailure(detail);
    return { status: "failed", reason, detail, cleaned, ...leftAt };
  }
  // Only now does the destination appear. An empty folder that was there is replaced by the copy.
  try {
    if (preview.destinationState === "empty") rmdirSync(preview.destination);
    else if (existsSync(preview.destination)) throw new Error(`${preview.destination} appeared while the copy was running.`);
    renameSync(staging, preview.destination);
  } catch (error) {
    return { status: "failed", reason: "destination", detail: errorText(error), cleaned: false, leftAt: staging };
  }
  const head = await runGit(preview.destination, ["rev-parse", "--verify", "--quiet", "HEAD"], 15_000).catch(() => undefined);
  return { status: "cloned", path: preview.destination, empty: head?.code !== 0 };
}
