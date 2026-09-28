export type RefChip = { label: string; kind: "head" | "local" | "remote" | "tag"; ref?: string; remoteRefs?: string[] };

/** Branches lead, the checked-out one first; a tag is a bookmark and only follows. */
const rank: Record<RefChip["kind"], number> = { head: 0, local: 1, remote: 2, tag: 3 };

/**
 * The refs worth showing, once each. `feature/x` and `origin/feature/x` are one branch that happens to
 * exist in two places, so drawing both spent the whole width saying the same name twice and truncated
 * it in the process. Colocated copies keep their exact remote targets behind the cloud icons. When
 * their tips differ, each remote copy retains its own exact identity, even across several remotes.
 *
 * "origin/HEAD" is a symbolic pointer rather than a branch anyone can visit, and the "HEAD -> "
 * decoration is a statement about the checkout, not part of any name.
 *
 * Only the first chip fits in the graph row, so the order decides what the user sees. Git lists a
 * release tag before `origin/main`, and that let `v1.0.64` cover the branch the commit is the tip of.
 * Tags keep their own names too: a tag called like a branch must not swallow the branch.
 */
export function refChips(refs: string[], remotes: string[]): RefChip[] {
  const order: string[] = [];
  const found = new Map<string, { head: boolean; local: boolean; remote: boolean }>();
  const tags: string[] = [];
  const remoteCopies = new Map<string, string[]>();
  const note = (label: string, key: "head" | "local" | "remote") => {
    if (!found.has(label)) { found.set(label, { head: false, local: false, remote: false }); order.push(label); }
    found.get(label)![key] = true;
  };
  for (const raw of refs) {
    const head = /^HEAD ->/.test(raw);
    const name = raw.replace(/^HEAD ->\s*/, "").trim();
    if (!name || name === "HEAD") continue;
    if (name.startsWith("tag:")) {
      const tag = name.slice(4).trim();
      if (tag && !tags.includes(tag)) tags.push(tag);
      continue;
    }
    if (remotes.some((remote) => name === `${remote}/HEAD`)) continue;
    const remote = [...remotes].sort((a, b) => b.length - a.length).find((candidate) => name.startsWith(`${candidate}/`));
    const label = remote ? name.slice(remote.length + 1) : name;
    if (remote) remoteCopies.set(label, [...new Set([...(remoteCopies.get(label) ?? []), name])]);
    note(label, remote ? "remote" : "local");
    if (head) note(label, "head");
  }
  const branches = order.flatMap((label): RefChip[] => {
    const flags = found.get(label)!;
    const copies = remoteCopies.get(label) ?? [];
    if (flags.local) return [{ label, kind: flags.head ? "head" : "local", ...(copies.length ? { remoteRefs: copies } : {}) }];
    return copies.map(ref => ({ label, kind: "remote", ref }));
  });
  return [...branches, ...tags.map((label): RefChip => ({ label, kind: "tag" }))]
    .map((chip, index) => ({ chip, index }))
    .sort((a, b) => rank[a.chip.kind] - rank[b.chip.kind] || a.index - b.index)
    .map(({ chip }) => chip);
}
