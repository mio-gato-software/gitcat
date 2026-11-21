import { isBranchNameSafe } from "./branch-operation.js";
import type { HostingProvider, Locale, Operation } from "../shared/types.js";
import { hostingProviders } from '../shared/hosting.js';
import { assistantReadKinds, type PlannedRead } from "./assistant-inspection.js";

export type PlannerIntent = "git_operation" | "create_repository" | "answer" | "needs_information" | "out_of_scope" | "needs_working_changes";

export type PlannedArgs = { name: string; onto: string; to: string; path: string; side: string; message: string; noVerify: string };

export type PlannedRepository = {
  provider?: HostingProvider | "";
  connectionId?: string;
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

export type PlannedStep = { operation: Operation; args: PlannedArgs; argv: string[]; paths?: string[] };

export type ModelPlan = {
  intent: PlannerIntent;
  steps: PlannedStep[];
  reads?: PlannedRead[];
  answerLanguage?: Locale | "";
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
  "status", "checkout", "create_branch", "delete_branch", "rename_branch", "fetch", "pull", "push", "sync_remote",
  "merge", "rebase", "abort_operation", "continue_operation", "skip_operation", "resolve_conflict", "commit",
  "git_command"
]);
const branchOperations = new Set<Operation>(["checkout", "create_branch", "delete_branch", "rename_branch", "merge"]);
const intents: PlannerIntent[] = ["git_operation", "create_repository", "answer", "needs_information", "out_of_scope", "needs_working_changes"];
const risks = ["low", "medium", "high"];
const planKeys = ["intent", "rationale", "reply", "repository", "risk", "steps", "summary"];
const stepKeys = ["args", "argv", "operation"];
const argsKeys = ["message", "name", "noVerify", "onto", "path", "side", "to"];
const repositoryKeys = ["host", "localPath", "owner", "protocol", "push", "remote", "replaceRemote", "repository", "sshHost"];
export { isBranchNameSafe } from "./branch-operation.js";

const readInstructions = `- "repository": use one or more of active_branch, primary_branch, working_tree, remotes, upstream,
  deletable_branches. working_tree separates staged, unstaged, new, and conflicting files.
  remotes includes the effective fetch and push URLs. upstream includes the local ahead/behind counts.
- "compare_branches": args are [target] for all local branches, or [target, source] for one
  comparison. Use exact branch names or refs. Use this for questions about remaining work between
  branches. It distinguishes ancestry, identical contents and equivalent individual patches.
- "commit": args are [selector] or [selector, ref]. Selectors are tip or latest_merge. The ref
  defaults to HEAD. GitCat shows changed files and how many commits a merge brought in. For
  questions about a specific change or code behavior, use [selector, ref, term, ...] with up to
  four short, literal search terms likely to occur in changed lines (identifiers, error text,
  feature names or their English equivalents). GitCat finds matching removed and added lines in
  that commit's diff locally, without making a claim about runtime behavior. For these questions
  include terms in the commit read instead of returning a bare commit plus an unfiltered diff.
- "commit_identity": args are [selector] or [selector, ref] as for "commit". Reports the
  commit author and dates. A "commit" changes summary alone does not report them.
- "commit_lines": args are [selector] or [selector, ref] as for "commit". Reports how many files
  changed and which gained or lost the most lines in the first-parent diff, including ties.
- "file_history": args are [event, path] or [event, path, ref]. Events are first_addition,
  latest_change and latest_deletion. Use for an author, date or commit that matches the event.
- "commit_count": args are [ref, filter]. Use HEAD for the current branch, an exact ref or range,
  or "--all" for all local refs. Filters: all, no_merges, merges. Use one read per requested count.
- "git": args are an allowed read-only Git command without the leading "git". Use for any
  other evidence. For example, file creation can be
  read with ["log", "--diff-filter=A", "--follow", "--format=%an <%ae> %ad", "--", "proto/x.test.js"].
  Cover every part of the question with the appropriate read. Put only Git placeholders and
  separators in formats. When a question depends on unavailable history, choose the relevant
  read and let GitCat explain the limits of this shallow copy. A search of the current files
  cannot establish what an older commit changed.`;

