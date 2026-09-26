import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readlinkSync, accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";
import { safeStorage, app } from "electron";
import { findExecutable, isExecutableFile, pathEntries, wellKnownToolDirectories } from "./executables.js";
import { parseWorktrees } from "./worktrees.js";
import { stackCandidates } from "./stacked-branches.js";
import { parseNameStatus, parseNumstat, parseShortstat } from "./diff-status.js";
import { parseRemoteUrls } from "./remotes.js";
import {
  canSkip, conflictLabels, conflictsFrom, parseRebaseProgress, pendingCommands, resolutionFor
} from "./pending-operation.js";
import {
  buildResolutionInstructions, conflictFileLimit, parseConflictProposal, resolutionResponseFormat, validateProposal
} from "./conflict-resolution.js";
import { isProtectedBranch, lifecycleOf, staleAfterDays } from "../shared/branch-lifecycle.js";
import {
  findAccount, isSshAuthenticated, parseGhAccounts, parseSshGreeting, parseSshResolvedHostName, sshConfigHostAliases
} from "./host-identity.js";
import {
  emptyMemory, forgetSshHost, recallIdentity, recallRepository, rememberIdentity, rememberRepository,
  sanitizeMemory, type Memory
} from "./memory.js";
import type {
  ActionPlan, Branch, Commit, CommitDetail, Conflict, ConversationMessage, DefaultBranchSource, GitProtocol,
  ConflictApplyResult, ConflictFileOutcome, ConflictProposal, ExecutionFailure, HistoryPage, HistoryRequest, HistoryScope, LlmConfig, LlmConfigInput,
  Locale, Operation, PendingOperation, PlanStep, RepoSnapshot, StepOutcome
} from "../shared/types.js";
import { localized, normalizeLocale } from "./i18n.js";
import {
  buildPlannerInstructions, commitMessageLimit, executableOperations, isBranchNameSafe, operationArgs,
  planIssues, parseModelPlan, planResponseFormat, type ModelPlan, type PlanIssue
} from "./llm-plan.js";
import {
  assertRepositoryPlan, buildRepositoryPlan, remoteNamePattern, repositoryHostPattern, repositoryNamePattern,
  repositoryOwnerPattern, sshHostPattern, validateRepositoryFields, type RepositoryFields
} from "./repository-plan.js";

type CommandResult = { stdout: string; stderr: string; code: number };
type PlanDraft = Omit<ActionPlan, "id" | "repoPath" | "head" | "stateId">;

const MODEL_FALLBACK = "gpt-5.6-luna";
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const LLM_REQUIRED =
  "GitCat necesita un proveedor LLM configurado: toda interpretación de tus mensajes la hace el modelo, no reglas locales. Añade tu API key y tu modelo en Configuración.";
const LLM_REQUIRED_EN =
  "GitCat needs a configured LLM provider: the model interprets every message, not local rules. Add your API key and model in Settings.";

function llmRequired(locale?: Locale) { return localized(locale, LLM_REQUIRED, LLM_REQUIRED_EN); }
const allowedOperations = new Set<Operation>([...executableOperations, "github_create_repo", "none"]);
/**
 * Operations that run without asking. The bar is deliberately high: they must leave the working tree,
 * the branch history and everything already published untouched, and running one again must be
 * harmless. Nothing here can lose work, so a confirmation would only be a click in the way.
 */
const unattendedOperations = new Set<Operation>(["status", "fetch"]);

let llmState: LlmConfigInput = { apiKey: "", model: MODEL_FALLBACK };
let memory: Memory = emptyMemory();

function isLlmConfigured() {
  return Boolean(llmState.apiKey.trim() && (llmState.model.trim() || MODEL_FALLBACK));
}

function memoryPath() { return join(app.getPath("userData"), "gitcat-memory.json"); }

export function loadMemory() {
  try {
    memory = sanitizeMemory(JSON.parse(readFileSync(memoryPath(), "utf8")));
  } catch {
    memory = emptyMemory();
  }
}

function saveMemory(next: Memory) {
  memory = next;
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    const target = memoryPath();
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(memory, null, 2), { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    console.error("No se pudo guardar lo aprendido sobre este repositorio.", error);
  }
}

/**
 * The user's login shell knows where their tools live; a GUI launch does not inherit that PATH.
 * Asked once, with a timeout, and never allowed to block a command.
 */
function loginShellPath(): Promise<string | undefined> {
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : undefined);
  if (process.platform === "win32" || !shell) return Promise.resolve(undefined);
  return new Promise((resolvePromise) => {
    execFile(shell, ["-ilc", 'printf "%s" "$PATH"'], { timeout: 5_000, encoding: "utf8" }, (_error, stdout) => {
      resolvePromise(stdout?.trim().split("\n").pop()?.trim() || undefined);
    });
  });
}

let toolDirectoriesPromise: Promise<string[]> | undefined;
const resolvedTools = new Map<string, string>();

export function toolDirectories(): Promise<string[]> {
  toolDirectoriesPromise ??= loginShellPath()
    .catch(() => undefined)
    .then((shellPath) => [...new Set([
      ...pathEntries(process.env.PATH),
      ...pathEntries(shellPath),
      ...wellKnownToolDirectories(process.platform, homedir())
    ])]);
  return toolDirectoriesPromise;
}

async function resolveTool(name: string) {
  const cached = resolvedTools.get(name);
  if (cached) return cached;
  const found = findExecutable(name, await toolDirectories(), isExecutableFile);
  if (found) resolvedTools.set(name, found);
  return found ?? name;
}

function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return runCommand("git", args, cwd, timeoutMs);
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs = 60_000, extraEnv: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  const executable = await resolveTool(command);
  const searchPath = (await toolDirectories()).join(delimiter);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, PATH: searchPath, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", GIT_EDITOR: "true", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (!settled) {
        settled = true;
        reject(new Error(`${command} ${args[0] ?? ""} excedió el tiempo máximo de espera.`));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 2_000_000) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 2_000_000) stderr += chunk.toString(); });
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on("close", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ stdout, stderr, code: code ?? 1 }); }
    });
  });
}

