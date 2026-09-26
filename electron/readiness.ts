import type {
  AccountReadiness, AuthorReadiness, ConfigScope, CredentialHelper, GitToolReadiness, IdentityValues, RemoteAccess, RemoteProtocol
} from "../shared/types.js";

/**
 * A new developer used to learn that Git was missing, that it did not know their name, or that the
 * remote refused them only when a save or a publish failed. These are facts this Mac can prove
 * beforehand, so they are read and explained up front. Everything here parses what Git, ssh and gh
 * print; none of it changes configuration, and a credential is never read, only the kind of helper
 * that keeps it.
 *
 * Commit attribution and authentication are kept apart on purpose: the author is a label written in
 * every commit, the sign-in is what lets a host accept a push, and one never stands in for the other.
 *
 * Git runs with LC_ALL=C, so its messages are stable English; matching them classifies tool output,
 * not user intent.
 */

export function parseGitVersion(output: string) {
  return output.match(/\bgit version (\S+)/)?.[1];
}

export function gitToolState(path: string | undefined, version: { code: number; stdout: string; stderr: string } | undefined, searched: number): GitToolReadiness {
  if (!path) return { status: "missing", searched };
  const parsed = version?.code === 0 ? parseGitVersion(version.stdout) : undefined;
  if (parsed) return { status: "ok", path, version: parsed };
  const detail = `${version?.stderr ?? ""}\n${version?.stdout ?? ""}`.trim() || "git --version did not answer";
  return { status: "unusable", path, detail: detail.slice(0, 400) };
}

const scopes = new Set<ConfigScope>(["local", "worktree", "global", "system", "command"]);
const precedence: ConfigScope[] = ["system", "global", "local", "worktree", "command"];

export type IdentityEntry = { scope: ConfigScope; key: "name" | "email"; value: string };

/** `git config --show-scope --get-regexp '^user\.(name|email)$'`, in the order Git read it. */
export function parseIdentityConfig(output: string): IdentityEntry[] {
  const entries: IdentityEntry[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^([a-z]+)\t(?:[^\t]*\t)?user\.(name|email)(?: (.*))?$/i);
    if (!match || !scopes.has(match[1] as ConfigScope)) continue;
    entries.push({ scope: match[1] as ConfigScope, key: match[2].toLowerCase() as "name" | "email", value: (match[3] ?? "").trim() });
  }
  return entries;
}

/**
 * The name and email Git will use, each with the file it comes from, plus what this repository and
 * the global settings hold. An empty value counts as unset: Git refuses an empty ident too.
 */
export function authorReadiness(entries: IdentityEntry[], { repository = true }: { repository?: boolean } = {}): AuthorReadiness {
  const considered = repository ? entries : entries.filter((entry) => entry.scope !== "local" && entry.scope !== "worktree");
  const effective = (key: "name" | "email") => {
    let found: { value: string; scope: ConfigScope } | undefined;
    for (const scope of precedence) {
      for (const entry of considered) if (entry.scope === scope && entry.key === key) found = entry.value ? { value: entry.value, scope } : undefined;
    }
    return found;
  };
  const valuesAt = (...wanted: ConfigScope[]): IdentityValues => {
    const values: IdentityValues = {};
    for (const entry of considered) if (wanted.includes(entry.scope) && entry.value) values[entry.key] = entry.value;
    return values;
  };
  const name = effective("name");
  const email = effective("email");
  const repositoryValues = valuesAt("local", "worktree");
  const globalValues = valuesAt("global");
  const overridesGlobal = Boolean((repositoryValues.name || repositoryValues.email) && (globalValues.name || globalValues.email)
    && ((repositoryValues.name && repositoryValues.name !== globalValues.name) || (repositoryValues.email && repositoryValues.email !== globalValues.email)));
  return {
    status: name && email ? "ok" : name || email ? "partial" : "missing",
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    repository: repositoryValues,
    global: globalValues,
    overridesGlobal
  };
}

export type RemoteAddress = { protocol: RemoteProtocol; host?: string; port?: string; path?: string };

/** What kind of address a remote is and which host it names. It only reads the string. */
export function parseRemoteAddress(url: string): RemoteAddress {
  const trimmed = url.trim();
  const scheme = trimmed.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/.*)?$/);
  if (scheme) {
    const kind = scheme[1].toLowerCase();
    const protocol: RemoteProtocol = kind === "https" || kind === "http" ? "https" : kind === "ssh" || kind === "git+ssh" || kind === "ssh+git" ? "ssh" : kind === "file" ? "local" : "other";
    return { protocol, ...(protocol === "local" ? {} : { host: scheme[2].toLowerCase() }), ...(scheme[3] ? { port: scheme[3] } : {}), path: (scheme[4] ?? "").replace(/^\/+/, "").replace(/\.git$/i, "") };
  }
  if (/^(?:\/|~|\.{1,2}\/|[A-Za-z]:[\\/])/.test(trimmed)) return { protocol: "local", path: trimmed };
  const scp = trimmed.match(/^(?:[^@/:\s]+@)?([^@/:\s]+):(?!\/\/)(.+)$/);
  if (scp) return { protocol: "ssh", host: scp[1].toLowerCase(), path: scp[2].replace(/^\/+/, "").replace(/\.git$/i, "") };
  return { protocol: "other" };
}

/** A remote address fit to show: a user name or token written into an https:// address is removed. */
export function displayUrl(url: string) {
  return url.trim().replace(/^(https?:\/\/)[^@/]*@/i, "$1");
}

