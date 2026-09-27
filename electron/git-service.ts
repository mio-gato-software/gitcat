import { operationContext, operationCheckpoint, operationPhase, inspectOperation, OperationCancelled } from "./operation-progress.js";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readlinkSync, accessSync, constants, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";
import { safeStorage, app } from "electron";
import { findExecutable, isExecutableFile, pathEntries, wellKnownToolDirectories } from "./executables.js";
import { parseWorktrees } from "./worktrees.js";
import { stackCandidates } from "./stacked-branches.js";
import { parseNameStatus, parseNumstat, parseShortstat } from "./diff-status.js";
import { parseRemoteUrls } from "./remotes.js";
import {
  accountReadiness, authorReadiness, classifyAccess, credentialHelperKind, displayUrl, gitToolState, parseIdentityConfig, parseRemoteAddress,
  redactSecrets, selectRemote
} from "./readiness.js";
import { changePaths, gitignoreLine, isPartlyStaged, isUntracked, resolveSelection, type SelectionProblem } from "../shared/selected-changes.js";
import {
  canSkip, conflictLabels, conflictsFrom, parseRebaseProgress, pendingCommands, resolutionFor
} from "./pending-operation.js";
import {
  buildResolutionInstructions, conflictFileLimit, parseConflictProposal, resolutionResponseFormat, validateProposal
} from "./conflict-resolution.js";
import {
  choicesFor, commandFor, hasConflictMarkers, isBinaryContent, isSpecialMode, parseRenames, parseUnmerged, remainingSteps, renamesFor,
  sideRoles, sideStage, type UnmergedEntry
} from "./conflict-guide.js";
import { isProtectedBranch, lifecycleOf, staleAfterDays } from "../shared/branch-lifecycle.js";
import {
  findAccount, isSshAuthenticated, parseGhAccounts, parseSshGreeting, parseSshResolvedHostName, sshConfigHostAliases
} from "./host-identity.js";
import {
  emptyMemory, forgetSshHost, recallIdentity, recallRepository, recallSharing, relocateRepository, rememberIdentity, rememberRepository,
  rememberSharing, sanitizeMemory, type Memory
} from "./memory.js";
import {
  credentialFindings, isCredentialFile, isExcluded, mayBeCredentialFile, normalizeExclusion, redactText, scanDiff, scanText, withheldPlaceholder,
  type DiffFinding
} from "./outbound-content.js";
import type {
  ActionPlan, AiSharingFile, AiSharingPreview, AiSharingPurpose, Branch, Commit, CommitDetail, Conflict, ConversationMessage, DefaultBranchSource,
  DeliveryRequest, FileChange, GitProtocol, SecretFinding, SecretKind, SelectedChange, WithheldFile,
  ConflictApplyResult, ConflictFileOutcome, ConflictProposal, ConflictChoice, ConflictChoiceOutcome, ConflictChoiceRequest, ConflictChoiceResult,
  ConflictFileVersion, ConflictGuide, ConflictGuideFile, ConflictSideIdentity, ConflictSideId, ExecutionFailure, HistoryPage, HistoryRequest, HistoryScope, LlmConfig, LlmConfigInput, LlmConnectResult, AiConnectionProblem,
  Locale, Operation, PendingOperation, PlanStep, RepoSnapshot, StepOutcome, AssistantUnavailable, RecoveryReport,
  AuthorReadiness, CredentialHelper, IdentityValues, ReadinessReport, ReadinessRequest, RemoteAccess, RemoteProtocol, RemoteReadiness
} from "../shared/types.js";
import { classifyProviderFailure, maskKeys, recommendedModel } from "../shared/ai-connection.js";
import { classifyFailure, operationFromCommand, recoveryActions, recoveryFacts, type FailureEvidence } from "./failure-recovery.js";
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

const MODEL_FALLBACK = recommendedModel;
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const LLM_REQUIRED =
  "Para entender lo que escribes, GitCat necesita un proveedor de IA conectado: esa interpretación la hace solo el modelo, no reglas locales. Conéctalo en Configuración; mientras tanto, todas las acciones de Git funcionan desde los botones.";
const LLM_REQUIRED_EN =
  "To understand what you write, GitCat needs a connected AI provider: only the model interprets requests, never local rules. Connect one in Settings; meanwhile every Git action works from the buttons.";

function llmRequired(locale?: Locale) { return localized(locale, LLM_REQUIRED, LLM_REQUIRED_EN); }
const allowedOperations = new Set<Operation>([...executableOperations, "github_create_repo", "ignore_path", "set_identity", "add_remote", "none"]);
/**
 * Operations that run without asking. The bar is deliberately high: they must leave the working tree,
 * the branch history and everything already published untouched, and running one again must be
 * harmless. Nothing here can lose work, so a confirmation would only be a click in the way.
 */
const unattendedOperations = new Set<Operation>(["status", "fetch"]);

let llmState: LlmConfigInput = { apiKey: "", model: MODEL_FALLBACK };
/** The last request with the saved key that failed, so Settings can say the connection needs a look. */
let llmProblem: AiConnectionProblem | undefined;
/** A key saved on disk that secure storage cannot unlock now. It is kept as it is, never dropped or decoded otherwise. */
let unreadableEncryptedKey: string | undefined;
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

export function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return runCommand("git", args, cwd, timeoutMs);
}

function commandEnv(searchPath: string, extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: searchPath, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", GIT_EDITOR: "true", ...extraEnv };
}

/**
 * A Git process with the same tool lookup and environment as every other command, for the callers
 * that have to read its output as it arrives or stop it part way: a clone, or a count of many files.
 */
export async function spawnGit(cwd: string, args: string[], { extraEnv = {}, group = false }: { extraEnv?: NodeJS.ProcessEnv; group?: boolean } = {}) {
  const executable = await resolveTool("git");
  const searchPath = (await toolDirectories()).join(delimiter);
  // A group of its own lets a stop reach the helpers Git starts too (git-remote-https, ssh), not only Git.
  return spawn(executable, args, { cwd, env: commandEnv(searchPath, extraEnv), stdio: ["ignore", "pipe", "pipe"], detached: group && process.platform !== "win32" });
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs = 60_000, extraEnv: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  const executable = await resolveTool(command);
  const searchPath = (await toolDirectories()).join(delimiter);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: commandEnv(searchPath, extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const active = operationContext();
    let stopped: Error | undefined;
    const stop = (error: Error) => {
      stopped = error;
      const signal = (value: NodeJS.Signals) => {
        try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value); else child.kill(value); } catch { /* already exited */ }
      };
      signal("SIGTERM");
      setTimeout(() => { if (!settled) signal("SIGKILL"); }, 2_000).unref();
    };
    const timer = setTimeout(() => stop(new Error(`${command} ${args[0] ?? ""} timed out. The final repository state must be checked; changes may have completed.`)), timeoutMs);
    const cancel = () => stop(new OperationCancelled());
    const canAbort = active && !active.mutation && !active.inspecting;
    if (canAbort) {
      active.signal.addEventListener("abort", cancel, { once: true });
      if (active.signal.aborted) cancel();
    }
    const cleanup = () => { clearTimeout(timer); if (canAbort) active.signal.removeEventListener("abort", cancel); };
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 2_000_000) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 2_000_000) stderr += chunk.toString(); });
    child.on("error", (error) => { if (!settled) { settled = true; cleanup(); reject(error); } });
    child.on("close", (code) => {
      if (!settled) { settled = true; cleanup(); if (stopped) reject(stopped); else resolvePromise({ stdout, stderr, code: code ?? 1 }); }
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
  const changes: FileChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const xy = record.slice(0, 2);
    const code = xy.trim() || "??";
    const change: FileChange = { code, path: record.slice(3) || record, xy };
    // With -z, a rename or copy is followed by the path it came from, as a record of its own.
    if (code.includes("R") || code.includes("C")) {
      index += 1;
      if (records[index]) change.from = records[index];
    }
    changes.push(change);
  }
  return changes;
}

/** The staged entries of every path, as `ls-files --stage -z` lists them, so each change can be bound to its own. */
function parseStage(raw: string) {
  const entries = new Map<string, string[]>();
  for (const record of raw.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    entries.set(path, [...(entries.get(path) ?? []), record.slice(0, tab)]);
  }
  return entries;
}

/** A pathspec that means this exact path: no glob, no magic, whatever characters the name has. */
function literalPaths(paths: string[]) {
  return paths.map((path) => `:(literal)${path}`);
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

/** The commits a history starts from. They never change, so they identify a repository wherever it is moved. */
export async function rootCommits(cwd: string): Promise<string[]> {
  return (await optionalGit(cwd, ["rev-list", "--max-parents=0", "HEAD"])).split("\n").map((line) => line.trim()).filter(Boolean);
}

/** A project confirmed to be the same repository at a new location keeps its remembered choices. */
export function relocateRepositoryMemory(from: string, to: string) {
  const next = relocateRepository(memory, from, to);
  if (next !== memory) saveMemory(next);
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
  const integration = await countNotIntegrated(repoRoot, head, currentBranch, defaultBranch);
  const pending = await readPendingOperation(repoRoot);
  const changes = parseStatus(statusRaw);
  const stageRaw = await checkedGit(repoRoot, ["ls-files", "--stage", "-z"], true);
  const stage = parseStage(stageRaw);
  // A file can change while keeping exactly the same status code. Bind reviews to its
  // contents, the staged version, the branch refs and checkout, not just "M file.txt".
  const fingerprint = createHash("sha256").update(JSON.stringify([
    head, currentBranch, statusRaw, branchRaw, remoteBranchRaw, pending, [...worktrees], stageRaw
  ]));
  for (const change of changes) {
    // Each change also gets a version of its own: the commit and branch it sits on, its status, the
    // staged entries of every path it occupies and the bytes on disk. A save of selected files is
    // bound to these, so it is not invalidated by edits to files it leaves alone.
    const version = createHash("sha256").update(JSON.stringify([
      head, currentBranch, change.xy, change.path, change.from ?? "", stage.get(change.path) ?? [], change.from ? stage.get(change.from) ?? [] : []
    ]));
    for (const path of change.from ? [change.path, change.from] : [change.path]) {
      const file = resolve(repoRoot, path);
      version.update(`\0${path}\0`);
      try {
        const stat = lstatSync(file);
        version.update(String(stat.mode));
        if (stat.isSymbolicLink()) version.update(readlinkSync(file));
        else if (stat.isFile()) {
          for await (const chunk of createReadStream(file)) version.update(chunk);
        } else if (stat.isDirectory()) version.update(await optionalGit(file, ["rev-parse", "HEAD"]));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        version.update("missing");
      }
    }
    change.version = version.digest("hex");
    fingerprint.update(`${change.path}\0${change.version}\0`);
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
    remoteUrls: parseRemoteUrls(await optionalGit(repoRoot, ["remote", "-v"])),
    ...(integration ? { integration } : {})
  };
}

/**
 * How many saved commits of the current branch the default branch does not have yet, counted by Git
 * rather than read off the graph page, which may not reach far enough back. Absent when there is no
 * branch to compare (detached, unborn, or already on the default branch) or Git could not answer.
 */
async function countNotIntegrated(repoRoot: string, head: string, currentBranch: string, target: string | undefined) {
  if (!target || !head || currentBranch === "HEAD" || currentBranch === target) return undefined;
  const count = Number.parseInt(await optionalGit(repoRoot, ["rev-list", "--count", `${target}..HEAD`, "--"]), 10);
  return Number.isInteger(count) ? { target, notIntegrated: count } : undefined;
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
    case "push": return args.setUpstream
      ? `git push${args.noVerify === "true" ? " --no-verify" : ""} --set-upstream ${args.setUpstream} ${args.branch ?? ""}`.trimEnd()
      : `git push${args.noVerify === "true" ? " --no-verify" : ""}`;
    case "set_identity": {
      const where = args.scope === "global" ? " --global" : "";
      return `git config${where} user.name ${JSON.stringify(args.user ?? "")} && git config${where} user.email ${JSON.stringify(args.email ?? "")}`;
    }
    case "add_remote": return `git remote add ${args.name ?? ""} ${quoteToken(args.url ?? "")}`;
    case "merge": return `git merge --no-edit ${args.name}`;
    case "rebase": return `git rebase ${args.onto}`;
    case "abort_operation": return `git ${args.pending ?? "rebase"} --abort`;
    case "continue_operation": return `git ${args.pending ?? "rebase"} --continue`;
    case "skip_operation": return `git ${args.pending ?? "rebase"} --skip`;
    case "resolve_conflict": return resolveConflictCommand(args);
    case "commit": return `git add -A && git commit -m "${args.message ?? ""}"`;
    case "ignore_path": return `echo ${JSON.stringify(args.line ?? "")} >> .gitignore`;
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

/** The settings files user.name and user.email come from, read the way Git reads them. Without a repository, only this Mac's. */
async function readAuthor(cwd: string | undefined): Promise<AuthorReadiness> {
  const result = await runGit(cwd ?? homedir(), ["config", "--show-scope", "--get-regexp", "^user\\.(name|email)$"], 10_000).catch(() => undefined);
  return authorReadiness(parseIdentityConfig(result?.stdout ?? ""), { repository: Boolean(cwd) });
}

/** Every value of a multi-valued setting, in order. An empty value is kept: for a helper list it means "forget the ones before". */
async function configValues(cwd: string, key: string) {
  const result = await runGit(cwd, ["config", "--get-all", key], 10_000).catch(() => undefined);
  return result?.code === 0 && result.stdout ? result.stdout.replace(/\n$/, "").split("\n") : [];
}

const accessTimeoutMs = 15_000;

/**
 * Reads the remote's branch list with the sign-in this Mac already has, and nothing else: no prompt
 * can appear, a first-time SSH host is not trusted on the person's behalf, and a hang ends as
 * "could not reach". What Git answered is kept with anything shaped like a credential masked.
 */
async function remoteAccess(repoRoot: string, remote: string): Promise<{ access: RemoteAccess; detail?: string }> {
  const ownSsh = (await optionalGit(repoRoot, ["config", "--get", "core.sshCommand"])) || process.env.GIT_SSH_COMMAND || process.env.GIT_SSH;
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never", GCM_INTERACTIVE: "never",
    // A person's own ssh command decides which key is used, so it is left exactly as configured.
    ...(ownSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" })
  };
  try {
    const result = await runCommand("git", ["-c", "protocol.ext.allow=never", "ls-remote", "--heads", remote], repoRoot, accessTimeoutMs, env);
    const said = redactSecrets(result.stderr.trim());
    return { access: classifyAccess({ code: result.code, output: said }), ...(result.code !== 0 && said ? { detail: said.slice(-800) } : {}) };
  } catch (error) {
    return { access: classifyAccess({ timedOut: true }), detail: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 400) };
  }
}

/** GitHub accounts behind a remote: every gh account, and who the SSH key signs in as. Nothing is switched. */
async function remoteAccount(repoRoot: string, sshHost: string | undefined, protocol: RemoteProtocol, helper: CredentialHelper | undefined, access: RemoteAccess) {
  const ghInstalled = Boolean(findExecutable("gh", await toolDirectories(), isExecutableFile));
  const accounts = ghInstalled ? await ghAccounts("github.com", repoRoot) : [];
  const sshLogin = protocol === "ssh" && sshHost && access === "ok" ? (await sshIdentity(sshHost, repoRoot)).login : undefined;
  return accountReadiness({ ghInstalled, accounts, protocol, sshLogin, helper, access });
}

async function readRemote(snapshot: RepoSnapshot, request: ReadinessRequest): Promise<RemoteReadiness> {
  const choice = selectRemote(snapshot.branches, snapshot.remotes, request.remote);
  if (!choice) return { status: "none", remotes: [...snapshot.remotes] };
  const pushUrl = (await optionalGit(snapshot.path, ["remote", "get-url", "--push", choice.name])) || snapshot.remoteUrls?.[choice.name] || "";
  const address = parseRemoteAddress(pushUrl);
  // A host that could read as an option is never handed to ssh.
  const sshHost = address.protocol === "ssh" && address.host && !address.host.startsWith("-") && !address.port ? address.host : undefined;
  let resolvedHost: string | undefined;
  if (sshHost) {
    const resolved = await runCommand("ssh", ["-G", sshHost], snapshot.path, 10_000).catch(() => undefined);
    const name = resolved?.code === 0 ? parseSshResolvedHostName(resolved.stdout) : undefined;
    if (name && name !== sshHost) resolvedHost = name;
  }
  const host = resolvedHost ?? address.host;
  const helper = address.protocol === "https" && address.host
    ? credentialHelperKind([...await configValues(snapshot.path, "credential.helper"), ...await configValues(snapshot.path, `credential.https://${address.host}.helper`)])
    : undefined;
  const checked = request.access ? await remoteAccess(snapshot.path, choice.name) : { access: "not_checked" as const };
  // gh verifies each token online, so accounts are only read when the person asked for a check.
  const account = request.access && host === "github.com" && (address.protocol === "https" || address.protocol === "ssh")
    ? await remoteAccount(snapshot.path, sshHost, address.protocol, helper, checked.access)
    : undefined;
  return {
    status: "found", name: choice.name, url: displayUrl(pushUrl), protocol: address.protocol,
    ...(address.host ? { host: address.host } : {}), ...(resolvedHost ? { resolvedHost } : {}), ...(address.path ? { path: address.path } : {}),
    source: choice.source, ...(choice.upstream ? { upstream: choice.upstream } : {}), remotes: [...snapshot.remotes],
    access: checked.access, ...("detail" in checked && checked.detail ? { detail: checked.detail } : {}),
    ...(helper ? { helper } : {}), ...(account ? { account } : {})
  };
}

/**
 * What Git needs before a first save or a publish: Git itself, who saves are attributed to, and where
 * a publish goes with the access this Mac has. It only reads; a recheck is always safe.
 */
export async function checkReadiness(cwd: string | undefined, request: ReadinessRequest = {}): Promise<ReadinessReport> {
  const checkedAt = new Date().toISOString();
  const directories = await toolDirectories();
  const gitPath = findExecutable("git", directories, isExecutableFile);
  const version = gitPath
    ? await runCommand("git", ["--version"], cwd ?? homedir(), 10_000).catch((error) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
    : undefined;
  const git = gitToolState(gitPath, version, directories.length);
  if (git.status !== "ok") return { checkedAt, git, author: authorReadiness([]), remote: { status: "none", remotes: [] } };
  if (!cwd) return { checkedAt, git, author: await readAuthor(undefined), remote: { status: "none", remotes: [] } };
  const snapshot = await getSnapshot(cwd);
  const [author, remote] = await Promise.all([readAuthor(snapshot.path), readRemote(snapshot, request)]);
  return { repoPath: snapshot.path, checkedAt, git, author, remote };
}

/** What changing the identity replaces and what keeps its own, said before anything is written. */
async function identityEffects(snapshot: RepoSnapshot, args: Record<string, string>, language: Locale): Promise<string[]> {
  const author = await readAuthor(snapshot.path);
  const shown = (values: IdentityValues) => values.name || values.email ? `${values.name ?? "—"} <${values.email ?? "—"}>` : undefined;
  const global = args.scope === "global";
  const current = shown(global ? author.global : author.repository);
  const repositoryOwn = shown(author.repository);
  const globalOwn = shown(author.global);
  return [
    current
      ? localized(language, `Sustituye ${global ? "la identidad global" : "la identidad de este repositorio"}: ${current}.`, `Replaces the ${global ? "global identity" : "identity set for this repository"}: ${current}.`)
      : localized(language, global ? "Todavía no hay una identidad global en este Mac; esto la crea." : "Este repositorio todavía no tiene una identidad propia; esto la crea.", global ? "No global identity is set on this Mac yet; this creates one." : "This repository has no identity of its own yet; this creates one."),
    ...(global && repositoryOwn ? [localized(language, `Este repositorio tiene su propia identidad (${repositoryOwn}) y la seguirá usando: la del repositorio tiene prioridad.`, `This repository has its own identity (${repositoryOwn}) and keeps using it: a repository's own setting takes precedence.`)] : []),
    ...(!global && globalOwn ? [localized(language, `Los demás repositorios de este Mac siguen usando ${globalOwn}.`, `Other repositories on this Mac keep using ${globalOwn}.`)] : []),
    localized(language, "Solo afecta a los próximos commits: los que ya existen conservan su autor. No es un inicio de sesión y no se envía nada.", "Only future commits use it: existing commits keep their author. It is not a sign-in and nothing is sent anywhere.")
  ];
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
  // Only the saved credentials leave a trace in Settings; a candidate being verified answers its caller.
  const saved = credentials === llmState;
  try {
    const payload = await sendToProvider(body, timeoutMs, credentials);
    if (saved) llmProblem = undefined;
    return payload;
  } catch (error) {
    if (error instanceof OperationCancelled) throw error;
    if (saved && !(error instanceof ProviderError && error.reason === "not_configured")) llmProblem = connectionProblem(error);
    throw error;
  }
}

async function sendToProvider(body: Record<string, unknown>, timeoutMs: number, credentials: LlmConfigInput): Promise<ProviderResponse> {
  const model = credentials.model.trim() || MODEL_FALLBACK;
  if (!credentials.apiKey.trim()) throw new ProviderError("not_configured", LLM_REQUIRED);
  operationCheckpoint();
  operationPhase("provider");
  const active = operationContext();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  active?.signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(RESPONSES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiKey}` },
      body: JSON.stringify({ model, store: false, ...body }),
      signal: controller.signal
    });
    if (!response.ok) {
      const raw = maskKeys(await response.text().catch(() => ""));
      throw new ProviderError("error", `The provider responded ${response.status}: ${raw.slice(0, 300)}`, { status: response.status, body: raw.slice(0, 4_000) });
    }
    return await response.json();
  } catch (error) {
    if (active?.signal.aborted) throw new OperationCancelled();
    if (error instanceof ProviderError) throw error;
    throw controller.signal.aborted
      ? new ProviderError("timeout", `El proveedor no respondió en ${Math.max(1, Math.round(timeoutMs / 1000))} s.`, { cause: error })
      : new ProviderError("unreachable", `No se pudo contactar con el proveedor: ${error instanceof Error ? error.message : "error de red"}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    active?.signal.removeEventListener("abort", cancel);
  }
}

/** A provider problem, told apart by kind so the interface can say what happened without parsing a message. */
export class ProviderError extends Error {
  /** The HTTP status and error body of a provider that answered with a failure. */
  readonly status?: number;
  readonly body?: string;
  constructor(readonly reason: AssistantUnavailable, message: string, options?: { cause?: unknown; status?: number; body?: string }) {
    super(message, options);
    this.name = "ProviderError";
    this.status = options?.status;
    this.body = options?.body;
  }
}

/** Why connecting failed, for any error a request to the provider produced, in terms the interface can explain. */
export function connectionProblem(error: unknown): AiConnectionProblem {
  const at = new Date().toISOString();
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (current instanceof LlmConnectionError) return current.problem;
    if (current instanceof ProviderError) {
      const transport = current.reason === "timeout" || current.reason === "unreachable" ? current.reason : undefined;
      return { kind: classifyProviderFailure({ status: current.status, body: current.body, transport }), detail: maskKeys(current.message).slice(0, 600), at };
    }
  }
  return { kind: "unexpected", detail: maskKeys(error instanceof Error ? error.message : String(error)).slice(0, 600), at };
}