async function checkedGit(cwd: string, args: string[], raw = false): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} terminó con código ${result.code}`;
    throw new Error(detail);
  }
  return raw ? result.stdout : result.stdout.trim();
}

/**
 * Like checkedGit, but keeps what Git says on stderr. Most of what a person needs to read
 * ("Switched to branch 'main'", "Fast-forward") is written there, not to stdout.
 */
async function reportedGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (result.code !== 0) throw new Error(detail || `git ${args.join(" ")} terminó con código ${result.code}`);
  return detail;
}

async function optionalGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  return result.code === 0 ? result.stdout.trim() : "";
}

function parseStatus(raw: string) {
  const records = raw.split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2).trim() || "??";
    changes.push({ code, path: record.slice(3) || record });
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return changes;
}

function parseTrack(track: string) {
  const ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(track.match(/behind (\d+)/)?.[1] ?? 0);
  return { ahead, behind };
}

const conventionalDefaults = ["main", "master", "develop", "trunk"];
type DefaultBranchResolution = { name: string; source: DefaultBranchSource };

/**
 * The branch integration is measured against. A remote's own HEAD is the repository's own answer, so
 * it is asked first; only when no remote publishes one does a conventional name decide.
 */
async function resolveDefaultBranch(repoRoot: string, remotes: string[], localNames: Set<string>): Promise<DefaultBranchResolution | undefined> {
  for (const remote of remotes) {
    const head = await optionalGit(repoRoot, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
    const name = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : "";
    if (name && name !== "HEAD") return { name, source: "remote_head" };
  }
  const name = conventionalDefaults.find((candidate) => localNames.has(candidate));
  return name ? { name, source: "conventional_name" } : undefined;
}

/**
 * Fills in which reference branches already contain each branch's tip. One walk per target answers it
 * for every branch at once, which is why integration is reported against the default and current
 * branches rather than against every possible pair.
 */
async function markIntegration(repoRoot: string, branches: Branch[], targets: (string | undefined)[]) {
  const wanted = [...new Set(targets.filter((name): name is string => Boolean(name) && name !== "HEAD"))];
  for (const target of wanted) {
    const raw = await optionalGit(repoRoot, ["for-each-ref", "--format=%(refname:short)", "--merged", target, "refs/heads", "refs/remotes"]);
    const contained = new Set(raw.split("\n").filter(Boolean));
    for (const branch of branches) {
      // A branch trivially contains itself; saying so would only be noise.
      if (branch.name === target) continue;
      if (contained.has(branch.name) || (branch.remoteRef && contained.has(branch.remoteRef))) branch.mergedInto.push(target);
    }
  }
}

/**
 * Ancestry answers keyed by the two tips they were asked about. Two commits either are in that
 * relation or are not, so the answer never goes stale: a branch that moves brings a new tip and a new
 * key with it. This is what keeps the panel from paying for the same question on every refresh.
 */
const ancestryCache = new Map<string, boolean>();

async function isAncestor(repoRoot: string, ancestor: string, descendant: string) {
  const key = `${ancestor}\0${descendant}`;
  const cached = ancestryCache.get(key);
  if (cached !== undefined) return cached;
  const result = await runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant], 10_000)
    .catch(() => undefined);
  // Only 0 and 1 are answers; anything else (a missing object, a timeout) is not cached as one.
  if (!result || (result.code !== 0 && result.code !== 1)) return false;
  const answer = result.code === 0;
  if (ancestryCache.size >= 4_000) ancestryCache.clear();
  ancestryCache.set(key, answer);
  return answer;
}

/**
 * Fills in which branch each branch continues. The names propose the pairs and Git decides them, so a
 * branch that merely reads like a continuation of another is not shown as one.
 */
async function markStacking(repoRoot: string, branches: Branch[]) {
  const tips = new Map(branches.filter((branch) => branch.lastCommit).map((branch) => [branch.name, branch.lastCommit!.hash]));
  for (const { base, stacked } of stackCandidates([...tips.keys()])) {
    const baseTip = tips.get(base)!;
    const stackedTip = tips.get(stacked)!;
    // A pair sitting on the very same commit is not a stack; neither one continues the other.
    if (baseTip === stackedTip) continue;
    if (await isAncestor(repoRoot, baseTip, stackedTip)) {
      const branch = branches.find((item) => item.name === stacked);
      if (branch) branch.stackedOn = base;
    }
  }
}

/**
 * Remote-tracking branches keyed by the local branch name they correspond to, so the interface can
 * say whether a branch lives here, on a remote, or on both. The remote prefix is stripped using the
 * configured remote names, because a branch name may itself contain slashes.
 */
function parseRemoteRefs(raw: string, remotes: string[], commitsByHash: Map<string, Commit>) {
  const byLocalName = new Map<string, { ref: string; lastCommit?: Commit }>();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [ref, shortHash, subject, author, email, date] = line.split("\0");
    const remote = remotes.find((candidate) => ref.startsWith(`${candidate}/`));
    if (!remote) continue;
    const name = ref.slice(remote.length + 1);
    // "origin/HEAD" is a symbolic pointer, not a branch anyone can check out.
    if (!name || name === "HEAD" || byLocalName.has(name)) continue;
    byLocalName.set(name, {
      ref,
      lastCommit: shortHash ? (commitsByHash.get(shortHash) ?? { hash: shortHash, shortHash, subject, author, email, date, refs: [], parents: [] }) : undefined
    });
  }
  return byLocalName;
}

/** A file inside the Git directory, resolved through Git so a worktree or a submodule still works. */
async function readGitFile(repoRoot: string, relative: string) {
  const path = await optionalGit(repoRoot, ["rev-parse", "--git-path", relative]);
  if (!path) return undefined;
  try {
    return readFileSync(resolve(repoRoot, path), "utf8");
  } catch {
    return undefined;
  }
}

async function gitPathExists(repoRoot: string, relative: string) {
  const path = await optionalGit(repoRoot, ["rev-parse", "--git-path", relative]);
  return Boolean(path) && existsSync(resolve(repoRoot, path));
}

/**
 * The half-finished job the repository is holding, if any. Git records each one differently, so each
 * is asked in its own terms rather than inferred from whatever happens to be lying around.
 */
async function readPendingOperation(repoRoot: string): Promise<PendingOperation | undefined> {
  const [rebaseMerge, rebaseApply] = await Promise.all([
    gitPathExists(repoRoot, "rebase-merge"),
    gitPathExists(repoRoot, "rebase-apply")
  ]);
  if (rebaseMerge || rebaseApply) {
    const directory = rebaseMerge ? "rebase-merge" : "rebase-apply";
    const names = ["msgnum", "end", "next", "last", "head-name", "onto", "onto-name"];
    const files: Record<string, string | undefined> = {};
    for (const name of names) files[name] = await readGitFile(repoRoot, `${directory}/${name}`);
    return { kind: "rebase", ...parseRebaseProgress(files) };
  }
  if (await gitPathExists(repoRoot, "MERGE_HEAD")) {
    // The branch a merge is bringing in is not recorded by name, so its message is the best label.
    const message = (await readGitFile(repoRoot, "MERGE_MSG"))?.split("\n")[0]?.trim();
    return { kind: "merge", onto: message?.replace(/^Merge (branch|remote-tracking branch|commit) /, "").replace(/^'|'$/g, "") || undefined };
  }
  if (await gitPathExists(repoRoot, "CHERRY_PICK_HEAD")) return { kind: "cherry_pick" };
  if (await gitPathExists(repoRoot, "REVERT_HEAD")) return { kind: "revert" };
  return undefined;
}

function parseCommit(raw: string): Commit | undefined {
  const [hash, shortHash, author, email, date, subject, refs = "", parents = ""] = raw.split("\x1f");
  if (!hash || !shortHash) return undefined;
  return {
    hash, shortHash, subject, author, email, date,
    refs: refs.split(",").map((ref) => ref.trim()).filter(Boolean),
    parents: parents.split(" ").map((parent) => parent.trim()).filter(Boolean)
  };
}

export async function getSnapshot(cwd: string): Promise<RepoSnapshot> {
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  const head = await optionalGit(repoRoot, ["rev-parse", "HEAD"]);
  const currentBranch = (await optionalGit(repoRoot, ["branch", "--show-current"])) || "HEAD";
  const statusRaw = await checkedGit(repoRoot, ["status", "--short", "--untracked-files=all", "-z"], true);
  const branchRaw = await checkedGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)%00%(authorname)%00%(authoremail)%00%(authordate:iso-strict)",
    "refs/heads"
  ]);
  const remoteBranchRaw = await checkedGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname:short)%00%(subject)%00%(authorname)%00%(authoremail)%00%(authordate:iso-strict)",
    "refs/remotes"
  ]);
  const logRaw = head ? await checkedGit(repoRoot, [
    // Topological order is what makes the list a graph: every child is listed before its parents, so
    // the lanes can be assigned in a single pass. "%P" carries the edges that order is describing.
    "log", "--all", "--topo-order", "-n", "80", "--date=iso-strict",
    "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%P"
  ]) : "";
  const commits = logRaw.split("\n").map(parseCommit).filter((commit): commit is Commit => Boolean(commit));
  const commitsByHash = new Map(commits.map((commit) => [commit.shortHash, commit]));
  const remotes = (await checkedGit(repoRoot, ["remote"])).split("\n").filter(Boolean);
  const remoteRefs = parseRemoteRefs(remoteBranchRaw, remotes, commitsByHash);
  const branches: Branch[] = branchRaw.split("\n").filter(Boolean).map((line) => {
    const [name, upstream, track, shortHash, subject, author, email, date] = line.split("\0");
    // A branch lives on a remote too when it has a counterpart there, whether or not it is its upstream.
    const tracked = upstream && [...remoteRefs.values()].some((remote) => remote.ref === upstream);
    const remoteRef = (tracked ? upstream : undefined) ?? remoteRefs.get(name)?.ref;
    return {
      name,
      upstream: upstream || undefined,
      remoteRef,
      presence: remoteRef ? "both" as const : "local" as const,
      mergedInto: [] as string[],
      ...parseTrack(track || ""),
      isCurrent: name === currentBranch,
      lastCommit: shortHash ? (commitsByHash.get(shortHash) ?? {
        hash: shortHash, shortHash, subject, author, email, date, refs: [], parents: []
      }) : undefined
    };
  });
  const localNames = new Set(branches.map((branch) => branch.name));
  for (const [name, remote] of remoteRefs) {
    if (localNames.has(name)) continue;
    branches.push({ name, remoteRef: remote.ref, presence: "remote", mergedInto: [], ahead: 0, behind: 0, isCurrent: false, lastCommit: remote.lastCommit });
  }
  await markStacking(repoRoot, branches);
  const worktrees = parseWorktrees(await optionalGit(repoRoot, ["worktree", "list", "--porcelain"]), repoRoot);
  for (const branch of branches) branch.checkedOutIn = worktrees.get(branch.name);
  const defaultBranchResolution = await resolveDefaultBranch(repoRoot, remotes, localNames);
  const defaultBranch = defaultBranchResolution?.name;
  await markIntegration(repoRoot, branches, [defaultBranch, currentBranch]);
  const pending = await readPendingOperation(repoRoot);
  const changes = parseStatus(statusRaw);
  // A file can change while keeping exactly the same status code. Bind reviews to its
  // contents, the staged version, the branch refs and checkout, not just "M file.txt".
  const fingerprint = createHash("sha256").update(JSON.stringify([
    head, currentBranch, statusRaw, branchRaw, remoteBranchRaw, pending, [...worktrees],
    await checkedGit(repoRoot, ["ls-files", "--stage", "-z"])
  ]));
  for (const change of changes) {
    const file = resolve(repoRoot, change.path);
    fingerprint.update(change.path);
    try {
      const stat = lstatSync(file);
      fingerprint.update(String(stat.mode));
      if (stat.isSymbolicLink()) fingerprint.update(readlinkSync(file));
      else if (stat.isFile()) {
        for await (const chunk of createReadStream(file)) fingerprint.update(chunk);
      } else if (stat.isDirectory()) fingerprint.update(await optionalGit(file, ["rev-parse", "HEAD"]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fingerprint.update("missing");
    }
    fingerprint.update("\0");
  }

  return {
    path: repoRoot,
    name: basename(repoRoot),
    head,
    stateId: fingerprint.digest("hex"),
    currentBranch,
    defaultBranch,
    defaultBranchSource: defaultBranchResolution?.source,
    isRebasing: pending?.kind === "rebase",
    pending,
    conflicts: conflictsFrom(changes),
    isDirty: Boolean(statusRaw.trim()),
    changes,
    branches,
    commits,
    remotes,
    remoteUrls: parseRemoteUrls(await optionalGit(repoRoot, ["remote", "-v"]))
  };
}

/**
 * History pages also carry each commit's message body and how much it changed, so the graph can say
 * what a commit did without opening it. Records are framed with \x1e and the fields end with \x1d,
 * because the body spans lines and `--shortstat` writes its summary right after the format.
 */
const historyFormat = "--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%P%x1f%b%x1d";

function parseHistory(raw: string): Commit[] {
  return raw.split("\x1e").flatMap((record) => {
    const [fields = "", stat = ""] = record.split("\x1d");
    const parts = fields.split("\x1f");
    const commit = parseCommit(parts.slice(0, 8).join("\x1f"));
    if (!commit) return [];
    const text = parts.slice(8).join("\x1f").trim();
    return [{ ...commit, body: text || undefined, stats: parseShortstat(stat) ?? { files: 0, additions: 0, deletions: 0 } }];
  });
}
export const historyPageSize = 80;
/** A diff nobody is going to read in one sitting, and that would only stall the window. */
const diffLimit = 400_000;

/**
 * A revision that reaches Git's argument list has to be one this repository actually has. The name
 * shape is checked first so nothing that could pass for an option ever gets that far, and the ref is
 * then resolved, because "exists" is Git's answer to give rather than the interface's to claim.
 */
async function verifiedRevision(repoRoot: string, name: string) {
  if (!isBranchNameSafe(name)) throw new Error("Nombre de rama no válido.");
  const resolved = await optionalGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  if (!resolved) throw new Error(`La rama ${name} ya no existe en este repositorio.`);
  return name;
}

function cutDiff(diff: string) {
  return diff.length > diffLimit
    ? { diff: `${diff.slice(0, diffLimit)}\n\n[diff recortado: ${diff.length} caracteres en total]`, truncated: true }
    : { diff, truncated: false };
}

/**
 * The slice of history the middle column asked for. Scoping it to a branch is the whole point: a list
 * of every ref at once could never answer "what is on this branch", which is the question being asked.
 */
export async function loadHistory(cwd: string, request: HistoryRequest): Promise<HistoryPage> {
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  const scope: HistoryScope = ["all", "branch", "branch-only"].includes(request.scope) ? request.scope : "all";
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? historyPageSize), 1), 500);
  const skip = Math.min(Math.max(Math.trunc(request.skip ?? 0), 0), 100_000);
  const empty = { commits: [], hasMore: false, scope, branch: request.branch };
  if (!(await optionalGit(repoRoot, ["rev-parse", "HEAD"]))) return empty;

  // One more than asked for, so "is there more behind this" is answered rather than guessed.
  // A merge is measured against its first parent, the same reading the commit detail gives it.
  const args = ["log", "--topo-order", "-n", String(limit + 1), "--skip", String(skip), "--date=iso-strict", "--shortstat", "--diff-merges=first-parent", historyFormat];
  let comparedTo: string | undefined;
  if (scope === "all") args.splice(1, 0, "--all");
  else {
    if (!request.branch) throw new Error("Falta la rama de la que mostrar el historial.");
    const branch = await verifiedRevision(repoRoot, request.branch);
    args.push(branch);
    if (scope === "branch-only") {
      const remotes = (await checkedGit(repoRoot, ["remote"])).split("\n").filter(Boolean);
      const localNames = new Set((await checkedGit(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n").filter(Boolean));
      const base = (await resolveDefaultBranch(repoRoot, remotes, localNames))?.name;
      // Excluding the branch from itself would leave nothing, which is not what "only this" means.
      if (base && base !== branch) { args.push("--not", await verifiedRevision(repoRoot, base)); comparedTo = base; }
    }
  }
  args.push("--");

  const raw = await checkedGit(repoRoot, args);
  const parsed = parseHistory(raw);
  return { commits: parsed.slice(0, limit), hasMore: parsed.length > limit, scope, branch: request.branch, comparedTo };
}

/**
 * What a commit changed, read against its first parent. For a merge that is what it actually brought
 * in; asking `git show` about a merge answers with nothing at all, which reads as "no changes".
 */
export async function getCommitDetail(cwd: string, hash: string): Promise<CommitDetail> {
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error("Hash de commit no válido.");
  const commit = await optionalGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${hash}^{commit}`]);
  if (!commit) throw new Error("Ese commit no existe en este repositorio.");
  const lineage = (await checkedGit(repoRoot, ["rev-list", "--parents", "-n", "1", commit])).split(" ").filter(Boolean);
  const base = lineage[1];
  const statusRaw = base
    ? await checkedGit(repoRoot, ["diff", "--no-color", "--name-status", "-z", base, commit, "--"])
    : await checkedGit(repoRoot, ["show", "--no-color", "--name-status", "-z", "--format=", commit, "--"]);
  const diffRaw = base
    ? await checkedGit(repoRoot, ["diff", "--no-color", "--no-ext-diff", "--unified=3", base, commit, "--"])
    : await checkedGit(repoRoot, ["show", "--no-color", "--no-ext-diff", "--unified=3", "--format=", commit, "--"]);
  const body = (await checkedGit(repoRoot, ["show", "-s", "--no-color", "--format=%b", commit])).trim();
  return { hash: commit, body: body || undefined, files: parseNameStatus(statusRaw), stats: await commitFileStats(repoRoot, commit, base), ...cutDiff(diffRaw) };
}

/** Lines gained and lost per file, against the same first parent the rest of the detail uses. */
async function commitFileStats(repoRoot: string, commit: string, base?: string) {
  return parseNumstat(base
    ? await checkedGit(repoRoot, ["diff", "--no-color", "--numstat", "-z", base, commit, "--"])
    : await checkedGit(repoRoot, ["show", "--no-color", "--numstat", "-z", "--format=", commit, "--"]));
}

/** The same commit reading, narrowed to one path selected in the file list. */
export async function getCommitFileDiff(cwd: string, hash: string, file: string): Promise<CommitDetail> {
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error("Hash de commit no válido.");
  const commit = await optionalGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${hash}^{commit}`]);
  if (!commit) throw new Error("Ese commit no existe en este repositorio.");
  const absolute = resolve(repoRoot, file);
  if (absolute !== repoRoot && !absolute.startsWith(`${repoRoot}${sep}`)) throw new Error("La ruta no pertenece a este repositorio.");
  const relative = absolute.slice(repoRoot.length + 1);
  const lineage = (await checkedGit(repoRoot, ["rev-list", "--parents", "-n", "1", commit])).split(" ").filter(Boolean);
  const base = lineage[1];
  const statusRaw = base
    ? await checkedGit(repoRoot, ["diff", "--no-color", "--name-status", "-z", base, commit, "--"])
    : await checkedGit(repoRoot, ["show", "--no-color", "--name-status", "-z", "--format=", commit, "--"]);
  const files = parseNameStatus(statusRaw);
  const selected = files.filter((change) => change.path === relative || change.from === relative);
  if (!selected.length) throw new Error("Ese archivo no forma parte de este commit.");
  const diffRaw = base
    ? await checkedGit(repoRoot, ["diff", "--no-color", "--no-ext-diff", "--unified=3", base, commit, "--", relative])
    : await checkedGit(repoRoot, ["show", "--no-color", "--no-ext-diff", "--unified=3", "--format=", commit, "--", relative]);
  const stats = await commitFileStats(repoRoot, commit, base);
  return { hash: commit, files: selected, stats: Object.fromEntries(selected.flatMap((change) => stats[change.path] ? [[change.path, stats[change.path]]] : [])), ...cutDiff(diffRaw) };
}

/** One uncommitted file, so the changes tab can show what changed rather than only that it did. */
export async function getWorkingFileDiff(cwd: string, file: string): Promise<CommitDetail> {
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  const absolute = resolve(repoRoot, file);
  // A path from the interface is still a path: it has to land inside the repository that asked.
  if (absolute !== repoRoot && !absolute.startsWith(`${repoRoot}${sep}`)) throw new Error("La ruta no pertenece a este repositorio.");
  const relative = absolute.slice(repoRoot.length + 1);
  const head = await optionalGit(repoRoot, ["rev-parse", "HEAD"]);
  const tracked = head
    ? await checkedGit(repoRoot, ["diff", "--no-color", "--no-ext-diff", "--unified=3", "HEAD", "--", relative])
    : await checkedGit(repoRoot, ["diff", "--no-color", "--no-ext-diff", "--unified=3", "--", relative]);
  if (tracked.trim()) return { hash: "", files: [], stats: {}, ...cutDiff(tracked) };

  // Untracked files have nothing to diff against, so the file itself is the change.
  const untracked = await checkedGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", relative]);
  if (!untracked.split("\0").filter(Boolean).length) return { hash: "", files: [], stats: {}, diff: "", truncated: false };
  try {
    const content = readFileSync(absolute);
    if (content.includes(0)) return { hash: "", files: [], stats: {}, diff: `--- /dev/null\n+++ b/${relative}\n[archivo binario]`, truncated: false };
    const body = content.toString("utf8").split("\n").map((line) => `+${line}`).join("\n");
    return { hash: "", files: [], stats: {}, ...cutDiff(`--- /dev/null\n+++ b/${relative}\n@@ archivo nuevo @@\n${body}`) };
  } catch (error) {
    return { hash: "", files: [], stats: {}, diff: `[no se pudo leer: ${error instanceof Error ? error.message : "error desconocido"}]`, truncated: false };
  }
}

function refused(reason: string, source: ActionPlan["source"] = "guardrail", summary = "Solicitud rechazada", kind: ActionPlan["kind"] = "refusal"): PlanDraft {
  return {
    allowed: false, steps: [], operation: "none", args: {}, command: "—", summary,
    rationale: reason, risk: "low", requiresConfirmation: false, kind, source
  };
}

/** The assistant needs something from the user. A question, not a failure. */
function asking(reason: string, summary: string): PlanDraft {
  return refused(reason, "llm", summary || "Necesito un dato más", "question");
}

/** Display-only quoting: execution never goes through a shell, this is so the card reads like what runs. */
function quoteToken(token: string) {
  return /^[A-Za-z0-9._/@:=+~-]+$/.test(token) ? token : JSON.stringify(token);
}

function buildCommand(operation: Operation, args: Record<string, string>, argv: string[] = []) {
  switch (operation) {
    case "checkout": return `git switch ${args.name}`;
    case "create_branch": return `git switch -c ${args.name}${args.from ? ` ${args.from}` : ""}`;
    case "delete_branch": return `git branch -d ${args.name}`;
    case "rename_branch": return `git branch -m ${args.name} ${args.to}`;
    case "fetch": return "git fetch --prune";
    case "pull": return "git pull --ff-only";
    case "push": return `git push${args.noVerify === "true" ? " --no-verify" : ""}`;
    case "merge": return `git merge --no-edit ${args.name}`;
    case "rebase": return `git rebase ${args.onto}`;
    case "abort_operation": return `git ${args.pending ?? "rebase"} --abort`;
    case "continue_operation": return `git ${args.pending ?? "rebase"} --continue`;
    case "skip_operation": return `git ${args.pending ?? "rebase"} --skip`;
    case "resolve_conflict": return resolveConflictCommand(args);
    case "commit": return `git add -A && git commit -m "${args.message ?? ""}"`;
    case "git_command": return ["git", ...argv].map(quoteToken).join(" ");
    case "github_create_repo": {
      const steps = [];
      if (args.account && args.account !== args.activeAccount) steps.push(`gh auth switch --hostname ${args.host} --user ${args.account}`);
      steps.push(`GH_HOST=${args.host} gh repo create ${args.owner}/${args.name} --private`);
      steps.push(`git -C ${JSON.stringify(args.source)} remote add ${args.remote} ${args.remoteUrl}`);
      if (args.push === "true") steps.push(`git -C ${JSON.stringify(args.source)} push -u ${args.remote} HEAD`);
      if (args.account && args.account !== args.activeAccount) steps.push(`gh auth switch --hostname ${args.host} --user ${args.activeAccount}`);
      return steps.join(" && ");
    }
    case "status": return "git status";
    default: return "—";
  }
}

/**
 * What resolving one conflict actually runs. The side a person picks is not always a checkout: a path
 * their side deleted has no version to check out, so keeping "ours" there means removing the file.
 * The conflict's own shape decides, which is why this reads the snapshot rather than trusting args.
 */
function conflictPlan(args: Record<string, string>, snapshot?: RepoSnapshot) {
  const conflict = snapshot?.conflicts.find((item) => item.path === args.path);
  if (args.side === "resolved" || !conflict) return { action: "add" as const, conflict };
  return { action: resolutionFor(conflict.kind, args.side === "theirs" ? "theirs" : "ours"), conflict };
}

function resolveConflictCommand(args: Record<string, string>, snapshot?: RepoSnapshot) {
  const { action } = conflictPlan(args, snapshot);
  const path = JSON.stringify(args.path ?? "");
  if (action === "remove") return `git rm -- ${path}`;
  if (action === "checkout") return `git checkout --${args.side} -- ${path} && git add -- ${path}`;
  return `git add -- ${path}`;
}

async function runResolveConflict(cwd: string, args: Record<string, string>, snapshot: RepoSnapshot, locale?: Locale) {
  const { action } = conflictPlan(args, snapshot);
  if (action === "remove") return reportedGit(cwd, ["rm", "-q", "--", args.path]);
  if (action === "checkout") await checkedGit(cwd, ["checkout", `--${args.side}`, "--", args.path]);
  await checkedGit(cwd, ["add", "--", args.path]);
  return localized(locale, `${args.path} resuelto.`, `${args.path} resolved.`);
}

/**
 * Environment checks report machine-readable blockers instead of prose: the planner model turns
 * them into an explanation written in the language the user is actually using.
 */
type RepositoryPreparation = { draft: PlanDraft } | { blockers: PlanIssue[] };

function blocked(problem: string, field = "environment"): RepositoryPreparation {
  return { blockers: [{ field, problem }] };
}

function hasSshPrivateKey() {
  const agent = runCommand("ssh-add", ["-L"], process.cwd(), 10_000).catch(() => undefined);
  return agent.then((result) => {
    if (result?.code === 0 && /^(?:ssh-|ecdsa-)/m.test(result.stdout)) return true;
    const sshDirectory = join(process.env.HOME ?? "", ".ssh");
    try {
      return readdirSync(sshDirectory).some((name) => {
        if (name.endsWith(".pub") || ["authorized_keys", "config", "known_hosts", "known_hosts.old"].includes(name)) return false;
        const path = join(sshDirectory, name);
        try {
          return statSync(path).isFile() && /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/.test(readFileSync(path, "utf8").slice(0, 200));
        } catch { return false; }
      });
    } catch { return false; }
  });
}

/** Dials one SSH host and reports which identity answered, so the wrong key cannot slip through. */
async function sshIdentity(sshHost: string, cwd: string) {
  const result = await runCommand("ssh", [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`, `git@${sshHost}`
  ], cwd, 15_000).catch(() => undefined);
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.trim();
  return {
    authenticated: isSshAuthenticated(output, result?.code),
    login: parseSshGreeting(output),
    output: output || "connection refused or timed out"
  };
}

