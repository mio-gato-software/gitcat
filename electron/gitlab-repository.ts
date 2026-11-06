export type GitlabApi = (args: string[]) => Promise<string>;

/** Read-only facts used both when preparing a private repository and immediately before creating it. */
export async function gitlabCreationFacts(api: GitlabApi, owner: string) {
  const user = JSON.parse(await api(["api", "user"]));
  if (!Number.isSafeInteger(user.id) || typeof user.username !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user.username)) throw new Error("GitLab could not verify the signed-in account. Sign in with glab auth login and check again.");
  const namespace = JSON.parse(await api(["api", `namespaces/${encodeURIComponent(owner)}`]));
  if (namespace.full_path !== owner || !Number.isSafeInteger(namespace.id) || namespace.id < 1) throw new Error("GitLab returned a different namespace. Check the full user or group path.");
  if (namespace.kind === "user") {
    if (owner.toLowerCase() !== user.username.toLowerCase() || user.projects_limit === 0) throw new Error("Choose your own GitLab namespace or a group where you can create projects.");
  } else if (namespace.kind === "group") {
    const group = JSON.parse(await api(["api", `groups/${encodeURIComponent(owner)}`]));
    if (group.full_path !== owner || !Number.isSafeInteger(group.id)) throw new Error("The GitLab group could not be verified. Check its full path.");
    const member = JSON.parse(await api(["api", `groups/${group.id}/members/all/${user.id}`]));
    const required = group.project_creation_level === "developer" ? 30 : group.project_creation_level === "maintainer" ? 40 : 50;
    if (member.id !== user.id || typeof member.access_level !== "number" || member.access_level < required || group.project_creation_level === "noone") throw new Error("This account cannot create projects in that GitLab group. Choose a writable namespace or ask its owner for access.");
  } else throw new Error("Choose a GitLab user or group namespace.");
  return { account: user.username as string, namespaceId: String(namespace.id) };
}

export async function assertGitlabProjectAvailable(api: GitlabApi, repository: string) {
  try { await api(["api", `projects/${encodeURIComponent(repository)}`]); }
  catch (error) {
    if (/\b404\b/.test(error instanceof Error ? error.message : String(error))) return;
    throw new Error("Could not check whether that GitLab project exists. Check the connection and account, then prepare the action again.", { cause: error });
  }
  throw new Error("That GitLab project already exists. Connect its existing repository address or choose a different name.");
}

export function createGitlabProjectArgs(name: string, namespaceId: string) {
  return ["api", "projects", "--method", "POST", "--raw-field", `name=${name}`, "--raw-field", `path=${name}`,
    "--field", `namespace_id=${namespaceId}`, "--raw-field", "visibility=private", "--field", "initialize_with_readme=false"];
}
