import type { Branch } from "./types.js";

/**
 * Branch names already carry the structure the panel needs, so it is read rather than imposed: this
 * module only rearranges the list it is given. It never renames anything, and the order of the input
 * decides the order of the output, which is how sorting stays a separate concern from grouping.
 */

/** How many branches must share a token before it earns a subgroup of its own. */
export const defaultSubgroupThreshold = 3;

/** The group that holds the branches with no prefix at all. It has no label, so it needs a key of its own. */
export const rootGroupKey = " root";

export type BranchGroupKind = "prefix" | "root";

export type BranchNode =
  /** `stacked` holds the branches that continue this one, nested one level and never a chain. */
  | { kind: "branch"; branch: Branch; stacked: Branch[] }
  | { kind: "group"; group: BranchGroup };

export type BranchGroup = {
  /** Stable between renders and sessions, so the collapsed state can be stored against it. */
  key: string;
  label: string;
  kind: BranchGroupKind;
  /** Every branch underneath, subgroups included. */
  count: number;
  children: BranchNode[];
};

export type BranchTree = {
  groups: BranchGroup[];
  /** A single group repeats what the list already says, so its header is dropped. */
  showHeaders: boolean;
};

export type BranchTreeOptions = {
  subgroupThreshold?: number;
  /**
   * Minority spellings mapped to the prefix the repository mostly uses, so `feat/x` sits under
   * `feature`. It changes where the row is drawn and nothing else: the branch keeps its real name.
   */
  aliases?: Record<string, string>;
};

/** The first segment of a branch name, when there is something on both sides of the slash. */
export function prefixOf(name: string) {
  const slash = name.indexOf("/");
  return slash > 0 && slash < name.length - 1 ? name.slice(0, slash) : undefined;
}

/**
 * The token that opens whatever follows the branch's own prefix. Repos write this second level
 * without a slash, separated by "-" or "_"; a further "/" delimits at least as strongly, so it counts
 * too. It reads the name itself rather than the group, so an aliased spelling still lands correctly.
 */
export function subgroupToken(name: string) {
  const slash = name.indexOf("/");
  return slash < 0 ? "" : name.slice(slash + 1).match(/^[^\-_/]+/)?.[0] ?? "";
}

function countBranches(nodes: BranchNode[]): number {
  return nodes.reduce((total, node) => total + (node.kind === "branch" ? 1 + node.stacked.length : node.group.count), 0);
}

/**
 * Branch rows for one list, with the branches that continue another nested under it. Nesting is one
 * level deep by design: when A ← B ← C, C stays at its own level rather than being re-pointed at A,
 * because flattening a chain onto its root would claim a relation Git was never asked about. Whatever
 * happens, no branch is dropped — a row that is not nested is a row that stands on its own.
 */
function branchNodes(branches: Branch[]): BranchNode[] {
  const present = new Map(branches.map((branch) => [branch.name, branch]));
  const baseOf = (branch: Branch) => branch.stackedOn && present.has(branch.stackedOn) ? branch.stackedOn : undefined;
  const nestable = (branch: Branch) => {
    const base = baseOf(branch);
    return base && !baseOf(present.get(base)!) ? base : undefined;
  };
  const followers = new Map<string, Branch[]>();
  for (const branch of branches) {
    const base = nestable(branch);
    if (base) followers.set(base, [...(followers.get(base) ?? []), branch]);
  }
  return branches
    .filter((branch) => !nestable(branch))
    .map((branch) => ({ kind: "branch" as const, branch, stacked: followers.get(branch.name) ?? [] }));
}

/**
 * One prefix group, with its implicit second level resolved. Nesting stops here: two levels are enough
 * to find a branch, and a third turns the panel into a file explorer.
 */