/** ~/.ssh/config aliases whose effective HostName is the target host, cheapest candidates first. */
async function sshAliasesFor(host: string, cwd: string) {
  let config: string;
  try {
    config = readFileSync(join(homedir(), ".ssh", "config"), "utf8");
  } catch {
    return [];
  }
  const aliases: string[] = [];
  for (const alias of sshConfigHostAliases(config)) {
    if (alias.toLowerCase() === host.toLowerCase()) continue;
    const resolved = await runCommand("ssh", ["-G", alias], cwd, 10_000).catch(() => undefined);
    if (resolved && parseSshResolvedHostName(resolved.stdout) === host.toLowerCase()) aliases.push(alias);
  }
  return aliases;
}

type SshResolution = { sshHost: string } | { problem: string };

/**
 * The default key for a host is not necessarily the owner's. Every candidate is dialled and the
 * greeting checked, so the remote URL ends up on the alias that actually authenticates as `owner`.
 */
async function resolveSshHost(host: string, owner: string, cwd: string, requested?: string): Promise<SshResolution> {
  if (!await hasSshPrivateKey()) {
    return { problem: "no SSH private key was found on this machine and ssh-agent has none loaded; the user must configure an SSH key first" };
  }
  const remembered = recallIdentity(memory, host, owner)?.sshHost;
  // Memory only reorders the search; every candidate still has to prove who it is.
  const first = requested ? [requested] : [...new Set([remembered, host].filter((entry): entry is string => Boolean(entry)))];
  const attempts: string[] = [];
  const tried = new Set<string>();

  const attempt = async (candidate: string): Promise<SshResolution | undefined> => {
    if (tried.has(candidate)) return undefined;
    tried.add(candidate);
    const identity = await sshIdentity(candidate, cwd);
    if (identity.authenticated && identity.login && identity.login.toLowerCase() === owner.toLowerCase()) return { sshHost: candidate };
    attempts.push(identity.authenticated
      ? `${candidate} authenticates as "${identity.login ?? "an unknown identity"}"`
      : `${candidate} did not authenticate (${identity.output.slice(0, 160)})`);
    if (candidate === remembered) saveMemory(forgetSshHost(memory, host, owner));
    // A host that cannot name its identity still proves access; accept it when it is the one asked for.
    if (identity.authenticated && !identity.login && (requested || candidate === host)) return { sshHost: candidate };
    return undefined;
  };

  for (const candidate of first) {
    const resolved = await attempt(candidate);
    if (resolved) return resolved;
  }
  if (!requested) {
    for (const alias of await sshAliasesFor(host, cwd)) {
      const resolved = await attempt(alias);
      if (resolved) return resolved;
    }
  }
  return {
    problem: requested
      ? `the requested SSH host "${requested}" does not authenticate as "${owner}": ${attempts.join("; ")}`
      : `no SSH host on this machine authenticates against ${host} as "${owner}". Tried: ${attempts.join("; ")}. The user can add a Host alias in ~/.ssh/config with the key for "${owner}" and name it, or say which existing alias to use`
  };
}

/** Every account logged into the host, not only the active one: the right one may be inactive. */
async function ghAccounts(host: string, cwd: string) {
  const status = await runCommand("gh", ["auth", "status", "--hostname", host, "--json", "hosts"], cwd, 20_000, { GH_PROMPT_DISABLED: "1" }).catch(() => undefined);
  return status?.code === 0 ? parseGhAccounts(status.stdout, host) : [];
}

async function checkedGh(args: string[], cwd: string, host?: string) {
  const result = await runCommand("gh", args, cwd, 60_000, {
    GH_PROMPT_DISABLED: "1",
    ...(host ? { GH_HOST: host } : {})
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `gh ${args[0] ?? ""} falló.`);
  return result.stdout.trim();
}

async function prepareGithubRepository(snapshot: RepoSnapshot, input: RepositoryFields, source: ActionPlan["source"]): Promise<RepositoryPreparation> {
  const validation = validateRepositoryFields(input);
  if (validation.issues.length) return { blockers: validation.issues.map((issue) => ({ field: `repository.${issue.field}`, problem: issue.problem })) };
  let repositoryPlan = buildRepositoryPlan(validation.fields);

  let sourcePath: string;
  try {
    sourcePath = realpathSync(repositoryPlan.localPath);
    if (!statSync(sourcePath).isDirectory()) return blocked(`localPath "${repositoryPlan.localPath}" is not a directory`, "repository.localPath");
    accessSync(sourcePath, constants.R_OK | constants.W_OK);
  } catch {
    return blocked(`localPath "${repositoryPlan.localPath}" does not exist or is not readable and writable`, "repository.localPath");
  }
  repositoryPlan = buildRepositoryPlan({ ...validation.fields, localPath: sourcePath });
  assertRepositoryPlan(repositoryPlan);

  let sourceSnapshot: RepoSnapshot;
  try {
    sourceSnapshot = await getSnapshot(sourcePath);
  } catch {
    return blocked(`"${sourcePath}" is not a Git repository; GitCat never runs git init on its own, the user must create or open the repository first`, "repository.localPath");
  }
  if (sourceSnapshot.path !== sourcePath) return blocked(`"${sourcePath}" is inside the repository "${sourceSnapshot.path}"; the exact repository root is required`, "repository.localPath");
  if (sourceSnapshot.path !== snapshot.path) return blocked(`"${sourcePath}" is not the project currently open in GitCat ("${snapshot.path}"); for safety the user must open it as the active project before publishing it`, "repository.localPath");

  const { repository: name, owner, host, protocol } = repositoryPlan;
  const remote = validation.fields.remote ?? "origin";
  const push = repositoryPlan.action === "create_repository_and_push";
  const replaceRemote = validation.fields.replaceRemote === true;
  if (push && !sourceSnapshot.head) return blocked("the local repository has no commits, so there is nothing to push; the user can create a first commit or ask to create the repository without pushing");

  const ghVersion = await runCommand("gh", ["--version"], sourcePath, 10_000, { GH_PROMPT_DISABLED: "1" }).catch(() => undefined);
  if (!ghVersion || ghVersion.code !== 0) {
    const searched = await toolDirectories();
    return blocked(`GitHub CLI (gh) is required but no runnable gh was found in any of the ${searched.length} directories GitCat searched (including ${searched.slice(0, 6).join(", ")}). If gh is installed elsewhere, it is a PATH problem rather than a missing install`);
  }
  const accounts = await ghAccounts(host, sourcePath);
  if (!accounts.length) return blocked(`no account is logged into ${host} with gh; the user must run: gh auth login --hostname ${host}`);
  const activeAccount = accounts.find((entry) => entry.active)?.login ?? accounts[0].login;
  const ownerAccount = findAccount(accounts, owner);
  const rememberedAccount = recallIdentity(memory, host, owner)?.account;
  const account = ownerAccount?.login ?? (rememberedAccount ? findAccount(accounts, rememberedAccount)?.login : undefined) ?? activeAccount;
  const available = accounts.map((entry) => `${entry.login}${entry.active ? " (active)" : ""}`).join(", ");

  // Owner is not one of the logged-in accounts, so it has to be an organization the account can publish to.
  if (!ownerAccount) {
    const permission = await runCommand("gh", [
      "api", "graphql",
      "-f", "query=query($login:String!){organization(login:$login){viewerCanCreateRepositories}}",
      "-F", `login=${owner}`,
      "--jq", ".data.organization.viewerCanCreateRepositories"
    ], sourcePath, 20_000, { GH_PROMPT_DISABLED: "1", GH_HOST: host });
    if (permission.code !== 0 || permission.stdout.trim() !== "true") {
      return blocked(`"${owner}" is neither an organization that ${account} can create repositories in, nor an account logged into ${host} on this machine. Accounts available here: ${available}. The user can pick one of those as the owner, or run: gh auth login --hostname ${host}`, "repository.owner");
    }
  }

  let sshHost = "";
  if (protocol === "ssh") {
    const resolution = await resolveSshHost(host, owner, sourcePath, validation.fields.sshHost);
    if ("problem" in resolution) return blocked(resolution.problem, "repository.sshHost");
    sshHost = resolution.sshHost;
    repositoryPlan = buildRepositoryPlan({ ...validation.fields, localPath: sourcePath, sshHost });
    assertRepositoryPlan(repositoryPlan);
  }
  const { remoteUrl } = repositoryPlan;

  const existing = await runCommand("gh", ["api", `repos/${owner}/${name}`, "--silent"], sourcePath, 20_000, { GH_PROMPT_DISABLED: "1", GH_HOST: host });
  if (existing.code === 0) return blocked(`the repository ${host}/${owner}/${name} already exists; a different name is needed`, "repository.repository");
  const existingError = `${existing.stderr}\n${existing.stdout}`;
  if (!/HTTP 404|not found/i.test(existingError)) {
    return blocked(`it could not be verified whether ${host}/${owner}/${name} already exists, so nothing was attempted; gh reported: ${(existing.stderr.trim() || existing.stdout.trim() || "network or API error").slice(0, 300)}`);
  }

  const remoteResult = await runGit(sourcePath, ["remote", "get-url", remote]);
  const remoteExists = remoteResult.code === 0;
  if (remoteExists && !replaceRemote) {
    return blocked(`the local remote "${remote}" already points to ${remoteResult.stdout.trim()}; replacing it requires the user to say so explicitly`, "repository.replaceRemote");
  }

  const args = {
    name, owner, host, protocol, sshHost, remoteUrl, visibility: "private", source: sourcePath, remote,
    account, activeAccount,
    push: String(push), replaceRemote: String(replaceRemote && remoteExists),
    existingRemoteHash: remoteExists ? createHash("sha256").update(remoteResult.stdout.trim()).digest("hex") : ""
  };
  const effects = [
    `create: ${host}/${owner}/${name} (private)`,
    `local: ${sourcePath}`,
    `gh account: ${account}${account === activeAccount ? " (active)" : ` (temporarily active instead of ${activeAccount}, restored afterwards)`}`,
    ...(protocol === "ssh" ? [`ssh identity: ${sshHost} → ${owner}`] : []),
    `remote ${remote}: ${remoteExists ? `${remoteResult.stdout.trim()} → ${remoteUrl}` : remoteUrl}`,
    `push: ${push ? `${remote} HEAD` : "no"}`
  ];
  return {
    draft: {
      allowed: true,
      steps: [{ operation: "github_create_repo", args, command: buildCommand("github_create_repo", args), summary: `${owner}/${name}`, risk: "high" }],
      operation: "github_create_repo",
      args,
      command: buildCommand("github_create_repo", args),
      summary: `${owner}/${name}`,
      rationale: `gh ${host} · ${protocol} · ${sourcePath}`,
      effects,
      repositoryPlan,
      targetPath: sourceSnapshot.path,
      targetHead: sourceSnapshot.head,
      targetStateId: sourceSnapshot.stateId,
      risk: "high",
      requiresConfirmation: true,
      kind: "plan",
      source
    }
  };
}

type ProviderResponse = {
  output_text?: string;
  output?: { content?: { refusal?: string; text?: string }[] }[];
  status?: string;
  incomplete_details?: { reason?: string };
};

function extractOutputText(body: ProviderResponse): string {
  if (typeof body?.output_text === "string" && body.output_text.trim()) return body.output_text;
  const textParts: string[] = [];
  for (const item of body?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.refusal === "string" && content.refusal.trim()) throw new Error(`El modelo rechazó la petición: ${content.refusal.slice(0, 300)}`);
      if (typeof content?.text === "string") textParts.push(content.text);
    }
  }
  return textParts.join("\n").trim();
}

