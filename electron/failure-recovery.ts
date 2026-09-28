import type {
  FailureKind, Operation, RecoveryAction, RecoveryFacts, RepoSnapshot
} from "../shared/types.js";

/**
 * A failed Git action used to be recoverable only when the assistant could answer: with no key, or
 * with the provider down, the person was left holding an error. Most failures do not need judgment
 * to explain, though. Git says in its own words that a host could not be reached, that the remote
 * refused a sign-in, that a lock file is in the way or that a hook said no, and the repository shows
 * which branch has no upstream and how far it diverged. This module turns those facts into a kind
 * and the ways on the repository actually supports. It never interprets what the person meant, and
 * every action it names is one GitCat already offers behind its usual preparation and confirmation.
 *
 * Git runs with LC_ALL=C, so its messages are stable English; matching them classifies tool output,
 * not user intent.
 */

export type FailureEvidence = {
  /** The failed step's operation, when a plan says what it was. */
  operation?: Operation;
  command: string;
  /** What Git printed, verbatim. */
  detail: string;
  /** The repository moved after the plan was prepared, so nothing ran. */
  stale: boolean;
  /** An executable hook that runs for this operation, when one exists. */
  hook?: string;
  /** A lock file Git named or that is present now, relative to the repository. */
  lock?: string;
  /** HEAD is not where the plan was prepared. */
  moved?: boolean;
};

export type RecoveryOptions = {
  /** The steps that never completed can be prepared again from a fresh read. */
  retryable: boolean;
  /** The plan saved selected files: a retry would lose the per-file review, so it is reviewed again instead. */
  selectionBound: boolean;
};

const patterns = {
  lock: /Unable to create '[^']+\.lock'|\.lock': File exists|Another git process seems to be running/i,
  identity: /Please tell me who you are|Author identity unknown|Committer identity unknown|unable to auto-detect email address|empty ident name|no email was given and auto-detection is disabled|no name was given and auto-detection is disabled/i,
  conflict: /^CONFLICT \(|Automatic merge failed|could not apply [0-9a-f]+|Merge conflict in|fix conflicts and then commit|Resolve all conflicts manually/im,
  pending: /You have not concluded your merge|MERGE_HEAD exists|rebase-merge directory|It seems that there is already a rebase|cherry-pick is already in progress|revert is already in progress|you are in the middle of/i,
  auth: /Permission denied \(publickey|Permission denied, please try again|Authentication failed|could not read Username|could not read Password|terminal prompts disabled|HTTP Basic: Access denied|returned error: 40[13]|Host key verification failed|Repository not found|remote: (?:Permission|Access) .*denied|does not appear to be a git repository/i,
  network: /Could not resolve host|Could not resolve hostname|Connection refused|Connection timed out|Operation timed out|Network is unreachable|No route to host|Failed to connect|Connection reset|early EOF|remote end hung up unexpectedly|unable to access '[^']*': (?!.*40[13])|SSL_ERROR|excedió el tiempo máximo|timed out/i,
  noUpstream: /has no upstream branch|There is no tracking information for the current branch|no such ref was fetched|does not track a remote branch/i,
  noRemote: /No configured push destination|specify a remote repository|No remote repository specified|'origin' does not appear to be a git repository/i,
  divergent: /Not possible to fast-forward|non-fast-forward|\(fetch first\)|Updates were rejected because|have diverged|diverging branches|Need to specify how to reconcile/i
};

/** The operation a plain command names, for failures that did not come from a plan. */
export function operationFromCommand(command: string): Operation | undefined {
  const verb = /^git\s+(?:-C\s+\S+\s+)?([a-z-]+)/.exec(command.trim())?.[1];
  const verbs: Record<string, Operation> = {
    fetch: "fetch", pull: "pull", push: "push", commit: "commit", merge: "merge", rebase: "rebase",
    switch: "checkout", checkout: "checkout", status: "status"
  };
  return verb ? verbs[verb] : undefined;
}

const remoteOperations = new Set<Operation>(["fetch", "pull", "push", "github_create_repo"]);

export function classifyFailure(evidence: FailureEvidence, snapshot: RepoSnapshot): FailureKind {
  const { detail, operation } = evidence;
  if (evidence.stale) return "stale";
  if (patterns.lock.test(detail)) return "lock";
  if (patterns.identity.test(detail)) return "identity";
  if (snapshot.conflicts.length || (snapshot.pending && patterns.conflict.test(detail))) return "conflict";
  if (snapshot.pending && (patterns.pending.test(detail) || ["abort_operation", "continue_operation", "skip_operation"].includes(operation ?? ""))) return "pending";
  // A remote that refused is about access; one that could not be reached is about the network. Neither
  // is about the files, which is why they are told apart from conflicts and from each other.
  if (patterns.auth.test(detail) && !(snapshot.remotes.length === 0 && patterns.noRemote.test(detail))) return "auth";
  if (patterns.network.test(detail)) return "network";
  if (patterns.noRemote.test(detail) || (!snapshot.remotes.length && operation && remoteOperations.has(operation))) return "no_remote";
  if (patterns.noUpstream.test(detail)) return "missing_upstream";
  if (patterns.divergent.test(detail)) return "divergent";
  if (evidence.hook && operation && ["commit", "push", "merge", "rebase"].includes(operation)) return "hook";
  return "unknown";
}

