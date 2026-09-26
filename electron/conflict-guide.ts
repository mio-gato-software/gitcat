import type {
  ConflictChoice, ConflictRename, ConflictSideId, ConflictSideRole, PendingOperationKind
} from "../shared/types.js";

/**
 * Resolving a conflict should never depend on an assistant being available. Git already knows
 * everything needed to explain one: the index holds up to three versions of each conflicted path
 * (stage 1 the common ancestor, stage 2 "ours", stage 3 "theirs"), and the operation's own state
 * says what those sides are. This module turns those facts into plain choices. It reads nothing and
 * writes nothing itself; the Git service feeds it what Git printed.
 */

export type UnmergedEntry = { mode: string; oid: string; stage: 1 | 2 | 3 };

/** `git ls-files -u -z`: "<mode> <oid> <stage>\t<path>" records, grouped by path. */
export function parseUnmerged(raw: string) {
  const entries = new Map<string, UnmergedEntry[]>();
  for (const record of raw.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    const number = Number(stage);
    if (!mode || !oid || ![1, 2, 3].includes(number)) continue;
    const path = record.slice(tab + 1);
    entries.set(path, [...(entries.get(path) ?? []), { mode, oid, stage: number as 1 | 2 | 3 }]);
  }
  return entries;
}

/** The stage Git uses for each side. The same numbers in every operation; only their meaning changes. */
export const sideStage: Record<ConflictSideId, 2 | 3> = { ours: 2, theirs: 3 };

/** A symlink or a submodule has no lines to compare: it is one version or the other. */
export function isSpecialMode(mode: string) {
  return mode === "120000" || mode === "160000";
}

/** The same test Git applies: a NUL byte near the start means the file is not text. */
export function isBinaryContent(content: Buffer) {
  return content.subarray(0, 8000).includes(0);
}

/**
 * Conflict markers Git wrote and nobody removed: the opening or closing line of a conflict block, or
 * the base section `merge.conflictStyle=diff3` adds. A line of seven "=" alone is not enough, since
 * Markdown and reStructuredText underline headings with exactly that.
 */
export function hasConflictMarkers(text: string) {
  return /^(<{7}|>{7}|\|{7})( |$)/m.test(text);
}

/** `git diff --name-status -z -M`: the renames between two commits, as from → to pairs. */
export function parseRenames(raw: string): { from: string; to: string }[] {
  const records = raw.split("\0");
  const renames: { from: string; to: string }[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];
    if (!status) continue;
    if (/^[RC]\d*$/.test(status)) {
      const from = records[index + 1];
      const to = records[index + 2];
      index += 2;
      if (status.startsWith("R") && from && to) renames.push({ from, to });
    } else index += 1;
  }
  return renames;
}

/** The renames that involve a path, on either side: it was renamed away, or it is where a file went. */
export function renamesFor(path: string, bySide: Record<ConflictSideId, { from: string; to: string }[]>): ConflictRename[] {
  return (["ours", "theirs"] as const).flatMap((side) => bySide[side]
    .filter((rename) => rename.from === path || rename.to === path)
    .map((rename) => ({ side, ...rename })));
}

/**
 * What each side is, by operation. In a merge, cherry-pick or revert "ours" is the branch you are
 * on. In a rebase it is the branch being moved onto, and the person's own commit is "theirs".
 */
export function sideRoles(kind: PendingOperationKind | undefined): Record<ConflictSideId, ConflictSideRole> {
  switch (kind) {
    case "rebase": return { ours: "rebase_base", theirs: "replayed_commit" };
    case "cherry_pick": return { ours: "current_branch", theirs: "picked_commit" };
    case "revert": return { ours: "current_branch", theirs: "reverted_commit" };
    default: return { ours: "current_branch", theirs: "incoming_branch" };
  }
}

/**
 * The only choices a file's shape supports. A side that does not hold the file cannot be "kept" as
 * a version — keeping the deletion is its own choice — and a file that is not text can only be taken
 * whole, so editing it by hand is not offered.
 */
export function choicesFor(file: { ours: boolean; theirs: boolean; binary: boolean; working: boolean }): ConflictChoice[] {
  const choices: ConflictChoice[] = [];
  if (file.ours) choices.push("ours");
  if (file.theirs) choices.push("theirs");
  if (!file.ours || !file.theirs) choices.push("delete");
  if (!file.binary && file.working && (file.ours || file.theirs)) choices.push("edited");
  return choices;
}

/** What Git is told for each choice. A side with no stage for the path means the file goes. */
export function commandFor(choice: ConflictChoice, stages: Set<number>): "checkout" | "remove" | "add" {
  if (choice === "delete") return "remove";
  if (choice === "edited") return "add";
  return stages.has(sideStage[choice]) ? "checkout" : "remove";
}

/**
 * Commits still waiting after the one that stopped. A rebase counts them itself; a cherry-pick or
 * revert of several commits keeps a to-do list whose first line is the commit that stopped.
 */
export function remainingSteps(kind: PendingOperationKind | undefined, progress: { step?: number; total?: number }, sequencerTodo?: string) {
  if (kind === "rebase") return progress.step && progress.total ? Math.max(0, progress.total - progress.step) : 0;
  if (kind === "cherry_pick" || kind === "revert") {
    const lines = (sequencerTodo ?? "").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    return Math.max(0, lines.length - 1);
  }
  return 0;
}

/**
 * File types the system does not merely show but runs or installs when asked to open them. A
 * conflicted file can come from someone else's branch, so for these GitCat shows the file in its
 * folder instead of opening it.
 */
const launchingExtensions = new Set([
  "app", "applescript", "bat", "cmd", "com", "command", "cpl", "desktop", "dmg", "exe", "inetloc", "jar", "jse", "lnk", "msi",
  "pkg", "ps1", "reg", "scpt", "scr", "sh", "terminal", "tool", "url", "vbs", "webloc", "workflow", "wsf"
]);

/** Windows runs a script file with its script host rather than showing it. */
const windowsScriptExtensions = new Set(["js", "hta", "vbe"]);

export function opensSafely(path: string, platform: string = process.platform) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return true;
  const extension = name.slice(dot + 1).toLowerCase();
  return !launchingExtensions.has(extension) && !(platform === "win32" && windowsScriptExtensions.has(extension));
}