/**
 * A truncated or empty provider answer used to fall back to a local keyword planner, which turned
 * provider problems into silent, wrong refusals. Every failure mode is now explicit.
 */
async function callProvider(body: Record<string, unknown>, timeoutMs = 180_000, credentials: LlmConfigInput = llmState): Promise<ProviderResponse> {
  const model = credentials.model.trim() || MODEL_FALLBACK;
  if (!credentials.apiKey.trim()) throw new Error(LLM_REQUIRED);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(RESPONSES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiKey}` },
      body: JSON.stringify({ model, store: false, ...body }),
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(controller.signal.aborted
      ? `El proveedor no respondió en ${Math.round(timeoutMs / 1000)} s.`
      : `No se pudo contactar con el proveedor: ${error instanceof Error ? error.message : "error de red"}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`El proveedor respondió ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function askProvider(body: Record<string, unknown>, timeoutMs?: number): Promise<string> {
  const payload = await callProvider(body, timeoutMs);
  if (payload?.status === "incomplete") {
    const reason = payload?.incomplete_details?.reason;
    throw new Error(reason === "max_output_tokens"
      ? `El modelo “${llmState.model || MODEL_FALLBACK}” agotó su presupuesto de tokens antes de emitir una respuesta.`
      : `El proveedor no completó la respuesta (${reason ?? "motivo desconocido"}).`);
  }
  const text = extractOutputText(payload);
  if (!text.trim()) throw new Error("El proveedor devolvió una respuesta vacía.");
  return text;
}

function cleanCommitDescription(text: string) {
  const normalized = text.trim().replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").trim();
  const firstParagraph = normalized.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim() ?? "";
  if (!firstParagraph) throw new Error("El proveedor no devolvió una descripción de commit.");
  return firstParagraph.slice(0, commitMessageLimit).trim();
}

async function getWorkingTreeDiff(snapshot: RepoSnapshot) {
  const trackedDiff = snapshot.head
    ? await checkedGit(snapshot.path, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"])
    : [
        await checkedGit(snapshot.path, ["diff", "--cached", "--no-ext-diff", "--unified=3", "--"]),
        await checkedGit(snapshot.path, ["diff", "--no-ext-diff", "--unified=3", "--"])
      ].filter(Boolean).join("\n");
  const untrackedRaw = await checkedGit(snapshot.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const sections = [trackedDiff];

  // Nothing is truncated: whatever the working tree holds is what the model gets to read.
  for (const relativePath of untrackedRaw.split("\0").filter(Boolean)) {
    const absolutePath = resolve(snapshot.path, relativePath);
    if (!absolutePath.startsWith(`${snapshot.path}${sep}`)) continue;
    try {
      if (lstatSync(absolutePath).isSymbolicLink()) {
        sections.push(`\n+++ b/${relativePath}\n[enlace simbólico omitido]`);
        continue;
      }
      const content = readFileSync(absolutePath);
      const header = `\n--- /dev/null\n+++ b/${relativePath}\n@@ archivo nuevo @@\n`;
      sections.push(`${header}${content.includes(0) ? "[archivo binario omitido]" : content.toString("utf8")}`);
    } catch (reason) {
      // A file too large for a single Buffer, or unreadable: reported, never silently dropped.
      sections.push(`\n+++ b/${relativePath}\n[no se pudo leer: ${reason instanceof Error ? reason.message : "error desconocido"}]`);
    }
  }
  const diff = sections.filter(Boolean).join("\n");
  if (!diff.trim()) throw new Error("No hay un diff de texto disponible para describir.");
  return diff;
}

/** One commit message read off the real diff. Shared by the manual button and by any planned commit. */
async function describeChanges(snapshot: RepoSnapshot) {
  const diff = await getWorkingTreeDiff(snapshot);
  const recentSubjects = snapshot.commits.slice(0, 15).map((commit) => commit.subject).filter(Boolean);
  const instructions = `Write one commit message for the working tree diff below.
Rules: a single line, ${commitMessageLimit} characters maximum, imperative mood, describing the intent of
the change. No quotes, no markdown, no prefix, no explanation, nothing but the message itself.
Write it in the same language as the recent commit subjects of this repository; if there are none, or
they are mixed, write it in English.`;
  const input = [
    `Current branch: ${snapshot.currentBranch}`,
    recentSubjects.length ? `Recent commit subjects:\n${recentSubjects.map((subject) => `- ${subject}`).join("\n")}` : "Recent commit subjects: none",
    `Working tree diff:\n${diff}`
  ].join("\n\n");
  const text = await askProvider({ instructions, input }, 180_000);
  return cleanCommitDescription(text);
}

export async function generateCommitDescription(cwd: string, locale?: Locale) {
  const language = normalizeLocale(locale);
  if (!isLlmConfigured()) throw new Error(llmRequired(language));
  const snapshot = await getSnapshot(cwd);
  if (!snapshot.changes.length) throw new Error(localized(language, "No hay cambios locales que describir.", "There are no local changes to describe."));
  const description = await describeChanges(snapshot);
  const current = await getSnapshot(snapshot.path);
  if (current.stateId !== snapshot.stateId) throw new Error(localized(language, "Los cambios variaron durante la generación. Inténtalo de nuevo.", "The changes moved while the description was being generated. Try again."));
  return { description, stateId: snapshot.stateId };
}

/** Everything the model is allowed to reason about: verified repository facts, never raw guesses. */
async function plannerState(snapshot: RepoSnapshot) {
  const workingTreeDiff = snapshot.isDirty
    ? await getWorkingTreeDiff(snapshot).catch((error) => `[no se pudo leer el diff de trabajo: ${error instanceof Error ? error.message : "error desconocido"}]`)
    : null;
  return {
    openRepositoryPath: snapshot.path,
    openRepositoryName: snapshot.name,
    currentBranch: snapshot.currentBranch,
    defaultBranch: snapshot.defaultBranch ?? null,
    defaultBranchSource: snapshot.defaultBranchSource ?? null,
    detachedHead: snapshot.currentBranch === "HEAD",
    isRebasing: snapshot.isRebasing,
    // A half-finished job blocks almost everything else, so it is stated rather than left to be inferred.
    pendingOperation: snapshot.pending ?? null,
    conflicts: snapshot.conflicts.map((conflict) => ({ path: conflict.path, kind: conflict.kind, meaning: conflictLabels[conflict.kind] })),
    hasLocalChanges: snapshot.isDirty,
    localChanges: snapshot.changes.slice(0, 60),
    // A dirty tree is not part of any branch tip. The model needs the actual diff before deciding
    // whether a merge request should commit it, leave it alone, or ask the user what it belongs to.
    workingTreeDiff,
    remotes: snapshot.remotes,
    branches: snapshot.branches.map((branch) => ({
      name: branch.name,
      isCurrent: branch.isCurrent,
      isDefault: branch.name === snapshot.defaultBranch,
      // "remote": it exists only on a remote, so switching to it creates the local branch.
      presence: branch.presence,
      // Verified containment: these branches already hold this one's work. [] means neither does.
      mergedInto: branch.mergedInto,
      // Another worktree holds it, so Git will refuse to check it out here until that one lets go.
      checkedOutIn: branch.checkedOutIn ?? null,
      // What the prefix says this branch is for. "permanent" is protected from deletion, full stop.
      lifecycle: lifecycleOf(branch.name),
      // Verified by Git: this branch continues that one, so that one rebases first.
      stackedOn: branch.stackedOn ?? null,
      upstream: branch.upstream ?? null,
      // Against the upstream only. These say nothing about integration into another branch.
      ahead: branch.ahead,
      behind: branch.behind,
      lastCommit: branch.lastCommit
        ? { shortHash: branch.lastCommit.shortHash, subject: branch.lastCommit.subject, author: branch.lastCommit.author, email: branch.lastCommit.email, date: branch.lastCommit.date }
        : null
    })),
    recentCommits: snapshot.commits.slice(0, 30).map((commit) => ({
      shortHash: commit.shortHash, subject: commit.subject, author: commit.author, date: commit.date, refs: commit.refs
    })),
    staleAfterDays,
    remembered: {
      thisRepository: recallRepository(memory, snapshot.path) ?? null,
      identities: Object.entries(memory.identities).map(([hostAndOwner, entry]) => ({
        hostAndOwner, account: entry.account ?? null, sshHost: entry.sshHost ?? null
      }))
    }
  };
}

async function requestPlan(request: string, snapshot: RepoSnapshot, context: ConversationMessage[], issues: PlanIssue[] = []): Promise<ModelPlan> {
  const text = await askProvider({
    instructions: buildPlannerInstructions(await plannerState(snapshot), issues),
    input: [...context, { role: "user", content: request }],
    text: { format: planResponseFormat }
  });
  const plan = parseModelPlan(text);
  if (!plan) throw new Error("El proveedor devolvió una respuesta que no cumple el esquema del plan.");
  return plan;
}

function answerDraft(plan: ModelPlan): PlanDraft {
  return {
    allowed: true, steps: [], operation: "none", args: {}, command: "—",
    summary: plan.summary || plan.reply.slice(0, 80),
    rationale: plan.rationale || plan.reply,
    answer: plan.reply,
    risk: "low", requiresConfirmation: false, kind: "question", source: "llm"
  };
}

const riskOrder = { low: 0, medium: 1, high: 2 } as const;

function highestRisk(a: ActionPlan["risk"], b: ActionPlan["risk"]): ActionPlan["risk"] {
  return riskOrder[a] >= riskOrder[b] ? a : b;
}

/**
 * The model chooses the operations and their order and writes the prose; the deterministic table owns
 * each command, its risk and whether the plan needs confirmation. A step the table does not recognise
 * cannot reach Git, so an unknown operation collapses the whole plan into a refusal.
 */
async function gitOperationDraft(plan: ModelPlan, snapshot: RepoSnapshot, locale: Locale = "es"): Promise<PlanDraft> {
  const proposed = plan.steps.map((step) => stepFrom(step.operation, operationArgs(step), step.argv, locale));
  if (proposed.some((step) => !step)) return refused(localized(locale, "El plan incluye una operación que no está permitida.", "The plan includes an operation that is not allowed."), "llm", plan.summary);
  const steps = await writeCommitMessages(proposed as PlanStep[], snapshot, locale);
  if ("blocker" in steps) return asking(steps.blocker, plan.summary);
  const draft = sequenceDraft(steps, plan.rationale || "", renameEffects(steps, snapshot, locale), locale);
  return {
    ...draft,
    summary: plan.summary || draft.summary,
    rationale: plan.rationale || draft.rationale,
    risk: highestRisk(draft.risk, plan.risk),
    source: "llm"
  };
}

/**
 * Branch names a free-form "git branch -d/-D" would delete. Those flags take no value, so every
 * non-flag token after the subcommand is a branch name.
 */
function gitBranchDeletions(argv: string[]): string[] {
  if (argv[0] !== "branch") return [];
  const tokens = argv.slice(1).filter((token) => token !== "--");
  if (!tokens.some((token) => token === "-d" || token === "-D" || token === "--delete")) return [];
  return tokens.filter((token) => !token.startsWith("-"));
}

/**
 * Deletions the repository protects, handed back as structured defects so the model corrects itself
 * and explains why in the user's own language, instead of running into the guardrail as a raw error.
 */
function protectedBranchIssues(plan: ModelPlan, snapshot: RepoSnapshot): PlanIssue[] {
  return plan.steps.flatMap((step, index) => {
    const names = step.operation === "delete_branch" ? [operationArgs(step).name]
      : step.operation === "git_command" ? gitBranchDeletions(step.argv)
      : [];
    const field = step.operation === "git_command" ? `steps[${index}].argv` : `steps[${index}].args.name`;
    return names.flatMap((name) => {
      if (snapshot.defaultBranch && name === snapshot.defaultBranch) {
        return [{ field, problem: `"${name}" is the repository's default branch and is protected; choose a non-default branch` }];
      }
      if (isProtectedBranch(name)) {
        return [{ field, problem: `"${name}" has a prefix whose branches are kept permanently; they exist to survive cleanups and are never deletion candidates` }];
      }
      return [];
    });
  });
}

function repositoryFieldsFromPlan(plan: ModelPlan): RepositoryFields {
  const { localPath, repository, owner, host, protocol, remote, push, replaceRemote } = plan.repository;
  return {
    localPath: localPath || undefined,
    repository: repository || undefined,
    owner: owner || undefined,
    host: host || undefined,
    protocol: protocol || undefined,
    remote: remote || undefined,
    push,
    replaceRemote
  };
}

const LAST_RESORT_REFUSAL =
  "No pude convertir la solicitud en un plan verificable y el proveedor no explicó por qué. Reformula la petición o revisa la configuración del modelo.";
const LAST_RESORT_REFUSAL_EN =
  "I could not turn the request into a verifiable plan and the provider did not explain why. Rephrase the request or check the model configuration.";

/**
 * Turns one model plan into a draft. When local validation or an environment check rejects it, the
 * defects go back to the model as structured issues so it can correct itself or explain the problem
 * to the user in their own language. Retried once; there is no keyword fallback.
 */
