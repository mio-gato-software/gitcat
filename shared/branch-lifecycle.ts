import type { Branch } from "./types.js";
import { prefixOf } from "./branch-tree.js";

/**
 * A prefix is not only a label: it states how long the branch is meant to live, and that is a policy.
 * `backup/pre-trailer-rewrite` exists precisely to survive a cleanup, so listing it as something to
 * delete would not be a cosmetic slip — it would be the app pointing at the one branch that must not
 * go. The policy lives in one table so it can be read, extended and argued with in a single place,
 * and both processes resolve it from here rather than from rules scattered through their own code.
 */
export type BranchLifecycle = "permanent" | "ephemeral" | "short" | "medium" | "unknown";

export type LifecycleRule = { prefix: string; lifecycle: BranchLifecycle };

export const defaultLifecycleRules: LifecycleRule[] = [
  { prefix: "backup", lifecycle: "permanent" },
  { prefix: "archive", lifecycle: "permanent" },
  { prefix: "wip", lifecycle: "ephemeral" },
  { prefix: "tmp", lifecycle: "ephemeral" },
  { prefix: "temp", lifecycle: "ephemeral" },
  { prefix: "cleanup", lifecycle: "ephemeral" },
  { prefix: "demo", lifecycle: "ephemeral" },
  { prefix: "spike", lifecycle: "ephemeral" },
  { prefix: "fix", lifecycle: "short" },
  { prefix: "hotfix", lifecycle: "short" },
  { prefix: "bugfix", lifecycle: "short" },
  { prefix: "feature", lifecycle: "medium" },
  { prefix: "feat", lifecycle: "medium" }
];

/** Days a short-lived branch can sit still before that is worth remarking on. */
export const staleAfterDays = 14;

export const lifecycleLabels: Record<BranchLifecycle, string> = {
  permanent: "permanente",
  ephemeral: "efímera",
  short: "de vida corta",
  medium: "de vida media",
  unknown: "sin política de prefijo"
};

/** What the prefix says about this branch's life. An unknown prefix gets no special treatment at all. */
export function lifecycleOf(name: string, rules: LifecycleRule[] = defaultLifecycleRules): BranchLifecycle {
  const prefix = prefixOf(name);
  if (!prefix) return "unknown";
  const lowered = prefix.toLocaleLowerCase();
  return rules.find((rule) => rule.prefix.toLocaleLowerCase() === lowered)?.lifecycle ?? "unknown";
}

/**
 * A branch whose whole purpose is to outlive cleanups. It is never marked as integrated, never
 * offered for deletion and never accepted by the delete guardrail, whatever its history says.
 */
export function isProtectedBranch(name: string, rules: LifecycleRule[] = defaultLifecycleRules) {
  return lifecycleOf(name, rules) === "permanent";
}

/** A short-lived branch that has not moved in a while. A remark about age, never about deletion. */
export function staleDays(branch: Branch, now: number, rules: LifecycleRule[] = defaultLifecycleRules) {
  if (lifecycleOf(branch.name, rules) !== "short" || branch.isCurrent) return 0;
  const last = branch.lastCommit ? Date.parse(branch.lastCommit.date) : Number.NaN;
  if (Number.isNaN(last)) return 0;
  const days = Math.floor((now - last) / 86_400_000);
  return days >= staleAfterDays ? days : 0;
}
