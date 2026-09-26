import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { workOverview, remoteFreshnessMs } = await import(pathToFileURL(join(root, "dist-electron/shared/work-overview.js")));
registerHooks({ resolve(specifier, context, next) { return specifier === "electron" ? { url: new URL("./helpers/electron-stub.mjs", import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
const { getSnapshot } = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));

const now = Date.parse("2026-09-26T12:00:00Z");
const fresh = { fetchedAt: new Date(now - 60_000).toISOString(), now };
const branch = (name, extra = {}) => ({ name, presence: "both", mergedInto: [], ahead: 0, behind: 0, isCurrent: false, ...extra });
const snapshot = (extra = {}) => ({
  path: "/repo", name: "repo", head: "abc123", stateId: "s", currentBranch: "feature/menu", defaultBranch: "main",
  isRebasing: false, conflicts: [], isDirty: false, changes: [], commits: [], remotes: ["origin"], remoteUrls: {},
  branches: [
    branch("main", { upstream: "origin/main" }),
    branch("feature/menu", { isCurrent: true, upstream: "origin/feature/menu", mergedInto: ["main"] })
  ],
  ...extra
});
const current = (extra) => [branch("main", { upstream: "origin/main" }), branch("feature/menu", { isCurrent: true, upstream: "origin/feature/menu", ...extra })];

test("a clean, published and integrated branch has nothing left to do", () => {
  const overview = workOverview(snapshot(), fresh);
  assert.equal(overview.edited.count, 0);
  assert.equal(overview.published.state, "in_sync");
  assert.equal(overview.published.remote, "origin");
  assert.equal(overview.integration.state, "integrated");
  assert.equal(overview.freshness.state, "checked");
  assert.equal(overview.next.action, "all_set");
});

test("the remote is unknown until checked, and an old check is said to be old", () => {
  const unknown = workOverview(snapshot(), { now });
  assert.equal(unknown.freshness.state, "unknown");
  assert.equal(unknown.next.action, "check_remote");
  assert.equal(unknown.next.git, "git fetch");
  const stale = workOverview(snapshot(), { fetchedAt: new Date(now - remoteFreshnessMs - 1).toISOString(), now });
  assert.equal(stale.freshness.state, "stale");
  assert.equal(stale.next.action, "check_remote");
  assert.equal(workOverview(snapshot({ remotes: [] }), { now }).freshness.state, "no_remote");
});

test("edited files are counted, staged or not, and saving comes first", () => {
  const changes = [{ code: "M", path: "a.txt", xy: "M " }, { code: "M", path: "b.txt", xy: " M" }, { code: "??", path: "c.txt", xy: "??" }];
  const overview = workOverview(snapshot({ isDirty: true, changes, branches: current({ ahead: 2, behind: 1 }) }), fresh);
  assert.deepEqual(overview.edited, { count: 3, untracked: 1 });
  assert.equal(overview.next.action, "save_changes");
});

test("saved commits the remote lacks are unpublished, not backed up", () => {
  const overview = workOverview(snapshot({ branches: current({ ahead: 2 }) }), fresh);
  assert.equal(overview.published.state, "ahead");
  assert.equal(overview.published.ahead, 2);
  assert.equal(overview.next.action, "publish_saved");
  assert.equal(overview.next.git, "git push");
});

test("behind asks to bring the remote's work in; diverged asks how to combine", () => {
  const behind = workOverview(snapshot({ branches: current({ behind: 3, mergedInto: ["main"] }) }), fresh);
  assert.equal(behind.published.state, "behind");
  assert.equal(behind.next.action, "get_latest");
  const diverged = workOverview(snapshot({ branches: current({ ahead: 1, behind: 2 }) }), fresh);
  assert.equal(diverged.published.state, "diverged");
  assert.equal(diverged.next.action, "combine_diverged");
  assert.equal(diverged.next.upstream, "origin/feature/menu");
});

test("no remote at all asks for a place to publish once local work is integrated", () => {
  const local = [branch("main", { presence: "local" }), branch("feature/menu", { presence: "local", isCurrent: true, mergedInto: ["main"] })];
  const overview = workOverview(snapshot({ remotes: [], branches: local }), fresh);
  assert.equal(overview.published.state, "no_remote");
  assert.equal(overview.next.action, "connect_remote");
  // Integration needs no remote, so it is offered first on a repository kept only on this computer.
  const pendingMerge = workOverview(snapshot({ remotes: [], branches: [local[0], { ...local[1], mergedInto: [] }], integration: { target: "main", notIntegrated: 2 } }), fresh);
  assert.equal(pendingMerge.next.action, "integrate");
  assert.equal(pendingMerge.integration.notIntegrated, 2);
});

test("a branch with no upstream publishes to the only remote, or to origin among several", () => {
  const unpublished = [branch("main", { upstream: "origin/main" }), branch("feature/menu", { presence: "local", isCurrent: true })];
  const one = workOverview(snapshot({ branches: unpublished }), fresh);
  assert.equal(one.published.state, "no_upstream");
  assert.equal(one.next.action, "publish_branch");
  assert.equal(one.next.remote, "origin");
  assert.match(one.next.git, /git push --set-upstream origin feature\/menu/);
  assert.equal(workOverview(snapshot({ branches: unpublished, remotes: ["fork", "upstream"] }), fresh).next.remote, undefined, "Several remotes and no origin: the choice is left to the person");
});

test("a detached checkout is asked back onto a branch before anything else", () => {
  const overview = workOverview(snapshot({ currentBranch: "HEAD", isDirty: true, changes: [{ code: "M", path: "a" }], branches: [branch("main", { upstream: "origin/main" })] }), fresh);
  assert.equal(overview.detached, true);
  assert.equal(overview.branch, undefined);
  assert.equal(overview.published.state, "not_applicable");
  assert.equal(overview.integration.state, "not_applicable");
  assert.equal(overview.next.action, "return_to_branch");
});

test("a half-finished operation or open conflicts outrank every other step", () => {
  const merging = workOverview(snapshot({ pending: { kind: "merge" }, isDirty: true, changes: [{ code: "UU", path: "a" }], conflicts: [{ path: "a", kind: "both-modified" }] }), fresh);
  assert.equal(merging.pending, "merge");
  assert.equal(merging.conflicts, 1);
  assert.equal(merging.next.action, "finish_pending");
  assert.equal(merging.next.git, "git merge --continue");
  assert.equal(workOverview(snapshot({ pending: { kind: "rebase" }, isRebasing: true }), fresh).next.git, "git rebase --continue");
});

test("integrated is Git's ancestry answer, never the branch name", () => {
  const notIntegrated = workOverview(snapshot({ branches: current({ mergedInto: [] }), integration: { target: "main", notIntegrated: 4 } }), fresh);
  assert.equal(notIntegrated.integration.state, "not_integrated");
  assert.equal(notIntegrated.integration.notIntegrated, 4);
  assert.equal(notIntegrated.next.action, "integrate");
  assert.equal(notIntegrated.next.target, "main");
  // A name that looks merged proves nothing; without the count the state is still not integrated.
  const named = workOverview(snapshot({ currentBranch: "merged/main", branches: [branch("main"), branch("merged/main", { isCurrent: true, upstream: "origin/merged/main" })] }), fresh);
  assert.equal(named.integration.state, "not_integrated");
  assert.equal(named.integration.notIntegrated, undefined);
  const onTarget = workOverview(snapshot({ currentBranch: "main", branches: [branch("main", { isCurrent: true, upstream: "origin/main" })] }), fresh);
  assert.equal(onTarget.integration.state, "on_target");
  assert.equal(workOverview(snapshot({ defaultBranch: undefined }), fresh).integration.state, "no_target");
});

test("a merge done on this computer is not published until the target is pushed", () => {
  const branches = [branch("main", { upstream: "origin/main", ahead: 3 }), branch("feature/menu", { isCurrent: true, upstream: "origin/feature/menu", mergedInto: ["main"] })];
  const overview = workOverview(snapshot({ branches }), fresh);
  assert.equal(overview.integration.state, "integrated");
  assert.equal(overview.integration.targetUnpublished, 3);
  assert.equal(overview.next.action, "publish_target");
  assert.equal(overview.next.target, "main");
});

test("an empty repository asks for its first save, and for files before that", () => {
  const unborn = { head: "", currentBranch: "main", branches: [] };
  assert.equal(workOverview(snapshot({ ...unborn }), fresh).next.action, "add_first_files");
  const withFiles = workOverview(snapshot({ ...unborn, isDirty: true, changes: [{ code: "??", path: "readme.md" }] }), fresh);
  assert.equal(withFiles.saved.hasCommits, false);
  assert.equal(withFiles.next.action, "first_save");
  assert.equal(withFiles.published.state, "not_applicable");
});

test("the snapshot counts, with Git, the saved commits the default branch does not have yet", async (t) => {
  const path = mkdtempSync(join(tmpdir(), "gitcat-overview-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  writeFileSync(join(path, "a.txt"), "a\n"); git("add", "."); git("commit", "-qm", "base");
  git("switch", "-qc", "feature/work");
  for (const name of ["b", "c"]) { writeFileSync(join(path, `${name}.txt`), `${name}\n`); git("add", "."); git("commit", "-qm", name); }
  const snapshot = await getSnapshot(path);
  assert.deepEqual(snapshot.integration, { target: "main", notIntegrated: 2 });
  const overview = workOverview(snapshot, { now });
  assert.equal(overview.integration.state, "not_integrated");
  assert.equal(overview.published.state, "no_remote");
  assert.equal(overview.next.action, "integrate");
  git("switch", "-q", "main"); git("merge", "-q", "--ff-only", "feature/work");
  const onMain = await getSnapshot(path);
  assert.equal(onMain.integration, undefined, "Nothing to compare while on the default branch");
  assert.equal(workOverview(onMain, { now }).next.action, "connect_remote");
});
