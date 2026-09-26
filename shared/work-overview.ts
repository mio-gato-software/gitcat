import type { Branch, PendingOperationKind, RepoSnapshot } from "./types.js";

/**
 * Where a person's work stands, in the four places it can be: edited on this computer, saved here as
 * commits, integrated into the branch everything lands in, and published to a remote. Every answer is
 * read off the snapshot Git produced; nothing is inferred from branch names or labels, and a remote
 * that has not been checked is said to be unknown rather than assumed to match.
 */

/** A remote check older than this is shown as old news: the numbers may have moved since. */
export const remoteFreshnessMs = 30 * 60_000;

export type NextActionId =
  | "finish_pending" | "return_to_branch" | "save_changes" | "first_save" | "add_first_files"
  | "combine_diverged" | "get_latest" | "connect_remote" | "publish_branch" | "publish_saved"
  | "integrate" | "publish_target" | "check_remote" | "all_set";

export type PublishState = "not_applicable" | "no_remote" | "no_upstream" | "in_sync" | "ahead" | "behind" | "diverged";

export type IntegrationState = "not_applicable" | "no_target" | "on_target" | "integrated" | "not_integrated";

export type WorkOverview = {
  /** The branch checked out, or undefined when Git is on a commit rather than a branch. */
  branch?: string;
  detached: boolean;
  pending?: PendingOperationKind;
  conflicts: number;
  /** Uncommitted files, staged or not. None of them are in any commit yet. */
  edited: { count: number; untracked: number };
  /** Whether this branch has any commit at all. An unborn branch has a name and nothing else. */
  saved: { hasCommits: boolean };
  integration: {
    state: IntegrationState;
    target?: string;
    /** Commits of this branch the target lacks, when Git counted them. */
    notIntegrated?: number;
    /**
     * When the work is in the target: how many of the target's commits are not published yet. A
     * merge done on this computer is not on the remote until the target itself is pushed.
     */
    targetUnpublished?: number;
    /** The target has a place it publishes to, so `targetUnpublished` means something. */
    targetTracked?: boolean;
  };
  published: {
    state: PublishState;
    /** Where a publish would go: the upstream's remote, or the one a first publish would use. */
    remote?: string;
    upstream?: string;
    ahead: number;
    behind: number;
  };
  /** When the remote was last read. Ahead and behind are only as current as this. */
  freshness: { state: "no_remote" | "unknown" | "checked" | "stale"; checkedAt?: string };
  next: {
    action: NextActionId;
    /** The Git command this corresponds to, offered as secondary help and never required. */
    git: string;
    remote?: string;
    upstream?: string;
    target?: string;
  };
};

export type WorkOverviewContext = {
  /** When this project's remote was last fetched in this session, if it was. */
  fetchedAt?: string;
  now?: number;
};

function remoteOf(upstream: string, remotes: string[]) {
  // The longest match wins, so a remote named "team/eu" is not mistaken for "team".
  return [...remotes].sort((a, b) => b.length - a.length).find((remote) => upstream.startsWith(`${remote}/`));
}

/** The remote a first publish would use: the only one, or origin among several. Otherwise a choice. */
function publishRemote(remotes: string[]) {
  if (remotes.length === 1) return remotes[0];
  return remotes.includes("origin") ? "origin" : undefined;
}

function publishState(branch: Branch | undefined, snapshot: RepoSnapshot, detached: boolean): WorkOverview["published"] {
  if (detached || !snapshot.head) {
    return snapshot.remotes.length
      ? { state: "not_applicable", remote: publishRemote(snapshot.remotes), ahead: 0, behind: 0 }
      : { state: "no_remote", ahead: 0, behind: 0 };
  }
  if (!snapshot.remotes.length) return { state: "no_remote", ahead: 0, behind: 0 };
  if (!branch?.upstream) return { state: "no_upstream", remote: publishRemote(snapshot.remotes), ahead: 0, behind: 0 };
  const { ahead, behind, upstream } = branch;
  const state: PublishState = ahead && behind ? "diverged" : ahead ? "ahead" : behind ? "behind" : "in_sync";
  return { state, remote: remoteOf(upstream, snapshot.remotes), upstream, ahead, behind };
}