export function recoveryFacts(snapshot: RepoSnapshot, evidence: FailureEvidence): RecoveryFacts {
  const current = snapshot.branches.find((branch) => branch.isCurrent);
  const remote = current?.upstream?.split("/")[0] ?? (snapshot.remotes.length === 1 ? snapshot.remotes[0] : undefined);
  return {
    branch: snapshot.currentBranch,
    ...(current?.upstream ? { upstream: current.upstream } : {}),
    ahead: current?.ahead ?? 0,
    behind: current?.behind ?? 0,
    remotes: [...snapshot.remotes],
    ...(remote ? { remote } : {}),
    ...(snapshot.pending ? { pending: snapshot.pending } : {}),
    conflicts: snapshot.conflicts.length,
    changes: snapshot.changes.length,
    ...(evidence.hook ? { hook: evidence.hook } : {}),
    ...(evidence.lock ? { lock: evidence.lock } : {}),
    ...(evidence.moved ? { moved: true } : {})
  };
}

const refresh: RecoveryAction = { kind: "refresh" };
const retry: RecoveryAction = { kind: "retry" };
const inspect: RecoveryAction = { kind: "inspect_changes" };
const keep: RecoveryAction = { kind: "keep" };
const prepare = (operation: Operation, option: RecoveryAction["option"], args: Record<string, string> = {}): RecoveryAction => ({ kind: "prepare", operation, option, args });

/**
 * The ways on, from facts alone. `actions` are safe to offer side by side; `choice` is a set of
 * alternatives that change the repository differently, and only the person can pick one of them.
 * Nothing already completed is ever offered again: a retry only covers steps that never finished.
 */
export function recoveryActions(kind: FailureKind, facts: RecoveryFacts, evidence: FailureEvidence, options: RecoveryOptions) {
  const actions: RecoveryAction[] = [];
  let choice: RecoveryAction[] | undefined;
  let needsJudgment = false;
  const retryOrReview = () => {
    if (options.retryable) actions.push(retry);
    else if (options.selectionBound && facts.changes && !actions.includes(inspect)) actions.push(inspect);
  };
  const branchKnown = facts.branch !== "HEAD";
  switch (kind) {
    case "stale":
      actions.push(refresh);
      retryOrReview();
      break;
    case "lock":
    case "auth":
      retryOrReview();
      actions.push(refresh);
      break;
    case "network":
      if (options.retryable) actions.push(retry);
      else if (evidence.operation === "fetch" || evidence.operation === "pull") actions.push(prepare("fetch", "fetch"));
      actions.push(refresh);
      break;
    case "identity":
      actions.push({ kind: "configure_identity" });
      retryOrReview();
      if (facts.changes && !actions.includes(inspect)) actions.push(inspect);
      break;
    case "conflict":
      // Settling the files and backing out are both real answers; which one is the person's call.
      choice = [{ kind: "resolve_conflicts" }, ...(facts.pending ? [prepare("abort_operation", "abort")] : [])];
      if (facts.changes) actions.push(inspect);
      break;
    case "pending":
      choice = [prepare("continue_operation", "continue"), prepare("abort_operation", "abort")];
      actions.push(refresh);
      break;
    case "no_remote":
      actions.push({ kind: "configure_remote" });
      break;
    case "missing_upstream":
      if (!branchKnown || !facts.remotes.length) { actions.push(refresh); needsJudgment = true; break; }
      if (evidence.operation === "pull") { actions.push(refresh); needsJudgment = true; break; }
      // One remote: publishing there is what the push asked for. Several: which one is a choice.
      if (facts.remotes.length === 1) actions.push(prepare("push", "publish", { setUpstream: facts.remotes[0] }));
      else choice = [...facts.remotes.slice(0, 4).map((remote) => prepare("push", "publish", { setUpstream: remote })), keep];
      break;
    case "divergent":
      if (!facts.upstream || facts.behind === 0) {
        // The remote has work this computer has not seen yet. Reading it first is safe and settles the numbers.
        actions.push(prepare("fetch", "fetch"));
        needsJudgment = Boolean(facts.upstream);
        break;
      }
      if (facts.ahead === 0) { actions.push(prepare("pull", "pull")); break; }
      // Both sides have commits the other lacks: merging, replaying and waiting all keep the work, in
      // different shapes. GitCat never picks one.
      choice = [
        prepare("merge", "merge_upstream", { name: facts.upstream }),
        // Git refuses to replay commits over uncommitted changes, so that answer is only offered when it can work.
        ...(facts.changes ? [] : [prepare("rebase", "rebase_upstream", { onto: facts.upstream })]),
        keep
      ];
      if (facts.changes) actions.push(inspect);
      needsJudgment = true;
      break;
    case "hook":
      if (evidence.operation === "commit" && facts.changes) actions.push(inspect);
      retryOrReview();
      if (evidence.operation === "push" && facts.hook === "pre-push") actions.push(prepare("push", "push_no_verify", { noVerify: "true" }));
      actions.push(refresh);
      break;
    default:
      retryOrReview();
      if (facts.changes && !actions.includes(inspect)) actions.push(inspect);
      actions.push(refresh);
      needsJudgment = true;
  }
  return { actions, choice, needsJudgment };
}
