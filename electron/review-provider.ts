import type { HostingProvider, ReviewPullRequest, ShareReviewPreview } from "../shared/types.js";

export type ReviewCommand = (provider: HostingProvider, host: string, args: string[]) => Promise<string>;
export type ReviewRepository = { provider: HostingProvider; host: string; repository: string; projectId?: number };

export async function checkReviewPermission(command: ReviewCommand, repo: ReviewRepository): Promise<ReviewRepository> {
  if (repo.provider === "github") {
    if ((await command("github", repo.host, ["api", `repos/${repo.repository}`, "--jq", ".permissions.push"])).trim() === "true") return repo;
  } else {
    const project = JSON.parse(await command("gitlab", repo.host, ["api", `projects/${encodeURIComponent(repo.repository)}`]));
    if (project.path_with_namespace === repo.repository && Number.isSafeInteger(project.id) && project.id > 0 && project.archived !== true
      && Math.max(project.permissions?.project_access?.access_level ?? 0, project.permissions?.group_access?.access_level ?? 0) >= 30) {
      return { ...repo, projectId: project.id };
    }
  }
  throw new Error("This account cannot publish to this repository. Choose a writable remote or a branch in your fork; no permission checks are bypassed.");
}

/** Review links are accepted only for the exact host, repository and branch pair just checked. */
export function checkedReview(value: unknown, repo: ReviewRepository, head: string, base: string): ReviewPullRequest | undefined {
  if (!value || typeof value !== "object") return;
  const p = value as Record<string, unknown>;
  const gitlab = repo.provider === "gitlab";
  if ((gitlab ? p.source_branch : p.headRefName) !== head || (gitlab ? p.target_branch : p.baseRefName) !== base) return;
  if (gitlab && (p.source_project_id !== repo.projectId || p.target_project_id !== repo.projectId)) return;
  const states: Record<string, ReviewPullRequest["state"]> = gitlab ? { opened: "OPEN", closed: "CLOSED", merged: "MERGED" } : { OPEN: "OPEN", CLOSED: "CLOSED", MERGED: "MERGED" };
  const state = Object.hasOwn(states, String(p.state)) ? states[String(p.state)] : undefined;
  const url = gitlab ? p.web_url : p.url;
  const expected = `https://${repo.host}/${repo.repository}/${gitlab ? "-/merge_requests" : "pull"}/`;
  if (!state || typeof url !== "string" || !url.startsWith(expected) || !/^[1-9]\d*$/.test(url.slice(expected.length))) return;
  return { url, state, head, base };
}

export async function findReview(command: ReviewCommand, repo: ReviewRepository, head: string, base: string) {
  const matches: ReviewPullRequest[] = [];
  // Bounded pagination prevents a truncated response from being mistaken for "no existing review".
  for (let page = 1; page <= 20; page++) {
    const args = repo.provider === "github"
      ? ["pr", "list", "--repo", `${repo.host}/${repo.repository}`, "--head", head, "--base", base, "--state", "all", "--json", "url,state,headRefName,baseRefName", "--limit", "100"]
      : ["api", `projects/${repo.projectId}/merge_requests?${new URLSearchParams({ source_branch: head, target_branch: base, state: "all", order_by: "updated_at", sort: "desc", per_page: "100", page: String(page) })}`];
    const values: unknown = JSON.parse(await command(repo.provider, repo.host, args));
    if (!Array.isArray(values)) throw new Error("Review status is unavailable. Check again before publishing.");
    for (const value of values) {
      const checked = checkedReview(value, repo, head, base);
      if (checked) matches.push(checked);
      else if (repo.provider === "github" || (value?.source_branch === head && value?.target_branch === base && value?.source_project_id === repo.projectId)) {
        throw new Error("The service returned an unexpected review identity or URL. Check the repository address and live review status before publishing.");
      }
    }
    const open = matches.find(v => v.state === "OPEN");
    if (open) return open;
    if (values.length < 100) return matches[0];
    if (repo.provider === "github") break;
  }
  throw new Error("There are too many matching reviews to verify safely. Check the review on the hosting service before publishing.");
}

export function createReviewArgs(preview: ShareReviewPreview): string[] {
  const { request, repository, provider, host } = preview;
  return provider === "github"
    ? ["pr", "create", "--repo", `${host}/${repository}`, "--head", request.head, "--base", request.base, "--title", request.title, "--body", request.body]
    : ["api", `projects/${encodeURIComponent(repository)}/merge_requests`, "--method", "POST",
      "--raw-field", `source_branch=${request.head}`, "--raw-field", `target_branch=${request.base}`,
      "--raw-field", `title=${request.title}`, "--raw-field", `description=${request.body}`];
}
