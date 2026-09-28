import type { GitProtocol } from "../shared/types.js";

/**
 * What GitCat is allowed to remember: choices the user confirmed, never measured state.
 * Whether gh is installed, where a binary lives or whether a key still authenticates is re-checked
 * every time, because those go stale silently and assuming them is how work is published under the
 * wrong identity. A recalled value only skips the *search*; the *check* always runs.
 */
export type IdentityMemory = { account?: string; sshHost?: string; confirmedAt: string };
export type RepositoryMemory = { host?: string; owner?: string; protocol?: GitProtocol; remote?: string; confirmedAt: string };
/**
 * What the person decided about sharing one repository with the assistant. It lives on this computer, never
 * inside the repository: `acknowledgedAt` is when they agreed that its content may go to the provider,
 * `exclusions` are path patterns it must never read, and `reviewed` holds the flagged files they looked
 * at and chose to share, each bound to the version they saw — an edit makes it a new question.
 */
export type SharingMemory = { acknowledgedAt?: string; exclusions: string[]; reviewed: Record<string, string>; confirmedAt: string };
export type Memory = { identities: Record<string, IdentityMemory>; repositories: Record<string, RepositoryMemory>; sharing: Record<string, SharingMemory> };

const entryLimit = 200;
const exclusionLimit = 200;
const reviewedLimit = 500;

export function emptyMemory(): Memory {
  return { identities: {}, repositories: {}, sharing: {} };
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
  const sharing: Memory["sharing"] = {};
  for (const [key, entry] of Object.entries((record.sharing ?? {}) as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const exclusions = Array.isArray(item.exclusions)
      ? [...new Set(item.exclusions.filter((pattern): pattern is string => typeof pattern === "string" && Boolean(pattern.trim()) && pattern.length <= 300 && !/[\r\n\0]/.test(pattern)).map((pattern) => pattern.trim()))].slice(0, exclusionLimit)
      : [];
    const reviewed = Object.fromEntries(Object.entries((item.reviewed && typeof item.reviewed === "object" ? item.reviewed : {}) as Record<string, unknown>)
      .filter(([path, version]) => path && typeof version === "string" && /^[0-9a-f]{16,128}$/.test(version))
      .slice(0, reviewedLimit)) as Record<string, string>;
    const acknowledgedAt = optionalString(item.acknowledgedAt) && !Number.isNaN(new Date(item.acknowledgedAt as string).valueOf()) ? (item.acknowledgedAt as string).trim() : undefined;
    if (!acknowledgedAt && !exclusions.length && !Object.keys(reviewed).length) continue;
    sharing[key] = { ...(acknowledgedAt ? { acknowledgedAt } : {}), exclusions, reviewed, confirmedAt: timestamp(item.confirmedAt) };
  }
  return { identities: prune(identities), repositories: prune(repositories), sharing: prune(sharing) };
}

export function recallSharing(memory: Memory, path: string): SharingMemory {
  return memory.sharing[path] ?? { exclusions: [], reviewed: {}, confirmedAt: new Date(0).toISOString() };
}

/** Replaces the given parts of what was decided about sharing this repository; the rest is kept. */
export function rememberSharing(memory: Memory, path: string, patch: Partial<Omit<SharingMemory, "confirmedAt">>, now: string): Memory {
  const previous = recallSharing(memory, path);
  const next: SharingMemory = {
    ...previous,
    ...patch,
    exclusions: (patch.exclusions ?? previous.exclusions).slice(0, exclusionLimit),
    reviewed: Object.fromEntries(Object.entries(patch.reviewed ?? previous.reviewed).slice(-reviewedLimit)),
    confirmedAt: now
  };
  if (!next.acknowledgedAt) delete next.acknowledgedAt;
  return { ...memory, sharing: prune({ ...memory.sharing, [path]: next }) };
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
  const sharingEntry = memory.sharing[from];
  if ((!entry && !sharingEntry) || from === to) return memory;
  const repositories = { ...memory.repositories };
  const sharing = { ...memory.sharing };
  delete repositories[from];
  delete sharing[from];
  // Whatever was already confirmed at the new location is the more recent truth.
  if (entry) repositories[to] = repositories[to] ?? entry;
  if (sharingEntry) sharing[to] = sharing[to] ?? sharingEntry;
  return { ...memory, repositories, sharing };
}