/** Connecting did not work, and why: the configuration that was there stays as it was. */
export class LlmConnectionError extends Error {
  constructor(readonly problem: AiConnectionProblem, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmConnectionError";
  }
}

/** Why the assistant could not answer, for any error a request to it produced. */
function unavailableReason(error: unknown): AssistantUnavailable {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (current instanceof ProviderError) return current.reason;
  }
  return "error";
}

/**
 * How long a request waits for the assistant. A recovery already shows what GitCat can prove, so it
 * does not keep the person waiting on a slow provider for as long as a plan would.
 */
export const providerLimits = { recoveryMs: 45_000 };

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

/** The tree a first commit is measured against. Asked of Git, because it depends on the hash the repository uses. */
async function emptyTree(repoRoot: string) {
  return checkedGit(repoRoot, ["hash-object", "-t", "tree", "--stdin"]);
}

/**
 * The working tree as a diff against the last saved version. With `paths`, only those files, each
 * read whole as it is on disk: that is exactly what a save of selected files records, so the model
 * describing it and the person reviewing it read the same thing the commit will contain.
 */
async function getWorkingTreeDiff(snapshot: RepoSnapshot, paths?: string[], display = false) {
  const scope = paths ? literalPaths(paths) : [];
  const trackedDiff = paths
    ? await checkedGit(snapshot.path, ["diff", "--no-ext-diff", "--unified=3", snapshot.head || await emptyTree(snapshot.path), "--", ...scope])
    : snapshot.head
    ? await checkedGit(snapshot.path, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"])
    : [
        await checkedGit(snapshot.path, ["diff", "--cached", "--no-ext-diff", "--unified=3", "--"]),
        await checkedGit(snapshot.path, ["diff", "--no-ext-diff", "--unified=3", "--"])
      ].filter(Boolean).join("\n");
  const untrackedRaw = await checkedGit(snapshot.path, ["ls-files", "--others", "--exclude-standard", "-z", ...(paths ? ["--", ...scope] : [])]);
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
      // Shown to a person, a new file reads as added lines, the way the single-file diff shows it.
      const text = display ? content.toString("utf8").split("\n").map((line) => `+${line}`).join("\n") : content.toString("utf8");
      sections.push(`${header}${content.includes(0) ? "[archivo binario omitido]" : text}`);
    } catch (reason) {
      // A file too large for a single Buffer, or unreadable: reported, never silently dropped.
      sections.push(`\n+++ b/${relativePath}\n[no se pudo leer: ${reason instanceof Error ? reason.message : "error desconocido"}]`);
    }
  }
  const diff = sections.filter(Boolean).join("\n");
  if (!diff.trim()) throw new Error("No hay un diff de texto disponible para describir.");
  return diff;
}

/**
 * One changed file as it would reach the provider: the exact text — its diff, or the whole file when
 * Git does not track it yet — and what the local checks found in it. `credential` is about the name,
 * `exists` says whether the file is on disk now, which decides whether a save records it at all.
 */
type ChangeChunk = { path: string; text: string; credential: boolean; findings: DiffFinding[]; exists: boolean };

/** One file of a request after the sharing rules: what the model reads when its content may go out. */
type OutboundFile = AiSharingFile & { text: string };

/** What a request to the provider had to leave out, gathered across every call it makes. */
type SharingNotes = { withheld: WithheldFile[]; redacted: number };

const newNotes = (): SharingNotes => ({ withheld: [], redacted: 0 });

function noteWithheld(notes: SharingNotes | undefined, files: WithheldFile[]) {
  if (!notes) return;
  for (const file of files) if (!notes.withheld.some((item) => item.path === file.path)) notes.withheld.push(file);
}

function onDisk(absolute: string) {
  try { lstatSync(absolute); return true; } catch { return false; }
}

/** A small text file read only to decide whether its name makes it a credential. */
function readForNameCheck(absolute: string) {
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > 1_000_000) return undefined;
    const raw = readFileSync(absolute);
    return raw.includes(0) ? undefined : raw.toString("utf8");
  } catch { return undefined; }
}

/** Where one file's section of a patch begins. Every other line of a patch starts with a diff marker. */
const patchSectionStart = /^(?=diff --git |diff --cc |\* Unmerged path )/m;

/**
 * Every uncommitted change, file by file, as the text that would describe it: the tracked diff against
 * the last saved version and each new file whole. Nothing is cut short. Git lists the files and writes
 * the patch in the same order; if the two ever disagree, each file is read on its own instead.
 */
