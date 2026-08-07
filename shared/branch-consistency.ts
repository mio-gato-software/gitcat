import type { Branch } from "./types.js";

/**
 * What the repository's own naming says when it disagrees with itself. Everything here produces
 * suggestions and nothing else: no rename is ever performed from this module, and a suggestion the
 * user dismisses is a suggestion that stays dismissed. The convention belongs to the user.
 */

/** Prefix families that mean the same thing without looking alike, so no distance would ever pair them. */
export const prefixFamilies: string[][] = [
  ["feat", "feature"],
  ["fix", "bugfix", "hotfix"],
  ["chore", "chores"],
  ["doc", "docs"],
  ["test", "tests"],
  ["release", "rel"]
];

/** Names that mean something to Git or to the team: never a candidate for a naming suggestion. */
export const reservedNames = new Set(["main", "master", "develop", "trunk", "HEAD"]);

/** How much bigger the majority has to be before the other spelling is "clearly a minority". */
export const minorityRatio = 3;

/** Below this share of prefixed branches, the repository does not have a slash convention to be inconsistent with. */
export const slashDominance = 0.6;

export type BranchRename = { from: string; to: string };

export type PrefixVariantSuggestion = {
  kind: "prefix";
  /** Stable across sessions so a dismissal survives a restart. */
  id: string;
  variant: string;
  canonical: string;
  variantCount: number;
  canonicalCount: number;
  renames: BranchRename[];
};

export type SeparatorSuggestion = {
  kind: "separator";
  id: string;
  token: string;
  renames: BranchRename[];
};

export type BranchSuggestion = PrefixVariantSuggestion | SeparatorSuggestion;

function prefixOf(name: string) {
  const slash = name.indexOf("/");
  return slash > 0 && slash < name.length - 1 ? name.slice(0, slash) : undefined;
}

/** Levenshtein, bounded by the two words being prefixes: nothing here needs a faster one. */
export function editDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1]
        : 1 + Math.min(previous[j - 1], previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Two spellings of one prefix. A small edit distance alone is not enough — "dev" and "demo" are two
 * characters apart and are not the same idea — so a pair also has to be a known family, or one has to
 * open the other, or both have to be long enough that a coincidence is unlikely.
 */
export function areSynonymPrefixes(a: string, b: string) {
  if (a === b) return false;
  if (prefixFamilies.some((family) => family.includes(a) && family.includes(b))) return true;
  if (editDistance(a, b) > 2) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) || shorter.length >= 5;
}

function countPrefixes(branches: Branch[]) {
  const counts = new Map<string, Branch[]>();
  for (const branch of branches) {
    const prefix = prefixOf(branch.name);
    if (prefix) counts.set(prefix, [...(counts.get(prefix) ?? []), branch]);
  }
  return counts;
}

/** 3.1 — a prefix spelled two ways, where one spelling is clearly the minority. */
export function prefixVariants(branches: Branch[]): PrefixVariantSuggestion[] {
  const counts = countPrefixes(branches);
  const suggestions: PrefixVariantSuggestion[] = [];
  const claimed = new Set<string>();
  for (const [variant, members] of counts) {
    if (claimed.has(variant)) continue;
    const canonical = [...counts]
      .filter(([other, group]) => areSynonymPrefixes(variant, other) && members.length * minorityRatio <= group.length)
      // The majority is the majority: when several qualify, the biggest one wins.
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (!canonical) continue;
    claimed.add(variant);
    suggestions.push({
      kind: "prefix",
      id: `prefix:${variant}->${canonical[0]}`,
      variant,
      canonical: canonical[0],
      variantCount: members.length,
      canonicalCount: canonical[1].length,
      renames: members.map((branch) => ({ from: branch.name, to: `${canonical[0]}/${branch.name.slice(variant.length + 1)}` }))
    });
  }
  return suggestions;
}

/** The variant-to-canonical map the panel groups by, so both spellings sit under one header. */
export function prefixAliases(suggestions: BranchSuggestion[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const suggestion of suggestions) if (suggestion.kind === "prefix") aliases[suggestion.variant] = suggestion.canonical;
  return aliases;
}

/**
 * 3.2 — a branch written with "-" where the repository writes "/". Only suggested when the token is
 * already a prefix here, or when several branches repeat it: one lone hyphenated name is a name, not
 * an inconsistency.
 */
export function separatorVariants(branches: Branch[]): SeparatorSuggestion[] {
  const prefixed = branches.filter((branch) => prefixOf(branch.name));
  if (prefixed.length < 3 || prefixed.length / branches.length < slashDominance) return [];
  const known = new Set(prefixed.map((branch) => prefixOf(branch.name)!));
  const byToken = new Map<string, BranchRename[]>();
  for (const branch of branches) {
    if (prefixOf(branch.name) || reservedNames.has(branch.name)) continue;
    const separator = branch.name.search(/[-_]/);
    if (separator < 2 || separator >= branch.name.length - 1) continue;
    const token = branch.name.slice(0, separator);
    const rename = { from: branch.name, to: `${token}/${branch.name.slice(separator + 1)}` };
    byToken.set(token, [...(byToken.get(token) ?? []), rename]);
  }
  return [...byToken]
    .filter(([token, renames]) => known.has(token) || renames.length > 1)
    .map(([token, renames]) => ({ kind: "separator" as const, id: `separator:${token}`, token, renames }));
}

/** Every naming suggestion this repository justifies, minus the ones the user already waved away. */
export function branchSuggestions(branches: Branch[], dismissed: string[] = []): BranchSuggestion[] {
  const ignored = new Set(dismissed);
  return [...prefixVariants(branches), ...separatorVariants(branches)].filter((suggestion) => !ignored.has(suggestion.id));
}

/**
 * 3.3 — what this repository already writes, offered while a new branch is being named. Ordered by
 * how much of the repository uses each one, because that is what makes a completion worth offering.
 */
export function namingCompletions(branches: Branch[]): string[] {
  const counts = new Map<string, number>();
  for (const branch of branches) {
    const prefix = prefixOf(branch.name);
    if (!prefix) continue;
    counts.set(`${prefix}/`, (counts.get(`${prefix}/`) ?? 0) + 1);
    const rest = branch.name.slice(prefix.length + 1);
    const token = rest.match(/^[^\-_/]+/)?.[0];
    if (token && token !== rest) counts.set(`${prefix}/${token}-`, (counts.get(`${prefix}/${token}-`) ?? 0) + 1);
  }
  return [...counts]
    .filter(([completion, count]) => count > 1 || completion.endsWith("/"))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([completion]) => completion);
}

/**
 * The prefix this repository overwhelmingly writes instead of the one being typed. It is a remark, not
 * a rule: whoever is naming the branch decides, and the caller must never block on this.
 */
export function variantHint(name: string, branches: Branch[]) {
  const typed = prefixOf(name.trim());
  if (!typed) return undefined;
  const counts = countPrefixes(branches);
  // A prefix that already has a handful of branches here is a convention, not a slip. One that has
  // one — the very case this exists for — still gets the remark.
  const typedCount = Math.max(counts.get(typed)?.length ?? 0, 1);
  const canonical = [...counts]
    .filter(([other, group]) => areSynonymPrefixes(typed, other) && typedCount * minorityRatio <= group.length)
    .sort((a, b) => b[1].length - a[1].length)[0];
  return canonical ? { typed, canonical: canonical[0], count: canonical[1].length } : undefined;
}
