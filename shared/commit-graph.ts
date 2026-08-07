import type { Commit } from "./types.js";
import { prefixOf } from "./branch-tree.js";

/**
 * The commit list turned into an actual graph. Until now the history was a flat list with one
 * vertical rule down the side and a colour taken from the row number, which is to say a decoration:
 * it could not show that two commits were on different branches, because nothing here knew that.
 *
 * Lanes are assigned in a single pass, which is only possible because Git hands the commits in
 * topological order — every child before its parents. That guarantee is the whole algorithm: when a
 * commit is reached, any lane still waiting for it was opened by a child that has already been drawn.
 */

/** Lanes are a column each, so a very wide history has to stop somewhere before it eats the panel. */
export const maxLanes = 12;

export type LaneLine = { lane: number; family: string };

export type GraphRow = {
  commit: Commit;
  /** The column the commit's own node sits in. */
  lane: number;
  /** Lanes crossing this row untouched: a straight line from top to bottom. */
  through: LaneLine[];
  /** Lanes arriving from above that end at this commit, its own lane included when it was already open. */
  incoming: number[];
  /** Lanes leaving downwards, one per parent. The first keeps the commit's own lane. */
  outgoing: number[];
  /** The branch family this commit belongs to, or "" when no ref claims it. */
  family: string;
};

export type CommitGraph = { rows: GraphRow[]; laneCount: number };

/**
 * Hues far enough apart to stay apart, and light enough to hold their own against the dark panel.
 * A fixed set rather than a free hue keeps a family from landing on a colour that reads as grey.
 */
const familyHues = [168, 276, 34, 212, 344, 128, 302, 190, 56, 246, 14, 96];

/** Commits no branch claims: present, readable, and not pretending to belong anywhere. */
export const neutralFamilyColour = "#5f7f96";

/**
 * FNV-1a over the family name. The colour has to be the same on every launch and on every machine,
 * so it comes from the name itself rather than from the order the branches happened to arrive in.
 */
export function familyColour(family: string) {
  if (!family) return neutralFamilyColour;
  let hash = 2166136261;
  for (let index = 0; index < family.length; index += 1) {
    hash ^= family.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${familyHues[(hash >>> 0) % familyHues.length]} 62% 68%)`;
}

/**
 * The family a ref belongs to: the prefix of the branch it names, or the whole name when it has
 * none. Tags name a moment rather than a line of work, so they claim nothing.
 */
export function familyOfRef(ref: string, remotes: string[] = []) {
  const name = ref.replace(/^HEAD ->\s*/, "").trim();
  if (!name || name.startsWith("tag:")) return "";
  const remote = remotes.find((candidate) => name.startsWith(`${candidate}/`));
  const local = remote ? name.slice(remote.length + 1) : name;
  if (!local || local === "HEAD") return "";
  return prefixOf(local) ?? local;
}

/**
 * Several refs can name the same commit, and then the choice is arbitrary unless something breaks the
 * tie. The default branch does: a commit that is the tip of both `main` and a feature branch is read
 * as trunk, because that is the line the rest of the history hangs from.
 */
function seedFamilies(commits: Commit[], remotes: string[], trunk: string) {
  const seed = new Map<string, string>();
  for (const commit of commits) {
    if (seed.has(commit.hash)) continue;
    const found = commit.refs.map((ref) => familyOfRef(ref, remotes)).filter(Boolean);
    const family = found.find((candidate) => candidate === trunk) ?? found[0];
    if (family) seed.set(commit.hash, family);
  }
  return seed;
}

/**
 * Assigns every commit a lane and a family. Commits whose parents fall outside the window Git was
 * asked for simply leave their lane open at the bottom, which is the truth: the history continues,
 * this list does not.
 */
export function buildCommitGraph(commits: Commit[], remotes: string[] = [], defaultBranch?: string): CommitGraph {
  const trunk = defaultBranch ? familyOfRef(defaultBranch, remotes) : "";
  const families = seedFamilies(commits, remotes, trunk);
  const lanes: (string | undefined)[] = [];
  const laneFamily: string[] = [];
  const rows: GraphRow[] = [];

  const firstFree = () => {
    const free = lanes.indexOf(undefined);
    if (free >= 0) return free;
    lanes.push(undefined);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const occupied = lanes.map((hash) => hash !== undefined);
    const waiting = lanes.flatMap((hash, index) => hash === commit.hash ? [index] : []);
    // The leftmost lane waiting for this commit keeps it; the others were branches that converge here.
    const lane = waiting.length ? waiting[0] : firstFree();
    for (const index of waiting) lanes[index] = undefined;
    lanes[lane] = undefined;

    // Only a ref or a child's inheritance decides this. A lane's previous occupant is not a relation.
    const family = families.get(commit.hash) ?? "";
    const outgoing: number[] = [];
    for (const [index, parent] of commit.parents.entries()) {
      // The first parent is the line this commit was committed on, so it stays in the same column.
      const target = index === 0 ? lane : (lanes.indexOf(parent) >= 0 ? lanes.indexOf(parent) : firstFree());
      lanes[target] = parent;
      laneFamily[target] = family;
      if (!outgoing.includes(target)) outgoing.push(target);
      /**
       * A commit with no ref of its own belongs to whatever claimed its child. The trunk claims
       * harder: its first-parent chain is the trunk all the way down, even where a branch that has
       * not diverged yet also happens to point at one of those commits. Asking "which line of work
       * is this on" about a commit on main has one useful answer, and it is main.
       */
      if (index === 0 && family && (family === trunk || !families.has(parent))) families.set(parent, family);
    }

    const touched = new Set([lane, ...waiting, ...outgoing]);
    const through = lanes.flatMap<LaneLine>((hash, index) =>
      hash !== undefined && occupied[index] && !touched.has(index)
        ? [{ lane: index, family: laneFamily[index] ?? "" }]
        : []);
    rows.push({ commit, lane, through, incoming: waiting, outgoing, family });
    while (lanes.length && lanes[lanes.length - 1] === undefined) lanes.pop();
  }

  // The honest width. Clamping belongs to whoever draws it, which cannot widen the panel forever.
  const laneCount = rows.reduce((widest, row) => Math.max(
    widest,
    row.lane + 1,
    ...row.outgoing.map((lane) => lane + 1),
    ...row.incoming.map((lane) => lane + 1),
    ...row.through.map((line) => line.lane + 1)
  ), 1);
  return { rows, laneCount };
}
