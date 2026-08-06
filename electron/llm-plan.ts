import type { Operation } from "../shared/types.js";

export type PlannerIntent = "git_operation" | "create_repository" | "answer" | "needs_information" | "out_of_scope";

export type PlannedArgs = { name: string; onto: string; message: string };

export type PlannedRepository = {
  localPath: string;
  repository: string;
  owner: string;
  host: string;
  protocol: "ssh" | "https" | "";
  sshHost: string;
  remote: string;
  push: boolean;
  replaceRemote: boolean;
};

export type ModelPlan = {
  intent: PlannerIntent;
  operation: Operation;
  args: PlannedArgs;
  repository: PlannedRepository;
  summary: string;
  rationale: string;
  reply: string;
  risk: "low" | "medium" | "high";
};

/** Machine-readable defect handed back to the model so it can correct itself or ask the user. */
export type PlanIssue = { field: string; problem: string };

export const commitMessageLimit = 120;

export const executableOperations = new Set<Operation>([
  "status", "checkout", "create_branch", "delete_branch", "fetch", "pull", "push",
  "merge", "rebase", "abort_rebase", "continue_rebase", "commit"
]);
const branchOperations = new Set<Operation>(["checkout", "create_branch", "delete_branch", "merge"]);
const intents: PlannerIntent[] = ["git_operation", "create_repository", "answer", "needs_information", "out_of_scope"];
const risks = ["low", "medium", "high"];
const planKeys = ["args", "intent", "operation", "rationale", "reply", "repository", "risk", "summary"];
const argsKeys = ["message", "name", "onto"];
const repositoryKeys = ["host", "localPath", "owner", "protocol", "push", "remote", "replaceRemote", "repository", "sshHost"];
const branchNamePattern = /^[A-Za-z0-9._/@-]+$/;

export function isBranchNameSafe(name: string) {
  return Boolean(name) && branchNamePattern.test(name) && !name.includes("..") && !name.includes("@{") &&
    !name.startsWith("-") && !name.startsWith(".") && !name.startsWith("/") && !name.endsWith("/") &&
    !name.endsWith(".") && !name.includes("//") && !name.includes("/.") && !name.endsWith(".lock");
}

export const planResponseFormat = {
  type: "json_schema",
  name: "branchline_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: planKeys,
    properties: {
      intent: { type: "string", enum: intents },
      operation: { type: "string", enum: [...executableOperations, "none"] },
      args: {
        type: "object",
        additionalProperties: false,
        required: argsKeys,
        properties: { name: { type: "string" }, onto: { type: "string" }, message: { type: "string" } }
      },
      repository: {
        type: "object",
        additionalProperties: false,
        required: repositoryKeys,
        properties: {
          localPath: { type: "string" },
          repository: { type: "string" },
          owner: { type: "string" },
          host: { type: "string" },
          protocol: { type: "string", enum: ["ssh", "https", ""] },
          sshHost: { type: "string" },
          remote: { type: "string" },
          push: { type: "boolean" },
          replaceRemote: { type: "boolean" }
        }
      },
      summary: { type: "string" },
      rationale: { type: "string" },
      reply: { type: "string" },
      risk: { type: "string", enum: risks }
    }
  }
} as const;

/**
 * The planner owns every judgement call: which language to answer in, whether a request is in
 * scope, which operation it maps to and which values are still missing. Nothing downstream
 * inspects the user's words.
 */
export function buildPlannerInstructions(repositoryState: unknown, issues: PlanIssue[] = []) {
  const base = `You are the planning layer of Branchline, a desktop Git workspace.

The user may write in any language, in any phrasing, direct or indirect. Decide what they mean by
understanding the message, never by matching words or verb forms. Always write "summary",
"rationale" and "reply" in the same language as the user's latest message.

You never execute anything and you never invent shell commands, repository data or values the user
did not provide. Answer with a single JSON object that matches the schema.

The application, not you, owns confirmation: every plan is shown to the user as a card they must
approve before anything runs. So never ask "shall I proceed?", never announce what you are about to
do, and never describe a plan inside "reply". When you have what you need, return the plan itself
and let the card do the asking. If the user has just approved something, act on it.

Pick exactly one intent:
- "git_operation": the user wants a Git operation on the open repository. Set "operation" and the args it needs.
- "create_repository": the user wants to create a remote repository for a local repository, optionally pushing to it. Fill "repository".
- "answer": the user asks something the repository state below already answers. Put the full answer in "reply".
- "needs_information": the request is in scope but a required value is missing or ambiguous. Ask for exactly what is missing in "reply".
- "out_of_scope": the request has nothing to do with this repository, with Git or with creating a repository. Say so briefly in "reply".

Operations: status, checkout, create_branch, delete_branch, fetch, pull, push, merge, rebase,
abort_rebase, continue_rebase, commit. Use "none" for every intent other than "git_operation".
args.name is the branch for checkout, create_branch, delete_branch and merge. args.onto is the base
branch for rebase. args.message is the commit message, ${commitMessageLimit} characters maximum.
Leave every arg you do not need as "".

"repository" is only meaningful for "create_repository". Use "" or false for anything unknown:
- localPath: absolute path of the local repository to publish. When the user means "this repository", use the open repository path from the state below.
- repository: remote repository name, 1 to 100 characters from A-Z a-z 0-9 . _ -, never ending in ".git".
- owner: GitHub user or organization login that will own it.
- host: DNS host name only, such as "github.com". No scheme, no port, no path.
- protocol: "ssh" or "https", whichever the user asked for.
- sshHost: leave "" unless the user names a specific SSH host or ~/.ssh/config alias. The application
  dials every candidate itself and picks the one that authenticates as "owner", so a non-default key
  is normal and needs no question. Never guess an alias.
- remote: name of the local Git remote, "origin" unless the user names another one.
- push: true unless the user asked to create the repository without pushing.
- replaceRemote: true only when the user explicitly authorized replacing an existing local remote.
Never guess an owner, host, repository name or path. A value like "/foo/bar" is a filesystem path,
never an owner or a repository name. If part of the data is missing, use "needs_information" and ask
for the rest instead of filling it in yourself.

Repositories are always created private. The application resolves by itself which authenticated gh
account and which SSH key correspond to "owner", including accounts that are not the active one and
keys that are not the default, so do not ask the user about credentials unless a validation issue
below says the machine genuinely lacks them.

"remembered" in the state holds choices the user already confirmed in earlier conversations: which
account owns a host, which SSH alias belongs to them, how this repository was published. Reuse them
instead of asking again, and only revisit one if the user says otherwise or a validation issue shows
it no longer holds. The application re-verifies each of them before acting, so trust them as
starting points, not as proof.

Only the repository state below is true. Do not state facts that are not in it.
Repository state (JSON):
${JSON.stringify(repositoryState, null, 2)}`;

  if (!issues.length) return base;
  return `${base}

Your previous answer failed local validation or an environment check. If you can fix it, answer
again with corrected values. If the user has to supply or fix something, use "needs_information";
if nothing can proceed at all, use "out_of_scope". In both cases explain the problem in "reply", in
the user's language, concretely enough to act on, and never repeat the same invalid values.
Validation issues (JSON):
${JSON.stringify(issues, null, 2)}`;
}

