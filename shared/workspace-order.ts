/** Move an open project beside another, using the current visible order. */
export function reorderWorkspacePaths(paths: string[], source: string, target: string, side: "before" | "after"): string[] {
  if (source === target || !paths.includes(source) || !paths.includes(target)) return paths;
  const next = paths.filter((path) => path !== source);
  const index = next.indexOf(target) + (side === "after" ? 1 : 0);
  next.splice(index, 0, source);
  return next.every((path, position) => path === paths[position]) ? paths : next;
}
