import type { GitProtocol } from "../shared/types.js";

/**
 * What GitCat is allowed to remember: choices the user confirmed, never measured state.
 * Whether gh is installed, where a binary lives or whether a key still authenticates is re-checked
 * every time, because those go stale silently and assuming them is how work is published under the
 * wrong identity. A recalled value only skips the *search*; the *check* always runs.
 */
export type IdentityMemory = { account?: string; sshHost?: string; confirmedAt: string };
export type RepositoryMemory = { host?: string; owner?: string; protocol?: GitProtocol; remote?: string; confirmedAt: string };
export type Memory = { identities: Record<string, IdentityMemory>; repositories: Record<string, RepositoryMemory> };

const entryLimit = 200;

export function emptyMemory(): Memory {
  return { identities: {}, repositories: {} };
}

/** Keyed by host and owner, not by repository: it answers "who am I on this host", which every repository shares. */
export function identityKey(host: string, owner: string) {
  return `${host.trim().toLowerCase()}/${owner.trim().toLowerCase()}`;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestamp(value: unknown) {
  const text = optionalString(value);
  return text && !Number.isNaN(new Date(text).valueOf()) ? text : new Date(0).toISOString();
}

function prune<T extends { confirmedAt: string }>(entries: Record<string, T>): Record<string, T> {
  const keys = Object.keys(entries);
  if (keys.length <= entryLimit) return entries;
  const kept = keys
    .sort((a, b) => entries[b].confirmedAt.localeCompare(entries[a].confirmedAt))
    .slice(0, entryLimit);
  return Object.fromEntries(kept.map((key) => [key, entries[key]]));
}

export function sanitizeMemory(value: unknown): Memory {
  const record = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const identities: Memory["identities"] = {};
  const repositories: Memory["repositories"] = {};

  for (const [key, entry] of Object.entries((record.identities ?? {}) as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const account = optionalString(item.account);
    const sshHost = optionalString(item.sshHost);
    if (!account && !sshHost) continue;
    identities[key] = { ...(account ? { account } : {}), ...(sshHost ? { sshHost } : {}), confirmedAt: timestamp(item.confirmedAt) };
  }
  for (const [key, entry] of Object.entries((record.repositories ?? {}) as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const protocol = item.protocol === "ssh" || item.protocol === "https" ? item.protocol : undefined;
    const remembered: RepositoryMemory = {
      ...(optionalString(item.host) ? { host: optionalString(item.host) } : {}),
      ...(optionalString(item.owner) ? { owner: optionalString(item.owner) } : {}),
      ...(protocol ? { protocol } : {}),
      ...(optionalString(item.remote) ? { remote: optionalString(item.remote) } : {}),
      confirmedAt: timestamp(item.confirmedAt)
    };
    if (Object.keys(remembered).length > 1) repositories[key] = remembered;
  }
  return { identities: prune(identities), repositories: prune(repositories) };
}

export function recallIdentity(memory: Memory, host: string, owner: string): IdentityMemory | undefined {
  return memory.identities[identityKey(host, owner)];
}

export function recallRepository(memory: Memory, path: string): RepositoryMemory | undefined {
  return memory.repositories[path];
}

export function rememberIdentity(memory: Memory, host: string, owner: string, patch: Omit<IdentityMemory, "confirmedAt">, now: string): Memory {
  const key = identityKey(host, owner);
  const account = patch.account?.trim() || memory.identities[key]?.account;
  const sshHost = patch.sshHost?.trim() || memory.identities[key]?.sshHost;
  if (!account && !sshHost) return memory;
  return {
    ...memory,
    identities: prune({ ...memory.identities, [key]: { ...(account ? { account } : {}), ...(sshHost ? { sshHost } : {}), confirmedAt: now } })
  };
}

/** A remembered alias that no longer answers as its owner is worse than no memory at all. */
export function forgetSshHost(memory: Memory, host: string, owner: string): Memory {
  const key = identityKey(host, owner);
  const entry = memory.identities[key];
  if (!entry?.sshHost) return memory;
  const identities = { ...memory.identities };
  if (entry.account) identities[key] = { account: entry.account, confirmedAt: entry.confirmedAt };
  else delete identities[key];
  return { ...memory, identities };
}

export function rememberRepository(memory: Memory, path: string, patch: Omit<RepositoryMemory, "confirmedAt">, now: string): Memory {
  const previous = memory.repositories[path];
  const merged: RepositoryMemory = {
    ...previous,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== "")),
    confirmedAt: now
  };
  if (Object.keys(merged).length <= 1) return memory;
  return { ...memory, repositories: prune({ ...memory.repositories, [path]: merged }) };
}

/** A project found at a new location keeps what was confirmed about it; the old path is forgotten. */
export function relocateRepository(memory: Memory, from: string, to: string): Memory {
  const entry = memory.repositories[from];
  if (!entry || from === to) return memory;
  const repositories = { ...memory.repositories };
  delete repositories[from];
  // Whatever was already confirmed at the new location is the more recent truth.
  repositories[to] = repositories[to] ?? entry;
  return { ...memory, repositories };
}
