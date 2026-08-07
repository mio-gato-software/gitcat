import type { Branch } from "./types.js";
import { isProtectedBranch } from "./branch-lifecycle.js";
import type { LifecycleRule } from "./branch-lifecycle.js";

/**
 * How the branch list is ordered before it is grouped. Ordering happens first on purpose: the tree
 * places every group where its first branch falls, so ordering the flat list also orders the groups
 * by the most recent branch each one holds, without the tree knowing anything about dates.
 */
export type BranchOrder = "activity" | "active" | "alphabetical";

/** Alphabetical says nothing about what you were doing; the last commit does. */
export const defaultBranchOrder: BranchOrder = "activity";

export const branchOrderLabels: Record<BranchOrder, string> = {
  activity: "Actividad reciente",
  active: "Activas primero",
  alphabetical: "Alfabético"
};

export function isBranchOrder(value: unknown): value is BranchOrder {
  return value === "activity" || value === "active" || value === "alphabetical";
}

/** A branch with no readable date sinks to the bottom rather than floating to the top of "recent". */
function activityOf(branch: Branch) {
  const value = branch.lastCommit ? Date.parse(branch.lastCommit.date) : Number.NaN;
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/**
 * Where work is actually happening: the branch this window has checked out, the ones another worktree
 * holds, and — first of all — the one with uncommitted changes sitting in it right now.
 */
function activityRank(branch: Branch, dirty: boolean) {
  if (branch.isCurrent) return dirty ? 3 : 2;
  return branch.checkedOutIn ? 1 : 0;
}

export type BranchOrderContext = { dirty: boolean };

/** Returns a new array: the caller's list is left as the service produced it. */
export function sortBranches(branches: Branch[], order: BranchOrder, context: BranchOrderContext): Branch[] {
  const byName = (a: Branch, b: Branch) => a.name.localeCompare(b.name);
  const byActivity = (a: Branch, b: Branch) => activityOf(b) - activityOf(a) || byName(a, b);
  if (order === "alphabetical") return [...branches].sort(byName);
  if (order === "activity") return [...branches].sort(byActivity);
  return [...branches].sort((a, b) => activityRank(b, context.dirty) - activityRank(a, context.dirty) || byActivity(a, b));
}

/**
 * A branch whose tip the default branch already contains: its work is there, so the row is noise
 * rather than a pending task. The current branch is never counted, because hiding what you are
 * standing on would be a way to lose the panel rather than to clean it. Neither is a branch its
 * prefix keeps permanently: `backup/pre-trailer-rewrite` is integrated by definition and exists
 * anyway, so dimming it would say the opposite of what it is for.
 */
export function isMergedIntoDefault(branch: Branch, defaultBranch?: string, rules?: LifecycleRule[]) {
  return Boolean(defaultBranch) && !branch.isCurrent && branch.name !== defaultBranch &&
    !isProtectedBranch(branch.name, rules) && branch.mergedInto.includes(defaultBranch!);
}
