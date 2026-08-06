import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { GitProtocol, RepositoryPlan } from "../shared/types.js";

export type RepositoryFields = {
  localPath?: string;
  repository?: string;
  owner?: string;
  host?: string;
  protocol?: GitProtocol;
  /** Optional ~/.ssh/config alias when the default key for `host` is not the owner's. */
  sshHost?: string;
  push?: boolean;
  remote?: string;
  replaceRemote?: boolean;
};

export type RepositoryFieldName = "localPath" | "repository" | "owner" | "host" | "protocol" | "remote" | "sshHost";

/** Machine-readable defect, written for the planner model rather than for the user. */
export type RepositoryIssue = { field: RepositoryFieldName; problem: string };

export type RepositoryValidation = {
  fields: RepositoryFields;
  issues: RepositoryIssue[];
};

export const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;
export const repositoryOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const repositoryHostPattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export const remoteNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const sshHostPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;

const expectations: Record<RepositoryFieldName, string> = {
  localPath: "absolute path of the local Git repository to publish",
  repository: "remote repository name, 1 to 100 characters from A-Z a-z 0-9 . _ -, never \".\", \"..\" or ending in .git",
  owner: "GitHub user or organization login",
  host: "DNS host name without scheme, port or path, for example github.com",
  protocol: "\"ssh\" or \"https\"",
  remote: "Git remote name, for example origin",
  sshHost: "SSH host name or ~/.ssh/config alias, without user, scheme or path"
};

function missing(field: RepositoryFieldName): RepositoryIssue {
  return { field, problem: `missing; expected the ${expectations[field]}` };
}

function invalid(field: RepositoryFieldName, value: string): RepositoryIssue {
  return { field, problem: `"${value}" is not valid; expected the ${expectations[field]}` };
}

function normalizeLocalPath(value: string) {
  const trimmed = value.trim();
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? `${homedir()}${trimmed.slice(1)}` : trimmed;
  return isAbsolute(expanded) ? normalize(resolve(expanded)) : expanded;
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function validateRepositoryFields(input: RepositoryFields): RepositoryValidation {
  const fields: RepositoryFields = {
    ...(input.localPath?.trim() ? { localPath: normalizeLocalPath(input.localPath) } : {}),
    ...(input.repository?.trim() ? { repository: input.repository.trim() } : {}),
    ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
    ...(input.host?.trim() ? { host: normalizeHost(input.host) } : {}),
    ...(input.protocol ? { protocol: input.protocol.toLowerCase() as GitProtocol } : {}),
    ...(input.sshHost?.trim() ? { sshHost: input.sshHost.trim() } : {}),
    push: input.push !== false,
    remote: input.remote?.trim() || "origin",
    replaceRemote: input.replaceRemote === true
  };
  const issues: RepositoryIssue[] = [];

  if (!fields.localPath) issues.push(missing("localPath"));
  else if (!isAbsolute(fields.localPath) || fields.localPath.includes("\0")) issues.push(invalid("localPath", fields.localPath));

  if (!fields.repository) issues.push(missing("repository"));
  else if (!repositoryNamePattern.test(fields.repository) || fields.repository === "." || fields.repository === ".." || fields.repository.endsWith(".git")) {
    issues.push(invalid("repository", fields.repository));
  }

  if (!fields.owner) issues.push(missing("owner"));
  else if (!repositoryOwnerPattern.test(fields.owner)) issues.push(invalid("owner", fields.owner));

  if (!fields.host) issues.push(missing("host"));
  else if (!repositoryHostPattern.test(fields.host)) issues.push(invalid("host", fields.host));

  if (!fields.protocol) issues.push(missing("protocol"));
  else if (!["ssh", "https"].includes(fields.protocol)) issues.push(invalid("protocol", fields.protocol));

  if (!remoteNamePattern.test(fields.remote ?? "")) issues.push(invalid("remote", fields.remote ?? ""));
  if (fields.sshHost && !sshHostPattern.test(fields.sshHost)) issues.push(invalid("sshHost", fields.sshHost));

  return { fields, issues };
}

export function buildRepositoryPlan(input: RepositoryFields): RepositoryPlan {
  const { fields, issues } = validateRepositoryFields(input);
  if (issues.length) throw new Error(issues.map((issue) => `${issue.field}: ${issue.problem}`).join(" "));
  const { host, owner, repository, localPath, protocol } = fields as Required<Pick<RepositoryFields, "host" | "owner" | "repository" | "localPath" | "protocol">>;
  // An alias only reaches the remote URL for SSH; HTTPS always addresses the DNS host.
  const sshHost = protocol === "ssh" ? (fields.sshHost || host) : "";
  const remoteUrl = protocol === "ssh" ? `git@${sshHost}:${owner}/${repository}.git` : `https://${host}/${owner}/${repository}.git`;
  return {
    action: fields.push === false ? "create_repository" : "create_repository_and_push",
    host,
    owner,
    repository,
    localPath,
    protocol,
    sshHost,
    remoteUrl,
    requiresConfirmation: true
  };
}

export function assertRepositoryPlan(value: RepositoryPlan) {
  const expectedKeys = ["action", "host", "localPath", "owner", "protocol", "remoteUrl", "repository", "requiresConfirmation", "sshHost"].sort();
  if (!value || Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) throw new Error("El esquema del plan de repositorio no es válido.");
  const rebuilt = buildRepositoryPlan({
    host: value.host,
    owner: value.owner,
    repository: value.repository,
    localPath: value.localPath,
    protocol: value.protocol,
    sshHost: value.sshHost,
    push: value.action === "create_repository_and_push"
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(value) || value.requiresConfirmation !== true) throw new Error("El contenido del plan de repositorio no es válido.");
}
