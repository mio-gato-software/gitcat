import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";
import { safeStorage, app } from "electron";
import { findExecutable, isExecutableFile, pathEntries, wellKnownToolDirectories } from "./executables.js";
import {
  findAccount, isSshAuthenticated, parseGhAccounts, parseSshGreeting, parseSshResolvedHostName, sshConfigHostAliases
} from "./host-identity.js";
import {
  emptyMemory, forgetSshHost, recallIdentity, recallRepository, rememberIdentity, rememberRepository,
  sanitizeMemory, type Memory
} from "./memory.js";
import type { ActionPlan, Branch, Commit, ConversationMessage, GitProtocol, LlmConfig, LlmConfigInput, Operation, RepoSnapshot } from "../shared/types.js";
import {
  buildPlannerInstructions, commitMessageLimit, executableOperations, isBranchNameSafe, operationArgs,
  operationIssues, parseModelPlan, planResponseFormat, type ModelPlan, type PlanIssue
} from "./llm-plan.js";
import {
  assertRepositoryPlan, buildRepositoryPlan, remoteNamePattern, repositoryHostPattern, repositoryNamePattern,
  repositoryOwnerPattern, sshHostPattern, validateRepositoryFields, type RepositoryFields
} from "./repository-plan.js";

type CommandResult = { stdout: string; stderr: string; code: number };
type PlanDraft = Omit<ActionPlan, "id" | "repoPath" | "head" | "stateId">;

const MODEL_FALLBACK = "luna";
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const LLM_REQUIRED =
  "Branchline necesita un proveedor LLM configurado: toda interpretación de tus mensajes la hace el modelo, no reglas locales. Añade tu API key y tu modelo en Configuración.";
const allowedOperations = new Set<Operation>([...executableOperations, "github_create_repo", "none"]);

let llmState: LlmConfigInput = { apiKey: "", model: MODEL_FALLBACK };
let memory: Memory = emptyMemory();

function isLlmConfigured() {
  return Boolean(llmState.apiKey.trim() && (llmState.model.trim() || MODEL_FALLBACK));
}

function memoryPath() { return join(app.getPath("userData"), "branchline-memory.json"); }

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

