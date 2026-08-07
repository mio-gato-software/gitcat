import { resolve } from "node:path";

/**
 * Which worktree holds each branch, read from `git worktree list --porcelain`. The repository the
 * window has open is left out on purpose: that branch is the current one and is already marked as
 * such, so what remains is exactly the set Git would refuse to check out here.
 */
export function parseWorktrees(raw: string, repoRoot: string) {
  const byBranch = new Map<string, string>();
  let path = "";
  for (const line of raw.split("\n")) {
    // A blank line closes a record, so a stray "branch" can never be attributed to the previous path.
    if (!line.trim()) { path = ""; continue; }
    if (line.startsWith("worktree ")) { path = resolve(line.slice("worktree ".length).trim()); continue; }
    if (!line.startsWith("branch ")) continue;
    const name = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    if (name && path && path !== repoRoot) byBranch.set(name, path);
  }
  return byBranch;
}
