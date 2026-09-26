/**
 * The graph's columns the user can drag. The message takes whatever is left, so it has no width of
 * its own. A column nobody dragged keeps the stylesheet's width, which still adapts to narrow panes,
 * and a graph column without a width follows the number of lanes.
 */
export type GraphColumn = "refs" | "graph" | "changes" | "when";
export type GraphColumnWidths = Partial<Record<GraphColumn, number>>;

export const graphColumnRange: Record<GraphColumn, readonly [number, number]> = {
  refs: [80, 520], graph: [34, 480], changes: [64, 240], when: [64, 220]
};

export function clampGraphColumn(column: GraphColumn, width: number) {
  const [min, max] = graphColumnRange[column];
  return Math.round(Math.min(Math.max(width, min), max));
}

/** Saved widths come back inside their range; anything unreadable is simply not a saved width. */
export function parseGraphColumns(stored: unknown): GraphColumnWidths {
  if (!stored || typeof stored !== "object") return {};
  const record = stored as Record<string, unknown>;
  const widths: GraphColumnWidths = {};
  for (const column of Object.keys(graphColumnRange) as GraphColumn[]) {
    const width = record[column];
    if (typeof width === "number" && Number.isFinite(width)) widths[column] = clampGraphColumn(column, width);
  }
  return widths;
}