async function draftFromPlan(
  plan: ModelPlan, snapshot: RepoSnapshot, request: string, context: ConversationMessage[], locale: Locale = "es", retried = false
): Promise<PlanDraft> {
  const fallbackRefusal = localized(locale, LAST_RESORT_REFUSAL, LAST_RESORT_REFUSAL_EN);
  if (plan.intent === "answer") return answerDraft(plan);
  if (plan.intent === "needs_information") return asking(plan.reply || plan.rationale || fallbackRefusal, plan.summary);
  if (plan.intent === "out_of_scope") return refused(plan.reply || plan.rationale || fallbackRefusal, "llm", plan.summary || localized(locale, "Solicitud rechazada", "Request rejected"));

  const retry = async (issues: PlanIssue[]) => {
    if (retried) return asking(plan.reply || plan.rationale || fallbackRefusal, plan.summary);
    return draftFromPlan(await requestPlan(request, snapshot, context, issues), snapshot, request, context, locale, true);
  };

  if (plan.intent === "git_operation") {
    const issues = [...planIssues(plan), ...protectedBranchIssues(plan, snapshot)];
    return issues.length ? retry(issues) : gitOperationDraft(plan, snapshot, locale);
  }

  const preparation = await prepareGithubRepository(snapshot, repositoryFieldsFromPlan(plan), "llm");
  if ("blockers" in preparation) return retry(preparation.blockers);
  return {
    ...preparation.draft,
    summary: plan.summary || preparation.draft.summary,
    rationale: plan.rationale || preparation.draft.rationale
  };
}

function bindPlan(snapshot: RepoSnapshot, draft: PlanDraft): ActionPlan {
  return { ...draft, id: randomUUID(), repoPath: snapshot.path, head: snapshot.head, stateId: snapshot.stateId };
}

/**
 * What a conflict proposal was drafted against. The operation part covers the job holding the
 * conflicts; each file keeps its unmerged index stages and the exact bytes that were reviewed. A file
 * can be edited without its status code changing, so "still UU" is not enough to write over it.
 */
export type ConflictBinding = {
  operation: string;
  files: Record<string, { stages: string; content: string }>;
};

/** A proposal as the main process keeps it: the reviewed content plus what it is bound to. */
export type IssuedConflictProposal = ConflictProposal & { binding: ConflictBinding };

