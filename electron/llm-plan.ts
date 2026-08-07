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

export type PlannedStep = { operation: Operation; args: PlannedArgs };

export type ModelPlan = {
  intent: PlannerIntent;
  steps: PlannedStep[];
  repository: PlannedRepository;
  summary: string;
  rationale: string;
  reply: string;
  risk: "low" | "medium" | "high";
};

/** Machine-readable defect handed back to the model so it can correct itself or ask the user. */
export type PlanIssue = { field: string; problem: string };

export const commitMessageLimit = 120;
/** A plan long enough for any real Git errand; beyond this the model is guessing rather than planning. */
export const planStepLimit = 6;

export const executableOperations = new Set<Operation>([
  "status", "checkout", "create_branch", "delete_branch", "fetch", "pull", "push",
  "merge", "rebase", "abort_rebase", "continue_rebase", "commit"
]);
const branchOperations = new Set<Operation>(["checkout", "create_branch", "delete_branch", "merge"]);
const intents: PlannerIntent[] = ["git_operation", "create_repository", "answer", "needs_information", "out_of_scope"];
const risks = ["low", "medium", "high"];
const planKeys = ["intent", "rationale", "reply", "repository", "risk", "steps", "summary"];
const stepKeys = ["args", "operation"];
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
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: stepKeys,
          properties: {
            operation: { type: "string", enum: [...executableOperations, "none"] },
            args: {
              type: "object",
              additionalProperties: false,
              required: argsKeys,
              properties: { name: { type: "string" }, onto: { type: "string" }, message: { type: "string" } }
            }
          }
        }
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
approve before anything runs, and approving it runs the whole plan from the first step to the last.
So never ask "shall I proceed?", never announce what you are about to do, never describe a plan
inside "reply", and never split an errand across turns waiting to be told to continue. When you have
what you need, return the plan itself and let the card do the asking. If the user has just approved
something, act on it.

Pick exactly one intent:
- "git_operation": the user wants something done with Git in the open repository. Put in "steps" every operation it takes, in the order they must run.
- "create_repository": the user wants to create a remote repository for a local repository, optionally pushing to it. Fill "repository".
- "answer": the user asks something the repository state below already answers. Put the full answer in "reply".
- "needs_information": the request is in scope but a required value is missing or ambiguous. Ask for exactly what is missing in "reply".
- "out_of_scope": the request has nothing to do with this repository, with Git or with creating a repository. Say so briefly in "reply".

You decide how to reach what the user asked for. Plenty of ordinary requests take several operations,
and it is your job to work out which ones and in what order, from the repository state below:
- "merge this branch into main" is checkout main, then merge the branch that was active. Read its
  name from the state; after the checkout it is no longer the current branch.
- "publish my work" may be commit, then push.
- "get me up to date and continue" may be fetch, then pull.
Each step runs against the repository as the previous step left it, so order matters: a branch you
create in step 1 is available in step 2. Use as few steps as the request truly needs, never more than
${planStepLimit}, and leave "steps" empty for every intent other than "git_operation".

Operations for each step: status, checkout, create_branch, delete_branch, fetch, pull, push, merge,
rebase, abort_rebase, continue_rebase, commit. args.name is the branch for checkout, create_branch,
delete_branch and merge. args.onto is the base branch for rebase. Leave every arg a step does not
need as "".

args.message is the commit message, ${commitMessageLimit} characters maximum. Leave it "" unless the
user dictated the message themselves: the application reads the actual diff and writes the message
for you, and shows it on the card before anything is committed. So never ask the user what the commit
message should be, and never invent one from the file names in the state.

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

The repository state also identifies "defaultBranch", the repository's primary branch. When
"defaultBranchSource" is "remote_head", the remote explicitly declared it through its HEAD; when
it is "conventional_name", it is the best local identification available from the conventional names.
Every branch has "isDefault" and "isCurrent" flags. Treat the default branch and the current branch
as protected: never recommend deleting either one, even when another branch contains its history.

Each branch carries "mergedInto": the reference branches whose history already contains that branch's
tip. It is computed by Git, so it is proof, not a guess, but it is a history fact—not permission to
delete every branch named there. For "what branches can I delete?", only consider local, non-current,
non-default branches whose "mergedInto" includes the default branch; if there are none, say that
there are no safe candidates. Do not treat two branches pointing at different commits as
unintegrated: an older tip that the default branch already contains is integrated. Never fall back to
comparing "ahead" and "behind" for this, as they only compare a branch with its own upstream.

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

/** Every arg that the step's operation actually uses; anything else the model sent is dropped. */
export function operationArgs(step: PlannedStep): Record<string, string> {
  switch (step.operation) {
    case "checkout": case "create_branch": case "delete_branch": case "merge": return { name: step.args.name.trim() };
    case "rebase": return { onto: step.args.onto.trim() };
    case "commit": return { message: step.args.message.trim() };
    default: return {};
  }
}

/** Defects in one step, addressed by index so the model knows which of its own steps to fix. */
export function operationIssues(step: PlannedStep, index = 0): PlanIssue[] {
  const at = `steps[${index}]`;
  if (!executableOperations.has(step.operation)) {
    return [{ field: `${at}.operation`, problem: `"${step.operation}" cannot be executed; use one of ${[...executableOperations].join(", ")} or another intent` }];
  }
  const args = operationArgs(step);
  const issues: PlanIssue[] = [];
  if (branchOperations.has(step.operation)) {
    if (!args.name) issues.push({ field: `${at}.args.name`, problem: `missing; ${step.operation} needs the branch name the user meant` });
    else if (!isBranchNameSafe(args.name)) issues.push({ field: `${at}.args.name`, problem: `"${args.name}" is not a valid Git branch name` });
  }
  if (step.operation === "rebase") {
    if (!args.onto) issues.push({ field: `${at}.args.onto`, problem: "missing; rebase needs the base branch" });
    else if (!isBranchNameSafe(args.onto)) issues.push({ field: `${at}.args.onto`, problem: `"${args.onto}" is not a valid Git branch name` });
  }
  // An empty commit message is not a defect: the application writes one from the real diff.
  if (step.operation === "commit" && args.message.length > commitMessageLimit) {
    issues.push({ field: `${at}.args.message`, problem: `${args.message.length} characters; the limit is ${commitMessageLimit}` });
  }
  return issues;
}

/** The sequence as a whole: it must exist, stay within the limit, and every step must stand on its own. */
export function planIssues(plan: ModelPlan): PlanIssue[] {
  if (!plan.steps.length) return [{ field: "steps", problem: "empty; a git_operation needs at least one step, or use another intent" }];
  if (plan.steps.length > planStepLimit) {
    return [{ field: "steps", problem: `${plan.steps.length} steps; the limit is ${planStepLimit}. Plan only what the request needs` }];
  }
  return plan.steps.flatMap((step, index) => operationIssues(step, index));
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
  if (typeof record.risk !== "string" || !risks.includes(record.risk)) return undefined;
  for (const key of ["summary", "rationale", "reply"]) if (typeof record[key] !== "string") return undefined;
  if (!Array.isArray(record.steps)) return undefined;
  for (const step of record.steps) {
    if (!hasExactKeys(step, stepKeys)) return undefined;
    const entry = step as Record<string, unknown>;
    if (typeof entry.operation !== "string" || !(executableOperations.has(entry.operation as Operation) || entry.operation === "none")) return undefined;
    if (!hasExactKeys(entry.args, argsKeys) || !Object.values(entry.args as object).every((item) => typeof item === "string")) return undefined;
  }
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
