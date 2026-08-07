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
  | { kind: "branch"; branch: Branch }
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

export type BranchTreeOptions = { subgroupThreshold?: number };

/** The first segment of a branch name, when there is something on both sides of the slash. */
function prefixOf(name: string) {
  const slash = name.indexOf("/");
  return slash > 0 && slash < name.length - 1 ? name.slice(0, slash) : undefined;
}

/**
 * The token that opens whatever follows the prefix. Repos write this second level without a slash,
 * separated by "-" or "_"; a further "/" delimits at least as strongly, so it counts too.
 */
export function subgroupToken(name: string, prefix: string) {
  return name.slice(prefix.length + 1).match(/^[^\-_/]+/)?.[0] ?? "";
}

function countBranches(nodes: BranchNode[]): number {
  return nodes.reduce((total, node) => total + (node.kind === "branch" ? 1 : node.group.count), 0);
}

/**
 * One prefix group, with its implicit second level resolved. Nesting stops here: two levels are enough
 * to find a branch, and a third turns the panel into a file explorer.
 */
function buildGroup(prefix: string, branches: Branch[], threshold: number): BranchGroup {
  const members = new Map<string, Branch[]>();
  for (const branch of branches) {
    const token = subgroupToken(branch.name, prefix);
    if (!token) continue;
    members.set(token, [...(members.get(token) ?? []), branch]);
  }
  // A token shared by every branch of the group discriminates nothing, so it stays out.
  const promoted = new Set([...members].filter(([, group]) => group.length >= threshold && group.length < branches.length).map(([token]) => token));

  const children: BranchNode[] = [];
  const emitted = new Set<string>();
  for (const branch of branches) {
    const token = subgroupToken(branch.name, prefix);
    if (!token || !promoted.has(token)) { children.push({ kind: "branch", branch }); continue; }
    if (emitted.has(token)) continue;
    emitted.add(token);
    // The subgroup takes the place of its first member, so an ordered input stays ordered.
    const grouped = members.get(token) ?? [];
    children.push({
      kind: "group",
      group: { key: `${prefix}/${token}`, label: token, kind: "prefix", count: grouped.length, children: grouped.map((item) => ({ kind: "branch", branch: item })) }
    });
  }
  return { key: prefix, label: prefix, kind: "prefix", count: branches.length, children };
}

/** Groups the branches by the convention their names already follow, in the order they arrive. */
export function buildBranchTree(branches: Branch[], options: BranchTreeOptions = {}): BranchTree {
  const threshold = Math.max(2, Math.trunc(options.subgroupThreshold ?? defaultSubgroupThreshold));
  const byPrefix = new Map<string, Branch[]>();
  const rootless: Branch[] = [];
  for (const branch of branches) {
    const prefix = prefixOf(branch.name);
    if (prefix) byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), branch]);
    else rootless.push(branch);
  }
  const groups = [...byPrefix].map(([prefix, group]) => buildGroup(prefix, group, threshold));
  // Branches with no prefix close the list: they are the exception, not the heading of anything.
  if (rootless.length) {
    groups.push({ key: rootGroupKey, label: "", kind: "root", count: rootless.length, children: rootless.map((branch) => ({ kind: "branch", branch })) });
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
  const keep = (nodes: BranchNode[]): BranchNode[] => nodes.flatMap<BranchNode>((node) => {
    if (node.kind === "branch") return node.branch.name.toLocaleLowerCase().includes(needle) ? [node] : [];
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
    if (node.kind === "branch") { if (node.branch.name === name) return [group.key]; continue; }
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