async function conflictOperation(repoRoot: string) {
  const heads = await Promise.all(["HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]
    .map((ref) => optionalGit(repoRoot, ["rev-parse", "-q", "--verify", ref])));
  return createHash("sha256").update(JSON.stringify([heads, (await readPendingOperation(repoRoot)) ?? null])).digest("hex");
}

/** Every unmerged index entry, grouped by path: mode, blob and stage of each side Git is holding. */
async function unmergedStages(repoRoot: string) {
  const stages = new Map<string, string[]>();
  for (const record of (await checkedGit(repoRoot, ["ls-files", "-u", "-z"], true)).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    stages.set(path, [...(stages.get(path) ?? []), record.slice(0, tab)]);
  }
  return new Map([...stages].map(([path, entries]) => [path, entries.sort().join("\n")]));
}

function contentVersion(raw: Buffer | undefined) {
  return raw ? createHash("sha256").update(raw).digest("hex") : "missing";
}

function readIfPresent(absolute: string) {
  try {
    return readFileSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The model's reading of every open conflict, as a proposal and nothing else. The file contents do
 * leave the machine here — that is unavoidable, since settling a conflict means understanding both
 * sides — so it only ever happens because someone pressed the button, never on its own.
 */
export async function proposeConflictResolution(cwd: string, locale?: Locale): Promise<IssuedConflictProposal> {
  const language = normalizeLocale(locale);
  if (!isLlmConfigured()) throw new Error(llmRequired(language));
  const snapshot = await getSnapshot(cwd);
  if (!snapshot.conflicts.length) throw new Error(localized(language, "No hay conflictos que resolver.", "There are no conflicts to resolve."));
  // Captured before anything is read, so a change made while the model is thinking is caught later.
  const operation = await conflictOperation(snapshot.path);
  const stages = await unmergedStages(snapshot.path);
  const issued = { id: randomUUID(), repoPath: snapshot.path };
  const current: Record<string, string> = {};
  const files: ConflictBinding["files"] = {};
  const readable: Conflict[] = [];
  for (const conflict of snapshot.conflicts) {
    const absolute = resolve(snapshot.path, conflict.path);
    if (!absolute.startsWith(`${snapshot.path}${sep}`)) continue;
    try {
      const raw = readFileSync(absolute);
      // A binary file has no sides to read, and a huge one nobody is going to review properly.
      if (raw.includes(0) || raw.length > conflictFileLimit) continue;
      current[conflict.path] = raw.toString("utf8");
      files[conflict.path] = { stages: stages.get(conflict.path) ?? "", content: contentVersion(raw) };
      readable.push(conflict);
    } catch { /* deleted on one side: there is no content to reason about */ }
  }
  if (!readable.length) {
    return {
      ...issued,
      resolutions: [],
      skipped: snapshot.conflicts.map((conflict) => ({
        path: conflict.path,
        reason: "Es binario, demasiado grande, o uno de los lados lo borró: eso se decide con «quedarse con un lado»."
      })),
      current: {},
      binding: { operation, files }
    };
  }

  // A rebase replays your commits on top of the other branch, so "ours" is the branch underneath.
  const rebasing = snapshot.pending?.kind === "rebase";
  const instructions = buildResolutionInstructions({
    operation: snapshot.pending ? pendingCommands[snapshot.pending.kind] : "merge",
    branch: snapshot.pending?.branch,
    onto: snapshot.pending?.onto,
    ours: rebasing ? `the branch being replayed onto (${snapshot.pending?.onto ?? "the base"})` : `the current branch (${snapshot.currentBranch})`,
    theirs: rebasing ? `the commits being replayed (${snapshot.pending?.branch ?? "your work"})` : "the branch being brought in"
  });
  const input = readable.map((conflict) => [
    `Path: ${conflict.path}`,
    `Conflict: ${conflictLabels[conflict.kind]}`,
    `Content:\n${current[conflict.path]}`
  ].join("\n")).join("\n\n---\n\n");

  const text = await askProvider({ instructions, input, text: { format: resolutionResponseFormat } }, 240_000);
  const parsed = parseConflictProposal(text);
  if (!parsed) throw new Error(localized(language, "El proveedor devolvió una respuesta que no cumple el esquema de resolución.", "The provider returned a response that does not match the resolution schema."));
  return { ...issued, ...validateProposal(parsed, readable.map((conflict) => conflict.path)), current, binding: { operation, files } };
}

/**
 * Writes what the person accepted, and only that. The content comes from the proposal the main
 * process issued, never from the renderer. The whole accepted set is checked against the repository
 * as it is now — the same repository, the same operation, the same conflict stages and the same bytes
 * that were reviewed — before a single file is written, because an edit made while the review was
 * open must never be overwritten by a draft of the older file.
 */
export async function applyConflictResolution(
  cwd: string, proposal: IssuedConflictProposal, accepted: string[], locale?: Locale
): Promise<ConflictApplyResult> {
  const language = normalizeLocale(locale);
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  if (!Array.isArray(accepted) || !accepted.length) throw new Error(localized(language, "No hay ninguna resolución que aplicar.", "There is no resolution to apply."));
  if (accepted.some((path) => typeof path !== "string") || new Set(accepted).size !== accepted.length) {
    throw new Error(localized(language, "La resolución no es válida.", "The resolution is invalid."));
  }
  const missing = accepted.find((path) => !proposal.resolutions.some((resolution) => resolution.path === path));
  if (missing) throw new Error(localized(language, `${missing} no forma parte de esta propuesta.`, `${missing} is not part of this proposal.`));
  const chosen = proposal.resolutions.filter((resolution) => accepted.includes(resolution.path));
  for (const resolution of chosen) {
    if (/^(<{7}|={7}|>{7})/m.test(resolution.content)) throw new Error(localized(language, `${resolution.path} todavía contiene marcas de conflicto.`, `${resolution.path} still contains conflict markers.`));
    const absolute = resolve(repoRoot, resolution.path);
    if (!absolute.startsWith(`${repoRoot}${sep}`)) throw new Error(localized(locale, "La ruta no pertenece a este repositorio.", "The path does not belong to this repository."));
  }
  const untouched = (status: "changed" | "not_applied", changed = new Set<string>()) => chosen.map((resolution) => ({
    path: resolution.path, status: changed.has(resolution.path) ? "changed" as const : status
  }));

  if (proposal.repoPath !== repoRoot) {
    return { snapshot: await getSnapshot(repoRoot), complete: false, stale: "repository", outcomes: untouched("not_applied") };
  }
  if (await conflictOperation(repoRoot) !== proposal.binding.operation) {
    return { snapshot: await getSnapshot(repoRoot), complete: false, stale: "operation", outcomes: untouched("changed") };
  }
  const stages = await unmergedStages(repoRoot);
  const reviewedNow = (path: string) => {
    const reviewed = proposal.binding.files[path];
    return Boolean(reviewed?.stages) && stages.get(path) === reviewed.stages &&
      contentVersion(readIfPresent(resolve(repoRoot, path))) === reviewed.content;
  };
  const changed = new Set(chosen.filter((resolution) => !reviewedNow(resolution.path)).map((resolution) => resolution.path));
  if (changed.size) {
    return { snapshot: await getSnapshot(repoRoot), complete: false, stale: "files", outcomes: untouched("not_applied", changed) };
  }

  // Everything still matches the review. Write and stage one file at a time, and stop at the first
  // failure: what was applied stays applied and is reported as such, the file that failed is put back
  // as it was, and the rest is left alone for another try.
  const outcomes: ConflictFileOutcome[] = [];
  for (const resolution of chosen) {
    const absolute = resolve(repoRoot, resolution.path);
    const original = readIfPresent(absolute);
    // The last look before writing: an editor can still save between the check above and here.
    if (contentVersion(original) !== proposal.binding.files[resolution.path].content) {
      outcomes.push({ path: resolution.path, status: "changed" });
      break;
    }
    let failure: string | undefined;
    try {
      writeFileSync(absolute, resolution.content, "utf8");
      const staged = await runGit(repoRoot, ["add", "--", resolution.path]);
      if (staged.code !== 0) failure = staged.stderr.trim() || staged.stdout.trim() || `git add -- ${resolution.path}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure === undefined) {
      outcomes.push({ path: resolution.path, status: "applied" });
      continue;
    }
    let restored = false;
    try {
      if (original) writeFileSync(absolute, original);
      restored = contentVersion(readIfPresent(absolute)) === proposal.binding.files[resolution.path].content;
    } catch { /* reported below: the file may now hold the proposed content */ }
    outcomes.push({ path: resolution.path, status: "failed", restored, detail: failure });
    break;
  }
  for (const resolution of chosen.slice(outcomes.length)) outcomes.push({ path: resolution.path, status: "not_applied" });
  return {
    snapshot: await getSnapshot(repoRoot),
    complete: outcomes.every((outcome) => outcome.status === "applied"),
    outcomes
  };
}

/**
 * A plan that stopped part-way used to be the end of the conversation: the repository was left holding
 * a half-finished job and the model never heard about it. Now the failure goes back as structured
 * detail so it can plan from where the repository actually is.
 */
export async function planRecovery(cwd: string, failure: ExecutionFailure, context: ConversationMessage[] = [], locale?: Locale): Promise<ActionPlan> {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  if (!isLlmConfigured()) return bindPlan(snapshot, refused(llmRequired(language)));
  const issues: PlanIssue[] = [
    { field: "execution.command", problem: `"${failure.command}" failed: ${failure.error}` },
    ...(failure.skipped.length ? [{ field: "execution.skipped", problem: `these steps never ran: ${failure.skipped.join("; ")}` }] : [])
  ];
  try {
    const plan = await requestPlan(RECOVERY_REQUEST, snapshot, context, issues);
    return bindPlan(snapshot, await draftFromPlan(plan, snapshot, RECOVERY_REQUEST, context, language));
  } catch (error) {
    return bindPlan(snapshot, refused(localized(language, `No pude consultar el proveedor LLM: ${error instanceof Error ? error.message : "error desconocido"}`, `I could not query the LLM provider: ${error instanceof Error ? error.message : "unknown error"}`), "llm"));
  }
}

const RECOVERY_REQUEST =
  "The plan just stopped part-way and left the repository as the state below describes. Work out how to continue from exactly there and propose the next step, or explain what the user has to decide first. Answer in the language of their last message.";

/** Every interpretation of what the user wrote happens in the model; this layer only validates. */
export async function planAction(cwd: string, request: string, context: ConversationMessage[] = [], locale?: Locale): Promise<ActionPlan> {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  if (!isLlmConfigured()) return bindPlan(snapshot, refused(llmRequired(language)));
  if (!request.trim()) return bindPlan(snapshot, refused(localized(language, "Escribe tu solicitud para el asistente.", "Write your request to the assistant.")));
  try {
    const plan = await requestPlan(request, snapshot, context);
    return bindPlan(snapshot, await draftFromPlan(plan, snapshot, request, context, language));
  } catch (error) {
    return bindPlan(snapshot, refused(localized(language, `No pude consultar el proveedor LLM: ${error instanceof Error ? error.message : "error desconocido"}`, `I could not query the LLM provider: ${error instanceof Error ? error.message : "unknown error"}`), "llm"));
  }
}

/**
 * What a free-form command costs, on the app's word: these subcommands only read — they leave the
 * working tree, the history and everything published untouched — so they are "low" and may run
 * unattended. Anything else is "high" and always waits for confirmation. "reflog" stays out:
 * "reflog expire" rewrites, so the subcommand alone does not prove read-only.
 */
const readOnlyGitSubcommands = new Set([
  "blame", "describe", "diff", "grep", "log", "ls-files", "ls-remote", "rev-list", "rev-parse", "shortlog", "show", "status"
]);

/** A step that leaves the repository exactly as it found it can run without asking. */
function isUnattended(step: PlanStep) {
  const argv = step.argv ?? [];
  if (step.operation === "git_command") return argv.length > 0 && readOnlyGitSubcommands.has(argv[0]);
  return unattendedOperations.has(step.operation);
}

function operationDraft(operation: Operation, args: Record<string, string>, snapshot?: RepoSnapshot, argv: string[] = [], locale: Locale = "es"): PlanDraft {
  const details: Partial<Record<Operation, [string, string, ActionPlan["risk"]]>> = {
    status: [localized(locale, "Actualizar la vista del repositorio", "Refresh the repository view"), localized(locale, "Lee el estado actual sin modificar archivos.", "Reads the current state without changing files."), "low"],
    checkout: [localized(locale, `Cambiar a ${args.name}`, `Switch to ${args.name}`), localized(locale, "Cambia la rama activa conservando los cambios locales compatibles.", "Switches the active branch while preserving compatible local changes."), "medium"],
    create_branch: [localized(locale, `Crear y cambiar a ${args.name}`, `Create and switch to ${args.name}`), args.from
      ? localized(locale, `Crea una rama local que empieza en el commit ${args.from.slice(0, 7)} y cambia a ella. Los cambios sin guardar te acompañan si no chocan.`, `Creates a local branch that starts at commit ${args.from.slice(0, 7)} and switches to it. Uncommitted changes come along when they do not clash.`)
      : localized(locale, "Crea una rama local desde HEAD.", "Creates a local branch from HEAD."), "medium"],
    delete_branch: [localized(locale, `Eliminar la rama ${args.name}`, `Delete branch ${args.name}`), localized(locale, "Elimina una rama local ya integrada.", "Deletes an already-merged local branch."), "high"],
    rename_branch: [localized(locale, `Renombrar ${args.name} a ${args.to}`, `Rename ${args.name} to ${args.to}`), localized(locale, "Cambia el nombre de una rama local. No toca su historia ni la rama remota.", "Renames a local branch. It does not change its history or the remote branch."), "medium"],
    fetch: [localized(locale, "Actualizar referencias remotas", "Update remote references"), localized(locale, "Descarga referencias y elimina remotas obsoletas.", "Downloads references and prunes stale remote-tracking branches."), "low"],
    pull: [localized(locale, "Actualizar la rama actual", "Update the current branch"), localized(locale, "Usa pull --ff-only para evitar merges implícitos.", "Uses pull --ff-only to avoid implicit merges."), "high"],
    push: args.noVerify === "true"
      ? [localized(locale, "Publicar la rama actual omitiendo las verificaciones", "Publish the current branch without verification"), localized(locale, "Envía los commits al upstream configurado con --no-verify: los hooks pre-push no se ejecutan.", "Pushes commits to the configured upstream with --no-verify: pre-push hooks do not run."), "high"]
      : [localized(locale, "Publicar la rama actual", "Publish the current branch"), localized(locale, "Envía los commits al upstream configurado.", "Pushes commits to the configured upstream."), "high"],
    merge: [localized(locale, `Fusionar ${args.name}`, `Merge ${args.name}`), localized(locale, "Integra la rama seleccionada en la rama actual.", "Integrates the selected branch into the current branch."), "high"],
    rebase: [localized(locale, `Rebase sobre ${args.onto}`, `Rebase onto ${args.onto}`), localized(locale, "Reescribe la base de la rama actual.", "Rewrites the base of the current branch."), "high"],
    abort_operation: [localized(locale, `Abortar ${args.pendingLabel ?? "la operación"}`, `Abort ${args.pendingLabel ?? "the operation"}`), localized(locale, "Deshace el trabajo a medias y devuelve el repositorio a como estaba antes de empezar.", "Discards the half-finished work and returns the repository to how it was before it started."), "high"],
    continue_operation: [localized(locale, `Continuar ${args.pendingLabel ?? "la operación"}`, `Continue ${args.pendingLabel ?? "the operation"}`), localized(locale, "Sigue desde donde se detuvo, una vez resueltos los conflictos.", "Continues from where it stopped after conflicts are resolved."), "high"],
    skip_operation: [localized(locale, `Saltar el commit atascado de ${args.pendingLabel ?? "la operación"}`, `Skip the stuck commit from ${args.pendingLabel ?? "the operation"}`), localized(locale, "Descarta el commit en el que se atascó y sigue con el resto.", "Discards the stuck commit and continues with the rest."), "high"],
    resolve_conflict: [localized(locale, `Resolver ${args.path} quedándose con ${args.side === "theirs" ? "el otro lado" : args.side === "ours" ? "nuestro lado" : "el archivo tal cual está"}`, `Resolve ${args.path} by keeping ${args.side === "theirs" ? "the other side" : args.side === "ours" ? "our side" : "the file as it is"}`), localized(locale, "Marca el conflicto de un archivo como resuelto. No modifica el contenido de ningún archivo.", "Marks a file conflict as resolved. It does not change file content."), "medium"],
    commit: [localized(locale, `Crear commit “${args.message ?? ""}”`, `Create commit “${args.message ?? ""}”`), localized(locale, "Añade todos los cambios y crea un commit.", "Stages all changes and creates a commit."), "high"],
    git_command: [
      localized(locale, `Ejecutar ${buildCommand("git_command", {}, argv)}`, `Run ${buildCommand("git_command", {}, argv)}`),
      localized(locale, "Comando Git propuesto por el asistente: se ejecuta tal cual, sin shell, y solo tras tu confirmación.", "Git command proposed by the assistant: it runs as-is, without a shell, only after your confirmation."),
      argv.length && readOnlyGitSubcommands.has(argv[0]) ? "low" : "high"
    ]
  };
  const detail = details[operation];
  if (!detail || operation === "none") return refused(localized(locale, "La operación solicitada no está permitida.", "The requested operation is not allowed."));
  const steps: PlanStep[] = [{ operation, args, ...(argv.length ? { argv } : {}), command: buildCommand(operation, args, argv), summary: detail[0], risk: detail[2] }];
  return sequenceDraft(steps, detail[1], renameEffects(steps, snapshot));
}

/**
 * A local rename leaves the remote alone: the branch keeps its published name and its upstream link
 * with it. Whoever confirms the plan has to read that beforehand, not discover it on the next push.
 */
function renameEffects(steps: PlanStep[], snapshot?: RepoSnapshot, locale: Locale = "es"): string[] | undefined {
  const effects = snapshot ? steps.flatMap((step) => {
    if (step.operation !== "rename_branch") return [];
    const branch = snapshot.branches.find((item) => item.name === step.args.name);
    return branch?.upstream
      ? [localized(locale, `${step.args.name} sigue publicada como ${branch.upstream}: el renombrado es local y no cambia la rama remota.`, `${step.args.name} remains published as ${branch.upstream}: the rename is local and does not change the remote branch.`)]
      : [];
  }) : [];
  return effects.length ? effects : undefined;
}

/**
 * Assembles the steps into the single plan the user approves. The plan speaks for the whole sequence:
 * its risk is the highest of its steps and its command line shows every one of them in order.
 */
function sequenceDraft(steps: PlanStep[], rationale: string, effects?: string[], locale: Locale = "es"): PlanDraft {
  const risk = steps.reduce<ActionPlan["risk"]>((worst, step) => highestRisk(worst, step.risk), "low");
  return {
    allowed: true,
    steps,
    ...(effects ? { effects } : {}),
    operation: steps[0].operation,
    args: steps[0].args,
    command: steps.map((step) => step.command).join(" && "),
    summary: steps.length === 1 ? steps[0].summary : steps.map((step) => step.summary).join(localized(locale, ", luego ", ", then ")),
    rationale,
    risk,
    requiresConfirmation: steps.some((step) => !isUnattended(step)),
    kind: "plan",
    source: "guardrail"
  };
}

/** A step the model asked for, described and priced by the deterministic table above. */
function stepFrom(operation: Operation, args: Record<string, string>, argv: string[] = [], locale: Locale = "es"): PlanStep | undefined {
  const draft = operationDraft(operation, args, undefined, argv, locale);
  return draft.allowed ? draft.steps[0] : undefined;
}

/**
 * A commit nobody dictated a message for. The diff is right there, so the app writes the message
 * itself instead of stopping to ask for something it can read, and the card shows what it wrote
 * before anything is committed.
 */
async function writeCommitMessages(steps: PlanStep[], snapshot: RepoSnapshot, locale: Locale = "es"): Promise<PlanStep[] | { blocker: string }> {
  const pending = (step: PlanStep) => step.operation === "commit" && !step.args.message?.trim();
  if (!steps.some(pending)) return steps;
  if (!snapshot.changes.length) return { blocker: localized(locale, "No hay cambios locales que confirmar, así que no hay nada de lo que escribir un commit.", "There are no local changes to commit, so there is nothing to write a commit message for.") };
  let message: string;
  try {
    message = await describeChanges(snapshot);
  } catch (error) {
    return { blocker: localized(locale, `No pude escribir el mensaje del commit a partir de los cambios: ${error instanceof Error ? error.message : "error desconocido"}`, `I could not write a commit message from the changes: ${error instanceof Error ? error.message : "unknown error"}`) };
  }
  if (!message) return { blocker: localized(locale, "El proveedor no devolvió un mensaje de commit utilizable a partir de los cambios.", "The provider did not return a usable commit message from the changes.") };
  return steps.map((step) => pending(step) ? stepFrom("commit", { ...step.args, message }, [], locale) ?? step : step);
}

/** Direct controls in the interface: the operation is already known, so no interpretation is needed. */
export async function prepareOperation(cwd: string, operation: Operation, args: Record<string, string> = {}, locale?: Locale) {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  if (operation === "github_create_repo") {
    const preparation = await prepareGithubRepository(snapshot, {
      localPath: args.localPath ?? args.source,
      repository: args.repository ?? args.name,
      owner: args.owner,
      host: args.host,
      protocol: args.protocol === "ssh" || args.protocol === "https" ? args.protocol : undefined,
      push: args.push !== "false",
      remote: args.remote,
      replaceRemote: args.replaceRemote === "true"
    }, "guardrail");
    if ("blockers" in preparation) throw new Error(preparation.blockers.map((blocker) => `${blocker.field}: ${blocker.problem}`).join(" "));
    return bindPlan(snapshot, preparation.draft);
  }
  if (operation === "create_branch" && args.from && /^[0-9a-f]{7,40}$/i.test(args.from)
      && !(await optionalGit(snapshot.path, ["rev-parse", "--verify", "--quiet", `${args.from}^{commit}`]))) {
    throw new Error(localized(language, "Ese commit ya no existe en este repositorio.", "That commit no longer exists in this repository."));
  }
  const draft = operationDraft(operation, args, snapshot, [], language);
  if (draft.allowed) validateExecution(bindPlan(snapshot, draft), snapshot, language);
  return bindPlan(snapshot, draft);
}

/** Explicit workflow: save all reviewed files on the current branch, optionally integrate locally. */
export async function prepareBranchDelivery(cwd: string, request: { stateId: string; mergeToDefault: boolean; message?: string }, locale?: Locale) {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  const fail = (es: string, en: string): never => { throw new Error(localized(language, es, en)); };
  if (snapshot.stateId !== request.stateId) fail("Los archivos o las ramas cambiaron. Revisa los cambios de nuevo antes de guardar.", "Files or branches changed. Review the changes again before saving.");
  if (snapshot.pending || snapshot.conflicts.length) fail("Resuelve la operación pendiente antes de guardar e integrar. Tus archivos siguen disponibles.", "Resolve the pending operation before saving and integrating. Your files remain available.");
  const source = snapshot.branches.find((branch) => branch.isCurrent);
  if ((!source && snapshot.head) || snapshot.currentBranch === "HEAD") fail("Cambia a una rama antes de guardar este trabajo.", "Switch to a branch before saving this work.");
  const target = snapshot.defaultBranch;
  if (request.mergeToDefault) {
    if (!target || target === snapshot.currentBranch) fail("Elige una rama de trabajo distinta de la principal para integrar cambios.", "Choose a work branch different from the main branch to integrate changes.");
    const destination = snapshot.branches.find((branch) => branch.name === target);
    if (!destination || destination.presence === "remote") fail("La rama principal debe existir en este equipo antes de integrar.", "The main branch must exist on this computer before integrating.");
    if (destination?.checkedOutIn) fail(`La rama ${target} está abierta en otro worktree. Guarda primero o continúa allí.`, `Branch ${target} is open in another worktree. Save first or continue there.`);
    if (!snapshot.isDirty) {
      const plan = await prepareMergeToDefault(cwd, snapshot.currentBranch, locale);
      if (plan.stateId !== request.stateId) fail("El repositorio cambió. Revisa el plan de nuevo.", "The repository changed. Review the plan again.");
      return plan;
    }
  }
  if (!snapshot.changes.length) fail("No hay archivos pendientes que guardar.", "There are no pending files to save.");
  const commit = stepFrom("commit", { message: request.message?.trim() ?? "" }, [], language)!;
  const steps = [commit];
  if (request.mergeToDefault) {
    steps.push(stepFrom("checkout", { name: target! }, [], language)!);
    steps.push(stepFrom("merge", { name: snapshot.currentBranch }, [], language)!);
  }
  const effects = [localized(language,
    `Se guardarán todos los ${snapshot.changes.length} archivos listados, incluidos los nuevos, en ${snapshot.currentBranch}.`,
    `All ${snapshot.changes.length} listed files, including new files, will be saved on ${snapshot.currentBranch}.`),
    localized(language, "La operación es local: no publica cambios ni elimina tu rama.", "This is local: it does not publish changes or delete your branch.")];
  if (request.mergeToDefault) effects.push(localized(language,
    `Al terminar estarás en ${target}. Si hay conflictos, la integración se detendrá y el commit guardado seguirá en ${snapshot.currentBranch}.`,
    `You will finish on ${target}. If conflicts occur, integration stops and the saved commit remains on ${snapshot.currentBranch}.`));
  const draft = sequenceDraft(steps, request.mergeToDefault ? localized(language, "Guarda el trabajo revisado antes de integrarlo.", "Saves the reviewed work before integrating it.") : localized(language, "Crea una versión local del trabajo revisado en tu rama.", "Creates a local saved version of the reviewed work on your branch."), effects, language);
  const plan = bindPlan(snapshot, { ...draft, summary: request.mergeToDefault
    ? localized(language, `Guardar e integrar en ${target}`, `Save and integrate into ${target}`)
    : localized(language, `Guardar cambios en ${snapshot.currentBranch}`, `Save changes on ${snapshot.currentBranch}`) });
  validateExecution(plan, snapshot, language);
  return plan;
}

/** A branch-row action with a known target: switch to the repository default, then merge the branch. */
export async function prepareMergeToDefault(cwd: string, branchName: string, locale?: Locale) {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  const target = snapshot.defaultBranch;
  const name = branchName.trim();
  if (!target) throw new Error(localized(language, "No se pudo determinar la rama por defecto de este repositorio.", "Could not determine this repository's default branch."));
  if (snapshot.isDirty) throw new Error(localized(language, "Hay cambios locales sin confirmar. El asistente debe revisarlos antes de fusionar esta rama.", "There are uncommitted local changes. The assistant must review them before merging this branch."));
  if (!name || !isBranchNameSafe(name)) throw new Error(localized(language, "Nombre de rama no válido.", "Invalid branch name."));
  if (name === target) throw new Error(localized(language, `No puedes fusionar ${name} consigo misma.`, `You cannot merge ${name} into itself.`));
  const branch = snapshot.branches.find((item) => item.name === name);
  if (!branch) throw new Error(localized(language, `La rama ${name} no existe localmente.`, `Branch ${name} does not exist locally.`));
  if (branch.presence === "remote") throw new Error(localized(language, `La rama ${name} solo existe en el remoto. Cámbiate a ella primero para tenerla en local.`, `Branch ${name} only exists on the remote. Switch to it first to create it locally.`));
  if (branch.mergedInto.includes(target)) {
    return bindPlan(snapshot, refused(localized(language, `La rama ${name} ya está integrada en ${target}; no hay commits pendientes que fusionar.`, `Branch ${name} is already merged into ${target}; there are no pending commits to merge.`), "guardrail", `Nothing to merge: ${name} is already in ${target}`));
  }

  const steps: PlanStep[] = [];
  if (snapshot.currentBranch !== target) {
    const checkout = stepFrom("checkout", { name: target }, [], language);
    if (!checkout) throw new Error(localized(language, `No se pudo preparar el cambio a ${target}.`, `Could not prepare the switch to ${target}.`));
    steps.push(checkout);
  }
  const merge = stepFrom("merge", { name }, [], language);
  if (!merge) throw new Error(localized(language, `No se pudo preparar la fusión de ${name}.`, `Could not prepare the merge of ${name}.`));
  steps.push(merge);

  const draft = sequenceDraft(steps, localized(language, `Integra ${name} en ${target}.`, `Merges ${name} into ${target}.`), undefined, language);
  const plan = bindPlan(snapshot, { ...draft, summary: `Merge ${name} to ${target}` });
  validateExecution(plan, snapshot, language);
  return plan;
}

/**
 * A step against the repository as it stands right now. Every step of a sequence goes through this,
 * including the ones prepared before the earlier steps moved the repository, so nothing runs on a
 * state it was not checked against.
 */
function validateStep(step: PlanStep, snapshot: RepoSnapshot, locale?: Locale) {
  const language = normalizeLocale(locale);
  const { operation, args } = step;
  if (operation === "none" || !allowedOperations.has(operation)) throw new Error(localized(language, "La acción no está permitida.", "The action is not allowed."));
  const branchArg = args.name || args.onto;
  if (branchArg && !isBranchNameSafe(branchArg)) throw new Error(localized(language, "Nombre de rama no válido.", "Invalid branch name."));
  if (args.to && !isBranchNameSafe(args.to)) throw new Error(localized(language, "Nombre de rama no válido.", "Invalid branch name."));
  if (["checkout", "create_branch", "delete_branch", "rename_branch", "merge"].includes(operation) && !args.name) throw new Error(localized(language, "Falta el nombre de la rama.", "The branch name is missing."));
  if (operation === "rebase" && !args.onto) throw new Error(localized(language, "Falta la rama base.", "The base branch is missing."));
  if (operation === "commit" && (!args.message?.trim() || args.message.length > commitMessageLimit)) throw new Error(localized(language, "El mensaje de commit no es válido.", "The commit message is invalid."));
  if (operation === "commit" && !snapshot.changes.length) throw new Error(localized(language, "No hay cambios locales para confirmar.", "There are no local changes to commit."));
  if (operation === "checkout" && !snapshot.branches.some((branch) => branch.name === args.name)) throw new Error(localized(language, `La rama ${args.name} no existe localmente.`, `Branch ${args.name} does not exist locally.`));
  // A start point is a commit hash picked in the graph: only hex, so it can never read as an option.
  if (operation === "create_branch" && args.from !== undefined && !/^[0-9a-f]{7,40}$/i.test(args.from)) throw new Error(localized(language, "El commit de partida no es válido.", "The starting commit is invalid."));
  if (operation === "create_branch" && snapshot.branches.some((branch) => branch.name === args.name)) throw new Error(localized(language, `La rama ${args.name} ya existe.`, `Branch ${args.name} already exists.`));
  if (operation === "delete_branch" && args.name === snapshot.defaultBranch) throw new Error(localized(language, `No puedes borrar la rama por defecto (${snapshot.defaultBranch}).`, `You cannot delete the default branch (${snapshot.defaultBranch}).`));
  if (operation === "delete_branch" && args.name === snapshot.currentBranch) throw new Error(localized(language, "No puedes borrar la rama activa.", "You cannot delete the active branch."));
  // The prefix states the policy: a permanent branch exists to survive exactly this kind of cleanup.
  if (operation === "delete_branch" && isProtectedBranch(args.name)) {
    throw new Error(localized(language, `La rama ${args.name} está protegida por su prefijo: las ramas de ese tipo existen para conservarse.`, `Branch ${args.name} is protected by its prefix: branches of this kind are meant to be kept.`));
  }
  if (operation === "rename_branch") {
    // The default branch is what integration is measured against, so its name is not a detail to change here.
    if (args.name === snapshot.defaultBranch) throw new Error(localized(language, `No puedes renombrar la rama por defecto (${snapshot.defaultBranch}).`, `You cannot rename the default branch (${snapshot.defaultBranch}).`));
    if (!args.to) throw new Error(localized(language, "Falta el nombre nuevo de la rama.", "The new branch name is missing."));
    if (args.to === args.name) throw new Error(localized(language, "El nombre nuevo es el mismo que el actual.", "The new name is the same as the current name."));
    if (snapshot.branches.some((branch) => branch.name === args.to)) throw new Error(localized(language, `La rama ${args.to} ya existe.`, `Branch ${args.to} already exists.`));
    const target = snapshot.branches.find((branch) => branch.name === args.name);
    if (target?.checkedOutIn) throw new Error(localized(language, `La rama ${args.name} está en uso por el worktree ${target.checkedOutIn}.`, `Branch ${args.name} is in use by worktree ${target.checkedOutIn}.`));
  }
  if (["delete_branch", "rename_branch", "merge"].includes(operation) && !snapshot.branches.some((branch) => branch.name === args.name)) throw new Error(localized(language, `La rama ${args.name} no existe localmente.`, `Branch ${args.name} does not exist locally.`));
  // A remote-only branch has no local ref: switching to it creates one, but deleting, renaming or merging it cannot work.
  if (["delete_branch", "rename_branch", "merge", "rebase"].includes(operation)) {
    const target = args.name || args.onto;
    const remoteOnly = snapshot.branches.find((branch) => branch.name === target)?.presence === "remote";
    if (remoteOnly) throw new Error(localized(language, `La rama ${target} solo existe en el remoto. Cámbiate a ella primero para tenerla en local.`, `Branch ${target} only exists on the remote. Switch to it first to create it locally.`));
  }
  if (operation === "merge" && args.name === snapshot.currentBranch) throw new Error(localized(language, `No puedes fusionar ${args.name} consigo misma.`, `You cannot merge ${args.name} into itself.`));
  if (operation === "rebase" && !snapshot.branches.some((branch) => branch.name === args.onto)) throw new Error(localized(language, `La rama base ${args.onto} no existe localmente.`, `Base branch ${args.onto} does not exist locally.`));
  if (["abort_operation", "continue_operation", "skip_operation"].includes(operation)) {
    if (!snapshot.pending) throw new Error(localized(language, "No hay ninguna operación de Git a medias.", "There is no half-finished Git operation."));
    if (operation === "skip_operation" && !canSkip(snapshot.pending.kind)) {
      throw new Error(localized(language, `Un ${pendingCommands[snapshot.pending.kind]} no puede saltarse un commit; solo continuar o abortar.`, `A ${pendingCommands[snapshot.pending.kind]} cannot skip a commit; only continue or abort.`));
    }
    // Continuing with a conflict still open is what Git refuses anyway, said earlier and in plain words.
    if (operation === "continue_operation" && snapshot.conflicts.length) {
      throw new Error(localized(language, `Todavía quedan ${snapshot.conflicts.length} archivos en conflicto: resuélvelos antes de continuar.`, `${snapshot.conflicts.length} files are still in conflict; resolve them before continuing.`));
    }
  }
  if (operation === "resolve_conflict") {
    if (!snapshot.conflicts.some((conflict) => conflict.path === args.path)) throw new Error(localized(language, `${args.path} no está en conflicto.`, `${args.path} is not in conflict.`));
    if (!["ours", "theirs", "resolved"].includes(args.side)) throw new Error(localized(language, "Hay que decir con qué lado quedarse.", "The side to keep must be specified."));
  }
  if (operation === "git_command") {
    const argv = step.argv ?? [];
    if (!argv.length || argv.some((token) => !token.trim())) throw new Error(localized(language, "El comando Git propuesto no es válido.", "The proposed Git command is invalid."));
    // A free command must not sneak past the protections the structured delete carries.
    for (const name of gitBranchDeletions(argv)) {
      if (!isBranchNameSafe(name)) throw new Error(localized(language, "Nombre de rama no válido.", "Invalid branch name."));
      if (name === snapshot.defaultBranch) throw new Error(localized(language, `No puedes borrar la rama por defecto (${snapshot.defaultBranch}).`, `You cannot delete the default branch (${snapshot.defaultBranch}).`));
      if (name === snapshot.currentBranch) throw new Error(localized(language, "No puedes borrar la rama activa.", "You cannot delete the active branch."));
      if (isProtectedBranch(name)) {
        throw new Error(localized(language, `La rama ${name} está protegida por su prefijo: las ramas de ese tipo existen para conservarse.`, `Branch ${name} is protected by its prefix: branches of this kind are meant to be kept.`));
      }
    }
  }
}

/** The plan as issued: it must belong to this repository, and the repository must not have moved under it. */
function validateExecution(plan: ActionPlan, snapshot: RepoSnapshot, locale?: Locale) {
  const language = normalizeLocale(locale);
  if (!plan.allowed || !plan.steps.length) throw new Error(localized(language, "La acción no está permitida.", "The action is not allowed."));
  if (plan.answer) throw new Error(localized(language, "Las consultas informativas no se ejecutan como operaciones Git.", "Informational questions are not executed as Git operations."));
  if (plan.repoPath !== snapshot.path) throw new Error(localized(language, "El plan pertenece a otro repositorio.", "The plan belongs to another repository."));
  if (plan.head !== snapshot.head) throw new Error(localized(language, "El repositorio cambió desde que se preparó el plan. Prepara la acción de nuevo.", "The repository changed after this plan was prepared. Prepare the action again."));
  if (plan.stateId !== snapshot.stateId) throw new Error(localized(language, "Los cambios locales variaron desde que se preparó el plan. Prepara la acción de nuevo.", "Local changes moved after this plan was prepared. Prepare the action again."));
  validateStep(plan.steps[0], snapshot, language);
}

function validateGithubPlan(plan: ActionPlan, locale?: Locale) {
  const language = normalizeLocale(locale);
  const { name, owner, host, protocol, sshHost, remoteUrl, visibility, source, remote, push, replaceRemote, account, activeAccount } = plan.args;
  if (!repositoryNamePattern.test(name ?? "") || !repositoryOwnerPattern.test(owner ?? "") || !repositoryHostPattern.test(host ?? "") || !["ssh", "https"].includes(protocol) ||
      visibility !== "private" || !remoteNamePattern.test(remote ?? "") || !["true", "false"].includes(push) || !["true", "false"].includes(replaceRemote)) {
    throw new Error(localized(language, "El plan de creación de GitHub contiene argumentos no válidos.", "The GitHub creation plan contains invalid arguments."));
  }
  if (!repositoryOwnerPattern.test(account ?? "") || !repositoryOwnerPattern.test(activeAccount ?? "")) throw new Error(localized(language, "La cuenta de GitHub del plan no es válida.", "The GitHub account in the plan is invalid."));
  if (protocol === "ssh" ? !sshHostPattern.test(sshHost ?? "") : sshHost !== "") throw new Error(localized(language, "El host SSH del plan no es válido.", "The SSH host in the plan is invalid."));
  if (!source || resolve(source) !== plan.targetPath) throw new Error(localized(language, "La ruta de origen del plan no es válida.", "The plan's source path is invalid."));
  if (!plan.repositoryPlan) throw new Error(localized(language, "Falta el plan JSON verificable del repositorio.", "The repository's verifiable JSON plan is missing."));
  assertRepositoryPlan(plan.repositoryPlan);
  if (plan.repositoryPlan.remoteUrl !== remoteUrl || plan.repositoryPlan.localPath !== source) throw new Error(localized(language, "El plan JSON no coincide con los argumentos de ejecución.", "The JSON plan does not match the execution arguments."));
}

async function executeGithubRepositoryPlan(plan: ActionPlan, locale?: Locale) {
  const language = normalizeLocale(locale);
  validateGithubPlan(plan, language);
  const source = realpathSync(plan.args.source);
  const snapshot = await getSnapshot(source);
  if (snapshot.path !== plan.targetPath || snapshot.head !== plan.targetHead || snapshot.stateId !== plan.targetStateId) {
    throw new Error(localized(language, "El repositorio de origen cambió desde la validación. Prepara la acción de nuevo.", "The source repository changed after validation. Prepare the action again."));
  }
  if (plan.args.push === "true" && !snapshot.head) throw new Error(localized(language, "No hay commits locales que publicar.", "There are no local commits to publish."));
  const ghVersion = await runCommand("gh", ["--version"], source, 10_000, { GH_PROMPT_DISABLED: "1" }).catch(() => undefined);
  if (!ghVersion || ghVersion.code !== 0) throw new Error(localized(language, "GitHub CLI (gh) ya no está instalado o disponible en PATH.", "GitHub CLI (gh) is no longer installed or available on PATH."));
  const accounts = await ghAccounts(plan.args.host, source);
  if (!findAccount(accounts, plan.args.account)) throw new Error(localized(language, `La cuenta ${plan.args.account} ya no está autenticada en ${plan.args.host}.`, `Account ${plan.args.account} is no longer authenticated on ${plan.args.host}.`));
  if (plan.args.protocol === "ssh") {
    const identity = await sshIdentity(plan.args.sshHost, source);
    if (!identity.authenticated) throw new Error(localized(language, `SSH ya no autentica contra ${plan.args.sshHost}: ${identity.output.slice(0, 200)}`, `SSH no longer authenticates against ${plan.args.sshHost}: ${identity.output.slice(0, 200)}`));
    if (identity.login && identity.login.toLowerCase() !== plan.args.owner.toLowerCase()) {
      throw new Error(localized(language, `${plan.args.sshHost} ahora autentica como ${identity.login}, no como ${plan.args.owner}.`, `${plan.args.sshHost} now authenticates as ${identity.login}, not ${plan.args.owner}.`));
    }
  }
  const existing = await runCommand("gh", ["api", `repos/${plan.args.owner}/${plan.args.name}`, "--silent"], source, 20_000, { GH_PROMPT_DISABLED: "1", GH_HOST: plan.args.host });
  if (existing.code === 0) throw new Error(localized(language, `El repositorio ${plan.args.owner}/${plan.args.name} ya existe.`, `Repository ${plan.args.owner}/${plan.args.name} already exists.`));
  if (!/HTTP 404|not found/i.test(`${existing.stderr}\n${existing.stdout}`)) throw new Error(localized(language, "No se pudo confirmar que el repositorio remoto siga disponible.", "Could not confirm that the remote repository is still available."));

  const currentRemote = await runGit(source, ["remote", "get-url", plan.args.remote]);
  if (currentRemote.code === 0 && plan.args.replaceRemote !== "true") throw new Error(localized(language, `El remoto “${plan.args.remote}” existe y no se autorizó reemplazarlo.`, `Remote “${plan.args.remote}” exists and replacing it was not authorized.`));
  if (currentRemote.code === 0 && createHash("sha256").update(currentRemote.stdout.trim()).digest("hex") !== plan.args.existingRemoteHash) throw new Error(localized(language, `El remoto “${plan.args.remote}” cambió desde la validación.`, `Remote “${plan.args.remote}” changed after validation.`));
  const previousRemoteUrl = currentRemote.code === 0 ? currentRemote.stdout.trim() : "";
  if (currentRemote.code === 0) await checkedGit(source, ["remote", "remove", plan.args.remote]);

  // gh has no per-command account flag, so the active one is switched and restored around the work.
  const switching = plan.args.account !== plan.args.activeAccount;
  if (switching) await checkedGh(["auth", "switch", "--hostname", plan.args.host, "--user", plan.args.account], source);

  let repositoryCreated = false;
  try {
    const createOutput = await checkedGh(["repo", "create", `${plan.args.owner}/${plan.args.name}`, "--private"], source, plan.args.host);
    repositoryCreated = true;
    await checkedGit(source, ["remote", "add", plan.args.remote, plan.args.remoteUrl]);
    const pushOutput = plan.args.push === "true" ? await checkedGit(source, ["push", "-u", plan.args.remote, "HEAD"]) : "";
    // The user confirmed it and it worked: this is the moment the choice becomes worth remembering.
    const now = new Date().toISOString();
    saveMemory(rememberRepository(
      rememberIdentity(memory, plan.args.host, plan.args.owner, {
        account: plan.args.account,
        ...(plan.args.protocol === "ssh" ? { sshHost: plan.args.sshHost } : {})
      }, now),
      source,
      { host: plan.args.host, owner: plan.args.owner, protocol: plan.args.protocol as GitProtocol, remote: plan.args.remote },
      now
    ));
    return [createOutput, pushOutput].filter(Boolean).join("\n");
  } catch (error) {
    const createdRemote = await runGit(source, ["remote", "get-url", plan.args.remote]);
    if (createdRemote.code === 0) await checkedGit(source, ["remote", "remove", plan.args.remote]).catch(() => undefined);
    if (currentRemote.code === 0) await checkedGit(source, ["remote", "add", plan.args.remote, previousRemoteUrl]).catch(() => undefined);
    const message = error instanceof Error ? error.message : localized(language, "gh no pudo crear el repositorio.", "gh could not create the repository.");
    if (repositoryCreated) throw new Error(localized(language, `El repositorio remoto se creó, pero no se pudo configurar o publicar el remoto local: ${message}`, `The remote repository was created, but the local remote could not be configured or published: ${message}`), { cause: error });
    if (/forbidden|permission|not accessible|403/i.test(message)) throw new Error(localized(language, "No hay permisos suficientes para crear el repositorio privado solicitado.", "You do not have enough permission to create the requested private repository."), { cause: error });
    throw error;
  } finally {
    if (switching) {
      await checkedGh(["auth", "switch", "--hostname", plan.args.host, "--user", plan.args.activeAccount], source)
        .catch(() => console.error(`No se pudo restaurar la cuenta activa de gh a ${plan.args.activeAccount}.`));
    }
  }
}

async function runStep(cwd: string, step: PlanStep, plan: ActionPlan, snapshot: RepoSnapshot, locale?: Locale): Promise<string> {
  const { args } = step;
  switch (step.operation) {
    case "status": return "";
    case "checkout": return reportedGit(cwd, ["switch", args.name]);
    case "create_branch": return reportedGit(cwd, ["switch", "-c", args.name, ...(args.from ? [args.from] : [])]);
    case "delete_branch": return reportedGit(cwd, ["branch", "-d", "--", args.name]);
    // "-m" and never "-M": Git must refuse when the new name is taken, rather than overwrite a branch.
    case "rename_branch": return reportedGit(cwd, ["branch", "-m", "--", args.name, args.to]);
    case "fetch": return reportedGit(cwd, ["fetch", "--prune"]);
    case "pull": return reportedGit(cwd, ["pull", "--ff-only"]);
    case "push": return reportedGit(cwd, args.noVerify === "true" ? ["push", "--no-verify"] : ["push"]);
    case "merge": return reportedGit(cwd, ["merge", "--no-edit", "--", args.name]);
    case "rebase": return reportedGit(cwd, ["rebase", args.onto]);
    case "abort_operation": return reportedGit(cwd, [pendingCommands[snapshot.pending!.kind], "--abort"]);
    case "continue_operation": return reportedGit(cwd, [pendingCommands[snapshot.pending!.kind], "--continue"]);
    case "skip_operation": return reportedGit(cwd, [pendingCommands[snapshot.pending!.kind], "--skip"]);
    case "resolve_conflict": return runResolveConflict(cwd, args, snapshot, locale);
    case "commit":
      await checkedGit(cwd, ["add", "-A"]);
      return reportedGit(cwd, ["commit", "-m", args.message]);
    case "git_command": return reportedGit(cwd, step.argv ?? []);
    case "github_create_repo": return executeGithubRepositoryPlan(plan, locale);
    default: throw new Error(localized(locale, "La acción no está permitida.", "The action is not allowed."));
  }
}

/** What the user reads afterwards. A single step keeps Git's own words; a sequence is listed step by step. */
function executionReport(outcomes: StepOutcome[], locale: Locale = "es") {
  if (outcomes.length === 1) return outcomes[0].output.trim();
  return outcomes.map((outcome) => {
    const mark = outcome.status === "completed" ? "✓" : outcome.status === "failed" ? "✗" : "·";
    const detail = outcome.status === "skipped" ? localized(locale, "sin ejecutar", "not run") : outcome.output.trim();
    return `${mark} ${outcome.summary}${detail ? `\n${detail}` : ""}`;
  }).join("\n");
}

/**
 * A sequence that stops halfway needs to say where it stopped, because the repository is now in a
 * state the user did not have before and did not fully ask for either.
 */
function explainGitFailure(command: string, detail: string, snapshot: RepoSnapshot, locale?: Locale) {
  const language = normalizeLocale(locale);
  if (/git push(?:\s|$)/i.test(command) && /has no upstream branch|no upstream branch/i.test(detail)) {
    const branch = snapshot.currentBranch === "HEAD"
      ? localized(language, "esta rama", "this branch")
      : localized(language, `la rama “${snapshot.currentBranch}”`, `branch “${snapshot.currentBranch}”`);
    if (snapshot.remotes.length) {
      return localized(language,
        `${branch} todavía no está publicada ni tiene un destino remoto asociado. Tus commits siguen a salvo en este equipo. Puedes publicarla en ${snapshot.remotes[0]} para que Git recuerde el destino, o dejarla local y continuar trabajando sin subirla.`,
        `${branch} is not published yet and has no remote destination. Your commits are safe on this machine. You can publish it to ${snapshot.remotes[0]} so Git remembers the destination, or leave it local and continue working without pushing.`);
    }
    return localized(language,
      `${branch} todavía no está publicada y este repositorio no tiene un remoto configurado. Tus commits siguen a salvo en este equipo. Puedes conectar un remoto cuando quieras publicarla, o continuar trabajando solo localmente.`,
      `${branch} is not published yet and this repository has no configured remote. Your commits are safe on this machine. You can connect a remote when you want to publish it, or continue working locally.`);
  }
  if (/git push(?:\s|$)/i.test(command) && /No configured push destination|specify a remote repository/i.test(detail)) {
    const branch = snapshot.currentBranch === "HEAD"
      ? localized(language, "esta rama", "this branch")
      : localized(language, `la rama “${snapshot.currentBranch}”`, `branch “${snapshot.currentBranch}”`);
    return localized(language,
      `No hay un repositorio remoto configurado para publicar ${branch}. Tus commits siguen a salvo en este equipo. Puedes conectar un remoto o continuar trabajando solo localmente.`,
      `No remote repository is configured to publish ${branch}. Your commits are safe on this machine. You can connect a remote or continue working locally.`);
  }
  return detail;
}

function failureReport(outcomes: StepOutcome[], failed: StepOutcome, detail: string, snapshot: RepoSnapshot, locale?: Locale) {
  const language = normalizeLocale(locale);
  const explanation = explainGitFailure(failed.command, detail, snapshot, language);
  if (outcomes.length === 1) return explanation;
  const done = outcomes.filter((outcome) => outcome.status === "completed").length;
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped");
  const tail = skipped.length
    ? localized(language, ` No se ejecutó: ${skipped.map((outcome) => outcome.summary).join(", ")}.`, ` Not run: ${skipped.map((outcome) => outcome.summary).join(", ")}.`)
    : "";
  return localized(language,
    `Se completaron ${done} de ${outcomes.length} pasos. Falló «${failed.summary}»: ${explanation}${tail}`,
    `${done} of ${outcomes.length} steps completed. “${failed.summary}” failed: ${explanation}${tail}`);
}

/**
 * Brings every remote's branches up to date, for Refresh and the quiet background check. Only
 * remote-tracking refs move: local branches, the working tree and anything already published stay
 * exactly as they were, which is why this never needs a plan or a confirmation.
 */
export async function fetchRemotes(cwd: string): Promise<RepoSnapshot> {
  if (await optionalGit(cwd, ["remote"])) await reportedGit(cwd, ["fetch", "--all", "--prune", "--quiet"]);
  return getSnapshot(cwd);
}

/**
 * Runs the approved plan end to end. Each step is validated against the repository the previous step
 * produced, and the first failure stops the sequence: a half-finished merge must never be reported as
 * done, and the steps that never ran are named so the user knows exactly where things stand.
 */
export async function executePlan(cwd: string, plan: ActionPlan, locale?: Locale): Promise<{ snapshot: RepoSnapshot; output: string; error?: string; outcomes: StepOutcome[] }> {
  const language = normalizeLocale(locale);
  let snapshot = await getSnapshot(cwd);
  validateExecution(plan, snapshot, language);
  const outcomes: StepOutcome[] = plan.steps.map((step) => ({ command: step.command, summary: step.summary, status: "skipped", output: "" }));

  for (const [index, step] of plan.steps.entries()) {
    try {
      if (index > 0) {
        snapshot = await getSnapshot(cwd);
        validateStep(step, snapshot, language);
      }
      outcomes[index] = { ...outcomes[index], status: "completed", output: await runStep(cwd, step, plan, snapshot, language) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : localized(language, "Git no pudo completar la acción.", "Git could not complete the action.");
      outcomes[index] = { ...outcomes[index], status: "failed", output: detail };
      const failedSnapshot = await getSnapshot(cwd);
      return {
        snapshot: failedSnapshot,
        output: executionReport(outcomes, language),
        error: failureReport(outcomes, outcomes[index], detail, failedSnapshot, language),
        outcomes
      };
    }
  }
  return { snapshot: await getSnapshot(cwd), output: executionReport(outcomes, language), outcomes };
}

function settingsPath() { return join(app.getPath("userData"), "gitcat-settings.json"); }

export function loadLlmConfig() {
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), "utf8")) as { model?: string; encryptedApiKey?: string };
    llmState.model = saved.model || MODEL_FALLBACK;
    if (saved.encryptedApiKey && safeStorage.isEncryptionAvailable()) llmState.apiKey = safeStorage.decryptString(Buffer.from(saved.encryptedApiKey, "base64"));
  } catch { /* first launch */ }
}

export function getLlmConfig(): LlmConfig {
  return { provider: "openai", model: llmState.model || MODEL_FALLBACK, configured: isLlmConfigured() };
}

/**
 * The credentials are checked against the provider before they are stored: an unusable key or model
 * would otherwise only surface later, as an unexplained refusal inside a conversation.
 */
async function verifyLlmAccess(candidate: LlmConfigInput) {
  try {
    // A 200 proves the key and the model id; the answer itself is irrelevant here.
    await callProvider({ instructions: "Reply with the single word: ok.", input: "ok", max_output_tokens: 1_000 }, 60_000, candidate);
  } catch (error) {
    throw new Error(`No se guardó la configuración porque el proveedor no respondió correctamente. ${error instanceof Error ? error.message : "Error desconocido."}`, { cause: error });
  }
}

export async function saveLlmConfig(input: LlmConfigInput): Promise<LlmConfig> {
  if (!input || typeof input.apiKey !== "string" || typeof input.model !== "string") throw new Error("La configuración no es válida.");
  const nextApiKey = input.clearApiKey ? "" : input.apiKey.trim() || llmState.apiKey;
  const nextModel = input.model.trim() || MODEL_FALLBACK;
  if (nextApiKey && !safeStorage.isEncryptionAvailable()) throw new Error("El almacenamiento seguro no está disponible; la API key no se guardó.");
  if (nextApiKey) await verifyLlmAccess({ apiKey: nextApiKey, model: nextModel });
  llmState = { apiKey: nextApiKey, model: nextModel };
  mkdirSync(app.getPath("userData"), { recursive: true });
  const payload: { model: string; encryptedApiKey?: string } = { model: llmState.model };
  if (llmState.apiKey && safeStorage.isEncryptionAvailable()) payload.encryptedApiKey = safeStorage.encryptString(llmState.apiKey).toString("base64");
  writeFileSync(settingsPath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
  return getLlmConfig();
}
