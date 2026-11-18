import type { RepoSnapshot } from "./types.js";

/** The local branches that track this exact ref, plus its same-named counterpart when it exists. */
export function syncDestinations(snapshot: RepoSnapshot, ref: string): string[] {
  const remote = [...snapshot.remotes].sort((a, b) => b.length - a.length).find(name => ref.startsWith(`${name}/`));
  if (!remote || !snapshot.remoteRefs?.includes(ref)) return [];
  const name = ref.slice(remote.length + 1);
  const local = snapshot.branches.filter(branch => branch.presence !== "remote" && (branch.name === name || branch.upstream === ref));
  return local.length ? local.map(branch => branch.name) : [name];
}
