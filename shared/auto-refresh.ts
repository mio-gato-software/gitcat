import type { RepoSnapshot } from "./types.js";

/**
 * How often the repository on screen is read again while the window is showing. Often enough that
 * work done in a terminal or an editor appears on its own, rare enough that an idle window costs
 * next to nothing.
 */
export const autoRefreshIntervalMs = 30_000;

/**
 * How often the remote is asked for news in the background. A fetch goes over the network, so it is
 * much rarer than the local read; Refresh asks straight away whenever the user wants to be sure.
 */
export const remoteRefreshIntervalMs = 5 * 60_000;

/**
 * An unchanged view keeps the same snapshot object, so only the "last read" time moves forward.
 * Compare the complete snapshot DTO: stateId binds an operation to Git state, while the view also
 * shows data such as remote configuration and changes in sibling worktrees.
 */
export function refreshedProject<T extends { snapshot: RepoSnapshot; loadedAt: string; fetchedAt?: string }>(project: T, next: RepoSnapshot, loadedAt: string, fetchedAt?: string): T {
  const times = fetchedAt ? { loadedAt, fetchedAt } : { loadedAt };
  return JSON.stringify(next) === JSON.stringify(project.snapshot)
    ? { ...project, ...times }
    : { ...project, snapshot: next, ...times };
}

/**
 * Whether the background check may ask the remote now. A fetch moves remote-tracking refs, which
 * changes the repository state a waiting plan or an open review was prepared against, so it holds
 * off while the user still has something to decide. A failed attempt counts as an attempt: an
 * offline laptop retries at the same calm pace, not on every tick.
 */
export function backgroundFetchDue(context: { hasRemote: boolean; awaitingDecision: boolean; lastAttempt?: number; now: number }): boolean {
  if (!context.hasRemote || context.awaitingDecision) return false;
  return context.lastAttempt === undefined || context.now - context.lastAttempt >= remoteRefreshIntervalMs;
}