/** Anything in Git's answer shaped like a credential is masked before it is shown or kept. */
export function redactSecrets(text: string) {
  return text
    .replace(/(https?:\/\/)[^@/\s]*@/gi, "$1")
    .replace(/\b(gh[pousr]_)[A-Za-z0-9]{6,}/g, "$1…")
    .replace(/\b(github_pat_)[A-Za-z0-9_]{6,}/g, "$1…")
    .replace(/\b(glpat-)[A-Za-z0-9_-]{6,}/g, "$1…");
}

type BranchFacts = { name: string; isCurrent: boolean; upstream?: string };
export type RemoteChoice = { name: string; source: "requested" | "upstream" | "origin" | "only" | "first"; upstream?: string };

/** The remote a publish goes to: the one asked for, the branch's upstream, origin, or the only one there is. */
export function selectRemote(branches: BranchFacts[], remotes: string[], requested?: string): RemoteChoice | undefined {
  if (requested && remotes.includes(requested)) return { name: requested, source: "requested" };
  const upstream = branches.find((branch) => branch.isCurrent)?.upstream;
  if (upstream) {
    const owner = remotes.filter((remote) => upstream.startsWith(`${remote}/`)).sort((a, b) => b.length - a.length)[0];
    if (owner) return { name: owner, source: "upstream", upstream };
  }
  if (remotes.includes("origin")) return { name: "origin", source: "origin" };
  if (remotes.length === 1) return { name: remotes[0], source: "only" };
  if (remotes.length) return { name: remotes[0], source: "first" };
  return undefined;
}

const accessPatterns: [RemoteAccess, RegExp][] = [
  ["host_key", /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (?:[A-Z0-9-]+ )?host key is known|host key .* not (?:known|verified)/i],
  ["offline", /Could not resolve host|Could not resolve hostname|Connection refused|Connection timed out|Operation timed out|Network is unreachable|No route to host|Failed to connect|Couldn't connect to server|Connection reset|Connection closed by remote host|timed out|excedió el tiempo máximo|SSL_ERROR|SSL connect error|Proxy CONNECT aborted/i],
  ["credentials", /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or (?:password|token)|HTTP Basic: Access denied|returned error: 401|Bad credentials|token (?:has )?expired|expired token|Password authentication is not supported/i],
  ["denied", /Permission denied \(|Permission to \S+ denied|returned error: 403|(?:access|permission) denied|not allowed to|You don't have access|ERROR: .*not authorized/i],
  ["not_found", /Repository not found|repository '.*' not found|returned error: 404|does not appear to be a git repository|project you were looking for could not be found/i]
];

/**
 * Tells what `git ls-remote` meant from what it printed. A refusal is about the sign-in, an
 * unreachable host is about the network, and neither says anything about the work on this Mac.
 */
export function classifyAccess(result: { code: number; output: string } | { timedOut: true }): RemoteAccess {
  if ("timedOut" in result) return "offline";
  if (result.code === 0) return "ok";
  for (const [kind, pattern] of accessPatterns) if (pattern.test(result.output)) return kind;
  return "unknown";
}

/**
 * Which helper keeps HTTPS sign-ins, from `credential.helper` values in the order Git reads them.
 * An empty value clears the ones before it, exactly as Git does.
 */
export function credentialHelperKind(values: string[]): CredentialHelper {
  const active: string[] = [];
  for (const value of values) {
    if (!value.trim()) active.length = 0;
    else active.push(value.trim());
  }
  if (!active.length) return "none";
  const kinds = active.map((value): CredentialHelper =>
    /\bgh(?:\.exe)?\s+auth\s+git-credential/.test(value) ? "gh"
      : /osxkeychain/.test(value) ? "osxkeychain"
      : /manager/.test(value) ? "manager"
      : /^(?:store)(?:\s|$)|credential-store/.test(value) ? "store"
      : /^(?:cache)(?:\s|$)|credential-cache/.test(value) ? "cache"
      : "other");
  return kinds.includes("gh") ? "gh" : kinds[0];
}

/**
 * The accounts behind a GitHub remote. The SSH greeting proves who a key signs in as; for HTTPS,
 * GitHub CLI's active account is only proven when gh is the helper that answered a working check.
 * Several accounts are listed side by side and none is ever switched to.
 */
export function accountReadiness(input: {
  ghInstalled: boolean;
  accounts: { login: string; active: boolean }[];
  protocol: RemoteProtocol;
  sshLogin?: string;
  helper?: CredentialHelper;
  access: RemoteAccess;
}): AccountReadiness {
  const active = input.accounts.find((account) => account.active)?.login;
  const verified = input.protocol === "ssh" && input.sshLogin ? { verified: input.sshLogin, verifiedBy: "ssh" as const }
    : input.protocol === "https" && input.helper === "gh" && input.access === "ok" && active ? { verified: active, verifiedBy: "gh" as const }
    : {};
  return {
    gh: !input.ghInstalled ? "missing" : input.accounts.length ? "signed_in" : "signed_out",
    accounts: input.accounts.map((account) => ({ login: account.login, active: account.active })),
    ...(input.sshLogin ? { sshLogin: input.sshLogin } : {}),
    ...verified,
    differs: Boolean(input.sshLogin && active && input.sshLogin.toLowerCase() !== active.toLowerCase())
  };
}
