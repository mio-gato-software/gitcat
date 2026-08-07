/**
 * Which branches sit on top of which. `feature/menu-import-openai-provider` continues
 * `feature/menu-import-openai`: both the name and the graph say so, and showing them side by side in
 * alphabetical order turns that relationship into a coincidence.
 *
 * Asking Git whether every tip is an ancestor of every other is O(n²) processes, so the names narrow
 * the field first: only a branch whose name opens another is worth a question. With 62 branches that
 * is a handful of pairs rather than nearly two thousand.
 */

export type StackCandidate = { base: string; stacked: string };

const separators = ["-", "_", "/"];

/** One name opens another when the longer continues the shorter at a token boundary. */
export function opensName(base: string, stacked: string) {
  return base !== stacked && stacked.length > base.length && stacked.startsWith(base) &&
    separators.includes(stacked[base.length]);
}

/**
 * The pairs worth verifying. Each branch keeps only its closest base — the longest name that opens
 * it — because a chain reconstructed from every ancestor is more structure than this phase promises.
 */
export function stackCandidates(names: string[]): StackCandidate[] {
  const candidates: StackCandidate[] = [];
  for (const stacked of names) {
    const base = names
      .filter((candidate) => opensName(candidate, stacked))
      .sort((a, b) => b.length - a.length)[0];
    if (base) candidates.push({ base, stacked });
  }
  return candidates;
}
