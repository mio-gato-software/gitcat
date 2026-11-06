import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { GitProtocol, HostingProvider, RepositoryPlan } from "../shared/types.js";
import { hostingProvider, validHostingRepository, isNativeProvider, validHostingHost } from "../shared/hosting.js";
import { nativeCreationLocation } from '../shared/native-hosting.js';

export type RepositoryFields = {
  provider?: HostingProvider;
  connectionId?: string;
  serviceUrl?: string;
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

export type RepositoryFieldName = "provider" | "connectionId" | "serviceUrl" | "localPath" | "repository" | "owner" | "host" | "protocol" | "remote" | "sshHost";

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
  provider: '"github", "gitlab", "bitbucket", "bitbucket_dc" or "azure"; company domains need an explicit service',
  connectionId: 'an ID from the saved hosting account list; never invent one',
  serviceUrl: 'the HTTPS address of the selected saved hosting service',
  localPath: "absolute path of the local Git repository to publish",
  repository: "remote repository name, 1 to 100 characters from A-Z a-z 0-9 . _ -, never \".\", \"..\" or ending in .git",
  owner: "GitHub user/organization, or full GitLab user/group/subgroup path",
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
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.serviceUrl ? { serviceUrl: input.serviceUrl } : {}),
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
  if(fields.provider==='bitbucket'||fields.provider==='bitbucket_dc'||fields.host==='bitbucket.org'){if(fields.repository)fields.repository=fields.repository.toLowerCase();}
  const issues: RepositoryIssue[] = [];
  if(fields.connectionId&&!/^[A-Za-z0-9-]{1,80}$/.test(fields.connectionId))issues.push(invalid('connectionId',fields.connectionId));

  if (!fields.localPath) issues.push(missing("localPath"));
  else if (!isAbsolute(fields.localPath) || fields.localPath.includes("\0")) issues.push(invalid("localPath", fields.localPath));

  if (!fields.repository) issues.push(missing("repository"));
  else if (!(fields.provider==='azure'||fields.host==='dev.azure.com'?/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,99}$/:repositoryNamePattern).test(fields.repository) || fields.repository === "." || fields.repository === ".." || fields.repository.endsWith(".git")) {
    issues.push(invalid("repository", fields.repository));
  }

  let provider: HostingProvider | undefined;
  try { provider = hostingProvider(fields.host, fields.provider); } catch { issues.push(invalid("provider", fields.provider ?? "")); }
  if (fields.host && repositoryHostPattern.test(fields.host) && !provider && !issues.some(issue => issue.field === "provider")) issues.push(missing("provider"));
  if (!fields.owner) issues.push(missing("owner"));
  else if (provider === "gitlab" || (provider&&isNativeProvider(provider)) ? !validHostingRepository(`${fields.owner}/repository`, provider) : !repositoryOwnerPattern.test(fields.owner)) issues.push(invalid("owner", fields.owner));

  if (!fields.host) issues.push(missing("host"));
  else if (provider&&isNativeProvider(provider) ? !validHostingHost(fields.host) : !repositoryHostPattern.test(fields.host)) issues.push(invalid("host", fields.host));

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
  const provider=hostingProvider(host,fields.provider)!;
  const native=isNativeProvider(provider);
  const baseUrl=native?(fields.serviceUrl??`https://${host}${provider==='azure'?'/'+owner.split('/').slice(0,-1).map(encodeURIComponent).join('/'):''}`):undefined;
  const location=native?nativeCreationLocation(provider,baseUrl!,owner,repository):undefined;
  if(location&&new URL(location.baseUrl).host!==host)throw new Error('The service address must belong to the selected host.');
  const sshHost = protocol === "ssh" ? (fields.sshHost || (provider==='azure'&&host==='dev.azure.com'?'ssh.dev.azure.com':native?new URL(baseUrl!).hostname:host)) : "";
  const remoteUrl = protocol === "ssh" ? (provider==='azure'?`git@${sshHost}:v3/${owner.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(repository)}`:`git@${sshHost}:${owner}/${repository}.git`) : location?.gitUrl??`https://${host}/${owner}/${repository}.git`;
  return {
    ...(fields.provider || provider!=='github' ? { provider } : {}),
    ...(fields.connectionId?{connectionId:fields.connectionId}:{}),
    ...(location?{serviceUrl:location.baseUrl}:{}),
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
  const expectedKeys = ["action", "host", "localPath", "owner", "protocol", "remoteUrl", "repository", "requiresConfirmation", "sshHost", ...(['provider','connectionId','serviceUrl'] as const).filter(key=>value?.[key]!==undefined)].sort();
  if (!value || Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) throw new Error("El esquema del plan de repositorio no es válido.");
  const rebuilt = buildRepositoryPlan({
    provider: value.provider,
    connectionId: value.connectionId,
    serviceUrl: value.serviceUrl,
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