const readListSchema = {
  type: "array", items: {
    type: "object", additionalProperties: false, required: ["kind", "args"],
    properties: { kind: { type: "string", enum: assistantReadKinds }, args: { type: "array", items: { type: "string" } } }
  }
};

export const planResponseFormat = {
  type: "json_schema",
  name: "gitcat_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [...planKeys, "reads", "answerLanguage"],
    properties: {
      intent: { type: "string", enum: intents },
      answerLanguage: { type: "string", enum: ["es", "en", ""] },
      reads: readListSchema,
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [...stepKeys, "paths"],
          properties: {
            operation: { type: "string", enum: [...executableOperations, "none"] },
            argv: { type: "array", items: { type: "string" } },
            paths: { type: "array", items: { type: "string" } },
            args: {
              type: "object",
              additionalProperties: false,
              required: argsKeys,
              properties: { name: { type: "string" }, onto: { type: "string" }, to: { type: "string" }, path: { type: "string" }, side: { type: "string" }, message: { type: "string" }, noVerify: { type: "string" } }
            }
          }
        }
      },
      repository: {
        type: "object",
        additionalProperties: false,
        required: [...repositoryKeys, "provider", "connectionId"],
        properties: {
          provider: { type: "string", enum: [...hostingProviders, ""] },
          connectionId: { type: "string" },
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
  const base = `You are the planning layer of GitCat, a desktop Git workspace.

The user may write in any language, in any phrasing, direct or indirect. Decide what they mean by
understanding the message, never by matching words or verb forms. Always write "summary",
"rationale" and "reply" in the same language as the user's latest message.
Plan only for the latest request. Use earlier turns to resolve references in it, and leave earlier
requests alone unless the user explicitly returns to them.

You never execute anything and you never invent shell commands, repository data or values the user
did not provide. Answer with a single JSON object that matches the schema.

The application, not you, owns confirmation: local reads run immediately. Plans that change the
repository go through the application's usual review.
So never ask "shall I proceed?", never announce what you are about to do, never describe a plan
inside "reply", and never split an errand across turns waiting to be told to continue. When you have
what you need, return the plan itself and let the card do the asking. If the user has just approved
something, act on it. A "reply" that says you will consult, check or run something is a failed turn:
the plan is the doing, and it belongs in this turn.

Pick exactly one intent:
- "git_operation": the user wants something done with Git in the open repository. Put in "steps" every operation it takes, in the order they must run.
- "create_repository": the user wants to create a remote repository for a local repository, optionally pushing to it. Fill "repository".
- "answer": the user wants information about the repository. Select the reads that establish it,
  even when the supplied snapshot appears to answer it. Leave "steps" and "reply" empty.
- "needs_working_changes": a decision about a requested action depends on unsaved content,
  "workingTreeDiffAvailable" is false and "hasLocalChanges" is true. Leave "steps" empty and say
  why the content matters. A local question about changes can use Git reads without sharing them.
- "needs_information": the request is in scope but a required value is missing or ambiguous. Ask for exactly what is missing in "reply".
- "out_of_scope": the request has nothing to do with this repository, with Git or with creating a repository. Say so briefly in "reply".

For an answer, "reads" is an array whose entries have "kind" and "args". GitCat reads Git and renders the results.
Set "answerLanguage" to "es" or "en" to match the user's question, or "" to use the app language.
Choose the smallest useful set. Every other intent leaves "reads" empty.
${readInstructions}

You decide how to reach what the user asked for. Plenty of ordinary requests take several operations,
and it is your job to work out which ones and in what order, from the repository state below:
- "merge this branch into main" is checkout main, then merge the branch that was active. Read its
  name from the state; after the checkout it is no longer the current branch.
- A branch tip never includes uncommitted working-tree changes. When a merge request targets the
  current branch and "hasLocalChanges" is true, inspect "workingTreeDiff" before deciding what to do.
  If the diff clearly belongs to that branch, put a commit step before checkout and merge; the empty
  commit message is intentional because the application writes it from the real diff. If the current
  branch is not the requested source, do not silently commit its changes into another branch: explain
  the mismatch or ask what the user wants. Never present checkout-plus-merge alone as having integrated
  uncommitted work.
- If the requested source branch's "mergedInto" already contains the default branch, there is no
  committed work pending for that merge. Do not propose an empty merge or claim that it integrated work.
- "publish my work" may be commit, then push.
- To update a local branch from a remote copy or work on a remote branch locally, use one
  sync_remote step. Set args.name to the exact remoteRefs entry, args.to to its local counterpart
  when known, and args.side to "theirs" only when the user asks to favor remote edits in conflicts.
  It fetches, switches to the local counterpart (or creates it), and brings in missing commits.
  Both histories and compatible edits are kept. An exact replacement is a different intention.
  If several destinations fit, ask which one. A detached HEAD is not a local branch to pull into.
- When a previous Git step failed, or an action could not be prepared, translate the problem into
  plain language before proposing the way forward. Give the user useful alternatives grounded in the
  repository state, not just the failed command. Say what is still safe, what caused the blockage,
  and what the user can do next; if the state does not support a safe choice, ask one focused question.
  For a push that says the current branch has no upstream, the branch is still safe locally: if a
  remote is available, propose a confirmed git_command such as ["push", "--set-upstream", "origin",
  "the-current-branch"] to publish it and remember the connection; also explain that the user can
  leave it local instead. Never suggest force-pushing as a generic fix, and never make a write happen
  automatically during recovery.
Each step runs against the repository as the previous step left it, so order matters: a branch you
create in step 1 is available in step 2. Use as few steps as the request truly needs, never more than
${planStepLimit}, and leave "steps" empty for every intent other than "git_operation".

Operations for each step: status, checkout, create_branch, delete_branch, fetch, pull, push, merge,
rebase, abort_operation, continue_operation, skip_operation, resolve_conflict, commit. args.name is the branch
for checkout, create_branch,
delete_branch and merge. args.onto is the base branch for rebase. Leave every arg a step does not
need as "".

args.noVerify applies to push only. Set it to "true" when — and only when — the user explicitly
asked to skip the Git hooks ("--no-verify", "skip the hooks", "sin verificaciones"), for example
because a hook failed and they authorized bypassing it. Otherwise leave it "". The exact command,
including the flag, is shown on the confirmation card before anything runs.

"git_command" accepts supported queries in "argv" without the leading "git", such as
["log", "--graph", "--oneline"], and supported forms of a few structured operations, such as the
explicit push examples above. Queries can use log, show, diff, status, blame, ls-files, rev-list
or grep. Use long options with an attached value, such as "--format=%h". The command stays inside
the open project. Use a structured operation for changes whenever possible. Global Git options,
aliases, external helpers and options that write to a file are unavailable. There is no shell.
Investigating a question with a read-only command is always your first instinct; saying
"I can't determine that" is the last resort, for when a command could not find it either. Leave
"argv" empty for every other operation.

args.message is the commit message, ${commitMessageLimit} characters maximum. Leave it "" unless the
user dictated the message themselves: the application reads the actual diff and writes the message
for you, and shows it on the card before anything is committed. So never ask the user what the commit
message should be, and never invent one from the file names in the state.

For a commit of specific files, fill "paths" with their exact names from localChanges, even when
the user names only one. Leave the other files out. An empty "paths" means all unsaved changes.
Other operations leave "paths" empty. A selected commit must be the first step and can be followed
only by a push. Never replace a selected commit with an all-files commit to make a plan fit.

"repository" is only meaningful for "create_repository". Use "" or false for anything unknown:
- localPath: absolute path of the local repository to publish. When the user means "this repository", use the open repository path from the state below.
- repository: remote repository name, 1 to 100 characters from A-Z a-z 0-9 . _ -, never ending in ".git".
- provider: "github", "gitlab", "bitbucket" (Cloud), "bitbucket_dc" (Data Center), or "azure" (Azure DevOps). For an unknown company domain, ask which service it runs; never infer it from its name.
- connectionId: for Bitbucket and Azure, an ID from savedHostingAccounts below, or "" to use the only matching account. Never invent IDs. If multiple accounts match, use the user's intended account or ask a focused question. GitHub and GitLab use "" and their CLI sign-ins.
- owner: GitHub user/organization, full GitLab namespace, Bitbucket Cloud workspace, Bitbucket Data Center project key, or the full Azure organization/collection and project path (for example "my-org/My Project"). Azure repository creation always needs an existing private project; never create or make a project public on the user's behalf.
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

Repositories are always created private. Bitbucket and Azure use the selected saved hosting account for initial HTTPS publication, keeping any SSH remote configuration the user requested. Never ask for tokens in chat: direct the person to Hosting accounts in Settings when no matching connection exists.
GitLab uses the active glab account; it never switches accounts.
The application resolves by itself which authenticated gh
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

Each branch carries "mergedInto": the reference branches whose history contains that branch's tip.
It is computed by Git and only establishes ancestry. Empty ancestry does not establish pending
changes: rebasing, cherry-picking and squashing can change hashes. "ahead" and "behind" compare
a branch with its own upstream. Use "compare_branches" for work pending against a different ref.

Each branch carries a "lifecycle" derived from its prefix, which is policy rather than description.
"permanent": kept on purpose — these branches exist to survive cleanups, so they are never deletion
candidates, never described as safe to remove and never counted as integrated, whatever their history
says. Deleting one is refused outright. "ephemeral": the ones a cleanup is actually about.
"short": worth remarking on when it has not moved for "staleAfterDays" days or more, but ageing is
never by itself a reason to delete anything. "medium" and "unknown" get no special treatment.

A branch with a "stackedOn" continues that branch: its tip already contains that one's, which Git
confirmed. That is the order the work has to be rebased or merged in — the base first, then the one
standing on it — and deleting or rebasing the base without saying what happens to what stands on it
is an answer with a hole in it.

"rename_branch" takes "name" and "to". It renames a local branch and nothing else: the history is
untouched and the remote branch keeps its published name, so a branch with an upstream stays
published under the old one. Only rename when the user asked for it in this conversation. A naming
convention you notice on your own is never a reason to rename anything, and neither is a suggestion
the interface may be showing: those are the user's to accept.

A branch whose "checkedOutIn" is not null is held by another worktree at that path. Git refuses to
check out one branch in two worktrees, so a switch to it will fail until that worktree lets go: say
so and name the path instead of proposing the switch. It is also a sign the branch is in use, so do
not offer it as a deletion candidate however integrated it may be.

"pendingOperation" is a Git job the repository is holding half-finished — a rebase, a merge, a
cherry-pick or a revert. While one exists, almost nothing else can happen: it has to be continued,
skipped or aborted first, and saying so is more useful than proposing something Git will refuse.
"continue_operation", "skip_operation" and "abort_operation" work on whichever job it is, so never
name the subcommand yourself. Aborting throws away the half-finished work and returns the repository
to where it started; it does not touch anything already committed. A rebase and a cherry-pick can
also skip the commit they are stuck on, which drops that commit. Say which of those a choice is
before proposing it.

"conflicts" lists the paths both sides changed. Nothing continues until every one is settled.
"resolve_conflict" takes "path" and "side": "ours" keeps the version already in the branch underneath,
"theirs" keeps the version being brought in, "resolved" means the file on disk is already correct.
Careful with a rebase: your commits are the ones being replayed, so they are "theirs", which is the
opposite of what most people expect. Only use it when the whole file plainly belongs to one side —
when the two sides have to be combined, say so and tell the user the assistant can draft the merged
file for them to review, rather than picking a side that quietly drops work.

Some repository content never reaches you. "withheldFromModel" lists files whose content GitCat kept
on the user's computer, each with its "reason": "excluded" means the user excluded it from what the
assistant may read, "likely_secret" means a local check found what looks like a credential in it
("kinds" says which shapes, never the value). In "workingTreeDiff" such a file appears as a GitCat
placeholder instead of its text. Never guess what a withheld file contains, and never propose a
command whose purpose is to print it (a show, diff, blame or grep aimed at that path) to work around
the rule. When your answer or plan depends on a withheld file, say so plainly in "reply" or
"rationale", name the file, and tell the user they can review what the assistant sees; work that
does not depend on it goes ahead as usual. "redactedFromConversation" counts likely credentials that
were replaced by a "[withheld by GitCat: …]" marker in the conversation or in this request; treat a
marker as a value you cannot see, never as the value itself.

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
    case "sync_remote": return { ref: step.args.name.trim(), name: step.args.to.trim(), side: step.args.side.trim() };
    case "rename_branch": return { name: step.args.name.trim(), to: step.args.to.trim() };
    case "rebase": return { onto: step.args.onto.trim() };
    case "resolve_conflict": return { path: step.args.path.trim(), side: step.args.side.trim() };
    case "commit": return { message: step.args.message.trim() };
    case "push": return step.args.noVerify.trim() === "true" ? { noVerify: "true" } : {};
    default: return {};
  }
}

export function selectedCommitPaths(step: PlannedStep) {
  return step.paths?.length ? step.paths : step.args.path ? [step.args.path] : [];
}

/** Defects in one step, addressed by index so the model knows which of its own steps to fix. */
export function operationIssues(step: PlannedStep, index = 0): PlanIssue[] {
  const at = `steps[${index}]`;
  if (!executableOperations.has(step.operation)) {
    return [{ field: `${at}.operation`, problem: `"${step.operation}" cannot be executed; use one of ${[...executableOperations].join(", ")} or another intent` }];
  }
  const args = operationArgs(step);
  const issues: PlanIssue[] = [];
  if (step.operation === "sync_remote") {
    if (!isBranchNameSafe(args.ref)) issues.push({ field: `${at}.args.name`, problem: "choose the exact remote branch from remoteRefs" });
    if (args.side && args.side !== "theirs") issues.push({ field: `${at}.args.side`, problem: 'use "theirs" for explicit remote preference or leave empty' });
  }
  if (branchOperations.has(step.operation)) {
    if (!args.name) issues.push({ field: `${at}.args.name`, problem: `missing; ${step.operation} needs the branch name the user meant` });
    else if (!isBranchNameSafe(args.name)) issues.push({ field: `${at}.args.name`, problem: `"${args.name}" is not a valid Git branch name` });
  }
  if (step.operation === "rename_branch") {
    if (!args.to) issues.push({ field: `${at}.args.to`, problem: "missing; rename_branch needs the new name" });
    else if (!isBranchNameSafe(args.to)) issues.push({ field: `${at}.args.to`, problem: `"${args.to}" is not a valid Git branch name` });
    else if (args.to === args.name) issues.push({ field: `${at}.args.to`, problem: `identical to "${args.name}"; a rename must change the name` });
  }
  if (step.operation === "resolve_conflict") {
    if (!args.path) issues.push({ field: `${at}.args.path`, problem: "missing; resolve_conflict needs the conflicted path" });
    if (!["ours", "theirs", "resolved"].includes(args.side)) {
      issues.push({ field: `${at}.args.side`, problem: `"${args.side}" is not a side; use "ours", "theirs" or "resolved"` });
    }
  }
  if (step.operation === "rebase") {
    if (!args.onto) issues.push({ field: `${at}.args.onto`, problem: "missing; rebase needs the base branch" });
    else if (!isBranchNameSafe(args.onto)) issues.push({ field: `${at}.args.onto`, problem: `"${args.onto}" is not a valid Git branch name` });
  }
  // An empty commit message is not a defect: the application writes one from the real diff.
  if (step.operation === "commit" && args.message.length > commitMessageLimit) {
    issues.push({ field: `${at}.args.message`, problem: `${args.message.length} characters; the limit is ${commitMessageLimit}` });
  }
  if (step.operation === "commit" && step.args.path && step.paths?.length && !step.paths.includes(step.args.path)) {
    issues.push({ field: `${at}.paths`, problem: "The file selections conflict. Put every selected path in paths and leave args.path empty." });
  }
  if (step.operation !== "commit" && step.paths?.length) {
    issues.push({ field: `${at}.paths`, problem: "Only a commit takes a list of selected files." });
  }
  if (step.operation === "push" && step.args.noVerify.trim() && step.args.noVerify.trim() !== "true") {
    issues.push({ field: `${at}.args.noVerify`, problem: `"${step.args.noVerify}" is not a value; use "true" to skip the hooks or "" to run them` });
  }
  if (step.operation === "git_command") {
    if (!step.argv.length) {
      issues.push({ field: `${at}.argv`, problem: `missing; git_command needs the full command as an argument list, without the leading "git"` });
    } else if (step.argv.some((token) => !token.trim())) {
      issues.push({ field: `${at}.argv`, problem: "contains an empty argument; every element must be a non-empty token" });
    }
  }
  if (step.operation !== "git_command" && step.argv.length) {
    issues.push({ field: `${at}.argv`, problem: `only git_command takes an argument list; leave it empty for ${step.operation}` });
  }
  return issues;
}

/** The sequence as a whole: it must exist, stay within the limit, and every step must stand on its own. */
export function planIssues(plan: ModelPlan): PlanIssue[] {
  if (!plan.steps.length) return [{ field: "steps", problem: "empty; a git_operation needs at least one step, or use another intent" }];
  if (plan.steps.length > planStepLimit) {
    return [{ field: "steps", problem: `${plan.steps.length} steps; the limit is ${planStepLimit}. Plan only what the request needs` }];
  }
  if (plan.steps.length > 1 && plan.steps.some(step => step.operation === "sync_remote")) {
    return [{ field: "steps", problem: "sync_remote prepares the entire update including the local switch; propose it as a single step" }];
  }
  return plan.steps.flatMap((step, index) => operationIssues(step, index));
}

/**
 * Every JSON object the text could contain, with a best effort at closing one that was cut off.
 * Shared by every reply the app parses: a provider that wraps its answer in prose or a fence is a
 * provider problem, not a reason for each caller to invent its own parser.
 */
export function jsonCandidates(text: string) {
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
    Object.keys(value as object).length === keys.length && keys.every((key) => Object.hasOwn(value as object, key));
}

function isReadList(value: unknown): value is PlannedRead[] {
  return Array.isArray(value) && value.every(read =>
    hasExactKeys(read, ["kind", "args"]) && assistantReadKinds.some(kind => kind === read.kind)
    && Array.isArray(read.args) && read.args.every(arg => typeof arg === "string"));
}

export const commitScopeResponseFormat = {
  type: "json_schema", name: "gitcat_commit_scope", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["scope", "paths"],
    properties: { scope: { type: "string", enum: ["all", "selected", "unclear"] }, paths: readListSchema.items.properties.args }
  }
} as const;

export function parseCommitScope(text: string): { scope: "all" | "selected" | "unclear"; paths: string[] } | undefined {
  for (const candidate of jsonCandidates(text.trim())) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (!hasExactKeys(value, ["scope", "paths"]) || !Array.isArray(value.paths) ||
          !value.paths.every(path => typeof path === "string" && path.length > 0)) continue;
      if (value.scope === "selected" && value.paths.length) return { scope: value.scope, paths: value.paths };
      if ((value.scope === "all" || value.scope === "unclear") && !value.paths.length) return { scope: value.scope, paths: [] };
    } catch { /* Try the next JSON object. */ }
  }
}

export const answerCoverageResponseFormat = {
  type: "json_schema",
  name: "gitcat_answer_coverage",
  strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["reads", "uncovered"],
    properties: { reads: readListSchema, uncovered: { type: "boolean" } }
  }
} as const;

export function buildAnswerCoverageInstructions() {
  return `Review a GitCat read plan against the latest user question. Independently identify every part
the user wants answered, including requested scopes, comparisons, dates, authors, counts and filters.
Then map each part to the results the planned reads actually produce. GitCat only displays the facts
those reads return, so selecting the right commit or branch does not by itself supply every fact
about it. Return only the additional reads needed for any missing parts, in the user's order. If a
part still has no suitable local verification or its scope is ambiguous, set uncovered to true. When
the supplied reads already cover the question, return an empty reads array with uncovered false.
Use the normalized reads to resolve references like "that branch" where possible. Add a read only
when it answers a fact requested in the latest question. Do not propose writes or draft answer text.
Prior reads are normalized descriptions: "git" with argv may include a normalized commit_count.
Use the following external read kinds and args for new reads.

${readInstructions}`;
}

export function parseAnswerCoverage(text: string): { reads: PlannedRead[]; uncovered: boolean } | undefined {
  for (const candidate of jsonCandidates(text.trim())) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (hasExactKeys(value, ["reads", "uncovered"]) && isReadList(value.reads) && typeof value.uncovered === "boolean") {
        return { reads: value.reads, uncovered: value.uncovered };
      }
    } catch { /* Try the next JSON object. */ }
  }
}

function validate(value: unknown): ModelPlan | undefined {
  const optionalKeys = ["reads", "answerLanguage"].filter(key => value !== null && typeof value === "object" && Object.hasOwn(value, key));
  if (!hasExactKeys(value, [...planKeys, ...optionalKeys])) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.intent !== "string" || !intents.includes(record.intent as PlannerIntent)) return undefined;
  if (typeof record.risk !== "string" || !risks.includes(record.risk)) return undefined;
  for (const key of ["summary", "rationale", "reply"]) if (typeof record[key] !== "string") return undefined;
  if (optionalKeys.includes("answerLanguage") && !["es", "en", ""].some(lang => lang === record.answerLanguage)) return undefined;
  if (optionalKeys.includes("reads") && !isReadList(record.reads)) return undefined;
  if (!Array.isArray(record.steps)) return undefined;
  for (const step of record.steps) {
    const pathList = step !== null && typeof step === "object" && Object.hasOwn(step, "paths");
    if (!hasExactKeys(step, pathList ? [...stepKeys, "paths"] : stepKeys)) return undefined;
    const entry = step as Record<string, unknown>;
    if (pathList && (!Array.isArray(entry.paths) || !entry.paths.every(path => typeof path === "string" && path.length > 0))) return undefined;
    if (typeof entry.operation !== "string" || !(executableOperations.has(entry.operation as Operation) || entry.operation === "none")) return undefined;
    if (!Array.isArray(entry.argv) || !entry.argv.every((item) => typeof item === "string")) return undefined;
    if (!hasExactKeys(entry.args, argsKeys) || !Object.values(entry.args as object).every((item) => typeof item === "string")) return undefined;
  }
  const optionalRepositoryKeys=['provider','connectionId'].filter(key=>record.repository&&typeof record.repository==='object'&&Object.hasOwn(record.repository,key));
  if (!hasExactKeys(record.repository, [...repositoryKeys,...optionalRepositoryKeys])) return undefined;
  const repository = record.repository as Record<string, unknown>;
  if (repository.provider !== undefined && ![...hostingProviders, ""].includes(repository.provider as string)) return undefined;
  if(repository.connectionId!==undefined&&typeof repository.connectionId!=='string')return undefined;
  for (const key of ["localPath", "repository", "owner", "host", "remote", "sshHost"]) if (typeof repository[key] !== "string") return undefined;
  if (!["ssh", "https", ""].includes(repository.protocol as string)) return undefined;
  if (typeof repository.push !== "boolean" || typeof repository.replaceRemote !== "boolean") return undefined;
  return record as ModelPlan;
}

export function parseModelPlan(text: string): ModelPlan | undefined {
  for (const candidate of jsonCandidates(text.trim())) {
    for (const json of [candidate, candidate.replace(/,\s*([}\]])/g, "$1")]) {
      try {
        const plan = validate(JSON.parse(json));
        if (plan) return plan;
      } catch { /* try the next safely bounded candidate */ }
    }
  }
  return undefined;
}
