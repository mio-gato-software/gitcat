import type { FileChange } from "../shared/types.js";

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