/** Every arg that the chosen operation actually uses; anything else the model sent is dropped. */
export function operationArgs(plan: ModelPlan): Record<string, string> {
  switch (plan.operation) {
    case "checkout": case "create_branch": case "delete_branch": case "merge": return { name: plan.args.name.trim() };
    case "rebase": return { onto: plan.args.onto.trim() };
    case "commit": return { message: plan.args.message.trim() };
    default: return {};
  }
}

export function operationIssues(plan: ModelPlan): PlanIssue[] {
  if (!executableOperations.has(plan.operation)) {
    return [{ field: "operation", problem: `"${plan.operation}" cannot be executed; use one of ${[...executableOperations].join(", ")} or another intent` }];
  }
  const args = operationArgs(plan);
  const issues: PlanIssue[] = [];
  if (branchOperations.has(plan.operation)) {
    if (!args.name) issues.push({ field: "args.name", problem: `missing; ${plan.operation} needs the branch name the user meant` });
    else if (!isBranchNameSafe(args.name)) issues.push({ field: "args.name", problem: `"${args.name}" is not a valid Git branch name` });
  }
  if (plan.operation === "rebase") {
    if (!args.onto) issues.push({ field: "args.onto", problem: "missing; rebase needs the base branch" });
    else if (!isBranchNameSafe(args.onto)) issues.push({ field: "args.onto", problem: `"${args.onto}" is not a valid Git branch name` });
  }
  if (plan.operation === "commit") {
    if (!args.message) issues.push({ field: "args.message", problem: "missing; a commit needs a message written by you or given by the user" });
    else if (args.message.length > commitMessageLimit) issues.push({ field: "args.message", problem: `${args.message.length} characters; the limit is ${commitMessageLimit}` });
  }
  return issues;
}

function candidates(text: string) {
  const result: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const opening = stack.pop();
        if ((opening === "{" && character !== "}") || (opening === "[" && character !== "]")) break;
        if (!stack.length) {
          result.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
    if (stack.length && !quoted) {
      const suffix = stack.reverse().map((opening) => opening === "{" ? "}" : "]").join("");
      result.push(`${text.slice(start).trim().replace(/```\s*$/, "").replace(/,\s*$/, "")}${suffix}`);
      break;
    }
  }
  return result;
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as object).sort().join("\0") === keys.join("\0");
}

function validate(value: unknown): ModelPlan | undefined {
  if (!hasExactKeys(value, planKeys)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.intent !== "string" || !intents.includes(record.intent as PlannerIntent)) return undefined;
  if (typeof record.operation !== "string" || !(executableOperations.has(record.operation as Operation) || record.operation === "none")) return undefined;
  if (typeof record.risk !== "string" || !risks.includes(record.risk)) return undefined;
  for (const key of ["summary", "rationale", "reply"]) if (typeof record[key] !== "string") return undefined;
  if (!hasExactKeys(record.args, argsKeys) || !Object.values(record.args as object).every((item) => typeof item === "string")) return undefined;
  if (!hasExactKeys(record.repository, repositoryKeys)) return undefined;
  const repository = record.repository as Record<string, unknown>;
  for (const key of ["localPath", "repository", "owner", "host", "remote", "sshHost"]) if (typeof repository[key] !== "string") return undefined;
  if (!["ssh", "https", ""].includes(repository.protocol as string)) return undefined;
  if (typeof repository.push !== "boolean" || typeof repository.replaceRemote !== "boolean") return undefined;
  return record as ModelPlan;
}

export function parseModelPlan(text: string): ModelPlan | undefined {
  for (const candidate of candidates(text.trim())) {
    for (const json of [candidate, candidate.replace(/,\s*([}\]])/g, "$1")]) {
      try {
        const plan = validate(JSON.parse(json));
        if (plan) return plan;
      } catch { /* try the next safely bounded candidate */ }
    }
  }
  return undefined;
}