function integrationState(branch: Branch | undefined, snapshot: RepoSnapshot, detached: boolean): WorkOverview["integration"] {
  const target = snapshot.defaultBranch;
  if (detached || !snapshot.head) return { state: "not_applicable", target };
  if (!target) return { state: "no_target" };
  if (snapshot.currentBranch === target) return { state: "on_target", target };
  const counted = snapshot.integration?.target === target ? snapshot.integration.notIntegrated : undefined;
  // Git's own ancestry answer decides; a count of zero from rev-list says the same thing.
  if (branch?.mergedInto.includes(target) || counted === 0) {
    const targetBranch = snapshot.branches.find((item) => item.name === target && item.presence !== "remote");
    return {
      state: "integrated", target,
      targetTracked: Boolean(targetBranch?.upstream),
      targetUnpublished: targetBranch?.upstream ? targetBranch.ahead : undefined
    };
  }
  return { state: "not_integrated", target, ...(counted !== undefined ? { notIntegrated: counted } : {}) };
}

function freshness(snapshot: RepoSnapshot, context: WorkOverviewContext): WorkOverview["freshness"] {
  if (!snapshot.remotes.length) return { state: "no_remote" };
  if (!context.fetchedAt) return { state: "unknown" };
  const at = Date.parse(context.fetchedAt);
  if (Number.isNaN(at)) return { state: "unknown" };
  const now = context.now ?? Date.now();
  return { state: now - at > remoteFreshnessMs ? "stale" : "checked", checkedAt: context.fetchedAt };
}

const pendingCommand: Record<PendingOperationKind, string> = {
  merge: "git merge --continue",
  rebase: "git rebase --continue",
  cherry_pick: "git cherry-pick --continue",
  revert: "git revert --continue"
};

export function workOverview(snapshot: RepoSnapshot, context: WorkOverviewContext = {}): WorkOverview {
  const detached = snapshot.currentBranch === "HEAD";
  const branch = detached ? undefined : snapshot.branches.find((item) => item.isCurrent);
  const edited = { count: snapshot.changes.length, untracked: snapshot.changes.filter((change) => change.code.includes("?")).length };
  const saved = { hasCommits: Boolean(snapshot.head) };
  const published = publishState(branch, snapshot, detached);
  const integration = integrationState(branch, snapshot, detached);
  const fresh = freshness(snapshot, context);
  const overview = {
    branch: detached ? undefined : snapshot.currentBranch,
    detached,
    pending: snapshot.pending?.kind,
    conflicts: snapshot.conflicts.length,
    edited,
    saved,
    integration,
    published,
    freshness: fresh
  };
  return { ...overview, next: nextAction(overview, snapshot) };
}

/**
 * One next step, the first that applies in order of what could otherwise cost work: a half-finished
 * operation, then a checkout that is not on a branch, then unsaved edits, then the remote. Each one
 * maps to a flow that already exists and still goes through its own review before Git runs.
 */
function nextAction(overview: Omit<WorkOverview, "next">, snapshot: RepoSnapshot): WorkOverview["next"] {
  const { published, integration, edited, saved } = overview;
  const name = overview.branch ?? "";
  if (overview.pending) return { action: "finish_pending", git: pendingCommand[overview.pending] };
  if (overview.conflicts) return { action: "finish_pending", git: "git status" };
  if (overview.detached) return { action: "return_to_branch", git: "git switch -c <branch>" };
  if (edited.count) return saved.hasCommits
    ? { action: "save_changes", git: "git add + git commit" }
    : { action: "first_save", git: "git add + git commit" };
  if (!saved.hasCommits) return { action: "add_first_files", git: "git add" };
  if (published.state === "diverged") return { action: "combine_diverged", git: `git merge ${published.upstream} · git rebase ${published.upstream}`, upstream: published.upstream };
  if (published.state === "behind") return { action: "get_latest", git: "git pull --ff-only", upstream: published.upstream };
  if (published.state === "no_upstream") return { action: "publish_branch", git: `git push --set-upstream ${published.remote ?? "<remote>"} ${name}`, remote: published.remote };
  if (published.state === "ahead") return { action: "publish_saved", git: "git push", remote: published.remote, upstream: published.upstream };
  if (integration.state === "not_integrated" && integration.target && snapshot.branches.some((item) => item.name === integration.target)) {
    return { action: "integrate", git: `git switch ${integration.target} && git merge ${name}`, target: integration.target };
  }
  // Integrating needs no remote, so a repository kept only on this computer still gets that step first.
  if (published.state === "no_remote") return { action: "connect_remote", git: "git remote add origin <url>" };
  if (integration.state === "integrated" && integration.targetUnpublished) {
    return { action: "publish_target", git: `git switch ${integration.target} && git push`, target: integration.target };
  }
  if (overview.freshness.state === "unknown" || overview.freshness.state === "stale") return { action: "check_remote", git: "git fetch" };
  return { action: "all_set", git: "git status" };
}
