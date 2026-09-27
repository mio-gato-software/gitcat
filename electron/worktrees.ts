import { resolve } from "node:path";
import type { Worktree } from "../shared/types.js";

/** NUL porcelain preserves spaces, newlines and non-ASCII paths without Git quoting. */
export function parseWorktreeList(raw: string, repoRoot: string): Worktree[] {
  const entries: Worktree[] = [];
  let entry: Worktree | undefined;
  for (const field of raw.split(raw.includes("\0") ? "\0" : "\n")) {
    if (!field) { entry = undefined; continue; }
    if (field.startsWith("worktree ")) {
      const path = resolve(field.slice(9));
      entry = { path, head: "", isCurrent: path === resolve(repoRoot), isMain: entries.length === 0, detached: false, bare: false };
      entries.push(entry);
    } else if (entry) {
      if (field.startsWith("HEAD ")) entry.head = field.slice(5);
      else if (field.startsWith("branch refs/heads/")) entry.branch = field.slice(18);
      else if (field === "detached") entry.detached = true;
      else if (field === "bare") entry.bare = true;
      else if (field === "locked" || field.startsWith("locked ")) entry.locked = field.slice(7);
      else if (field === "prunable" || field.startsWith("prunable ")) entry.prunable = field.slice(9);
    }
  }
  return entries;
}

/** The opened folder is excluded from branch occupancy guards. */
export function parseWorktrees(raw: string, repoRoot: string) {
  return new Map(parseWorktreeList(raw, repoRoot)
    .filter(entry => entry.branch && !entry.isCurrent)
    .map(entry => [entry.branch!, entry.path]));
}
