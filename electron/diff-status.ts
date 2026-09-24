import type { CommitStats, FileChange, FileStats } from "../shared/types.js";

/**
 * `git diff --name-status -z` writes a status and then its path, except for renames and copies, which
 * write two paths: where the file was and where it is now. Reading that as one record per pair is the
 * whole difficulty — get it wrong and every file after the first rename is attributed to the wrong
 * status, which is the kind of mistake a list of filenames makes look plausible.
 */
export function parseNameStatus(raw: string): FileChange[] {
  const records = raw.split("\0").filter(Boolean);
  const changes: FileChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index];
    const pair = code.startsWith("R") || code.startsWith("C");
    // The destination is what the file is called now, so that is the path worth showing.
    const path = records[index + (pair ? 2 : 1)];
    if (path) changes.push({ code, path, from: pair ? records[index + 1] : undefined });
    index += pair ? 2 : 1;
  }
  return changes;
}

/**
 * `git diff --numstat -z` counts lines per file. A rename or copy leaves the path field empty and
 * writes both paths as the next two records, the same pairing `--name-status` uses. Binary files
 * report "-" for both counts, which is not zero: nobody counted anything.
 */
export function parseNumstat(raw: string): Record<string, FileStats> {
  const records = raw.split("\0");
  const stats: Record<string, FileStats> = {};
  for (let index = 0; index < records.length; index += 1) {
    const match = records[index].match(/^\s*(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!match) continue;
    const [, added, deleted, inline] = match;
    // The destination is the file's name now, which is how the file list refers to it.
    const path = inline || records[index + 2];
    if (!inline) index += 2;
    if (!path) continue;
    const binary = added === "-" || deleted === "-";
    stats[path] = { additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary };
  }
  return stats;
}

/** The summary line `--shortstat` prints, such as " 3 files changed, 10 insertions(+), 2 deletions(-)". */
export function parseShortstat(line: string): CommitStats | undefined {
  const files = line.match(/(\d+) files? changed/);
  if (!files) return undefined;
  return {
    files: Number(files[1]),
    additions: Number(line.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
    deletions: Number(line.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0)
  };
}
