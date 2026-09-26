import type { FileChange, SelectedChange } from "./types.js";

/**
 * Why a set of picked files cannot be saved as it stands. Each one names the file, so the person is
 * told which file to look at again instead of being sent back to the start.
 */
export type SelectionProblem =
  | { kind: "empty" }
  | { kind: "duplicate"; path: string }
  /** The file is no longer an uncommitted change: it was saved, restored or removed elsewhere. */
  | { kind: "unknown"; path: string }
  /** The file, its staged entry or the commit it sits on changed after it was reviewed. */
  | { kind: "changed"; path: string }
  /** A rename was picked while another listed change for one of its two paths was left out. */
  | { kind: "shared"; path: string; with: string };

export type ResolvedSelection = {
  /** The listed changes that were picked, in the order Git lists them. */
  selected: FileChange[];
  /** Every path the save records: both sides of a rename are one change and are saved together. */
  paths: string[];
  /** The listed changes that stay exactly as they are. */
  excluded: FileChange[];
};

/** The paths a listed change occupies. A rename or copy occupies both its old and its new path. */
export function changePaths(change: FileChange) {
  return change.from ? [change.path, change.from] : [change.path];
}

/**
 * Matches what the person picked against what Git lists right now. Nothing is guessed: a file that
 * moved since it was reviewed, or that is no longer listed, is reported rather than saved.
 */
export function resolveSelection(changes: FileChange[], picked: SelectedChange[]): ResolvedSelection | { problem: SelectionProblem } {
  if (!picked.length) return { problem: { kind: "empty" } };
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const seen = new Set<string>();
  for (const item of picked) {
    if (seen.has(item.path)) return { problem: { kind: "duplicate", path: item.path } };
    seen.add(item.path);
    const change = byPath.get(item.path);
    if (!change) return { problem: { kind: "unknown", path: item.path } };
    if (!change.version || change.version !== item.version) return { problem: { kind: "changed", path: item.path } };
  }
  const selected = changes.filter((change) => seen.has(change.path));
  const excluded = changes.filter((change) => !seen.has(change.path));
  const paths = [...new Set(selected.flatMap(changePaths))];
  const recorded = new Set(paths);
  for (const change of excluded) {
    const overlap = changePaths(change).find((path) => recorded.has(path));
    if (overlap) {
      const owner = selected.find((item) => changePaths(item).includes(overlap))!;
      return { problem: { kind: "shared", path: change.path, with: owner.path } };
    }
  }
  return { selected, paths, excluded };
}

/**
 * A file with edits on both sides of the staging area. Saving it records the whole file as it is on
 * disk now, so the staged part and the unstaged part are saved together.
 */
export function isPartlyStaged(change: FileChange) {
  const xy = change.xy ?? "";
  return xy.length === 2 && !" ?!".includes(xy[0]) && !" ?!".includes(xy[1]);
}

export function isUntracked(change: FileChange) {
  return change.code === "??" || change.xy === "??";
}

/**
 * The one .gitignore line that matches exactly this path and nothing else. It is anchored to the
 * repository root, and every character a pattern would read specially is escaped, so a name such as
 * "#notes" or "draft[1].txt" means itself. A name Git cannot express in one line gets no rule.
 */
export function gitignoreLine(path: string): string | undefined {
  if (!path || /[\r\n]/.test(path) || path.startsWith("/") || path.endsWith("/")) return undefined;
  const escaped = path
    .replace(/[\\*?[\]!#]/g, (character) => `\\${character}`)
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
  return `/${escaped}`;
}
