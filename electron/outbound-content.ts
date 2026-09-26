import type { SecretFinding, SecretKind, WithheldFile } from "../shared/types.js";

/**
 * The local checks every piece of repository content passes before it may leave the Mac for the
 * configured provider. They run here, without the network, and they only ever report where something
 * looks like a credential (a path, a line and a kind) — never the matched text itself, so a finding can
 * be shown, logged or handed to the model without repeating the secret it describes.
 *
 * These are heuristics. They catch the common shapes (private keys, cloud and API tokens, passwords in
 * settings files, credential files by name) and they can both miss a secret and flag harmless text.
 * Nothing here proves a repository is safe to share; it only lowers the chance of an accident.
 */

type Pattern = { kind: SecretKind; regex: RegExp; group?: number; accept?: (value: string) => boolean };

const placeholderWords = /^(?:x+|\*+|\.+|-+|_+|0+|1234.*|changeme|change_me|example.*|sample.*|dummy.*|placeholder.*|redacted|your.*|my.*|test|testing|password|secret|token|null|none|undefined|true|false|todo|fixme|replace.*)$/i;

/** A value that reads as a generated credential rather than a word, a reference or a placeholder. */
function looksGenerated(value: string) {
  const text = value.trim();
  if (text.length < 12) return false;
  if (/^[$%{<[(]|^(?:process\.env|os\.environ|env\.|import\.meta|ENV\[|getenv|secrets\.)/i.test(text)) return false;
  if (/[()]/.test(text) || placeholderWords.test(text)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(text)).length;
  if (classes < 2) return false;
  return entropy(text) >= 3.2;
}

function entropy(text: string) {
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / text.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

function notPlaceholder(value: string) {
  return value.length >= 3 && !placeholderWords.test(value) && !/^[$%{<]/.test(value);
}

const patterns: Pattern[] = [
  { kind: "private_key", regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "aws_access_key", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: "slack_token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe_key", regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { kind: "api_key", regex: /\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "credential_url", regex: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]+:([^\s:/@'"`]{3,})@/gi, group: 1, accept: notPlaceholder },
  {
    kind: "secret_assignment",
    regex: /[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|auth[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?([^\s"'`,;#]+)/gi,
    group: 1,
    accept: looksGenerated
  }
];

type Match = { kind: SecretKind; start: number; end: number };

function matchesIn(line: string): Match[] {
  const found: Match[] = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of line.matchAll(pattern.regex)) {
      const value = pattern.group ? match[pattern.group] ?? "" : match[0];
      if (!value || (pattern.accept && !pattern.accept(value))) continue;
      const start = (match.index ?? 0) + (pattern.group ? match[0].lastIndexOf(value) : 0);
      const end = start + value.length;
      // One span, one finding: a GitHub token inside an assignment is reported once, by its own kind.
      if (found.some((item) => start < item.end && end > item.start)) continue;
      found.push({ kind: pattern.kind, start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** A cap per file, so one generated fixture cannot turn a review into thousands of rows. */
const findingLimit = 50;

/** Likely credentials in plain text, by 1-based line number and kind. */
export function scanText(path: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length && findings.length < findingLimit; index += 1) {
    for (const match of matchesIn(lines[index])) findings.push({ path, line: index + 1, kind: match.kind });
  }
  return findings.slice(0, findingLimit);
}

/** Where in a diff a finding sits. Only an added line is something a save would newly record. */
export type DiffFinding = SecretFinding & { side: "added" | "removed" | "context" };

/**
 * Likely credentials in one file's unified diff. Every line of it would leave the Mac, including the
 * context and the removed lines, so all of them are read; each finding carries the line number of the
 * version it appears in and which side it is on, because removing a secret is not adding one.
 */
export function scanDiff(path: string, diff: string): DiffFinding[] {
  const findings: DiffFinding[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (findings.length >= findingLimit) break;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk) continue;
    const marker = line[0];
    if (marker !== "+" && marker !== "-" && marker !== " ") continue;
    for (const match of matchesIn(line.slice(1))) {
      findings.push(marker === "-"
        ? { path, line: oldLine, kind: match.kind, side: "removed" }
        : { path, line: newLine, kind: match.kind, side: marker === "+" ? "added" : "context" });
    }
    if (marker === "+") newLine += 1;
    else if (marker === "-") oldLine += 1;
    else { oldLine += 1; newLine += 1; }
  }
  return findings.slice(0, findingLimit);
}

const credentialExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".kdbx", ".asc", ".gpg"]);
const safeEnvSuffixes = /^\.env\.(?:example|sample|template|dist|defaults|schema|test\.example)$/i;

/**
 * Whether a file is a credential by what it is called — a private key, an environment file, a token
 * store — whatever its text looks like. Some names only count when the content carries the part that
 * makes them sensitive: an .npmrc with no token is configuration, one with a token is a credential.
 */
export function isCredentialFile(path: string, content?: string) {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (name === ".env" || (name.startsWith(".env.") && !safeEnvSuffixes.test(name)) || (name.endsWith(".env") && name !== ".env" && !name.startsWith("."))) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(name)) return true;
  if (credentialExtensions.has(extension)) {
    // A certificate or a public key is meant to be shared; only say so when the text proves it.
    if (content !== undefined && !/PRIVATE KEY/.test(content) && /-----BEGIN (?:CERTIFICATE|PUBLIC KEY|PGP PUBLIC KEY BLOCK)-----/.test(content)) return false;
    return true;
  }
  if (["credentials.json", ".git-credentials", ".htpasswd", ".pgpass", "secrets.json", "secrets.yml", "secrets.yaml"].includes(name)) return true;
  if (/^(?:client_secret|service[-_]?account)[^/]*\.json$/.test(name)) return true;
  if (lower.endsWith(".aws/credentials") || lower === "credentials" && content !== undefined && /aws_secret_access_key/i.test(content)) return true;
  if (content === undefined) return false;
  if ([".npmrc", ".yarnrc", ".yarnrc.yml"].includes(name)) return /_auth(?:token)?\s*[=:]|_password\s*[=:]|npmauthtoken\s*:/i.test(content);
  if (name === ".pypirc") return /^\s*password\s*[=:]/im.test(content);
  if (name === ".netrc" || name === "_netrc") return /\bpassword\b/i.test(content);
  if (lower.endsWith(".docker/config.json")) return /"auth"\s*:/.test(content);
  return false;
}

const contentDependentNames = new Set([".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".netrc", "_netrc", "credentials", "config.json"]);

/** Whether the name alone could make a file a credential, so its text is worth reading from disk to decide. */
export function mayBeCredentialFile(path: string) {
  const name = path.toLowerCase().slice(path.lastIndexOf("/") + 1);
  return isCredentialFile(path) || contentDependentNames.has(name);
}

/** Every finding for one file: its name first, then whatever its text holds. */
export function credentialFindings(path: string, content: string | undefined, textFindings: SecretFinding[]): SecretFinding[] {
  return isCredentialFile(path, content) ? [{ path, kind: "credential_file" }, ...textFindings] : textFindings;
}

/**
 * Free text on its way out — a conversation, a Git error, a request — with every likely credential
 * replaced by a marker that names its kind. Nothing else changes, so the text still reads the same.
 */
export function redactText(text: string): { text: string; redacted: number } {
  let redacted = 0;
  const lines = text.split("\n").map((line) => {
    const matches = matchesIn(line);
    if (!matches.length) return line;
    let result = "";
    let cursor = 0;
    for (const match of matches) {
      result += `${line.slice(cursor, match.start)}[withheld by GitCat: looks like ${kindLabels[match.kind]}]`;
      cursor = match.end;
      redacted += 1;
    }
    return result + line.slice(cursor);
  });
  return { text: lines.join("\n"), redacted };
}

/** Plain English for the model; the interface has its own translated labels. */
export const kindLabels: Record<SecretKind, string> = {
  credential_file: "a credential file",
  private_key: "a private key",
  aws_access_key: "an AWS access key id",
  github_token: "a GitHub token",
  slack_token: "a Slack token",
  stripe_key: "a Stripe live key",
  api_key: "an API key",
  google_api_key: "a Google API key",
  jwt: "a signed token (JWT)",
  credential_url: "a password inside a URL",
  secret_assignment: "a password or key assigned in settings"
};

/**
 * What the model reads in place of a file it may not see. It names the file and why, so the model can
 * tell the person its answer is limited instead of guessing — and it never carries the content.
 */
export function withheldPlaceholder(file: WithheldFile) {
  const reason = file.reason === "excluded"
    ? "the user excluded it from what the assistant may read"
    : `a local check found what looks like a credential (${(file.findings ?? []).slice(0, 6).map((finding) => `${kindLabels[finding.kind]}${finding.line ? ` at line ${finding.line}` : ""}`).join("; ")}) and the user has not chosen to share it`;
  return `[GitCat withheld the content of ${file.path}: ${reason}. Do not guess what it contains; if the answer depends on it, say so.]`;
}

/**
 * A repository exclusion as it is stored: trimmed, relative, one line. Patterns read like .gitignore:
 * "secrets/" is a folder anywhere, "*.sql" any file with that ending, "config/prod.yml" or "/notes.md"
 * one path from the root, and "**" crosses folders.
 */
export function normalizeExclusion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // A leading "/" anchors the pattern at the repository root, as it does in .gitignore.
  const pattern = raw.trim().replace(/^\.\//, "").replace(/^\/+/, "/");
  if (!pattern || pattern === "/" || pattern.length > 300 || /[\r\n\0]/.test(pattern) || pattern.split("/").includes("..")) return undefined;
  return pattern;
}

function globSource(glob: string) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      index += 1;
      // "**/" means any number of folders, including none.
      if (glob[index + 1] === "/") { index += 1; source += "(?:.*/)?"; } else source += ".*";
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return source;
}

export function matchesExclusion(path: string, pattern: string) {
  const anchored = pattern.startsWith("/");
  const directory = pattern.endsWith("/");
  const body = pattern.slice(anchored ? 1 : 0, directory ? -1 : undefined);
  if (!body) return false;
  const source = globSource(body);
  if (anchored || body.includes("/")) return new RegExp(`^${source}(?:/.*)?$`).test(path);
  // Without a slash the pattern names a file or folder anywhere; a folder match covers what is inside.
  const segments = path.split("/");
  const segment = new RegExp(`^${source}$`);
  return segments.some((part, index) => segment.test(part) && (!directory || index < segments.length - 1));
}

export function isExcluded(path: string, exclusions: string[]) {
  return exclusions.some((pattern) => matchesExclusion(path, pattern));
}
