import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve, win32 } from "node:path";
import type { ProjectUnavailableReason, RepoSnapshot, RepositoryMatch, UnavailableProject } from "../shared/types.js";

/**
 * The saved workspace is a list of references, not a list of repositories that happened to open
 * this time. An external drive that is not plugged in, a network share that is slow to answer or a
 * Git that fails once must not be enough to forget a project: restoration reports what it could not
 * open, keeps the path, and leaves removal to the person.
 */

/** What identifies a repository independently of where it lives: its first commits and its remotes. */
export type RepoFingerprint = { roots: string[]; remotes: string[] };

export type WorkspaceRecord = {
  paths: string[];
  activePath?: string;
  /** Kept per saved path so a folder offered as its new location can be compared with the original. */
  fingerprints: Record<string, RepoFingerprint>;
};

export type ProjectOutcome = { project: RepoSnapshot } | { unavailable: UnavailableProject };

export type InspectOptions = {
  /** Where the drive that holds a path is mounted; injectable so tests can unplug a pretend volume. */
  volumeRootOf?: (path: string) => string | undefined;
  now?: () => string;
  /**
   * A saved project must still be the root of its own repository. A folder picked by hand may be
   * any folder inside one, and then the repository around it is the candidate.
   */
  exactRoot?: boolean;
};

export function emptyWorkspace(): WorkspaceRecord {
  return { paths: [], fingerprints: {} };
}

function strings(value: unknown, limit: number) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item)))].slice(0, limit) : [];
}

export function parseWorkspace(value: unknown): WorkspaceRecord {
  const record = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const paths = [...new Set(strings(record.paths, 500).map((path) => resolve(path)))];
  const activePath = typeof record.activePath === "string" && paths.includes(resolve(record.activePath)) ? resolve(record.activePath) : undefined;
  const fingerprints: Record<string, RepoFingerprint> = {};
  const saved = (record.fingerprints && typeof record.fingerprints === "object" ? record.fingerprints : {}) as Record<string, unknown>;
  for (const [path, entry] of Object.entries(saved)) {
    if (!paths.includes(resolve(path)) || !entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    fingerprints[resolve(path)] = { roots: strings(item.roots, 20), remotes: strings(item.remotes, 20) };
  }
  return { paths, activePath, fingerprints };
}

/** Fingerprints only for the paths still saved, so a removed project leaves nothing behind. */
export function keepFingerprints(fingerprints: Record<string, RepoFingerprint>, paths: string[]) {
  return Object.fromEntries(Object.entries(fingerprints).filter(([path]) => paths.includes(path)));
}

/**
 * Removable and network storage is mounted under a folder of its own. When that folder is gone the
 * whole drive is, which is a different story from one project folder having moved.
 */
export function volumeRoot(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32") {
    const root = win32.parse(path).root;
    return root && root !== "\\" && root !== "/" ? root : undefined;
  }
  const parts = resolve(path).split("/").filter(Boolean);
  const take = (count: number) => parts.length >= count ? `/${parts.slice(0, count).join("/")}` : undefined;
  if (platform === "darwin") return parts[0] === "Volumes" ? take(2) : undefined;
  if (parts[0] === "media" || (parts[0] === "run" && parts[1] === "media")) return take(parts[0] === "run" ? 4 : 3);
  if (parts[0] === "mnt") return take(2);
  return undefined;
}

/** The closest folder that still exists, so a file dialog opens near where the project used to be. */
export function nearestExistingFolder(path: string): string | undefined {
  let current = resolve(path);
  for (;;) {
    try { if (statSync(current).isDirectory()) return current; } catch { /* keep walking up */ }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

export function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error ?? "")).trim().slice(0, 500);
}

/**
 * Why a folder could not be opened. The filesystem is asked first, because Git reports a missing
 * working directory and a missing Git with the same ENOENT. Only a folder that is there, readable,
 * and that Git explicitly calls "not a git repository" is confirmed to have stopped being one.
 */
export function classifyFailure(path: string, error: unknown, options: InspectOptions = {}): ProjectUnavailableReason {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch (statError) {
    const code = errorCode(statError);
    if (code === "EACCES" || code === "EPERM") return "permission";
    if (code === "ENOENT" || code === "ENOTDIR") {
      const root = (options.volumeRootOf ?? volumeRoot)(path);
      return root && !existsSync(root) ? "storage" : "missing";
    }
    // EIO, ETIMEDOUT, EHOSTDOWN…: the disk or the share is there but did not answer.
    return "storage";
  }
  if (!isDirectory) return "missing";
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch (accessError) {
    const code = errorCode(accessError);
    return code === "EACCES" || code === "EPERM" ? "permission" : "storage";
  }
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") return "permission";
  const message = errorText(error);
  if (/permission denied|dubious ownership|unsafe repository/i.test(message)) return "permission";
  // "not a git repository: /elsewhere/.git/worktrees/x" is a link to data that is not reachable, not a plain folder.
  if (/not a git repository: \S/i.test(message)) return "storage";
  if (/not a git repository/i.test(message)) return "not_repository";
  return "tool";
}

