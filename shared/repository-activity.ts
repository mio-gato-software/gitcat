import type { RepoSnapshot } from "./types.js";

export type ActivityBaseline = { branches: Record<string, string> };

/** Stable across checkout changes and across the bounded history page. */
export function activityBaseline(snapshot: RepoSnapshot): ActivityBaseline {
  return { branches: Object.fromEntries(snapshot.branches.map((branch) => [branch.name,
    JSON.stringify([branch.lastCommit?.shortHash ?? "", branch.presence, branch.upstream ?? "", branch.ahead, branch.behind])
  ])) };
}

export function parseActivityBaseline(raw: string | null): ActivityBaseline | undefined {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value && value.branches && typeof value.branches === "object" && !Array.isArray(value.branches)
      && Object.values(value.branches).every((hash) => typeof hash === "string")) return value;
  } catch { /* Invalid storage is a first visit, never evidence of new work. */ }
  return undefined;
}

export function changedBranches(previous: ActivityBaseline, current: ActivityBaseline): string[] {
  return [...new Set([...Object.keys(previous.branches), ...Object.keys(current.branches)])]
    .filter((name) => previous.branches[name] !== current.branches[name]);
}

/** Conventional PR references only. A generic #number could just be an issue. */
export function pullRequestReference(subject: string): string | undefined {
  return subject.match(/^Merge pull request #(\d+)\b/i)?.[1]
    ?? subject.match(/\(#(\d+)\)\s*$/)?.[1];
}