async function changeChunks(snapshot: RepoSnapshot, paths?: string[]): Promise<ChangeChunk[]> {
  const scope = paths ? literalPaths(paths) : [];
  const base = snapshot.head || await emptyTree(snapshot.path);
  const diff = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-renames", "--unified=3", base, "--"];
  const names = (await checkedGit(snapshot.path, ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", base, "--", ...scope], true))
    .split("\0").filter(Boolean);
  const chunks: ChangeChunk[] = [];
  if (names.length) {
    let pieces = (await checkedGit(snapshot.path, [...diff, ...scope], true)).split(patchSectionStart).filter((piece) => piece.trim());
    if (pieces.length !== names.length) {
      pieces = [];
      for (const name of names) pieces.push(await checkedGit(snapshot.path, [...diff, ...literalPaths([name])], true));
    }
    names.forEach((name, index) => {
      const text = pieces[index] ?? "";
      const absolute = resolve(snapshot.path, name);
      const exists = onDisk(absolute);
      const credential = mayBeCredentialFile(name) && isCredentialFile(name, exists ? readForNameCheck(absolute) : undefined);
      chunks.push({ path: name, text: text.startsWith("\n") ? text : `\n${text}`, credential, findings: scanDiff(name, text), exists });
    });
  }
  const untracked = (await checkedGit(snapshot.path, ["ls-files", "--others", "--exclude-standard", "-z", ...(paths ? ["--", ...scope] : [])], true))
    .split("\0").filter(Boolean);
  for (const relativePath of untracked) {
    const absolutePath = resolve(snapshot.path, relativePath);
    if (!absolutePath.startsWith(`${snapshot.path}${sep}`)) continue;
    const header = `\n--- /dev/null\n+++ b/${relativePath}\n@@ archivo nuevo @@\n`;
    try {
      if (lstatSync(absolutePath).isSymbolicLink()) {
        chunks.push({ path: relativePath, text: `\n+++ b/${relativePath}\n[enlace simbólico omitido]`, credential: false, findings: [], exists: true });
        continue;
      }
      const content = readFileSync(absolutePath);
      if (content.includes(0)) {
        chunks.push({ path: relativePath, text: `${header}[archivo binario omitido]`, credential: isCredentialFile(relativePath), findings: [], exists: true });
        continue;
      }
      const text = content.toString("utf8");
      chunks.push({
        path: relativePath, text: `${header}${text}`, credential: isCredentialFile(relativePath, text),
        findings: scanText(relativePath, text).map((finding) => ({ ...finding, side: "added" as const })), exists: true
      });
    } catch (reason) {
      // A file too large for a single Buffer, or unreadable: reported, never silently dropped.
      chunks.push({ path: relativePath, text: `\n+++ b/${relativePath}\n[no se pudo leer: ${reason instanceof Error ? reason.message : "error desconocido"}]`, credential: isCredentialFile(relativePath), findings: [], exists: true });
    }
  }
  return chunks;
}

/** The version of every listed path, both sides of a rename included, so a review is bound to what was seen. */
function versionsOf(snapshot: RepoSnapshot) {
  const versions = new Map<string, string>();
  for (const change of snapshot.changes) for (const path of changePaths(change)) if (change.version) versions.set(path, change.version);
  return versions;
}

function plainFindings(findings: SecretFinding[]): SecretFinding[] {
  return findings.map(({ path, line, kind }) => (line ? { path, line, kind } : { path, kind }));
}

/**
 * The sharing rules for one file, in order: an exclusion always wins; then anything that looks like a
 * credential is withheld unless the person reviewed exactly this version and chose to share it.
 */
function classifyOutbound(snapshot: RepoSnapshot, path: string, text: string, findings: SecretFinding[], versions: Map<string, string>): OutboundFile {
  const sharing = recallSharing(memory, snapshot.path);
  if (isExcluded(path, sharing.exclusions)) return { path, status: "excluded", findings: [], text };
  if (!findings.length) return { path, status: "sent", findings: [], text };
  const version = versions.get(path);
  return { path, status: version && sharing.reviewed[path] === version ? "reviewed" : "likely_secret", findings: plainFindings(findings), text };
}

function chunkFindings(chunk: ChangeChunk): SecretFinding[] {
  return chunk.credential ? [{ path: chunk.path, kind: "credential_file" }, ...chunk.findings] : chunk.findings;
}

/** The single gate every change passes on its way to the provider, whichever request carries it. */
async function outboundChanges(snapshot: RepoSnapshot, paths?: string[]): Promise<OutboundFile[]> {
  const versions = versionsOf(snapshot);
  return (await changeChunks(snapshot, paths)).map((chunk) => classifyOutbound(snapshot, chunk.path, chunk.text, chunkFindings(chunk), versions));
}

function isWithheld(file: AiSharingFile) {
  return file.status === "excluded" || file.status === "likely_secret";
}

function withheldFiles(files: AiSharingFile[]): WithheldFile[] {
  return files.filter(isWithheld).map((file) => ({
    path: file.path, reason: file.status === "excluded" ? "excluded" as const : "likely_secret" as const,
    ...(file.findings.length ? { findings: file.findings } : {})
  }));
}

/** What the model reads for one file: its text, or a placeholder that names it and says why it is missing. */
function modelText(file: OutboundFile) {
  if (!isWithheld(file)) return file.text;
  return `\n--- ${file.path}\n${withheldPlaceholder(withheldFiles([file])[0])}`;
}

/** The working tree diff as the model may read it, with every withheld file standing in as a placeholder. */
async function modelWorkingTreeDiff(snapshot: RepoSnapshot, paths?: string[]) {
  const files = await outboundChanges(snapshot, paths);
  const diff = files.map(modelText).filter(Boolean).join("\n");
  if (!diff.trim()) throw new Error("No hay un diff de texto disponible para describir.");
  return { diff, files, withheld: withheldFiles(files) };
}

/**
 * Likely credentials a save of these files would newly record: credential files that will exist after
 * the save, and anything in the lines it adds. A secret that is only being removed is not one of them.
 */
function saveFindings(chunks: ChangeChunk[]): SecretFinding[] {
  return chunks.flatMap((chunk) => [
    ...(chunk.credential && chunk.exists ? [{ path: chunk.path, kind: "credential_file" as const }] : []),
    ...plainFindings(chunk.findings.filter((finding) => finding.side === "added"))
  ]);
}

/**
 * Free text on its way out — the conversation, a Git error, the request itself — with every likely
 * credential replaced by a marker. The count is kept so the planner can be told something was removed.
 */
function redactOutgoing(text: string, counter: { redacted: number }) {
  const result = redactText(text);
  counter.redacted += result.redacted;
  return result.text;
}

function sharingAcknowledged(repoPath: string) {
  return Boolean(recallSharing(memory, repoPath).acknowledgedAt);
}

function sharingRequiredText(language: Locale) {
  return localized(language,
    "Antes de que el asistente lea este repositorio, revisa qué partes se enviarán al proveedor configurado y dale tu visto bueno. No se envió nada. Todo lo demás sigue funcionando sin el asistente: puedes guardar con tu propia descripción, cambiar de rama y usar cualquier control de Git.",
    "Before the assistant reads this repository, review which parts will be sent to the configured provider and approve it. Nothing was sent. Everything else keeps working without the assistant: you can save with your own description, switch branches and use every Git control.");
}

function sharingRequiredPlan(snapshot: RepoSnapshot, language: Locale): ActionPlan {
  return bindPlan(snapshot, {
    ...refused(sharingRequiredText(language), "guardrail", localized(language, "Revisa qué se comparte con el asistente", "Review what is shared with the assistant"), "question"),
    sharingRequired: true
  });
}

const secretKindText: Record<SecretKind, [string, string]> = {
  credential_file: ["archivo de credenciales", "credential file"],
  private_key: ["clave privada", "private key"],
  aws_access_key: ["clave de acceso de AWS", "AWS access key"],
  github_token: ["token de GitHub", "GitHub token"],
  slack_token: ["token de Slack", "Slack token"],
  stripe_key: ["clave de Stripe", "Stripe key"],
  api_key: ["clave de API", "API key"],
  google_api_key: ["clave de API de Google", "Google API key"],
  jwt: ["token firmado (JWT)", "signed token (JWT)"],
  credential_url: ["contraseña dentro de una URL", "password inside a URL"],
  secret_assignment: ["contraseña o clave en la configuración", "password or key in settings"]
};

/** Findings by file, with line and kind only: "config/.env (credential file; line 3: AWS access key)". */
function secretsText(findings: SecretFinding[], language: Locale) {
  const byPath = new Map<string, SecretFinding[]>();
  for (const finding of findings) byPath.set(finding.path, [...(byPath.get(finding.path) ?? []), finding]);
  return [...byPath].map(([path, items]) => `${path} (${items.slice(0, 4).map((item) => {
    const kind = localized(language, ...secretKindText[item.kind]);
    return item.line ? localized(language, `línea ${item.line}: ${kind}`, `line ${item.line}: ${kind}`) : kind;
  }).join("; ")}${items.length > 4 ? "; …" : ""})`).join(", ");
}

/** What the person decided about one repository, as the interface shows it before anything is sent. */
export async function getAiSharing(cwd: string, purpose: AiSharingPurpose, paths?: string[], locale?: Locale): Promise<AiSharingPreview> {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  const sharing = recallSharing(memory, snapshot.path);
  let files: AiSharingFile[] = [];
  if (purpose === "conflicts") files = (await readConflicts(snapshot)).flatMap((entry) => entry.file ? [entry.file] : []);
  else if (snapshot.isDirty) {
    const selection = purpose === "description" && paths ? currentSelection(snapshot, paths, language) : undefined;
    files = await outboundChanges(snapshot, selection?.paths);
  }
  return {
    repoPath: snapshot.path,
    provider: "openai",
    model: llmState.model || MODEL_FALLBACK,
    destination: new URL(RESPONSES_ENDPOINT).host,
    acknowledged: Boolean(sharing.acknowledgedAt),
    ...(sharing.acknowledgedAt ? { acknowledgedAt: sharing.acknowledgedAt } : {}),
    purpose,
    exclusions: sharing.exclusions,
    files: files.map(({ path, status, findings }) => ({ path, status, findings }))
  };
}

/** The person read what leaves the Mac for this repository and agreed to it. Remembered on this Mac. */
export async function acknowledgeAiSharing(cwd: string) {
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  const now = new Date().toISOString();
  saveMemory(rememberSharing(memory, repoRoot, { acknowledgedAt: now }, now));
}

/** Replaces this repository's exclusions. Invalid patterns are refused as a whole, so nothing half-applies. */
export async function setAiSharingExclusions(cwd: string, exclusions: unknown, locale?: Locale): Promise<string[]> {
  const language = normalizeLocale(locale);
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  if (!Array.isArray(exclusions) || exclusions.length > 200) throw new Error(localized(language, "La lista de exclusiones no es válida. No se cambió nada.", "The exclusion list is invalid. Nothing was changed."));
  const normalized: string[] = [];
  for (const raw of exclusions) {
    const pattern = normalizeExclusion(raw);
    if (!pattern) throw new Error(localized(language,
      `${JSON.stringify(typeof raw === "string" ? raw.slice(0, 80) : "")} no es un patrón válido: usa una ruta del repositorio como «secretos/», «*.sql» o «config/prod.yml». No se cambió nada.`,
      `${JSON.stringify(typeof raw === "string" ? raw.slice(0, 80) : "")} is not a valid pattern: use a repository path such as “secrets/”, “*.sql” or “config/prod.yml”. Nothing was changed.`));
    if (!normalized.includes(pattern)) normalized.push(pattern);
  }
  const now = new Date().toISOString();
  saveMemory(rememberSharing(memory, repoRoot, { exclusions: normalized }, now));
  return normalized;
}

/**
 * Shares one flagged file at the version on disk now, after the person looked at it — or takes that
 * back. An edit to the file changes its version, and the question is asked again.
 */
export async function setAiSharingReview(cwd: string, file: string, share: boolean, locale?: Locale) {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  const reviewed = { ...recallSharing(memory, snapshot.path).reviewed };
  if (share) {
    const version = versionsOf(snapshot).get(file);
    if (!version) throw new Error(localized(language, `${file} ya no es un cambio sin guardar, así que no hay nada que compartir. No se cambió nada.`, `${file} is no longer an unsaved change, so there is nothing to share. Nothing was changed.`));
    reviewed[file] = version;
  } else delete reviewed[file];
  const now = new Date().toISOString();
  saveMemory(rememberSharing(memory, snapshot.path, { reviewed }, now));
}

/** Likely credentials among every uncommitted change, for the warning beside the files to save. */
export async function scanChangesForSecrets(cwd: string): Promise<SecretFinding[]> {
  const snapshot = await getSnapshot(cwd);
  return snapshot.isDirty ? saveFindings(await changeChunks(snapshot)) : [];
}

/** A read-only command that prints a file the assistant may not read keeps its output out of the conversation. */
function argvShowsWithheld(argv: string[], exclusions: string[]) {
  return argv.slice(1).some((token) => {
    if (token.startsWith("-")) return false;
    const path = token.replace(/^:\([^)]*\)/, "").replace(/^[^:]*:(?=[^:])/, "");
    return Boolean(path) && (isExcluded(path, exclusions) || isCredentialFile(path));
  });
}

/**
 * One commit message read off the real diff. Shared by the manual button and by any planned commit.
 * With `paths`, the model only ever reads the files that will be saved.
 */
async function describeChanges(snapshot: RepoSnapshot, paths?: string[], locale?: Locale) {
  const language = normalizeLocale(locale);
  const { diff, files, withheld } = await modelWorkingTreeDiff(snapshot, paths);
  // With nothing readable, a message would be a guess from file names; the person writes it instead.
  if (files.length && files.every(isWithheld)) {
    throw new Error(localized(language,
      "GitCat no envió al asistente el contenido de ninguno de estos archivos (están excluidos o parecen contener una credencial), así que no puede describirlos sin adivinar. Escribe tú la descripción —guardar funciona igual— o revisa qué se comparte si quieres que el asistente los lea.",
      "GitCat did not send the assistant the content of any of these files (they are excluded or look like they hold a credential), so it cannot describe them without guessing. Write the description yourself — saving works the same — or review what is shared if you want the assistant to read them."));
  }
  const recentSubjects = snapshot.commits.slice(0, 15).map((commit) => redactText(commit.subject).text).filter(Boolean);
  const instructions = `Write one commit message for the working tree diff below.
Rules: a single line, ${commitMessageLimit} characters maximum, imperative mood, describing the intent of
the change. No quotes, no markdown, no prefix, no explanation, nothing but the message itself.
Write it in the same language as the recent commit subjects of this repository; if there are none, or
they are mixed, write it in English.
Some files may appear as a GitCat placeholder instead of their content, because the user withheld them
or they look like they hold a credential. Describe the change from what you can read, and never guess
or invent what a withheld file contains.`;
  const input = [
    `Current branch: ${snapshot.currentBranch}`,
    recentSubjects.length ? `Recent commit subjects:\n${recentSubjects.map((subject) => `- ${subject}`).join("\n")}` : "Recent commit subjects: none",
    `Working tree diff:\n${diff}`
  ].join("\n\n");
  const text = await askProvider({ instructions, input }, 180_000);
  return { description: cleanCommitDescription(text), withheld };
}

/**
 * The listed changes behind these paths, checked against Git's list right now. The versions are the
 * current ones: this is for reading, and whoever shows the result compares them with what they show.
 */
function currentSelection(snapshot: RepoSnapshot, paths: string[], language: Locale) {
  const versions = new Map(snapshot.changes.map((change) => [change.path, change.version ?? ""]));
  const resolved = resolveSelection(snapshot.changes, paths.map((path) => ({ path, version: versions.get(path) ?? "" })));
  if ("problem" in resolved) throw new Error(selectionProblemText(resolved.problem, language));
  return resolved;
}

function selectedVersions(changes: FileChange[]): SelectedChange[] {
  return changes.map((change) => ({ path: change.path, version: change.version ?? "" }));
}

export async function generateCommitDescription(cwd: string, locale?: Locale, paths?: string[]) {
  const language = normalizeLocale(locale);
  if (!isLlmConfigured()) throw new Error(llmRequired(language));
  const snapshot = await getSnapshot(cwd);
  if (!sharingAcknowledged(snapshot.path)) throw new Error(sharingRequiredText(language));
  if (!snapshot.changes.length) throw new Error(localized(language, "No hay cambios locales que describir.", "There are no local changes to describe."));
  const selection = paths ? currentSelection(snapshot, paths, language) : undefined;
  const { description, withheld } = await describeChanges(snapshot, selection?.paths, language);
  const current = await getSnapshot(snapshot.path);
  const moved = selection
    ? selection.selected.some((change) => current.changes.find((item) => item.path === change.path)?.version !== change.version)
    : current.stateId !== snapshot.stateId;
  if (moved) throw new Error(localized(language, "Los cambios variaron durante la generación. Inténtalo de nuevo.", "The changes moved while the description was being generated. Try again."));
  return {
    description, stateId: snapshot.stateId,
    ...(selection ? { selection: selectedVersions(selection.selected) } : {}),
    ...(withheld.length ? { withheld } : {})
  };
}

/** Exactly what saving these files would record, for the review before anything is saved. */
export async function getSelectionDiff(cwd: string, paths: string[], locale?: Locale): Promise<CommitDetail> {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  const selection = currentSelection(snapshot, paths, language);
  const diff = await getWorkingTreeDiff(snapshot, selection.paths, true).catch(() => "");
  const secrets = saveFindings(await changeChunks(snapshot, selection.paths));
  return { hash: "", files: selection.selected, stats: {}, ...cutDiff(diff), ...(secrets.length ? { secrets } : {}) };
}

/** Everything the model is allowed to reason about: verified repository facts, never raw guesses. */
async function plannerState(snapshot: RepoSnapshot, notes: SharingNotes = newNotes()) {
  const outbound = snapshot.isDirty
    ? await modelWorkingTreeDiff(snapshot).catch((error) => ({ diff: `[no se pudo leer el diff de trabajo: ${error instanceof Error ? error.message : "error desconocido"}]`, withheld: [] as WithheldFile[] }))
    : undefined;
  noteWithheld(notes, outbound?.withheld ?? []);
  const workingTreeDiff = outbound?.diff ?? null;
  const subject = (text: string) => redactText(text).text;
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
    // Files that stand in the diff as a placeholder. The model says so when its answer depends on one.
    withheldFromModel: (outbound?.withheld ?? []).map((file) => ({
      path: file.path, reason: file.reason, kinds: [...new Set((file.findings ?? []).map((finding) => finding.kind))]
    })),
    // Likely credentials replaced by a marker in the conversation or the request before they were sent.
    redactedFromConversation: notes.redacted,
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
        ? { shortHash: branch.lastCommit.shortHash, subject: subject(branch.lastCommit.subject), author: branch.lastCommit.author, email: branch.lastCommit.email, date: branch.lastCommit.date }
        : null
    })),
    recentCommits: snapshot.commits.slice(0, 30).map((commit) => ({
      shortHash: commit.shortHash, subject: subject(commit.subject), author: commit.author, date: commit.date, refs: commit.refs
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

async function requestPlan(request: string, snapshot: RepoSnapshot, context: ConversationMessage[], issues: PlanIssue[] = [], notes: SharingNotes = newNotes(), timeoutMs?: number): Promise<ModelPlan> {
  // Earlier answers, Git errors and the request itself can carry a credential that was printed or
  // pasted; each one is replaced by a marker before anything is sent.
  const counter = { redacted: 0 };
  context = context.map((message) => ({ role: message.role, content: redactOutgoing(message.content, counter) }));
  request = redactOutgoing(request, counter);
  issues = issues.map((issue) => ({ field: issue.field, problem: redactOutgoing(issue.problem, counter) }));
  notes.redacted = Math.max(notes.redacted, counter.redacted);
  const text = await askProvider({
    instructions: buildPlannerInstructions(await plannerState(snapshot, notes), issues),
    input: [...context, { role: "user", content: request }],
    text: { format: planResponseFormat }
  }, timeoutMs);
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
async function gitOperationDraft(plan: ModelPlan, snapshot: RepoSnapshot, locale: Locale = "es", notes?: SharingNotes): Promise<PlanDraft> {
  const proposed = plan.steps.map((step) => stepFrom(step.operation, operationArgs(step), step.argv, locale));
  if (proposed.some((step) => !step)) return refused(localized(locale, "El plan incluye una operación que no está permitida.", "The plan includes an operation that is not allowed."), "llm", plan.summary);
  const steps = await writeCommitMessages(proposed as PlanStep[], snapshot, locale, notes);
  if ("blocker" in steps) return asking(steps.blocker, plan.summary);
  // A planned commit saves every change, so whatever looks like a credential among them is named on the card.
  const secrets = steps.some((step) => step.operation === "commit" && !step.paths) ? saveFindings(await changeChunks(snapshot)) : [];
  const effects = [
    ...(renameEffects(steps, snapshot, locale) ?? []),
    ...(secrets.length ? [savingSecretsEffect(secrets, locale)] : [])
  ];
  const draft = sequenceDraft(steps, plan.rationale || "", effects.length ? effects : undefined, locale);
  return {
    ...draft,
    ...(secrets.length ? { secrets } : {}),
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
  plan: ModelPlan, snapshot: RepoSnapshot, request: string, context: ConversationMessage[], locale: Locale = "es", notes: SharingNotes = newNotes(), retried = false
): Promise<PlanDraft> {
  const fallbackRefusal = localized(locale, LAST_RESORT_REFUSAL, LAST_RESORT_REFUSAL_EN);
  if (plan.intent === "answer") return answerDraft(plan);
  if (plan.intent === "needs_information") return asking(plan.reply || plan.rationale || fallbackRefusal, plan.summary);
  if (plan.intent === "out_of_scope") return refused(plan.reply || plan.rationale || fallbackRefusal, "llm", plan.summary || localized(locale, "Solicitud rechazada", "Request rejected"));

  const retry = async (issues: PlanIssue[]) => {
    if (retried) return asking(plan.reply || plan.rationale || fallbackRefusal, plan.summary);
    return draftFromPlan(await requestPlan(request, snapshot, context, issues, notes), snapshot, request, context, locale, notes, true);
  };

  if (plan.intent === "git_operation") {
    const issues = [...planIssues(plan), ...protectedBranchIssues(plan, snapshot)];
    return issues.length ? retry(issues) : gitOperationDraft(plan, snapshot, locale, notes);
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

/** A plan that says which files the model could not read while preparing it. */
function withNotes(draft: PlanDraft, notes: SharingNotes): PlanDraft {
  return notes.withheld.length ? { ...draft, withheld: notes.withheld } : draft;
}

/** The card line for a save that records something that looks like a credential. */
function savingSecretsEffect(secrets: SecretFinding[], language: Locale) {
  return localized(language,
    `Atención: esto guarda archivos que parecen contener una credencial: ${secretsText(secrets, language)}. Una vez publicada, sacarla del historial es difícil; si es real, conviene cambiarla por una nueva.`,
    `Heads up: this saves files that look like they hold a credential: ${secretsText(secrets, language)}. Once published it is hard to remove from history; if it is real, it is worth replacing it with a new one.`);
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
 * Every open conflict as the model could read it: the whole file, and the sharing rules applied to it.
 * A binary file, one too large to review, or one a side deleted has no `file`: there is nothing to send.
 */
type ConflictEntry = { conflict: Conflict; raw?: Buffer; file?: OutboundFile };

async function readConflicts(snapshot: RepoSnapshot): Promise<ConflictEntry[]> {
  const versions = versionsOf(snapshot);
  return snapshot.conflicts.flatMap((conflict): ConflictEntry[] => {
    const absolute = resolve(snapshot.path, conflict.path);
    if (!absolute.startsWith(`${snapshot.path}${sep}`)) return [];
    try {
      const raw = readFileSync(absolute);
      if (raw.includes(0) || raw.length > conflictFileLimit) return [{ conflict, raw }];
      const text = raw.toString("utf8");
      const findings = credentialFindings(conflict.path, text, scanText(conflict.path, text));
      return [{ conflict, raw, file: classifyOutbound(snapshot, conflict.path, text, findings, versions) }];
    } catch {
      return [{ conflict }];
    }
  });
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
  if (!sharingAcknowledged(snapshot.path)) throw new Error(sharingRequiredText(language));
  // Captured before anything is read, so a change made while the model is thinking is caught later.
  const operation = await conflictOperation(snapshot.path);
  const stages = await unmergedStages(snapshot.path);
  const issued = { id: randomUUID(), repoPath: snapshot.path };
  const current: Record<string, string> = {};
  const files: ConflictBinding["files"] = {};
  const readable: Conflict[] = [];
  const skipped: ConflictProposal["skipped"] = [];
  const entries = await readConflicts(snapshot);
  const withheld = withheldFiles(entries.flatMap((entry) => entry.file ? [entry.file] : []));
  for (const conflict of snapshot.conflicts) {
    const entry = entries.find((item) => item.conflict.path === conflict.path);
    // A binary file has no sides to read, a huge one nobody is going to review properly, and a
    // file deleted on one side has no content to reason about.
    if (!entry?.file || !entry.raw) {
      skipped.push({ path: conflict.path, reason: localized(language,
        "Es binario, demasiado grande, o uno de los lados lo borró: eso se decide con «quedarse con un lado».",
        "It is binary, too large, or one side deleted it: settle it by keeping one side.") });
      continue;
    }
    if (isWithheld(entry.file)) {
      skipped.push({ path: conflict.path, reason: entry.file.status === "excluded"
        ? localized(language, "No se envió al asistente porque está excluido de lo que puede leer. Puedes quedarte con un lado, editarlo tú o dejar que lo lea desde «Qué ve el asistente».", "Not sent to the assistant because it is excluded from what it may read. You can keep one side, edit it yourself, or let it be read from “What the assistant sees”.")
        : localized(language, `No se envió al asistente porque parece contener una credencial (${secretsText(entry.file.findings, language)}). Puedes quedarte con un lado, editarlo tú o revisarlo y compartirlo desde «Qué ve el asistente».`, `Not sent to the assistant because it looks like it holds a credential (${secretsText(entry.file.findings, language)}). You can keep one side, edit it yourself, or review and share it from “What the assistant sees”.`) });
      continue;
    }
    current[conflict.path] = entry.file.text;
    files[conflict.path] = { stages: stages.get(conflict.path) ?? "", content: contentVersion(entry.raw) };
    readable.push(conflict);
  }
  if (!readable.length) {
    return { ...issued, resolutions: [], skipped, current: {}, binding: { operation, files }, ...(withheld.length ? { withheld } : {}) };
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
  const proposal = validateProposal(parsed, readable.map((conflict) => conflict.path));
  return {
    ...issued, ...proposal, skipped: [...skipped, ...proposal.skipped], current, binding: { operation, files },
    ...(withheld.length ? { withheld } : {})
  };
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
 * What a conflict guide was read against. Like a proposal's binding: the job holding the conflicts,
 * and per file its unmerged index stages, the bytes that were on disk, and the choices its shape
 * supports. Taking a side overwrites the file, so it needs the very bytes the person looked at;
 * "I edited it myself" needs the same conflict, since the edit is the point.
 */
export type ConflictGuideBinding = {
  operation: string;
  files: Record<string, { stages: string; content: string; choices: ConflictChoice[] }>;
};

export type IssuedConflictGuide = ConflictGuide & { binding: ConflictGuideBinding };

/** Enough of a side to choose it by looking. Bigger than this, the preview is cut and says so. */
const guidePreviewLimit = 60_000;

/**
 * The first bytes of a blob, never more than `limit`. A version can be a large binary, and reading
 * it whole just to learn that it is binary would be wasted work.
 */
async function blobHead(repoRoot: string, oid: string, limit: number): Promise<{ bytes: Buffer; complete: boolean } | undefined> {
  const executable = await resolveTool("git");
  const searchPath = (await toolDirectories()).join(delimiter);
  return new Promise((done) => {
    const child = spawn(executable, ["cat-file", "blob", oid], {
      cwd: repoRoot, env: { ...process.env, PATH: searchPath, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let cut = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (cut) return;
      chunks.push(chunk);
      length += chunk.length;
      if (length > limit) { cut = true; child.kill("SIGTERM"); }
    });
    child.on("error", () => { clearTimeout(timer); done(undefined); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!cut && code !== 0) return done(undefined);
      const bytes = Buffer.concat(chunks);
      done({ bytes: bytes.subarray(0, limit), complete: !cut && bytes.length <= limit });
    });
  });
}

async function versionFrom(repoRoot: string, entry: UnmergedEntry | undefined): Promise<ConflictFileVersion> {
  if (!entry) return { present: false, binary: false };
  const size = Number(await optionalGit(repoRoot, ["cat-file", "-s", entry.oid])) || undefined;
  // A symlink's content is where it points and a submodule has no content here: one or the other, whole.
  if (isSpecialMode(entry.mode)) return { present: true, binary: true, size };
  const head = await blobHead(repoRoot, entry.oid, guidePreviewLimit);
  if (!head) return { present: true, binary: false, size };
  if (isBinaryContent(head.bytes)) return { present: true, binary: true, size };
  return { present: true, binary: false, size, preview: head.bytes.toString("utf8"), ...(head.complete ? {} : { previewTruncated: true }) };
}

async function commitLine(repoRoot: string, revision: string | undefined) {
  if (!revision) return undefined;
  const line = await optionalGit(repoRoot, ["log", "-1", "--format=%h%x1f%s", revision, "--"]);
  const [shortHash, subject = ""] = line.split("\x1f");
  return shortHash ? { shortHash, subject } : undefined;
}

/** A branch that points exactly at a commit, preferring a local one and never the branch being replayed. */
async function branchAt(repoRoot: string, commit: string, except?: string) {
  const names = (await optionalGit(repoRoot, ["for-each-ref", "--points-at", commit, "--format=%(refname)", "refs/heads", "refs/remotes"]))
    .split("\n").filter(Boolean).filter((ref) => ref !== `refs/heads/${except}` && !ref.endsWith("/HEAD"));
  const local = names.find((ref) => ref.startsWith("refs/heads/"));
  return (local ?? names[0])?.replace(/^refs\/(heads|remotes)\//, "");
}

/**
 * Which commits the two sides and their common ancestor come from. Each operation builds the
 * conflict from a different triple, and a revert even applies a commit backwards.
 */
async function conflictCommits(repoRoot: string, kind: PendingOperation["kind"] | undefined) {
  const verify = (ref: string) => optionalGit(repoRoot, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  const ours = await verify("HEAD");
  if (kind === "merge") {
    const theirs = await verify("MERGE_HEAD");
    const base = ours && theirs ? (await optionalGit(repoRoot, ["merge-base", ours, theirs])).split("\n")[0] : "";
    return { ours, theirs, theirsTree: theirs, base };
  }
  if (kind === "rebase" || kind === "cherry_pick") {
    const theirs = await verify(kind === "rebase" ? "REBASE_HEAD" : "CHERRY_PICK_HEAD");
    return { ours, theirs, theirsTree: theirs, base: theirs ? await verify(`${theirs}^`) : "" };
  }
  if (kind === "revert") {
    const theirs = await verify("REVERT_HEAD");
    // Undoing a commit applies the change from it back to its parent.
    return { ours, theirs, theirsTree: theirs ? await verify(`${theirs}^`) : "", base: theirs };
  }
  return { ours, theirs: "", theirsTree: "", base: "" };
}

async function renamesBetween(repoRoot: string, from: string, to: string) {
  if (!from || !to) return [];
  return parseRenames(await optionalGit(repoRoot, ["diff", "--name-status", "-z", "-M", "--diff-filter=R", from, to, "--"]));
}

async function sideIdentities(repoRoot: string, snapshot: RepoSnapshot, commits: { ours: string; theirs: string }): Promise<Record<ConflictSideId, ConflictSideIdentity>> {
  const pending = snapshot.pending;
  const roles = sideRoles(pending?.kind);
  const ours = await commitLine(repoRoot, commits.ours);
  const theirs = await commitLine(repoRoot, commits.theirs);
  const current = snapshot.currentBranch !== "HEAD" ? snapshot.currentBranch : undefined;
  let oursName = current ?? ours?.shortHash ?? "HEAD";
  let theirsName = theirs?.shortHash ?? "";
  if (pending?.kind === "rebase") {
    const onto = ((await readGitFile(repoRoot, "rebase-merge/onto")) ?? (await readGitFile(repoRoot, "rebase-apply/onto")) ?? "").trim();
    oursName = (onto && await branchAt(repoRoot, onto, pending.branch)) || (onto ? onto.slice(0, 7) : ours?.shortHash ?? "HEAD");
    theirsName = pending.branch ?? theirsName;
  } else if (pending?.kind === "merge") {
    theirsName = pending.onto ?? theirsName;
  }
  return {
    ours: { id: "ours", role: roles.ours, name: oursName, ...(ours ? { commit: ours } : {}) },
    theirs: { id: "theirs", role: roles.theirs, name: theirsName, ...(theirs ? { commit: theirs } : {}) }
  };
}

/**
 * Every open conflict explained from the repository alone, for a person to decide file by file.
 * Nothing here is sent anywhere: the assistant is an optional second opinion, not the way in.
 */
export async function describeConflicts(cwd: string, locale?: Locale): Promise<IssuedConflictGuide> {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  const repoRoot = snapshot.path;
  if (!snapshot.conflicts.length && !snapshot.pending) {
    throw new Error(localized(language, "No hay conflictos que resolver.", "There are no conflicts to resolve."));
  }
  // Captured before anything is read, so a change made while the person decides is caught later.
  const operation = await conflictOperation(repoRoot);
  const stages = await unmergedStages(repoRoot);
  const entries = parseUnmerged(await checkedGit(repoRoot, ["ls-files", "-u", "-z"], true));
  const pending = snapshot.pending;
  const commits = await conflictCommits(repoRoot, pending?.kind);
  const renames = {
    ours: await renamesBetween(repoRoot, commits.base, commits.ours),
    theirs: await renamesBetween(repoRoot, commits.base, commits.theirsTree)
  };
  const binding: ConflictGuideBinding = { operation, files: {} };
  const files: ConflictGuideFile[] = [];
  for (const conflict of snapshot.conflicts) {
    const absolute = resolve(repoRoot, conflict.path);
    if (!absolute.startsWith(`${repoRoot}${sep}`)) continue;
    const held = entries.get(conflict.path) ?? [];
    const at = (stage: number) => held.find((entry) => entry.stage === stage);
    const [ours, theirs] = await Promise.all([versionFrom(repoRoot, at(sideStage.ours)), versionFrom(repoRoot, at(sideStage.theirs))]);
    let working: ConflictGuideFile["working"] = { present: false, binary: false, markers: false };
    let raw: Buffer | undefined;
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) working = { present: true, binary: true, markers: false };
      else {
        raw = readFileSync(absolute);
        const binary = isBinaryContent(raw);
        working = { present: true, binary, markers: !binary && hasConflictMarkers(raw.toString("utf8")) };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const binary = ours.binary || theirs.binary || working.binary;
    const choices = choicesFor({ ours: ours.present, theirs: theirs.present, binary, working: working.present });
    binding.files[conflict.path] = { stages: stages.get(conflict.path) ?? "", content: working.binary && !raw ? "special" : contentVersion(raw), choices };
    files.push({
      path: conflict.path, kind: conflict.kind, binary, renames: renamesFor(conflict.path, renames),
      ours, theirs, base: { present: Boolean(at(1)) }, working, choices
    });
  }
  const sequencer = pending && (pending.kind === "cherry_pick" || pending.kind === "revert") ? await readGitFile(repoRoot, "sequencer/todo") : undefined;
  return {
    id: randomUUID(),
    repoPath: repoRoot,
    ...(pending ? { operation: pending.kind } : {}),
    ...(pending?.step ? { step: pending.step } : {}),
    ...(pending?.total ? { total: pending.total } : {}),
    ...(pending?.branch ? { branch: pending.branch } : {}),
    remaining: remainingSteps(pending?.kind, pending ?? {}, sequencer),
    sides: await sideIdentities(repoRoot, snapshot, commits),
    files,
    binding
  };
}

/** The bytes a file holds now, in the same terms the guide recorded them. */
function workingVersion(absolute: string) {
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return "special";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  return contentVersion(readIfPresent(absolute));
}

/** Why a hand edit cannot be marked resolved as it is, or nothing when it can. */
function editProblem(absolute: string): ConflictChoiceOutcome["reason"] | undefined {
  const raw = readIfPresent(absolute);
  if (!raw) return "missing";
  return !isBinaryContent(raw) && hasConflictMarkers(raw.toString("utf8")) ? "markers" : undefined;
}

const conflictChoices = new Set<ConflictChoice>(["ours", "theirs", "delete", "edited"]);

/**
 * Applies the choices a person made in the guide, and only those. The whole set is checked against
 * the repository as it is now before anything is written — the same repository, the same operation,
 * the same conflict stages, and for a side choice the very bytes that were on screen — because taking
 * a side overwrites the file, and an edit made meanwhile must never be lost to it. Files are then
 * settled one at a time; the first failure stops the run and is reported exactly, with the file put
 * back as it was.
 */
export async function applyConflictChoices(
  cwd: string, guide: IssuedConflictGuide, requested: ConflictChoiceRequest[], locale?: Locale
): Promise<ConflictChoiceResult> {
  const language = normalizeLocale(locale);
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  if (!Array.isArray(requested) || !requested.length) throw new Error(localized(language, "No hay ninguna elección que aplicar.", "There is no choice to apply."));
  if (requested.some((item) => !item || typeof item.path !== "string" || !conflictChoices.has(item.choice)) ||
      new Set(requested.map((item) => item.path)).size !== requested.length) {
    throw new Error(localized(language, "Las elecciones no son válidas.", "The choices are invalid."));
  }
  for (const item of requested) {
    const bound = guide.binding.files[item.path];
    if (!bound) throw new Error(localized(language, `${item.path} no forma parte de esta revisión.`, `${item.path} is not part of this review.`));
    if (!bound.choices.includes(item.choice)) throw new Error(localized(language, `Esa elección no vale para ${item.path}.`, `That choice does not apply to ${item.path}.`));
    const absolute = resolve(repoRoot, item.path);
    if (!absolute.startsWith(`${repoRoot}${sep}`)) throw new Error(localized(language, "La ruta no pertenece a este repositorio.", "The path does not belong to this repository."));
  }
  const report = (status: (item: ConflictChoiceRequest) => Pick<ConflictChoiceOutcome, "status" | "reason">) =>
    requested.map((item) => ({ path: item.path, choice: item.choice, ...status(item) }));

  if (guide.repoPath !== repoRoot) {
    return { snapshot: await getSnapshot(repoRoot), complete: false, stale: "repository", outcomes: report(() => ({ status: "not_applied" })) };
  }
  if (await conflictOperation(repoRoot) !== guide.binding.operation) {
    return { snapshot: await getSnapshot(repoRoot), complete: false, stale: "operation", outcomes: report(() => ({ status: "changed" })) };
  }
  const stages = await unmergedStages(repoRoot);
  const changed = new Set<string>();
  const refused = new Map<string, ConflictChoiceOutcome["reason"]>();
  for (const item of requested) {
    const bound = guide.binding.files[item.path];
    const absolute = resolve(repoRoot, item.path);
    if (!bound.stages || stages.get(item.path) !== bound.stages) { changed.add(item.path); continue; }
    if (item.choice === "edited") {
      const problem = editProblem(absolute);
      if (problem) refused.set(item.path, problem);
    } else if (workingVersion(absolute) !== bound.content) changed.add(item.path);
  }
  if (changed.size || refused.size) {
    return {
      snapshot: await getSnapshot(repoRoot), complete: false, ...(changed.size ? { stale: "files" as const } : {}),
      outcomes: report((item) => changed.has(item.path) ? { status: "changed" }
        : refused.has(item.path) ? { status: "refused", reason: refused.get(item.path) } : { status: "not_applied" })
    };
  }

  const entries = parseUnmerged(await checkedGit(repoRoot, ["ls-files", "-u", "-z"], true));
  const outcomes: ConflictChoiceOutcome[] = [];
  for (const item of requested) {
    const bound = guide.binding.files[item.path];
    const absolute = resolve(repoRoot, item.path);
    // The last look before writing: an editor can still save between the check above and here.
    if (item.choice === "edited") {
      const problem = editProblem(absolute);
      if (problem) { outcomes.push({ path: item.path, choice: item.choice, status: "refused", reason: problem }); break; }
    } else if (workingVersion(absolute) !== bound.content) {
      outcomes.push({ path: item.path, choice: item.choice, status: "changed" });
      break;
    }
    const original = readIfPresent(absolute);
    const before = workingVersion(absolute);
    const action = commandFor(item.choice, new Set((entries.get(item.path) ?? []).map((entry) => entry.stage)));
    let failure: string | undefined;
    const step = async (args: string[]) => {
      if (failure !== undefined) return;
      const result = await runGit(repoRoot, args);
      if (result.code !== 0) failure = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")}`;
    };
    if (action === "remove") await step(["rm", "-q", "--", item.path]);
    else {
      if (action === "checkout") await step(["checkout", `--${item.choice}`, "--", item.path]);
      await step(["add", "--", item.path]);
    }
    if (failure === undefined) {
      outcomes.push({ path: item.path, choice: item.choice, status: "applied" });
      continue;
    }
    let restored = false;
    try {
      if (workingVersion(absolute) !== before) {
        if (original) writeFileSync(absolute, original);
        else if (before === "missing") unlinkSync(absolute);
      }
      restored = workingVersion(absolute) === before;
    } catch { /* reported below: the file may now hold the chosen side */ }
    outcomes.push({ path: item.path, choice: item.choice, status: "failed", restored, detail: failure });
    break;
  }
  for (const item of requested.slice(outcomes.length)) outcomes.push({ path: item.path, choice: item.choice, status: "not_applied" });
  return {
    snapshot: await getSnapshot(repoRoot),
    complete: outcomes.every((outcome) => outcome.status === "applied"),
    outcomes
  };
}

/**
 * The file to hand to the system's editor. Only a path that is in conflict right now, inside this
 * repository once links are followed, and a regular file: opening is harmless, but opening something
 * outside the repository because a path said so is not.
 */
export async function conflictFileToOpen(cwd: string, file: string, locale?: Locale) {
  const language = normalizeLocale(locale);
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  if (typeof file !== "string" || !file) throw new Error(localized(language, "El archivo solicitado no es válido.", "The requested file is invalid."));
  const conflicted = parseUnmerged(await checkedGit(repoRoot, ["ls-files", "-u", "-z"], true));
  if (!conflicted.has(file)) throw new Error(localized(language, `${file} ya no está en conflicto.`, `${file} is no longer in conflict.`));
  const absolute = resolve(repoRoot, file);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new Error(localized(language, `${file} no está en el disco: uno de los lados lo borró. Elige qué versión conservar o mantén el borrado.`, `${file} is not on disk: one side deleted it. Choose which version to keep, or keep the deletion.`));
  }
  const realRoot = realpathSync(repoRoot);
  if (!real.startsWith(`${realRoot}${sep}`) || !statSync(real).isFile()) {
    throw new Error(localized(language, "La ruta no pertenece a este repositorio.", "The path does not belong to this repository."));
  }
  return real;
}

/**
 * A plan that stopped part-way used to be the end of the conversation: the repository was left holding
 * a half-finished job and the model never heard about it. Now the failure goes back as structured
 * detail so it can plan from where the repository actually is.
 */
export async function planRecovery(cwd: string, failure: ExecutionFailure, context: ConversationMessage[] = [], locale?: Locale, report?: RecoveryReport): Promise<ActionPlan> {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  // No assistant is not a dead end: the interface already shows what GitCat can prove from the facts.
  if (!isLlmConfigured()) return bindPlan(snapshot, { ...refused(llmRequired(language)), assistantUnavailable: "not_configured" });
  if (!sharingAcknowledged(snapshot.path)) return sharingRequiredPlan(snapshot, language);
  const issues: PlanIssue[] = [
    { field: "execution.command", problem: `"${failure.command}" failed: ${failure.error}` },
    ...(failure.skipped.length ? [{ field: "execution.skipped", problem: `these steps never ran: ${failure.skipped.join("; ")}` }] : []),
    ...(report ? [{
      field: "execution.classification",
      problem: `GitCat read the repository again and classified this as "${report.kind}".${report.completed.length ? ` Already completed, never to be repeated: ${report.completed.join("; ")}.` : ""} Decide only what the facts leave open, and never re-run a completed step.`
    }] : [])
  ];
  const notes = newNotes();
  try {
    const plan = await requestPlan(RECOVERY_REQUEST, snapshot, context, issues, notes, providerLimits.recoveryMs);
    return bindPlan(snapshot, withNotes(await draftFromPlan(plan, snapshot, RECOVERY_REQUEST, context, language, notes), notes));
  } catch (error) {
    return bindPlan(snapshot, {
      ...refused(localized(language, `No pude consultar el proveedor LLM: ${error instanceof Error ? error.message : "error desconocido"}`, `I could not query the LLM provider: ${error instanceof Error ? error.message : "unknown error"}`), "llm"),
      assistantUnavailable: unavailableReason(error)
    });
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
  if (!sharingAcknowledged(snapshot.path)) return sharingRequiredPlan(snapshot, language);
  const notes = newNotes();
  try {
    const plan = await requestPlan(request, snapshot, context, [], notes);
    return bindPlan(snapshot, withNotes(await draftFromPlan(plan, snapshot, request, context, language, notes), notes));
  } catch (error) {
    return bindPlan(snapshot, {
      ...refused(localized(language, `No pude consultar el proveedor LLM: ${error instanceof Error ? error.message : "error desconocido"}`, `I could not query the LLM provider: ${error instanceof Error ? error.message : "unknown error"}`), "llm"),
      assistantUnavailable: unavailableReason(error)
    });
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
    push: args.setUpstream
      ? [localized(locale, `Publicar ${args.branch} en ${args.setUpstream}`, `Publish ${args.branch} to ${args.setUpstream}`), localized(locale, `Envía tus commits a ${args.setUpstream} y lo recuerda como el destino de esta rama, para que los próximos push y pull sepan adónde ir. Tus archivos locales no cambian.`, `Sends your commits to ${args.setUpstream} and remembers it as this branch's destination, so later pushes and pulls know where to go. Your local files do not change.`), "high"]
      : args.noVerify === "true"
      ? [localized(locale, "Publicar la rama actual omitiendo las verificaciones", "Publish the current branch without verification"), localized(locale, "Envía los commits al upstream configurado con --no-verify: los hooks pre-push no se ejecutan.", "Pushes commits to the configured upstream with --no-verify: pre-push hooks do not run."), "high"]
      : [localized(locale, "Publicar la rama actual", "Publish the current branch"), localized(locale, "Envía los commits al upstream configurado.", "Pushes commits to the configured upstream."), "high"],
    merge: [localized(locale, `Fusionar ${args.name}`, `Merge ${args.name}`), localized(locale, "Integra la rama seleccionada en la rama actual.", "Integrates the selected branch into the current branch."), "high"],
    rebase: [localized(locale, `Rebase sobre ${args.onto}`, `Rebase onto ${args.onto}`), localized(locale, "Reescribe la base de la rama actual.", "Rewrites the base of the current branch."), "high"],
    abort_operation: [localized(locale, `Abortar ${args.pendingLabel ?? "la operación"}`, `Abort ${args.pendingLabel ?? "the operation"}`), localized(locale, "Deshace el trabajo a medias y devuelve el repositorio a como estaba antes de empezar.", "Discards the half-finished work and returns the repository to how it was before it started."), "high"],
    continue_operation: [localized(locale, `Continuar ${args.pendingLabel ?? "la operación"}`, `Continue ${args.pendingLabel ?? "the operation"}`), localized(locale, "Sigue desde donde se detuvo, una vez resueltos los conflictos.", "Continues from where it stopped after conflicts are resolved."), "high"],
    skip_operation: [localized(locale, `Saltar el commit atascado de ${args.pendingLabel ?? "la operación"}`, `Skip the stuck commit from ${args.pendingLabel ?? "the operation"}`), localized(locale, "Descarta el commit en el que se atascó y sigue con el resto.", "Discards the stuck commit and continues with the rest."), "high"],
    resolve_conflict: [localized(locale, `Resolver ${args.path} quedándose con ${args.side === "theirs" ? "el otro lado" : args.side === "ours" ? "nuestro lado" : "el archivo tal cual está"}`, `Resolve ${args.path} by keeping ${args.side === "theirs" ? "the other side" : args.side === "ours" ? "our side" : "the file as it is"}`), localized(locale, "Marca el conflicto de un archivo como resuelto. No modifica el contenido de ningún archivo.", "Marks a file conflict as resolved. It does not change file content."), "medium"],
    commit: [localized(locale, `Crear commit “${args.message ?? ""}”`, `Create commit “${args.message ?? ""}”`), localized(locale, "Añade todos los cambios y crea un commit.", "Stages all changes and creates a commit."), "high"],
    set_identity: args.scope === "global"
      ? [localized(locale, `Firmar los commits de todos los repositorios de este Mac como ${args.user} <${args.email}>`, `Sign commits in every repository on this Mac as ${args.user} <${args.email}>`), localized(locale, "Guarda el nombre y el correo que Git anota en cada commit en tu configuración global de Git, para todos los repositorios de este Mac que no tengan los suyos. Tus archivos y tu historial no cambian.", "Saves the name and email Git records with each commit in your global Git settings, for every repository on this Mac that does not set its own. Your files and history do not change."), "high"]
      : [localized(locale, `Firmar los commits de este repositorio como ${args.user} <${args.email}>`, `Sign commits in this repository as ${args.user} <${args.email}>`), localized(locale, "Guarda el nombre y el correo que Git anota en cada commit, solo para este repositorio. Tus archivos y tu historial no cambian.", "Saves the name and email Git records with each commit, for this repository only. Your files and history do not change."), "medium"],
    add_remote: [localized(locale, `Conectar este repositorio con ${args.url} como ${args.name}`, `Connect this repository to ${args.url} as ${args.name}`), localized(locale, "Añade la dirección donde se puede publicar este repositorio. Todavía no se envía nada: publicar es otro paso que confirmas aparte.", "Adds the address where this repository can be published. Nothing is sent yet: publishing is a separate step you confirm."), "medium"],
    ignore_path: [localized(locale, `Ignorar los cambios futuros de ${args.path}`, `Ignore future changes to ${args.path}`), localized(locale, "Añade una línea a .gitignore para que Git deje de listar este archivo nuevo. El archivo se queda en tu disco tal como está.", "Adds one line to .gitignore so Git stops listing this new file. The file stays on your disk exactly as it is."), "medium"],
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
async function writeCommitMessages(steps: PlanStep[], snapshot: RepoSnapshot, locale: Locale = "es", notes?: SharingNotes): Promise<PlanStep[] | { blocker: string }> {
  const pending = (step: PlanStep) => step.operation === "commit" && !step.args.message?.trim();
  if (!steps.some(pending)) return steps;
  if (!snapshot.changes.length) return { blocker: localized(locale, "No hay cambios locales que confirmar, así que no hay nada de lo que escribir un commit.", "There are no local changes to commit, so there is nothing to write a commit message for.") };
  let message: string;
  try {
    const described = await describeChanges(snapshot, undefined, locale);
    noteWithheld(notes, described.withheld);
    message = described.description;
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
  if (operation === "ignore_path") return prepareIgnore(snapshot, typeof args.path === "string" ? args.path : "", language);
  if (operation === "create_branch" && args.from && /^[0-9a-f]{7,40}$/i.test(args.from)
      && !(await optionalGit(snapshot.path, ["rev-parse", "--verify", "--quiet", `${args.from}^{commit}`]))) {
    throw new Error(localized(language, "Ese commit ya no existe en este repositorio.", "That commit no longer exists in this repository."));
  }
  // Only what each direct control needs reaches the step: a publish names the active branch as Git
  // reads it now, and an identity or a remote address is trimmed of stray spaces.
  const normalized = operation === "push" && args.setUpstream ? { setUpstream: args.setUpstream, branch: snapshot.currentBranch, ...(args.noVerify === "true" ? { noVerify: "true" } : {}) }
    : operation === "set_identity" ? { user: (args.user ?? "").trim(), email: (args.email ?? "").trim(), scope: typeof args.scope === "string" ? args.scope : "local" }
    : operation === "add_remote" ? { name: (args.name ?? "origin").trim() || "origin", url: (args.url ?? "").trim() }
    : args;
  const draft = operationDraft(operation, normalized, snapshot, [], language);
  if (draft.allowed) validateExecution(bindPlan(snapshot, draft), snapshot, language);
  const effects = draft.allowed
    ? [...await pendingEffects(snapshot, operation, language), ...(operation === "set_identity" ? await identityEffects(snapshot, normalized, language) : [])]
    : [];
  return bindPlan(snapshot, effects.length ? { ...draft, effects: [...(draft.effects ?? []), ...effects] } : draft);
}

/**
 * Exactly what continuing, skipping or aborting a half-finished job does to this repository, read
 * from its own state, so the confirmation says what is kept, what is dropped and whether more
 * conflicts can still come.
 */
async function pendingEffects(snapshot: RepoSnapshot, operation: Operation, language: Locale): Promise<string[]> {
  const pending = snapshot.pending;
  if (!pending || !["continue_operation", "skip_operation", "abort_operation"].includes(operation)) return [];
  const sequencer = pending.kind === "cherry_pick" || pending.kind === "revert" ? await readGitFile(snapshot.path, "sequencer/todo") : undefined;
  const remaining = remainingSteps(pending.kind, pending, sequencer);
  const later = remaining
    ? localized(language,
      `Después quedan ${remaining} commit${remaining === 1 ? "" : "s"} por aplicar, y cualquiera de ellos puede volver a detenerse con conflictos nuevos.`,
      `${remaining} more commit${remaining === 1 ? "" : "s"} will be applied afterwards, and any of them can stop again with new conflicts.`)
    : localized(language, "Es el último paso: no quedan más commits por aplicar.", "This is the last step: no more commits are waiting.");
  const current = await commitLine(snapshot.path, pending.kind === "rebase" ? "REBASE_HEAD" : pending.kind === "cherry_pick" ? "CHERRY_PICK_HEAD" : pending.kind === "revert" ? "REVERT_HEAD" : undefined);
  const named = current ? `${current.shortHash} “${current.subject}”` : localized(language, "el commit en el que se detuvo", "the commit it stopped on");
  if (operation === "continue_operation") {
    if (pending.kind === "merge") {
      return [localized(language,
        "Crea el commit de fusión con los archivos tal como están resueltos ahora. No queda nada más por aplicar.",
        "Creates the merge commit with the files exactly as they are resolved now. Nothing else is waiting.")];
    }
    return [localized(language,
      `Guarda los archivos resueltos como el commit ${named} y sigue.`,
      `Records the resolved files as commit ${named} and moves on.`), later];
  }
  if (operation === "skip_operation") {
    return [localized(language,
      `Deja fuera el commit ${named}: sus cambios no estarán en el resultado, y lo que ya resolviste para él se descarta.`,
      `Leaves out commit ${named}: its changes will not be in the result, and what you already resolved for it is discarded.`), later];
  }
  return [localized(language,
    "Vuelve al commit y la rama en los que estabas antes de empezar. Las resoluciones que hayas hecho hasta ahora se descartan.",
    "Returns to the commit and branch you were on before it started. Any resolutions made so far are discarded."),
  ...(pending.kind === "rebase" && pending.step && pending.step > 1 ? [localized(language,
    "Los commits que ya se habían vuelto a aplicar en este rebase también se deshacen: la rama queda como antes del rebase.",
    "Commits already replayed in this rebase are undone as well: the branch is left as it was before the rebase.")] : [])];
}

function selectionProblemText(problem: SelectionProblem, language: Locale) {
  switch (problem.kind) {
    case "empty": return localized(language, "Marca al menos un archivo para guardar. No se cambió nada.", "Tick at least one file to save. Nothing was changed.");
    case "duplicate": return localized(language, `${problem.path} aparece dos veces en la selección. Revisa la selección de nuevo; no se cambió nada.`, `${problem.path} appears twice in the selection. Review the selection again; nothing was changed.`);
    case "unknown": return localized(language,
      `${problem.path} ya no es un cambio sin guardar: puede que se haya guardado, restaurado o borrado fuera de GitCat. No se cambió nada; revisa la lista actualizada.`,
      `${problem.path} is no longer an unsaved change: it may have been saved, restored or removed outside GitCat. Nothing was changed; review the updated list.`);
    case "changed": return localized(language,
      `${problem.path} cambió después de revisarlo. No se guardó nada; revísalo de nuevo para que el guardado contenga lo que viste.`,
      `${problem.path} changed after you reviewed it. Nothing was saved; review it again so the save contains what you saw.`);
    case "shared": return localized(language,
      `${problem.path} y ${problem.with} comparten una ruta por un renombrado. Inclúyelos los dos o déjalos los dos fuera; no se cambió nada.`,
      `${problem.path} and ${problem.with} share a path because of a rename. Include both or leave both out; nothing was changed.`);
  }
}

/**
 * What a save of selected files is bound to. The selected files' versions already carry the commit
 * and branch they sit on; when the save continues into an integration, the target branch's tip and
 * whether another worktree holds it are part of it too. Edits to files that were left out are not.
 */
async function selectionBinding(snapshot: RepoSnapshot, changes: SelectedChange[], target?: string) {
  const targetTip = target ? await optionalGit(snapshot.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${target}`]) : "";
  const holder = target ? snapshot.branches.find((branch) => branch.name === target)?.checkedOutIn ?? "" : "";
  const ordered = [...changes].sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify([
    snapshot.path, snapshot.head, snapshot.currentBranch, snapshot.pending ?? null, snapshot.conflicts.length, ordered, target ?? "", targetTip, holder
  ])).digest("hex");
}

/** The versions the selected files have now; a file that is no longer listed has none. */
function currentVersions(snapshot: RepoSnapshot, changes: SelectedChange[]): SelectedChange[] {
  return changes.map((change) => ({ path: change.path, version: snapshot.changes.find((item) => item.path === change.path)?.version ?? "missing" }));
}

/** Whether saving these paths would record anything at all, compared with the last saved version. */
async function selectionHasChanges(snapshot: RepoSnapshot, paths: string[]) {
  const scope = literalPaths(paths);
  if ((await checkedGit(snapshot.path, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...scope])).length) return true;
  const result = await runGit(snapshot.path, ["diff", "--quiet", "--no-ext-diff", snapshot.head || await emptyTree(snapshot.path), "--", ...scope]);
  if (result.code > 1) throw new Error(result.stderr.trim() || `git diff terminó con código ${result.code}`);
  return result.code === 1;
}

/**
 * Files left out of a save that would stop the switch to the target branch. The save leaves them as
 * they are, so after it the branch still has their last saved version: where the target's version is
 * different, or the target has a file where an untracked one sits, Git refuses to switch rather than
 * overwrite them. They are named here instead of being saved behind the person's back.
 */
async function integrationBlockers(snapshot: RepoSnapshot, excluded: FileChange[], target: string) {
  if (!excluded.length || !snapshot.head) return [];
  const paths = [...new Set(excluded.flatMap(changePaths))];
  const raw = await checkedGit(snapshot.path, ["diff", "--name-only", "-z", "--no-renames", "HEAD", `refs/heads/${target}`, "--", ...literalPaths(paths)], true);
  const differing = raw.split("\0").filter(Boolean);
  return excluded.filter((change) => changePaths(change).some((path) => differing.some((item) => item === path || item.startsWith(`${path}/`))));
}

function blockersText(blockers: FileChange[], branch: string, target: string, language: Locale) {
  const list = blockers.map((change) => change.path).join(", ");
  return localized(language,
    `No se guardó ni se integró nada. Estos archivos que dejaste fuera tienen cambios sin guardar que Git tendría que sobrescribir al cambiar a ${target}: ${list}. GitCat no los guarda por su cuenta. Puedes marcarlos para incluirlos en este guardado, guardar ahora solo los archivos marcados en ${branch} sin integrar (desmarca «integrar»), o integrar más tarde, cuando hayas decidido qué hacer con ellos.`,
    `Nothing was saved or integrated. These files you left out have unsaved changes that Git would have to overwrite when switching to ${target}: ${list}. GitCat does not save them on its own. You can tick them to include them in this save, save only the ticked files on ${branch} now without integrating (untick “integrate”), or integrate later, once you have decided what to do with them.`);
}

/** What the confirmation says a save of selected files will and will not do, file by file where it matters. */
function selectionEffects(selection: { selected: FileChange[]; excluded: FileChange[] }, branch: string, language: Locale) {
  const effects: string[] = [];
  const { selected, excluded } = selection;
  effects.push(excluded.length
    ? localized(language,
      `Solo se guardarán los ${selected.length} archivos marcados en ${branch}. Los ${excluded.length} que dejaste fuera se quedan exactamente como están, sin guardar.`,
      `Only the ${selected.length} ticked files will be saved on ${branch}. The ${excluded.length} you left out stay exactly as they are, unsaved.`)
    : localized(language,
      `Se guardarán todos los ${selected.length} archivos listados, incluidos los nuevos, en ${branch}.`,
      `All ${selected.length} listed files, including new files, will be saved on ${branch}.`));
  const partial = selected.filter(isPartlyStaged).map((change) => change.path);
  if (partial.length) effects.push(localized(language,
    `${partial.join(", ")} tenía cambios preparados y otros sin preparar: se guarda el archivo completo tal como está ahora en tu disco.`,
    `${partial.join(", ")} had both staged and unstaged edits: the whole file is saved as it is on your disk now.`));
  for (const change of selected.filter((item) => item.from)) effects.push(localized(language,
    `El renombrado de ${change.from} a ${change.path} se guarda completo: ${change.from} deja de existir y ${change.path} queda guardado.`,
    `The rename from ${change.from} to ${change.path} is saved as a whole: ${change.from} goes away and ${change.path} is saved.`));
  if (excluded.some((change) => change.xy && !" ?!".includes(change.xy[0]))) effects.push(localized(language,
    "Lo que ya habías preparado (staged) en los archivos que dejaste fuera sigue preparado y no entra en este guardado.",
    "Anything you had already staged in the files you left out stays staged and is not part of this save."));
  return effects;
}

/** A save of these paths only. The command reads as Git's own "only these paths" commit, which is what it does. */
function selectedCommitCommand(message: string, paths: string[]) {
  return ["git", "commit", "--only", "-m", message, "--", ...paths].map(quoteToken).join(" ");
}

/**
 * Explicit workflow: save reviewed files on the current branch, optionally integrate locally. With a
 * selection only those files are saved, bound to the versions that were reviewed; without one every
 * listed file is saved and the whole repository state is the binding, as it always was.
 */
export async function prepareBranchDelivery(cwd: string, request: DeliveryRequest, locale?: Locale) {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  const fail = (es: string, en: string): never => { throw new Error(localized(language, es, en)); };
  const picked = request.selection;
  if (!picked && snapshot.stateId !== request.stateId) fail("Los archivos o las ramas cambiaron. Revisa los cambios de nuevo antes de guardar.", "Files or branches changed. Review the changes again before saving.");
  if (snapshot.pending || snapshot.conflicts.length) fail("Resuelve la operación pendiente antes de guardar e integrar. Tus archivos siguen disponibles.", "Resolve the pending operation before saving and integrating. Your files remain available.");
  const source = snapshot.branches.find((branch) => branch.isCurrent);
  if ((!source && snapshot.head) || snapshot.currentBranch === "HEAD") fail("Cambia a una rama antes de guardar este trabajo.", "Switch to a branch before saving this work.");
  const target = snapshot.defaultBranch;
  if (request.mergeToDefault) {
    if (!target || target === snapshot.currentBranch) fail("Elige una rama de trabajo distinta de la principal para integrar cambios.", "Choose a work branch different from the main branch to integrate changes.");
    const destination = snapshot.branches.find((branch) => branch.name === target);
    if (!destination || destination.presence === "remote") fail("La rama principal debe existir en este equipo antes de integrar.", "The main branch must exist on this computer before integrating.");
    if (destination?.checkedOutIn) fail(`La rama ${target} está abierta en otro worktree. Guarda primero o continúa allí.`, `Branch ${target} is open in another worktree. Save first or continue there.`);
    if (!snapshot.isDirty && !picked) {
      const plan = await prepareMergeToDefault(cwd, snapshot.currentBranch, locale);
      if (plan.stateId !== request.stateId) fail("El repositorio cambió. Revisa el plan de nuevo.", "The repository changed. Review the plan again.");
      return plan;
    }
  }
  if (!snapshot.changes.length) fail("No hay archivos pendientes que guardar.", "There are no pending files to save.");
  const resolved = picked ? resolveSelection(snapshot.changes, picked) : undefined;
  if (resolved && "problem" in resolved) throw new Error(selectionProblemText(resolved.problem, language));
  const selection = resolved && !("problem" in resolved) ? resolved : undefined;
  if (selection && !await selectionHasChanges(snapshot, selection.paths)) fail(
    "Los archivos marcados ya coinciden con la última versión guardada, así que no hay nada que guardar de ellos (pasa, por ejemplo, cuando se deshace en el archivo un cambio que estaba preparado). Marca otros archivos o déjalos como están.",
    "The ticked files already match the last saved version, so there is nothing to save from them (this happens, for example, when a staged edit was undone in the file itself). Tick other files, or leave them as they are.");
  // Before anything else is prepared: a save that would record what looks like a credential is a
  // question with choices, and only a person who looked at it can turn it into a plan.
  const secrets = saveFindings(await changeChunks(snapshot, selection?.paths));
  if (secrets.length && request.secretsReviewed !== true) {
    return bindPlan(snapshot, {
      ...refused(localized(language,
        `No se guardó nada. Estos archivos parecen contener una contraseña, una clave o un token: ${secretsText(secrets, language)}. Guardarlos los deja en el historial del repositorio, donde es difícil borrarlos una vez publicados. Puedes dejarlos fuera del guardado (desmarcarlos), pedir a Git que ignore los archivos nuevos, o revisarlos y guardarlos de todas formas si sabes que no son secretos reales.`,
        `Nothing was saved. These files look like they hold a password, a key or a token: ${secretsText(secrets, language)}. Saving puts them in the repository history, where they are hard to remove once published. You can leave them out of the save (untick them), ask Git to ignore the new ones, or review them and save anyway if you know they are not real secrets.`),
        "guardrail", localized(language, "Revisa los posibles secretos antes de guardar", "Review the likely secrets before saving"), "question"),
      secrets
    });
  }
  const message = request.message?.trim() ?? "";
  const commit = stepFrom("commit", { message }, [], language)!;
  const steps = [selection ? { ...commit, paths: selection.paths, command: selectedCommitCommand(message, selection.paths) } : commit];
  if (request.mergeToDefault) {
    if (selection) {
      const blockers = await integrationBlockers(snapshot, selection.excluded, target!);
      if (blockers.length) {
        return bindPlan(snapshot, refused(blockersText(blockers, snapshot.currentBranch, target!, language), "guardrail",
          localized(language, `Hay archivos fuera del guardado que impiden integrar en ${target}`, `Files left out of the save block integrating into ${target}`)));
      }
    }
    steps.push(stepFrom("checkout", { name: target! }, [], language)!);
    steps.push(stepFrom("merge", { name: snapshot.currentBranch }, [], language)!);
  }
  const effects = selection ? selectionEffects(selection, snapshot.currentBranch, language) : [localized(language,
    `Se guardarán todos los ${snapshot.changes.length} archivos listados, incluidos los nuevos, en ${snapshot.currentBranch}.`,
    `All ${snapshot.changes.length} listed files, including new files, will be saved on ${snapshot.currentBranch}.`)];
  if (secrets.length) effects.push(savingSecretsEffect(secrets, language));
  effects.push(localized(language, "La operación es local: no publica cambios ni elimina tu rama.", "This is local: it does not publish changes or delete your branch."));
  if (request.mergeToDefault) effects.push(localized(language,
    `Al terminar estarás en ${target}. Si hay conflictos, la integración se detendrá y el commit guardado seguirá en ${snapshot.currentBranch}.`,
    `You will finish on ${target}. If conflicts occur, integration stops and the saved commit remains on ${snapshot.currentBranch}.`));
  if (request.mergeToDefault && selection?.excluded.length) effects.push(localized(language,
    `Los ${selection.excluded.length} archivos que dejaste fuera no se integran: siguen sin guardar en tu carpeta de trabajo y te acompañan a ${target}.`,
    `The ${selection.excluded.length} files you left out are not integrated: they stay unsaved in your working folder and come along to ${target}.`));
  const draft = sequenceDraft(steps, request.mergeToDefault ? localized(language, "Guarda el trabajo revisado antes de integrarlo.", "Saves the reviewed work before integrating it.") : localized(language, "Crea una versión local del trabajo revisado en tu rama.", "Creates a local saved version of the reviewed work on your branch."), effects, language);
  const summary = request.mergeToDefault
    ? localized(language, `Guardar e integrar en ${target}`, `Save and integrate into ${target}`)
    : localized(language, `Guardar cambios en ${snapshot.currentBranch}`, `Save changes on ${snapshot.currentBranch}`);
  const reviewed = selection ? selectedVersions(selection.selected) : undefined;
  const bound = reviewed ? { changes: reviewed, binding: await selectionBinding(snapshot, reviewed, request.mergeToDefault ? target : undefined), ...(request.mergeToDefault ? { target } : {}) } : undefined;
  const plan = bindPlan(snapshot, { ...draft, summary, ...(bound ? { selection: bound } : {}), ...(secrets.length ? { secrets } : {}) });
  validateExecution(plan, snapshot, language, bound?.binding);
  return plan;
}

/**
 * Saves only the selected paths, in a commit built from a private copy of the index. The copy starts
 * from the last saved version, each selected path is recorded whole as it is on disk (so a file with
 * both staged and unstaged edits is saved complete), and the commit runs with hooks as usual. The real
 * index is only touched afterwards, and only for those paths: whatever was staged in any other file
 * stays staged, and every file that was left out keeps its contents on disk.
 */
async function commitSelected(repoRoot: string, paths: string[], message: string, locale?: Locale) {
  const language = normalizeLocale(locale);
  const head = await optionalGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const directory = mkdtempSync(join(tmpdir(), "gitcat-save-"));
  const index = join(directory, "index");
  const git = (args: string[], timeoutMs = 120_000) => runCommand("git", args, repoRoot, timeoutMs, { GIT_INDEX_FILE: index });
  const detail = (result: CommandResult, args: string[]) => [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || `git ${args[0]} terminó con código ${result.code}`;
  try {
    if (head) {
      // Starting from a copy keeps what Git knows about unchanged files, so it does not re-read them all.
      const real = await optionalGit(repoRoot, ["rev-parse", "--git-path", "index"]);
      if (real && existsSync(resolve(repoRoot, real))) copyFileSync(resolve(repoRoot, real), index);
      let seeded = await git(["read-tree", "-m", "HEAD"]);
      if (seeded.code !== 0) {
        rmSync(index, { force: true });
        seeded = await git(["read-tree", "HEAD"]);
        if (seeded.code !== 0) throw new Error(detail(seeded, ["read-tree"]));
      }
    }
    // A path that is neither on disk nor in the last saved version has nothing to record.
    const listed = await git(["ls-files", "-z", "--", ...literalPaths(paths)]);
    const known = new Set(listed.stdout.split("\0").filter(Boolean));
    const present = paths.filter((path) => known.has(path) || existsSync(resolve(repoRoot, path)) || isSymlink(resolve(repoRoot, path)));
    if (present.length) {
      const added = await git(["add", "-A", "--", ...literalPaths(present)]);
      if (added.code !== 0) throw new Error(detail(added, ["add"]));
    }
    const pendingSave = head
      ? (await git(["diff", "--cached", "--quiet", "HEAD", "--"])).code === 1
      : Boolean((await git(["ls-files", "-z"])).stdout);
    if (!pendingSave) throw new Error(localized(language, "Los archivos marcados ya coinciden con la última versión guardada; no se guardó nada.", "The ticked files already match the last saved version; nothing was saved."));
    // Hooks run as they would for any commit, and see the files being saved as the staged ones.
    const committed = await git(["commit", "-m", message], 600_000);
    const output = detail(committed, ["commit"]);
    if (committed.code !== 0) throw new Error(output);
    const reset = await runGit(repoRoot, ["reset", "-q", "--", ...literalPaths(paths)]);
    if (reset.code !== 0) {
      const saved = await optionalGit(repoRoot, ["rev-parse", "--short", "HEAD"]);
      throw new Error(localized(language,
        `Los archivos marcados se guardaron en el commit ${saved}, pero Git no pudo actualizar su lista de cambios preparados para ellos: ${detail(reset, ["reset"])}. Tus archivos en disco no cambiaron.`,
        `The ticked files were saved in commit ${saved}, but Git could not update its list of staged changes for them: ${detail(reset, ["reset"])}. Your files on disk did not change.`));
    }
    return output;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function isSymlink(path: string) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/**
 * The .gitignore rule for one untracked file, prepared for review. Only a file Git does not track yet
 * can be ignored this way: a rule never stops Git from seeing changes to a file it already tracks, so
 * that case is explained instead of being turned into a rule that would look like it worked.
 */
function prepareIgnore(snapshot: RepoSnapshot, path: string, language: Locale) {
  const change = snapshot.changes.find((item) => item.path === path);
  if (!change || !isUntracked(change)) throw new Error(ignoreTrackedText(path, Boolean(change), language));
  const line = gitignoreLine(path);
  if (!line) throw new Error(localized(language, `No se puede escribir una regla de .gitignore de una sola línea para ${JSON.stringify(path)}. No se cambió nada.`, `A single-line .gitignore rule cannot be written for ${JSON.stringify(path)}. Nothing was changed.`));
  const target = join(snapshot.path, ".gitignore");
  const existing = (() => {
    try { return lstatSync(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  })();
  // A link or a folder named .gitignore is not something to write through.
  if (existing && !existing.isFile()) throw new Error(localized(language, ".gitignore no es un archivo normal en este repositorio, así que GitCat no lo modifica. No se cambió nada.", ".gitignore is not a regular file in this repository, so GitCat does not modify it. Nothing was changed."));
  const exists = Boolean(existing);
  const draft = operationDraft("ignore_path", { path, line }, snapshot, [], language);
  const plan = bindPlan(snapshot, {
    ...draft,
    effects: [
      exists
        ? localized(language, `Se añade esta línea al final de .gitignore: ${line}`, `This line is added at the end of .gitignore: ${line}`)
        : localized(language, `Se crea .gitignore en la raíz del repositorio con esta línea: ${line}`, `.gitignore is created at the root of the repository with this line: ${line}`),
      localized(language, `La regla solo coincide con ${path}; otros archivos con un nombre parecido no se ven afectados.`, `The rule matches ${path} only; other files with a similar name are not affected.`),
      localized(language, `${path} se queda en tu disco tal como está; Git solo deja de listarlo como trabajo nuevo.`, `${path} stays on your disk exactly as it is; Git only stops listing it as new work.`),
      localized(language, "El cambio en .gitignore aparece como un archivo por guardar, para que puedas compartir la regla o deshacerla.", "The .gitignore edit shows up as a file to save, so you can share the rule or undo it."),
      localized(language, "Ignorar solo funciona con archivos que Git todavía no sigue. Los archivos que ya están guardados en Git se siguen vigilando aunque coincidan con una regla.", "Ignoring only works for files Git does not track yet. Files already saved in Git keep being tracked even when a rule matches them.")
    ]
  });
  validateExecution(plan, snapshot, language);
  return plan;
}

function ignoreTrackedText(path: string, listed: boolean, language: Locale) {
  return listed
    ? localized(language,
      `${path} ya lo sigue Git, así que una regla de .gitignore no haría que Git dejara de ver sus cambios: ignorar solo funciona con archivos nuevos que Git todavía no sigue. Para dejar de seguirlo habría que quitarlo de Git (el archivo puede quedarse en tu disco); pídeselo al asistente y te enseñará el plan antes de cambiar nada. No se cambió nada.`,
      `Git already tracks ${path}, so a .gitignore rule would not stop Git from seeing its changes: ignoring only works for new files Git does not track yet. To stop tracking it, it would have to be removed from Git (the file can stay on your disk); ask the assistant and it will show you the plan before changing anything. Nothing was changed.`)
    : localized(language,
      `${path} ya no aparece como archivo nuevo, así que no hay nada que ignorar. No se cambió nada; revisa la lista actualizada.`,
      `${path} is no longer listed as a new file, so there is nothing to ignore. Nothing was changed; review the updated list.`);
}

/** Appends the reviewed rule, then asks Git whether it now ignores the file; if not, .gitignore is put back as it was. */
async function ignorePath(repoRoot: string, args: Record<string, string>, locale?: Locale) {
  const language = normalizeLocale(locale);
  const target = join(repoRoot, ".gitignore");
  let previous: string | undefined;
  try {
    if (!lstatSync(target).isFile()) throw new Error(localized(language, ".gitignore no es un archivo normal en este repositorio, así que GitCat no lo modifica.", ".gitignore is not a regular file in this repository, so GitCat does not modify it."));
    previous = readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const separator = previous && !previous.endsWith("\n") ? "\n" : "";
  writeFileSync(target, `${previous ?? ""}${separator}${args.line}\n`);
  const check = await runGit(repoRoot, ["check-ignore", "-q", "--", args.path]);
  if (check.code !== 0) {
    if (previous === undefined) unlinkSync(target); else writeFileSync(target, previous);
    throw new Error(localized(language,
      `Git no ignoró ${args.path} con la nueva línea, así que .gitignore se dejó como estaba. El archivo sigue en tu disco y en la lista de cambios.`,
      `Git did not ignore ${args.path} with the new line, so .gitignore was left as it was. The file is still on your disk and in the list of changes.`));
  }
  return localized(language, `Git ya no listará ${args.path}. Se añadió ${args.line} a .gitignore; el archivo sigue en tu disco.`, `Git will no longer list ${args.path}. ${args.line} was added to .gitignore; the file is still on your disk.`);
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
  if (["delete_branch", "rename_branch", "merge"].includes(operation) && !snapshot.branches.some((branch) => branch.name === args.name)
      && !(operation === "merge" && isCurrentUpstream(snapshot, args.name))) throw new Error(localized(language, `La rama ${args.name} no existe localmente.`, `Branch ${args.name} does not exist locally.`));
  // A remote-only branch has no local ref: switching to it creates one, but deleting, renaming or merging it cannot work.
  if (["delete_branch", "rename_branch", "merge", "rebase"].includes(operation)) {
    const target = args.name || args.onto;
    const remoteOnly = snapshot.branches.find((branch) => branch.name === target)?.presence === "remote";
    if (remoteOnly) throw new Error(localized(language, `La rama ${target} solo existe en el remoto. Cámbiate a ella primero para tenerla en local.`, `Branch ${target} only exists on the remote. Switch to it first to create it locally.`));
  }
  if (operation === "merge" && args.name === snapshot.currentBranch) throw new Error(localized(language, `No puedes fusionar ${args.name} consigo misma.`, `You cannot merge ${args.name} into itself.`));
  if (operation === "rebase" && !snapshot.branches.some((branch) => branch.name === args.onto) && !isCurrentUpstream(snapshot, args.onto)) throw new Error(localized(language, `La rama base ${args.onto} no existe localmente.`, `Base branch ${args.onto} does not exist locally.`));
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
  if (operation === "commit" && step.paths) {
    const listed = new Set(snapshot.changes.flatMap(changePaths));
    const missing = step.paths.find((path) => !listed.has(path));
    if (!step.paths.length || missing) throw new Error(localized(language, `${missing ?? "—"} ya no es un cambio sin guardar. Revisa los archivos de nuevo.`, `${missing ?? "—"} is no longer an unsaved change. Review the files again.`));
  }
  if (operation === "push" && args.setUpstream !== undefined) {
    if (!snapshot.remotes.includes(args.setUpstream)) throw new Error(localized(language, `El remoto ${args.setUpstream} no existe en este repositorio.`, `Remote ${args.setUpstream} does not exist in this repository.`));
    if (snapshot.currentBranch === "HEAD" || args.branch !== snapshot.currentBranch || !isBranchNameSafe(args.branch)) {
      throw new Error(localized(language, "Solo se puede publicar la rama activa, y no es la que nombra este plan.", "Only the active branch can be published, and it is not the one this plan names."));
    }
  }
  if (operation === "set_identity") {
    const user = args.user?.trim() ?? "";
    if (!user || user.length > 100 || /[\p{Cc}<>]/u.test(user)) throw new Error(localized(language, "Escribe el nombre con el que quieres firmar tus commits.", "Type the name you want your commits signed with."));
    if (!args.email || args.email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+$/.test(args.email)) throw new Error(localized(language, "Escribe un correo con la forma nombre@dominio.", "Type an email in the form name@domain."));
    // Only the two places a person can pick: this repository, or every repository on this Mac.
    if (args.scope !== undefined && args.scope !== "local" && args.scope !== "global") throw new Error(localized(language, "Elige si el nombre y el correo son para este repositorio o para todos.", "Choose whether the name and email are for this repository or for all of them."));
  }
  if (operation === "add_remote") {
    if (!remoteNamePattern.test(args.name ?? "")) throw new Error(localized(language, "El nombre del remoto no es válido.", "The remote name is invalid."));
    if (snapshot.remotes.includes(args.name)) throw new Error(localized(language, `Ya existe un remoto llamado ${args.name}.`, `A remote named ${args.name} already exists.`));
    if (!remoteAddressPattern.test(args.url ?? "")) {
      throw new Error(localized(language, "Esa dirección no parece la de un repositorio. Suele empezar por https:// o git@, como la que muestra tu servicio de Git al crear el repositorio.", "That does not look like a repository address. It usually starts with https:// or git@, like the one your Git host shows when you create the repository."));
    }
  }
  if (operation === "ignore_path") {
    const change = snapshot.changes.find((item) => item.path === args.path);
    if (!change || !isUntracked(change)) throw new Error(ignoreTrackedText(args.path ?? "", Boolean(change), language));
    if (!args.line || gitignoreLine(args.path) !== args.line) throw new Error(localized(language, "La regla de .gitignore no es válida.", "The .gitignore rule is invalid."));
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

/** The remote-tracking branch the active branch follows: merging or replaying it is what reconciling means. */
function isCurrentUpstream(snapshot: RepoSnapshot, ref: string | undefined) {
  return Boolean(ref) && snapshot.branches.some((branch) => branch.isCurrent && branch.upstream === ref);
}

/** What a remote address looks like: a URL, an scp-style SSH address, or an absolute path. Never an option. */
const remoteAddressPattern = /^(?:(?:https?|ssh|git|file):\/\/[^\s]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+|\/[^\s]*)$/;

/** The repository moved after the plan was prepared, so nothing ran. Recovery tells it apart from a Git failure. */
export class StalePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StalePlanError";
  }
}

/**
 * The plan as issued: it must belong to this repository, and the repository must not have moved under
 * it. A save of selected files passes its binding as it stands now; everything else is held to the
 * whole repository state.
 */
function validateExecution(plan: ActionPlan, snapshot: RepoSnapshot, locale?: Locale, selectionNow?: string) {
  const language = normalizeLocale(locale);
  if (!plan.allowed || !plan.steps.length) throw new Error(localized(language, "La acción no está permitida.", "The action is not allowed."));
  if (plan.answer) throw new Error(localized(language, "Las consultas informativas no se ejecutan como operaciones Git.", "Informational questions are not executed as Git operations."));
  if (plan.repoPath !== snapshot.path) throw new Error(localized(language, "El plan pertenece a otro repositorio.", "The plan belongs to another repository."));
  if (plan.head !== snapshot.head) throw new StalePlanError(localized(language, "El repositorio cambió desde que se preparó el plan. Prepara la acción de nuevo.", "The repository changed after this plan was prepared. Prepare the action again."));
  if (plan.selection) {
    if (selectionNow !== plan.selection.binding) throw new StalePlanError(localized(language,
      "Un archivo marcado, su versión preparada o la rama de destino cambió después de la revisión, así que no se guardó nada. Revisa los archivos marcados de nuevo.",
      "A ticked file, its staged version or the target branch changed after the review, so nothing was saved. Review the ticked files again."));
  } else if (plan.stateId !== snapshot.stateId) throw new StalePlanError(localized(language, "Los cambios locales variaron desde que se preparó el plan. Prepara la acción de nuevo.", "Local changes moved after this plan was prepared. Prepare the action again."));
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
    case "push": return reportedGit(cwd, [
      "push", ...(args.noVerify === "true" ? ["--no-verify"] : []), ...(args.setUpstream ? ["--set-upstream", args.setUpstream, args.branch] : [])
    ]);
    case "set_identity": {
      const global = args.scope === "global";
      await checkedGit(cwd, ["config", global ? "--global" : "--local", "user.name", args.user]);
      await checkedGit(cwd, ["config", global ? "--global" : "--local", "user.email", args.email]);
      return global
        ? localized(locale, `Los commits de los repositorios de este Mac sin identidad propia se firmarán como ${args.user} <${args.email}>.`, `Commits in repositories on this Mac without their own identity will be signed as ${args.user} <${args.email}>.`)
        : localized(locale, `Los commits de este repositorio se firmarán como ${args.user} <${args.email}>.`, `Commits in this repository will be signed as ${args.user} <${args.email}>.`);
    }
    case "add_remote": return reportedGit(cwd, ["remote", "add", args.name, args.url]);
    case "merge": return reportedGit(cwd, ["merge", "--no-edit", "--", args.name]);
    case "rebase": return reportedGit(cwd, ["rebase", args.onto]);
    case "abort_operation": return reportedGit(cwd, [pendingCommands[snapshot.pending!.kind], "--abort"]);
    case "continue_operation": return reportedGit(cwd, [pendingCommands[snapshot.pending!.kind], "--continue"]);
    case "skip_operation": return reportedGit(cwd, [pendingCommands[snapshot.pending!.kind], "--skip"]);
    case "resolve_conflict": return runResolveConflict(cwd, args, snapshot, locale);
    case "commit":
      if (step.paths) return commitSelected(snapshot.path, step.paths, args.message, locale);
      await checkedGit(cwd, ["add", "-A"]);
      return reportedGit(cwd, ["commit", "-m", args.message]);
    case "ignore_path": return ignorePath(snapshot.path, args, locale);
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
 * Whether what a plan printed is something the assistant may not read: a command aimed at an excluded
 * or credential file, or output that itself looks like it holds a credential. The person still sees it.
 */
function showsWithheld(plan: ActionPlan, outcomes: StepOutcome[]) {
  const exclusions = recallSharing(memory, plan.repoPath).exclusions;
  return plan.steps.some((step) => step.operation === "git_command" && argvShowsWithheld(step.argv ?? [], exclusions)) ||
    outcomes.some((outcome) => redactText(outcome.output).redacted > 0);
}

/**
 * Runs the approved plan end to end. Each step is validated against the repository the previous step
 * produced, and the first failure stops the sequence: a half-finished merge must never be reported as
 * done, and the steps that never ran are named so the user knows exactly where things stand.
 */
export async function executePlan(cwd: string, plan: ActionPlan, locale?: Locale): Promise<{ snapshot: RepoSnapshot; output: string; error?: string; outcomes: StepOutcome[]; withheldFromAssistant?: boolean }> {
  const language = normalizeLocale(locale);
  let snapshot = await getSnapshot(cwd);
  const selectionNow = plan.selection ? await selectionBinding(snapshot, currentVersions(snapshot, plan.selection.changes), plan.selection.target) : undefined;
  validateExecution(plan, snapshot, language, selectionNow);
  if (plan.selection?.target) {
    // Files left out can have changed since the review; one that now blocks the switch is named before anything is saved.
    const resolved = resolveSelection(snapshot.changes, plan.selection.changes);
    const blockers = "problem" in resolved ? [] : await integrationBlockers(snapshot, resolved.excluded, plan.selection.target);
    if (blockers.length) throw new Error(blockersText(blockers, snapshot.currentBranch, plan.selection.target, language));
  }
  const outcomes: StepOutcome[] = plan.steps.map((step) => ({ command: step.command, summary: step.summary, status: "skipped", output: "" }));

  for (const [index, step] of plan.steps.entries()) {
    if (operationContext()?.signal.aborted) {
      operationPhase("inspecting");
      return { snapshot: await inspectOperation(() => getSnapshot(cwd)), output: executionReport(outcomes, language),
        error: localized(language, "Se detuvo antes del siguiente paso. Los cambios completados siguen hechos; no se deshizo nada.", "Stopped before the next step. Completed changes remain; nothing was rolled back."), outcomes };
    }
    operationPhase("executing", index + 1, plan.steps.length);
    try {
      if (index > 0) {
        snapshot = await getSnapshot(cwd);
        validateStep(step, snapshot, language);
      }
      outcomes[index] = { ...outcomes[index], status: "completed", output: await runStep(cwd, step, plan, snapshot, language) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : localized(language, "Git no pudo completar la acción.", "Git could not complete the action.");
      outcomes[index] = { ...outcomes[index], status: "failed", output: detail };
      operationPhase("inspecting");
      const failedSnapshot = await inspectOperation(() => getSnapshot(cwd));
      return {
        snapshot: failedSnapshot,
        output: executionReport(outcomes, language),
        error: failureReport(outcomes, outcomes[index], detail, failedSnapshot, language),
        outcomes,
        ...(showsWithheld(plan, outcomes) ? { withheldFromAssistant: true } : {})
      };
    }
  }
  operationPhase("inspecting");
  return { snapshot: await inspectOperation(() => getSnapshot(cwd)), output: executionReport(outcomes, language), outcomes, ...(showsWithheld(plan, outcomes) ? { withheldFromAssistant: true } : {}) };
}

/**
 * What the main process keeps about a plan that stopped: the plan as approved and what each of its
 * steps did. Recovery reads this instead of what the interface reports, so "completed" is a fact.
 */
export type FailedPlanRecord = { plan: ActionPlan; outcomes: StepOutcome[]; stale: boolean };

const hooksFor: Partial<Record<Operation, string[]>> = {
  commit: ["pre-commit", "prepare-commit-msg", "commit-msg"],
  merge: ["pre-merge-commit", "prepare-commit-msg", "commit-msg"],
  push: ["pre-push"],
  rebase: ["pre-rebase"]
};

/** The first executable hook Git would run for this operation, wherever core.hooksPath points. */
async function activeHook(repoRoot: string, operation: Operation | undefined) {
  const names = operation ? hooksFor[operation] : undefined;
  if (!names) return undefined;
  const hooks = resolve(repoRoot, await optionalGit(repoRoot, ["rev-parse", "--git-path", "hooks"]) || ".git/hooks");
  return names.find((name) => {
    try { accessSync(join(hooks, name), constants.X_OK); return statSync(join(hooks, name)).isFile(); } catch { return false; }
  });
}

/** A lock file Git named, or the index lock when it is still there, relative to the repository. */
async function lockInTheWay(repoRoot: string, detail: string) {
  const named = /Unable to create '([^']+\.lock)'/.exec(detail)?.[1];
  if (named) return relativeTo(repoRoot, named);
  const index = resolve(repoRoot, await optionalGit(repoRoot, ["rev-parse", "--git-path", "index.lock"]) || ".git/index.lock");
  return existsSync(index) ? relativeTo(repoRoot, index) : undefined;
}

function relativeTo(repoRoot: string, path: string) {
  const absolute = resolve(repoRoot, path);
  return absolute.startsWith(repoRoot + sep) ? absolute.slice(repoRoot.length + 1) : absolute;
}

/** A plan can be prepared again only from steps it can still vouch for. */
function retryableRecord(record: FailedPlanRecord | undefined) {
  if (!record) return false;
  const remaining = record.outcomes.some((outcome) => outcome.status !== "completed");
  // A save of selected files is bound to the reviewed versions; it is reviewed again, not replayed.
  return remaining && !record.plan.selection && !record.plan.repositoryPlan && record.plan.steps.every((step) => step.operation !== "github_create_repo");
}

/**
 * A failure explained from facts, with no assistant involved: the repository is read again, Git's own
 * words are classified, and the ways on are the ones this state supports. It is what the interface
 * shows first, whether or not a provider is configured, answering or even reachable.
 */
export async function describeFailure(cwd: string, failure: ExecutionFailure, record?: FailedPlanRecord, known: { stale?: boolean } = {}): Promise<RecoveryReport> {
  const snapshot = await getSnapshot(cwd);
  const outcomes = record?.outcomes;
  const failedIndex = outcomes ? outcomes.findIndex((outcome) => outcome.status === "failed") : -1;
  const failedOutcome = failedIndex >= 0 ? outcomes![failedIndex] : undefined;
  const failedStep = record ? record.plan.steps[failedIndex >= 0 ? failedIndex : 0] : undefined;
  const stale = Boolean(record?.stale || known.stale || failure.stage === "stale");
  // Git's raw words, when the plan's record has them: the error the interface shows may already be a translation.
  const detail = (failedOutcome?.output || failure.error || "").slice(0, 4_000);
  const operation = failedStep?.operation ?? operationFromCommand(failure.command);
  const evidence: FailureEvidence = {
    operation,
    command: failedOutcome?.command ?? failure.command,
    detail,
    stale,
    hook: await activeHook(snapshot.path, operation),
    lock: await lockInTheWay(snapshot.path, detail),
    // Only a plan that never ran can say the repository moved under it; a partial run moved it itself.
    moved: stale && Boolean(record && record.plan.head !== snapshot.head)
  };
  const kind = classifyFailure(evidence, snapshot);
  const facts = recoveryFacts(snapshot, evidence);
  const { actions, choice, needsJudgment } = recoveryActions(kind, facts, evidence, {
    retryable: retryableRecord(record) && !["conflict", "pending", "divergent", "missing_upstream", "no_remote"].includes(kind),
    selectionBound: Boolean(record?.plan.selection)
  });
  return {
    repoPath: snapshot.path,
    kind,
    stage: stale ? "stale" : record || failure.stage === "execute" ? "execute" : "prepare",
    failedSummary: failedOutcome?.summary ?? failure.summary,
    detail,
    completed: outcomes ? outcomes.filter((outcome) => outcome.status === "completed").map((outcome) => outcome.summary) : [],
    notRun: outcomes ? outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.summary) : failure.skipped.filter((summary) => summary !== failure.summary),
    facts,
    actions,
    ...(choice ? { choice } : {}),
    needsJudgment
  };
}

/**
 * Prepares again, from a fresh read of the repository, only the steps of a stopped plan that never
 * completed. What already ran is never offered again, the result is validated like any plan, and a
 * step that changes anything still waits for the person's confirmation.
 */
export async function prepareRetry(cwd: string, record: FailedPlanRecord, locale?: Locale): Promise<ActionPlan> {
  const language = normalizeLocale(locale);
  const snapshot = await getSnapshot(cwd);
  if (record.plan.repoPath !== snapshot.path) throw new Error(localized(language, "El plan pertenece a otro repositorio.", "The plan belongs to another repository."));
  if (!retryableRecord(record)) {
    throw new Error(record.plan.selection
      ? localized(language, "Este guardado dependía de los archivos que revisaste. Revísalos de nuevo para guardarlos; nada se repite solo.", "This save depended on the files you reviewed. Review them again to save them; nothing is repeated on its own.")
      : localized(language, "No queda ningún paso de este plan que se pueda volver a preparar.", "No step of this plan is left that can be prepared again."));
  }
  // A half-finished merge or rebase decides what comes next; running the rest over it would only fail again.
  if (snapshot.pending || snapshot.conflicts.length) {
    throw new Error(localized(language,
      "Hay una operación de Git a medias. Termínala o abórtala primero; lo que ya se hizo sigue hecho y no se repite.",
      "A Git operation is still half-finished. Finish or abort it first; what already ran stays done and is not repeated."));
  }
  const start = record.outcomes.findIndex((outcome) => outcome.status !== "completed");
  const remaining = record.plan.steps.slice(start);
  const completed = record.outcomes.slice(0, start).map((outcome) => outcome.summary);
  const draft = sequenceDraft(remaining, localized(language,
    "Se prepara de nuevo con el repositorio tal como está ahora. Solo incluye lo que no llegó a completarse.",
    "Prepared again against the repository as it is now. It only includes what did not complete."), [
    ...(completed.length ? [localized(language, `Ya hecho, no se repite: ${completed.join(", ")}.`, `Already done, not repeated: ${completed.join(", ")}.`)] : []),
    ...(record.plan.effects ?? [])
  ], language);
  const plan = bindPlan(snapshot, draft);
  validateExecution(plan, snapshot, language);
  return plan;
}

function settingsPath() { return join(app.getPath("userData"), "gitcat-settings.json"); }

export function loadLlmConfig() {
  let saved: { model?: string; encryptedApiKey?: string };
  try { saved = JSON.parse(readFileSync(settingsPath(), "utf8")); } catch { return; /* first launch */ }
  llmState.model = saved.model || MODEL_FALLBACK;
  if (!saved.encryptedApiKey) return;
  // A key that cannot be unlocked now is kept on disk untouched, and Settings says why the assistant is off.
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("secure storage unavailable");
    llmState.apiKey = safeStorage.decryptString(Buffer.from(saved.encryptedApiKey, "base64"));
    unreadableEncryptedKey = undefined;
  } catch {
    unreadableEncryptedKey = saved.encryptedApiKey;
  }
}

function secureStorageAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

export function getLlmConfig(): LlmConfig {
  return {
    provider: "openai",
    model: llmState.model || MODEL_FALLBACK,
    configured: isLlmConfigured(),
    secureStorage: secureStorageAvailable(),
    ...(unreadableEncryptedKey && !isLlmConfigured() ? { storedKeyUnreadable: true } : {}),
    ...(llmProblem && isLlmConfigured() ? { lastProblem: llmProblem } : {})
  };
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
    throw new LlmConnectionError(connectionProblem(error), `No se guardó la configuración porque el proveedor no respondió correctamente. ${error instanceof Error ? error.message : "Error desconocido."}`, { cause: error });
  }
}

export async function saveLlmConfig(input: LlmConfigInput): Promise<LlmConfig> {
  if (!input || typeof input.apiKey !== "string" || typeof input.model !== "string") throw new Error("La configuración no es válida.");
  const nextApiKey = input.clearApiKey ? "" : input.apiKey.trim() || llmState.apiKey;
  const nextModel = input.model.trim() || MODEL_FALLBACK;
  // Without encryption the key is not saved at all: never as plain text, and not silently in memory either.
  if (nextApiKey && !secureStorageAvailable()) {
    throw new LlmConnectionError({ kind: "storage_unavailable", detail: "safeStorage.isEncryptionAvailable() = false", at: new Date().toISOString() },
      "El almacenamiento seguro no está disponible; la API key no se guardó.");
  }
  if (nextApiKey) await verifyLlmAccess({ apiKey: nextApiKey, model: nextModel });
  llmState = { apiKey: nextApiKey, model: nextModel };
  llmProblem = undefined;
  // A key that could not be unlocked survives a model change; only a new key or removing it replaces it.
  const keepUnreadable = !nextApiKey && !input.clearApiKey ? unreadableEncryptedKey : undefined;
  unreadableEncryptedKey = keepUnreadable;
  mkdirSync(app.getPath("userData"), { recursive: true });
  const payload: { model: string; encryptedApiKey?: string } = { model: llmState.model };
  if (llmState.apiKey) payload.encryptedApiKey = safeStorage.encryptString(llmState.apiKey).toString("base64");
  else if (keepUnreadable) payload.encryptedApiKey = keepUnreadable;
  writeFileSync(settingsPath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
  return getLlmConfig();
}

/** Saving, as the interface asks for it: a provider problem comes back as a reason, never as a bare error. */
export async function connectLlm(input: LlmConfigInput): Promise<LlmConnectResult> {
  try {
    return { ok: true, config: await saveLlmConfig(input) };
  } catch (error) {
    if (error instanceof LlmConnectionError) return { ok: false, config: getLlmConfig(), problem: error.problem };
    throw error;
  }
}

/** Checks the saved key and model again, changing nothing; the answer updates what Settings shows. */
export async function verifyLlmConfig(): Promise<LlmConnectResult> {
  if (!isLlmConfigured()) {
    if (!unreadableEncryptedKey) throw new Error("No hay ninguna API key guardada que comprobar.");
    // Secure storage may have come back (the keychain was unlocked): the saved key is tried again.
    loadLlmConfig();
    if (!isLlmConfigured()) return { ok: false, config: getLlmConfig(), problem: { kind: "storage_unavailable", detail: "safeStorage", at: new Date().toISOString() } };
  }
  try {
    await callProvider({ instructions: "Reply with the single word: ok.", input: "ok", max_output_tokens: 1_000 }, 60_000);
    return { ok: true, config: getLlmConfig() };
  } catch (error) {
    return { ok: false, config: getLlmConfig(), problem: connectionProblem(error) };
  }
}