function sameLocation(saved: string, root: string) {
  if (resolve(saved) === resolve(root)) return true;
  try { return realpathSync(saved) === resolve(root); } catch { return false; }
}

export function unavailableProject(path: string, reason: ProjectUnavailableReason, detail: string | undefined, options: InspectOptions = {}): UnavailableProject {
  return { path, name: basename(path) || path, reason, ...(detail ? { detail } : {}), checkedAt: options.now?.() ?? new Date().toISOString() };
}

/** Opens one saved project, or says precisely why it cannot be opened right now. It never throws. */
export async function inspectProject(path: string, load: (path: string) => Promise<RepoSnapshot>, options: InspectOptions = {}): Promise<ProjectOutcome> {
  let project: RepoSnapshot;
  try {
    project = await load(path);
  } catch (error) {
    return { unavailable: unavailableProject(path, classifyFailure(path, error, options), errorText(error), options) };
  }
  // A folder whose own .git is gone can still sit inside another repository; that one is not the project.
  if (options.exactRoot !== false && !sameLocation(path, project.path)) {
    return { unavailable: unavailableProject(path, "not_repository", `git rev-parse --show-toplevel: ${project.path}`, options) };
  }
  return { project };
}

/**
 * Restores every saved project it can and keeps every one it cannot, in the saved order. The active
 * choice survives too, even when it points at a project that is unavailable for now.
 */
export async function restoreProjects(record: WorkspaceRecord, load: (path: string) => Promise<RepoSnapshot>, options: InspectOptions = {}) {
  const projects: RepoSnapshot[] = [];
  const unavailable: UnavailableProject[] = [];
  const paths: string[] = [];
  const fingerprints = { ...record.fingerprints };
  let activePath = record.activePath;
  for (const path of record.paths) {
    const outcome = await inspectProject(path, load, options);
    if ("unavailable" in outcome) {
      paths.push(path);
      unavailable.push(outcome.unavailable);
      continue;
    }
    const actual = outcome.project.path;
    if (actual !== path) {
      // The same folder reached through a link: keep the name Git uses for it.
      if (fingerprints[path] && !fingerprints[actual]) fingerprints[actual] = fingerprints[path];
      delete fingerprints[path];
      if (activePath === path) activePath = actual;
    }
    if (paths.includes(actual)) continue;
    paths.push(actual);
    projects.push(outcome.project);
  }
  if (!activePath || !paths.includes(activePath)) activePath = paths[0];
  return { projects, unavailable, activePath, record: { paths, activePath, fingerprints: keepFingerprints(fingerprints, paths) } satisfies WorkspaceRecord };
}

/** One spelling per remote, so https, ssh and scp-style addresses of the same repository compare equal. */
export function normalizeRemoteUrl(url: string) {
  return url.trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):\d+\//, "$1/")
    .replace(/^([^/:]+):(?!\/)/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

export function fingerprintFrom(roots: string[], remoteUrls: Record<string, string>): RepoFingerprint {
  return {
    roots: [...new Set(roots.map((root) => root.trim()).filter(Boolean))].slice(0, 20),
    remotes: [...new Set(Object.values(remoteUrls).map(normalizeRemoteUrl).filter(Boolean))].slice(0, 20)
  };
}

/**
 * Whether a replacement folder is the saved repository. Sharing a first commit or a remote is enough
 * to call it the same; with nothing saved to compare against, or no overlap, GitCat asks instead.
 */
export function compareFingerprints(saved: RepoFingerprint | undefined, candidate: RepoFingerprint): RepositoryMatch {
  if (!saved) return "unverified";
  const overlap = (a: string[], b: string[]) => a.some((item) => b.includes(item));
  if (overlap(saved.roots, candidate.roots) || overlap(saved.remotes, candidate.remotes)) return "same";
  const comparable = (saved.roots.length > 0 && candidate.roots.length > 0) || (saved.remotes.length > 0 && candidate.remotes.length > 0);
  return comparable ? "different" : "unverified";
}

/**
 * Puts a new location in the old one's place, keeping the order and the active choice. When the new
 * folder is already a saved project the old entry simply goes, instead of listing it twice.
 */
export function relocateProject(record: WorkspaceRecord, from: string, to: string, fingerprint?: RepoFingerprint): WorkspaceRecord {
  if (!record.paths.includes(from)) return record;
  const alreadySaved = from !== to && record.paths.includes(to);
  const paths = record.paths.flatMap((path) => path === from ? (alreadySaved ? [] : [to]) : [path]);
  const fingerprints = { ...record.fingerprints };
  delete fingerprints[from];
  if (fingerprint) fingerprints[to] = fingerprint;
  const activePath = record.activePath === from ? to : record.activePath;
  return { paths, activePath: activePath && paths.includes(activePath) ? activePath : paths[0], fingerprints: keepFingerprints(fingerprints, paths) };
}
