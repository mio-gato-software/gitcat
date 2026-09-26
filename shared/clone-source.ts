import type { CloneUrlProblem } from "./types.js";

/**
 * Addresses a person may clone from. Only the network transports people actually paste are accepted:
 * https://, ssh://, and the scp-like user@host:path that GitHub shows for SSH. Everything Git could
 * read as an option, a local path, or a transport helper ("ext::", "fd::", "file://") is refused
 * here, before Git runs, because those are how an address turns into a command on this Mac.
 * The renderer uses this to answer while the person types; the main process checks again.
 */
export type CloneSource = { url: string; protocol: "https" | "ssh"; host: string; path: string };

export type CloneUrlCheck = { ok: true; source: CloneSource } | { ok: false; problem: CloneUrlProblem };

const maxUrlLength = 1000;
const hostPattern = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/;
const scpPattern = /^(?:([A-Za-z0-9._~][A-Za-z0-9._~-]*)@)?([^@/:\s]+):(?!\/\/)(.+)$/;

function refuse(problem: CloneUrlProblem): CloneUrlCheck { return { ok: false, problem }; }

function pathProblem(path: string): CloneUrlProblem | undefined {
  const trimmed = path.replace(/^\/+/, "");
  if (!trimmed || trimmed === ".git") return "malformed";
  if (trimmed.startsWith("-") || path.split("/").some((segment) => segment.startsWith("-"))) return "option";
  return undefined;
}

export function parseCloneUrl(input: unknown): CloneUrlCheck {
  if (typeof input !== "string") return refuse("empty");
  const url = input.trim();
  if (!url) return refuse("empty");
  if (url.length > maxUrlLength) return refuse("too_long");
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(url)) return refuse("spaces");
  if (url.startsWith("-")) return refuse("option");
  if (url.includes("::")) return refuse("transport_helper");
  if (/^file:/i.test(url) || /^(?:\/|\.{1,2}(?:[/\\]|$)|~|[A-Za-z]:[\\/]|\\\\)/.test(url)) return refuse("local");
  const scheme = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === "http" || scheme === "git") return refuse("insecure");
    if (scheme !== "https" && scheme !== "ssh") return refuse("unsupported");
    let parsed: URL;
    try { parsed = new URL(url); } catch { return refuse("malformed"); }
    if (parsed.password) return refuse("credentials");
    if (parsed.username.startsWith("-")) return refuse("option");
    const host = parsed.hostname;
    if (!host || host.startsWith("-")) return refuse(host ? "option" : "malformed");
    if (!hostPattern.test(host)) return refuse("malformed");
    if (parsed.search || parsed.hash) return refuse("malformed");
    let decoded: string;
    try { decoded = decodeURIComponent(parsed.pathname); } catch { return refuse("malformed"); }
    const problem = pathProblem(decoded);
    if (problem) return refuse(problem);
    return { ok: true, source: { url, protocol: scheme, host, path: parsed.pathname.replace(/^\/+/, "") } };
  }
  const scp = url.match(scpPattern);
  if (!scp) return refuse(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) ? "unsupported" : "malformed");
  const [, user, host, path] = scp;
  if (host.startsWith("-") || user?.startsWith("-")) return refuse("option");
  if (!hostPattern.test(host)) return refuse("malformed");
  const problem = pathProblem(path);
  if (problem) return refuse(problem);
  return { ok: true, source: { url, protocol: "ssh", host, path } };
}

/** The folder name a clone gets by default: the repository's own name, as Git would pick it. */
export function suggestedFolderName(url: string) {
  const check = parseCloneUrl(url);
  if (!check.ok) return "repository";
  let last = check.source.path.replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? "";
  try { last = decodeURIComponent(last); } catch { /* keep it as written */ }
  const name = last.replace(/\.git$/i, "").replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/^[.\s-]+|[\s.]+$/g, "").slice(0, 100);
  return name || "repository";
}

export type FolderNameProblem = "empty" | "reserved" | "separator" | "too_long" | "control";

/** A folder name to create inside the chosen parent: one plain name, never a path. */
export function folderNameProblem(input: unknown): FolderNameProblem | undefined {
  if (typeof input !== "string" || !input.trim()) return "empty";
  const name = input.trim();
  if (name === "." || name === "..") return "reserved";
  if (/[/\\:]/.test(name)) return "separator";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return "control";
  if (new TextEncoder().encode(name).length > 255) return "too_long";
  return undefined;
}
