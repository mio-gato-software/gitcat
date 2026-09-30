import type { Commit, HistoryScope, RepoSnapshot, Worktree } from "./types.js";
import { workInProgressHash } from "./commit-graph.js";

export function worktreeWipHash(worktree: Worktree) {
  return worktree.isCurrent ? workInProgressHash : `${workInProgressHash}:${worktree.path}`;
}

/** Each folder's edits continue from its own HEAD, including detached worktrees. */
export function graphWorktrees(snapshot: RepoSnapshot, scope: HistoryScope, branch?: string): Worktree[] {
  const current: Worktree = { path: snapshot.path, head: snapshot.head, branch: snapshot.currentBranch,
    isCurrent: true, isMain: true, bare: false, detached: snapshot.currentBranch === "HEAD", changes: snapshot.changes };
  return (snapshot.worktrees ?? [current]).filter(worktree => !worktree.bare
    && worktree.prunable === undefined && !worktree.statusUnavailable && worktree.changes?.length
    && (scope === "all" || (worktree.branch ?? (worktree.isCurrent && worktree.detached ? "HEAD" : undefined)) === branch));
}

/** Insert WIP just above its parent, preserving Git's topological order and all saved commit refs. */
export function withWorktreeWork(commits: Commit[], worktrees: Worktree[]): Commit[] {
  return commits.flatMap(commit => [
    ...worktrees.filter(worktree => worktree.head === commit.hash).map((worktree): Commit => ({
      hash: worktreeWipHash(worktree), shortHash: "", subject: "", author: "", email: "", date: "",
      refs: worktree.branch && !worktree.detached ? [worktree.branch] : [], parents: [worktree.head]
    })), commit
  ]);
}