function buildGroup(prefix: string, branches: Branch[], threshold: number): BranchGroup {
  const members = new Map<string, Branch[]>();
  for (const branch of branches) {
    const token = subgroupToken(branch.name);
    if (!token) continue;
    members.set(token, [...(members.get(token) ?? []), branch]);
  }
  // A token shared by every branch of the group discriminates nothing, so it stays out.
  const promoted = new Set([...members].filter(([, group]) => group.length >= threshold && group.length < branches.length).map(([token]) => token));

  const children: BranchNode[] = [];
  const emitted = new Set<string>();
  const loose = branchNodes(branches.filter((branch) => {
    const token = subgroupToken(branch.name);
    return !token || !promoted.has(token);
  }));
  const looseByName = new Map(loose.map((node) => [node.kind === "branch" ? node.branch.name : "", node]));
  for (const branch of branches) {
    const token = subgroupToken(branch.name);
    if (!token || !promoted.has(token)) {
      // A branch nested under another is drawn there, not twice.
      const node = looseByName.get(branch.name);
      if (node) children.push(node);
      continue;
    }
    if (emitted.has(token)) continue;
    emitted.add(token);
    // The subgroup takes the place of its first member, so an ordered input stays ordered.
    const grouped = branchNodes(members.get(token) ?? []);
    children.push({
      kind: "group",
      group: { key: `${prefix}/${token}`, label: token, kind: "prefix", count: countBranches(grouped), children: grouped }
    });
  }
  return { key: prefix, label: prefix, kind: "prefix", count: branches.length, children };
}

/** Groups the branches by the convention their names already follow, in the order they arrive. */
export function buildBranchTree(branches: Branch[], options: BranchTreeOptions = {}): BranchTree {
  const threshold = Math.max(2, Math.trunc(options.subgroupThreshold ?? defaultSubgroupThreshold));
  const aliases = options.aliases ?? {};
  const byPrefix = new Map<string, Branch[]>();
  const rootless: Branch[] = [];
  for (const branch of branches) {
    const own = prefixOf(branch.name);
    const prefix = own ? aliases[own] ?? own : undefined;
    if (prefix) byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), branch]);
    else rootless.push(branch);
  }
  const groups = [...byPrefix].map(([prefix, group]) => buildGroup(prefix, group, threshold));
  // Branches with no prefix close the list: they are the exception, not the heading of anything.
  if (rootless.length) {
    groups.push({ key: rootGroupKey, label: "", kind: "root", count: rootless.length, children: branchNodes(rootless) });
  }
  return { groups, showHeaders: groups.length > 1 };
}

/**
 * The tree reduced to the branches whose full name matches, structure intact. Matching the whole name
 * rather than the leaf is what lets "menu-im" find `feature/menu-import-openai` from anywhere.
 */
export function filterBranchTree(tree: BranchTree, query: string): BranchTree {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return tree;
  const matches = (name: string) => name.toLocaleLowerCase().includes(needle);
  const keep = (nodes: BranchNode[]): BranchNode[] => nodes.flatMap<BranchNode>((node) => {
    if (node.kind === "branch") {
      const stacked = node.stacked.filter((branch) => matches(branch.name));
      if (matches(node.branch.name)) return [{ ...node, stacked }];
      // The base did not match, so its followers stand on their own instead of dragging a row the
      // user did not search for back into the list.
      return stacked.map((branch) => ({ kind: "branch" as const, branch, stacked: [] }));
    }
    const children = keep(node.group.children);
    return children.length ? [{ kind: "group" as const, group: { ...node.group, children, count: countBranches(children) } }] : [];
  });
  const groups = tree.groups.flatMap((group) => {
    const children = keep(group.children);
    return children.length ? [{ ...group, children, count: countBranches(children) }] : [];
  });
  // Headers keep the shape they had unfiltered, so typing never makes the list jump about.
  return { groups, showHeaders: tree.showHeaders };
}

function pathWithin(group: BranchGroup, name: string): string[] | undefined {
  for (const node of group.children) {
    if (node.kind === "branch") {
      if (node.branch.name === name || node.stacked.some((branch) => branch.name === name)) return [group.key];
      continue;
    }
    const nested = pathWithin(node.group, name);
    if (nested) return [group.key, ...nested];
  }
  return undefined;
}

/** The keys of the groups holding this branch, outermost first: what has to be open for it to be visible. */
export function groupPathFor(tree: BranchTree, name: string): string[] {
  for (const group of tree.groups) {
    const path = pathWithin(group, name);
    if (path) return path;
  }
  return [];
}