async function checkedGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} terminó con código ${result.code}`;
    throw new Error(detail);
  }
  return result.stdout.trim();
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

function parseCommit(raw: string): Commit | undefined {
  const [hash, shortHash, author, email, date, subject, refs = ""] = raw.split("\x1f");
  if (!hash || !shortHash) return undefined;
  return { hash, shortHash, subject, author, email, date, refs: refs.split(",").map((ref) => ref.trim()).filter(Boolean) };
}

export async function getSnapshot(cwd: string): Promise<RepoSnapshot> {
  const repoRoot = resolve(await checkedGit(cwd, ["rev-parse", "--show-toplevel"]));
  const head = await optionalGit(repoRoot, ["rev-parse", "HEAD"]);
  const currentBranch = (await optionalGit(repoRoot, ["branch", "--show-current"])) || "HEAD";
  const statusRaw = await checkedGit(repoRoot, ["status", "--short", "-z"]);
  const branchRaw = await checkedGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)%00%(authorname)%00%(authoremail)%00%(authordate:iso-strict)",
    "refs/heads"
  ]);
  const logRaw = head ? await checkedGit(repoRoot, [
    "log", "--all", "-n", "80", "--date=iso-strict",
    "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D"
  ]) : "";
  const commits = logRaw.split("\n").map(parseCommit).filter((commit): commit is Commit => Boolean(commit));
  const commitsByHash = new Map(commits.map((commit) => [commit.shortHash, commit]));
  const branches: Branch[] = branchRaw.split("\n").filter(Boolean).map((line) => {
    const [name, upstream, track, shortHash, subject, author, email, date] = line.split("\0");
    return {
      name,
      upstream: upstream || undefined,
      ...parseTrack(track || ""),
      isCurrent: name === currentBranch,
      lastCommit: shortHash ? (commitsByHash.get(shortHash) ?? {
        hash: shortHash, shortHash, subject, author, email, date, refs: []
      }) : undefined
    };
  });
  const gitDir = await optionalGit(repoRoot, ["rev-parse", "--git-dir"]);
  const rebaseMerge = await optionalGit(repoRoot, ["rev-parse", "--git-path", "rebase-merge"]);
  const rebaseApply = await optionalGit(repoRoot, ["rev-parse", "--git-path", "rebase-apply"]);
  const isRebasing = Boolean(gitDir && ((rebaseMerge && existsSync(resolve(repoRoot, rebaseMerge))) || (rebaseApply && existsSync(resolve(repoRoot, rebaseApply)))));
  const remotes = (await checkedGit(repoRoot, ["remote"])).split("\n").filter(Boolean);

  return {
    path: repoRoot,
    name: basename(repoRoot),
    head,
    stateId: createHash("sha256").update(`${head}\0${statusRaw}`).digest("hex"),
    currentBranch,
    isRebasing,
    isDirty: Boolean(statusRaw.trim()),
    changes: parseStatus(statusRaw),
    branches,
    commits,
    remotes
  };
}

function refused(reason: string, source: ActionPlan["source"] = "guardrail", summary = "Solicitud rechazada", kind: ActionPlan["kind"] = "refusal"): PlanDraft {
  return {
    allowed: false, operation: "none", args: {}, command: "—", summary,
    rationale: reason, risk: "low", requiresConfirmation: false, kind, source
  };
}

/** The assistant needs something from the user. A question, not a failure. */
function asking(reason: string, summary: string): PlanDraft {
  return refused(reason, "llm", summary || "Necesito un dato más", "question");
}

function buildCommand(operation: Operation, args: Record<string, string>) {
  switch (operation) {
    case "checkout": return `git switch ${args.name}`;
    case "create_branch": return `git switch -c ${args.name}`;
    case "delete_branch": return `git branch -d ${args.name}`;
    case "fetch": return "git fetch --prune";
    case "pull": return "git pull --ff-only";
    case "push": return "git push";
    case "merge": return `git merge --no-edit ${args.name}`;
    case "rebase": return `git rebase ${args.onto}`;
    case "abort_rebase": return "git rebase --abort";
    case "continue_rebase": return "git rebase --continue";
    case "commit": return `git add -A && git commit -m "${args.message ?? ""}"`;
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
  let config = "";
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
    return blocked(`"${sourcePath}" is not a Git repository; Branchline never runs git init on its own, the user must create or open the repository first`, "repository.localPath");
  }
  if (sourceSnapshot.path !== sourcePath) return blocked(`"${sourcePath}" is inside the repository "${sourceSnapshot.path}"; the exact repository root is required`, "repository.localPath");
  if (sourceSnapshot.path !== snapshot.path) return blocked(`"${sourcePath}" is not the project currently open in Branchline ("${snapshot.path}"); for safety the user must open it as the active project before publishing it`, "repository.localPath");

  const { repository: name, owner, host, protocol } = repositoryPlan;
  const remote = validation.fields.remote ?? "origin";
  const push = repositoryPlan.action === "create_repository_and_push";
  const replaceRemote = validation.fields.replaceRemote === true;
  if (push && !sourceSnapshot.head) return blocked("the local repository has no commits, so there is nothing to push; the user can create a first commit or ask to create the repository without pushing");

  const ghVersion = await runCommand("gh", ["--version"], sourcePath, 10_000, { GH_PROMPT_DISABLED: "1" }).catch(() => undefined);
  if (!ghVersion || ghVersion.code !== 0) {
    const searched = await toolDirectories();
    return blocked(`GitHub CLI (gh) is required but no runnable gh was found in any of the ${searched.length} directories Branchline searched (including ${searched.slice(0, 6).join(", ")}). If gh is installed elsewhere, it is a PATH problem rather than a missing install`);
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

function extractOutputText(body: any): string {
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
async function callProvider(body: Record<string, unknown>, timeoutMs = 180_000, credentials: LlmConfigInput = llmState): Promise<any> {
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
      : `No se pudo contactar con el proveedor: ${error instanceof Error ? error.message : "error de red"}`);
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

export async function generateCommitDescription(cwd: string) {
  if (!isLlmConfigured()) throw new Error(LLM_REQUIRED);
  const snapshot = await getSnapshot(cwd);
  if (!snapshot.changes.length) throw new Error("No hay cambios locales que describir.");
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
  const description = cleanCommitDescription(text);
  const current = await getSnapshot(snapshot.path);
  if (current.stateId !== snapshot.stateId) throw new Error("Los cambios variaron durante la generación. Inténtalo de nuevo.");
  return { description, stateId: snapshot.stateId };
}

/** Everything the model is allowed to reason about: verified repository facts, never raw guesses. */
function plannerState(snapshot: RepoSnapshot) {
  return {
    openRepositoryPath: snapshot.path,
    openRepositoryName: snapshot.name,
    currentBranch: snapshot.currentBranch,
    detachedHead: snapshot.currentBranch === "HEAD",
    isRebasing: snapshot.isRebasing,
    hasLocalChanges: snapshot.isDirty,
    localChanges: snapshot.changes.slice(0, 60),
    remotes: snapshot.remotes,
    branches: snapshot.branches.map((branch) => ({
      name: branch.name,
      isCurrent: branch.isCurrent,
      upstream: branch.upstream ?? null,
      ahead: branch.ahead,
      behind: branch.behind,
      lastCommit: branch.lastCommit
        ? { shortHash: branch.lastCommit.shortHash, subject: branch.lastCommit.subject, author: branch.lastCommit.author, email: branch.lastCommit.email, date: branch.lastCommit.date }
        : null
    })),
    recentCommits: snapshot.commits.slice(0, 30).map((commit) => ({
      shortHash: commit.shortHash, subject: commit.subject, author: commit.author, date: commit.date, refs: commit.refs
    })),
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
    instructions: buildPlannerInstructions(plannerState(snapshot), issues),
    input: [...context, { role: "user", content: request }],
    text: { format: planResponseFormat }
  });
  const plan = parseModelPlan(text);
  if (!plan) throw new Error("El proveedor devolvió una respuesta que no cumple el esquema del plan.");
  return plan;
}

function answerDraft(plan: ModelPlan): PlanDraft {
  return {
    allowed: true, operation: "none", args: {}, command: "—",
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

/** The model chooses the operation and writes the prose; the deterministic draft owns risk, command and confirmation. */
function gitOperationDraft(plan: ModelPlan, snapshot: RepoSnapshot): PlanDraft {
  const draft = operationDraft(plan.operation, operationArgs(plan), snapshot);
  return {
    ...draft,
    summary: plan.summary || draft.summary,
    rationale: plan.rationale || draft.rationale,
    risk: highestRisk(draft.risk, plan.risk),
    source: "llm"
  };
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

/**
 * Turns one model plan into a draft. When local validation or an environment check rejects it, the
 * defects go back to the model as structured issues so it can correct itself or explain the problem
 * to the user in their own language. Retried once; there is no keyword fallback.
 */
async function draftFromPlan(
  plan: ModelPlan, snapshot: RepoSnapshot, request: string, context: ConversationMessage[], retried = false
): Promise<PlanDraft> {
  if (plan.intent === "answer") return answerDraft(plan);
  if (plan.intent === "needs_information") return asking(plan.reply || plan.rationale || LAST_RESORT_REFUSAL, plan.summary);
  if (plan.intent === "out_of_scope") return refused(plan.reply || plan.rationale || LAST_RESORT_REFUSAL, "llm", plan.summary || "Solicitud rechazada");

  const retry = async (issues: PlanIssue[]) => {
    if (retried) return asking(plan.reply || plan.rationale || LAST_RESORT_REFUSAL, plan.summary);
    return draftFromPlan(await requestPlan(request, snapshot, context, issues), snapshot, request, context, true);
  };

  if (plan.intent === "git_operation") {
    const issues = operationIssues(plan);
    return issues.length ? retry(issues) : gitOperationDraft(plan, snapshot);
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

/** Every interpretation of what the user wrote happens in the model; this layer only validates. */
export async function planAction(cwd: string, request: string, context: ConversationMessage[] = []): Promise<ActionPlan> {
  const snapshot = await getSnapshot(cwd);
  if (!isLlmConfigured()) return bindPlan(snapshot, refused(LLM_REQUIRED));
  if (!request.trim()) return bindPlan(snapshot, refused("Escribe tu solicitud para el asistente."));
  try {
    const plan = await requestPlan(request, snapshot, context);
    return bindPlan(snapshot, await draftFromPlan(plan, snapshot, request, context));
  } catch (error) {
    return bindPlan(snapshot, refused(`No pude consultar el proveedor LLM: ${error instanceof Error ? error.message : "error desconocido"}`, "llm"));
  }
}

function operationDraft(operation: Operation, args: Record<string, string>, snapshot?: RepoSnapshot): PlanDraft {
  const details: Partial<Record<Operation, [string, string, ActionPlan["risk"]]>> = {
    status: ["Actualizar la vista del repositorio", "Lee el estado actual sin modificar archivos.", "low"],
    checkout: [`Cambiar a ${args.name}`, "Cambia la rama activa conservando los cambios locales compatibles.", "medium"],
    create_branch: [`Crear y cambiar a ${args.name}`, "Crea una rama local desde HEAD.", "medium"],
    delete_branch: [`Eliminar la rama ${args.name}`, "Elimina una rama local ya integrada.", "high"],
    fetch: ["Actualizar referencias remotas", "Descarga referencias y elimina remotas obsoletas.", "low"],
    pull: ["Actualizar la rama actual", "Usa pull --ff-only para evitar merges implícitos.", "high"],
    push: ["Publicar la rama actual", "Envía los commits al upstream configurado.", "high"],
    merge: [`Fusionar ${args.name}`, "Integra la rama seleccionada en la rama actual.", "high"],
    rebase: [`Rebase sobre ${args.onto}`, "Reescribe la base de la rama actual.", "high"],
    abort_rebase: ["Abortar el rebase", "Restaura el estado anterior al rebase.", "high"],
    continue_rebase: ["Continuar el rebase", "Continúa después de resolver los conflictos.", "high"],
    commit: [`Crear commit “${args.message ?? ""}”`, "Añade todos los cambios y crea un commit.", "high"]
  };
  const detail = details[operation];
  if (!detail || operation === "none") return refused("La operación solicitada no está permitida.");
  return {
    allowed: true,
    operation,
    args,
    command: buildCommand(operation, args),
    summary: detail[0],
    rationale: detail[1],
    risk: detail[2],
    requiresConfirmation: !["status", "fetch"].includes(operation),
    kind: "plan",
    source: "guardrail"
  };
}

/** Direct controls in the interface: the operation is already known, so no interpretation is needed. */
export async function prepareOperation(cwd: string, operation: Operation, args: Record<string, string> = {}) {
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
  const draft = operationDraft(operation, args, snapshot);
  if (draft.allowed) validateExecution(bindPlan(snapshot, draft), snapshot);
  return bindPlan(snapshot, draft);
}

function validateExecution(plan: ActionPlan, snapshot: RepoSnapshot) {
  if (!plan.allowed || plan.operation === "none" || !allowedOperations.has(plan.operation)) throw new Error("La acción no está permitida.");
  if (plan.answer) throw new Error("Las consultas informativas no se ejecutan como operaciones Git.");
  const branchArg = plan.args.name || plan.args.onto;
  if (branchArg && !isBranchNameSafe(branchArg)) throw new Error("Nombre de rama no válido.");
  if (plan.repoPath !== snapshot.path) throw new Error("El plan pertenece a otro repositorio.");
  if (plan.head !== snapshot.head) throw new Error("El repositorio cambió desde que se preparó el plan. Prepara la acción de nuevo.");
  if (plan.stateId !== snapshot.stateId) throw new Error("Los cambios locales variaron desde que se preparó el plan. Prepara la acción de nuevo.");
  if (["checkout", "create_branch", "delete_branch", "merge"].includes(plan.operation) && !plan.args.name) throw new Error("Falta el nombre de la rama.");
  if (plan.operation === "rebase" && !plan.args.onto) throw new Error("Falta la rama base.");
  if (plan.operation === "commit" && (!plan.args.message?.trim() || plan.args.message.length > commitMessageLimit)) throw new Error("El mensaje de commit no es válido.");
  if (plan.operation === "commit" && !snapshot.changes.length) throw new Error("No hay cambios locales para confirmar.");
  if (plan.operation === "checkout" && !snapshot.branches.some((branch) => branch.name === plan.args.name)) throw new Error(`La rama ${plan.args.name} no existe localmente.`);
  if (plan.operation === "create_branch" && snapshot.branches.some((branch) => branch.name === plan.args.name)) throw new Error(`La rama ${plan.args.name} ya existe.`);
  if (plan.operation === "delete_branch" && plan.args.name === snapshot.currentBranch) throw new Error("No puedes borrar la rama activa.");
  if (["delete_branch", "merge"].includes(plan.operation) && !snapshot.branches.some((branch) => branch.name === plan.args.name)) throw new Error(`La rama ${plan.args.name} no existe localmente.`);
  if (plan.operation === "rebase" && !snapshot.branches.some((branch) => branch.name === plan.args.onto)) throw new Error(`La rama base ${plan.args.onto} no existe localmente.`);
  if (["abort_rebase", "continue_rebase"].includes(plan.operation) && !snapshot.isRebasing) throw new Error("No hay un rebase en curso.");
}

function validateGithubPlan(plan: ActionPlan) {
  const { name, owner, host, protocol, sshHost, remoteUrl, visibility, source, remote, push, replaceRemote, account, activeAccount } = plan.args;
  if (!repositoryNamePattern.test(name ?? "") || !repositoryOwnerPattern.test(owner ?? "") || !repositoryHostPattern.test(host ?? "") || !["ssh", "https"].includes(protocol) ||
      visibility !== "private" || !remoteNamePattern.test(remote ?? "") || !["true", "false"].includes(push) || !["true", "false"].includes(replaceRemote)) {
    throw new Error("El plan de creación de GitHub contiene argumentos no válidos.");
  }
  if (!repositoryOwnerPattern.test(account ?? "") || !repositoryOwnerPattern.test(activeAccount ?? "")) throw new Error("La cuenta de GitHub del plan no es válida.");
  if (protocol === "ssh" ? !sshHostPattern.test(sshHost ?? "") : sshHost !== "") throw new Error("El host SSH del plan no es válido.");
  if (!source || resolve(source) !== plan.targetPath) throw new Error("La ruta de origen del plan no es válida.");
  if (!plan.repositoryPlan) throw new Error("Falta el plan JSON verificable del repositorio.");
  assertRepositoryPlan(plan.repositoryPlan);
  if (plan.repositoryPlan.remoteUrl !== remoteUrl || plan.repositoryPlan.localPath !== source) throw new Error("El plan JSON no coincide con los argumentos de ejecución.");
}

async function executeGithubRepositoryPlan(plan: ActionPlan) {
  validateGithubPlan(plan);
  const source = realpathSync(plan.args.source);
  const snapshot = await getSnapshot(source);
  if (snapshot.path !== plan.targetPath || snapshot.head !== plan.targetHead || snapshot.stateId !== plan.targetStateId) {
    throw new Error("El repositorio de origen cambió desde la validación. Prepara la acción de nuevo.");
  }
  if (plan.args.push === "true" && !snapshot.head) throw new Error("No hay commits locales que publicar.");
  const ghVersion = await runCommand("gh", ["--version"], source, 10_000, { GH_PROMPT_DISABLED: "1" }).catch(() => undefined);
  if (!ghVersion || ghVersion.code !== 0) throw new Error("GitHub CLI (gh) ya no está instalado o disponible en PATH.");
  const accounts = await ghAccounts(plan.args.host, source);
  if (!findAccount(accounts, plan.args.account)) throw new Error(`La cuenta ${plan.args.account} ya no está autenticada en ${plan.args.host}.`);
  if (plan.args.protocol === "ssh") {
    const identity = await sshIdentity(plan.args.sshHost, source);
    if (!identity.authenticated) throw new Error(`SSH ya no autentica contra ${plan.args.sshHost}: ${identity.output.slice(0, 200)}`);
    if (identity.login && identity.login.toLowerCase() !== plan.args.owner.toLowerCase()) {
      throw new Error(`${plan.args.sshHost} ahora autentica como ${identity.login}, no como ${plan.args.owner}.`);
    }
  }
  const existing = await runCommand("gh", ["api", `repos/${plan.args.owner}/${plan.args.name}`, "--silent"], source, 20_000, { GH_PROMPT_DISABLED: "1", GH_HOST: plan.args.host });
  if (existing.code === 0) throw new Error(`El repositorio ${plan.args.owner}/${plan.args.name} ya existe.`);
  if (!/HTTP 404|not found/i.test(`${existing.stderr}\n${existing.stdout}`)) throw new Error("No se pudo confirmar que el repositorio remoto siga disponible.");

  const currentRemote = await runGit(source, ["remote", "get-url", plan.args.remote]);
  if (currentRemote.code === 0 && plan.args.replaceRemote !== "true") throw new Error(`El remoto “${plan.args.remote}” existe y no se autorizó reemplazarlo.`);
  if (currentRemote.code === 0 && createHash("sha256").update(currentRemote.stdout.trim()).digest("hex") !== plan.args.existingRemoteHash) throw new Error(`El remoto “${plan.args.remote}” cambió desde la validación.`);
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
    const message = error instanceof Error ? error.message : "gh no pudo crear el repositorio.";
    if (repositoryCreated) throw new Error(`El repositorio remoto se creó, pero no se pudo configurar o publicar el remoto local: ${message}`);
    if (/forbidden|permission|not accessible|403/i.test(message)) throw new Error("No hay permisos suficientes para crear el repositorio privado solicitado.");
    throw error;
  } finally {
    if (switching) {
      await checkedGh(["auth", "switch", "--hostname", plan.args.host, "--user", plan.args.activeAccount], source)
        .catch(() => console.error(`No se pudo restaurar la cuenta activa de gh a ${plan.args.activeAccount}.`));
    }
  }
}

export async function executePlan(cwd: string, plan: ActionPlan) {
  const snapshot = await getSnapshot(cwd);
  validateExecution(plan, snapshot);
  let output = "";
  try {
    switch (plan.operation) {
      case "status": break;
      case "checkout": output = await checkedGit(cwd, ["switch", plan.args.name]); break;
      case "create_branch": output = await checkedGit(cwd, ["switch", "-c", plan.args.name]); break;
      case "delete_branch": output = await checkedGit(cwd, ["branch", "-d", "--", plan.args.name]); break;
      case "fetch": output = await checkedGit(cwd, ["fetch", "--prune"]); break;
      case "pull": output = await checkedGit(cwd, ["pull", "--ff-only"]); break;
      case "push": output = await checkedGit(cwd, ["push"]); break;
      case "merge": output = await checkedGit(cwd, ["merge", "--no-edit", "--", plan.args.name]); break;
      case "rebase": output = await checkedGit(cwd, ["rebase", plan.args.onto]); break;
      case "abort_rebase": output = await checkedGit(cwd, ["rebase", "--abort"]); break;
      case "continue_rebase": output = await checkedGit(cwd, ["rebase", "--continue"]); break;
      case "commit":
        await checkedGit(cwd, ["add", "-A"]);
        output = await checkedGit(cwd, ["commit", "-m", plan.args.message]);
        break;
      case "github_create_repo": output = await executeGithubRepositoryPlan(plan); break;
    }
    return { snapshot: await getSnapshot(cwd), output };
  } catch (error) {
    return {
      snapshot: await getSnapshot(cwd),
      output,
      error: error instanceof Error ? error.message : "Git no pudo completar la acción."
    };
  }
}

function settingsPath() { return join(app.getPath("userData"), "branchline-settings.json"); }

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
    throw new Error(`No se guardó la configuración porque el proveedor no respondió correctamente. ${error instanceof Error ? error.message : "Error desconocido."}`);
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
