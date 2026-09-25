import type { RepoSnapshot } from "./types.js";

/**
 * How often the repository on screen is read again while the window is showing. Often enough that
 * work done in a terminal or an editor appears on its own, rare enough that an idle window costs
 * next to nothing.
 */
export const autoRefreshIntervalMs = 30_000;

/**
 * A quiet re-read only replaces the snapshot when Git reports a different state. An unchanged
 * repository keeps the same object, so the graph, the selection and the scroll stay where they are;
 * only the "last read" time moves forward.
 */
export function refreshedProject<T extends { snapshot: RepoSnapshot; loadedAt: string }>(project: T, next: RepoSnapshot, loadedAt: string): T {
  return next.stateId === project.snapshot.stateId && next.path === project.snapshot.path
    ? { ...project, loadedAt }
    : { ...project, snapshot: next, loadedAt };
}
