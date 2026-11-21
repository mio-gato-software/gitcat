import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseRemoteUrls } = await import(pathToFileURL(join(root, "dist-electron/electron/remotes.js")));
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: new URL("./helpers/electron-stub.mjs", import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { executePlan, getSnapshot, prepareOperation } = await import("../dist-electron/electron/git-service.js");

function remoteFixture(t) {
  const path = mkdtempSync(join(tmpdir(), "gitcat-remote-edit-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "QA"); git("config", "user.email", "qa@example.test");
  writeFileSync(join(path, "work.txt"), "initial\n");
  git("add", "work.txt"); git("commit", "-qm", "Initial commit");
  const prepare = (name, url) => prepareOperation(path, "edit_remote_url", { name, url }, "en");
  return { path, git, prepare };
}

test("cada remoto queda con su URL, y fetch manda cuando difieren", () => {
  const raw = [
    "origin\tgit@github.com:eliaquin/gitcat.git (fetch)",
    "origin\tgit@github.com:eliaquin/gitcat.git (push)",
    "upstream\thttps://github.com/otro/gitcat.git (fetch)",
    "upstream\thttps://github.com/otro/otro-destino.git (push)"
  ].join("\n");
  assert.deepEqual(parseRemoteUrls(raw), {
    origin: "git@github.com:eliaquin/gitcat.git",
    upstream: "https://github.com/otro/gitcat.git"
  });
});

test("una salida vacía o rara no inventa remotos", () => {
  assert.deepEqual(parseRemoteUrls(""), {});
  assert.deepEqual(parseRemoteUrls("origin"), {});
  assert.deepEqual(parseRemoteUrls("\n\n"), {});
});

test("coincide con lo que git escribe de verdad", () => {
  const repo = mkdtempSync(join(tmpdir(), "gitcat-remotes-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main", ".");
  git("remote", "add", "origin", "git@github-trabajo:empresa/proyecto.git");
  git("remote", "add", "personal", "https://github.com/yo/proyecto.git");
  const parsed = parseRemoteUrls(git("remote", "-v"));
  assert.equal(parsed.origin, "git@github-trabajo:empresa/proyecto.git");
  assert.equal(parsed.personal, "https://github.com/yo/proyecto.git");
});

test("edit a remote's URL without changing its push destinations, refspec, tracking or local work", async (t) => {
  const { path, git, prepare } = remoteFixture(t);
  const previous = "https://user:password@example.test/team/old.git";
  const next = "git@work-alias:team/new.git";
  const push = "git@publish-alias:team/project.git";
  const mirror = "https://read-only.example.test/team/project.git";
  git("remote", "add", "origin", previous);
  git("remote", "set-url", "--push", "origin", push);
  git("remote", "add", "mirror", mirror);
  git("config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  git("config", "branch.main.remote", "origin");
  git("config", "branch.main.merge", "refs/heads/main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(path, "work.txt"), "staged edit\n"); git("add", "work.txt");
  writeFileSync(join(path, "work.txt"), "further unsaved edit\n");
  const head = git("rev-parse", "HEAD");
  const stage = git("write-tree");

  const plan = await prepare("origin", next);
  assert.ok(plan.requiresConfirmation);
  assert.equal(plan.steps[0].args.previousUrl, "https://example.test/team/old.git");
  assert.doesNotMatch(JSON.stringify(plan), /password/);
  assert.ok(plan.effects.some((effect) => effect.includes(push)));
  assert.equal(git("config", "--get", "remote.origin.url"), previous);
  assert.equal((await executePlan(path, plan, "en")).error, undefined);
  assert.equal(git("remote", "get-url", "origin"), next);
  assert.equal(git("remote", "get-url", "--push", "origin"), push);
  assert.equal(git("remote", "get-url", "mirror"), mirror);
  assert.equal(git("config", "--get", "remote.origin.fetch"), "+refs/heads/main:refs/remotes/origin/main");
  assert.equal(git("rev-parse", "@{upstream}"), head, "the cached tracking ref is kept");
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("write-tree"), stage);
  assert.equal(readFileSync(join(path, "work.txt"), "utf8"), "further unsaved edit\n");
});

test("a default push URL follows the edit and a stale remote review does not overwrite new settings", async (t) => {
  const { path, git, prepare } = remoteFixture(t);
  git("remote", "add", "origin", "company:repo.git");
  git("config", "url.https://old.example.test/team/.insteadOf", "company:");
  const next = join(path, "New remote.git");
  const plan = await prepare("origin", next);
  assert.equal(plan.steps[0].args.previousUrl, "https://old.example.test/team/repo.git");
  assert.match(plan.effects.join(" "), /Publishing will also use the new address/);

  const before = await getSnapshot(path);
  git("remote", "set-url", "origin", "https://others.example.test/team/repo.git");
  assert.equal((await getSnapshot(path)).stateId, before.stateId, "remote settings have an independent binding");
  await assert.rejects(() => executePlan(path, plan, "en"), /remote configuration changed/);
  assert.equal(git("config", "--get-all", "remote.origin.url"), "https://others.example.test/team/repo.git");

  const updated = await prepare("origin", next);
  git("remote", "set-url", "--push", "origin", "https://publish.example.test/team/repo.git");
  await assert.rejects(() => executePlan(path, updated, "en"), /remote configuration changed/);
  git("config", "--unset-all", "remote.origin.pushurl");
  assert.equal((await executePlan(path, await prepare("origin", next), "en")).error, undefined);
  assert.equal(git("remote", "get-url", "origin"), next);
  assert.equal(git("remote", "get-url", "--push", "origin"), next);
});

test("remote edits validate addresses and refuse ambiguous or rewritten destinations", async (t) => {
  const { git, prepare } = remoteFixture(t);
  const previous = "https://example.test/team/old.git";
  const next = "https://example.test/team/new.git";
  git("remote", "add", "origin", previous);
  await assert.rejects(() => prepare("unknown", next), /remote is no longer available/);
  await assert.rejects(() => prepare("origin", previous), /already configured/);
  await assert.rejects(() => prepare("origin", "ext::example arg"), /valid repository address/);
  await assert.rejects(() => prepare("origin", "https://my-token@example.test/team/new.git"), /without credentials/);
  git("config", "url.ssh://git@publish.example.test/.pushInsteadOf", "https://example.test/team/new");
  await assert.rejects(() => prepare("origin", next), /URL rewrite rules/);
  assert.equal(git("remote", "get-url", "origin"), previous);

  git("remote", "set-url", "--add", "origin", "https://other.example.test/team/repo.git");
  await assert.rejects(() => prepare("origin", next), /one address stored/);
  assert.deepEqual(git("config", "--get-all", "remote.origin.url").split("\n"), [previous, "https://other.example.test/team/repo.git"]);
});

test("linked worktrees cannot both apply reviews of the same shared remote configuration", async (t) => {
  const { path, git, prepare } = remoteFixture(t);
  const linked = mkdtempSync(join(tmpdir(), "gitcat-remote-linked-"));
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  git("remote", "add", "origin", "https://example.test/team/old.git");
  git("worktree", "add", "-qb", "linked", linked);
  const localPlan = await prepare("origin", "https://example.test/team/local.git");
  const linkedPlan = await prepareOperation(linked, "edit_remote_url", { name: "origin", url: "https://example.test/team/linked.git" }, "en");
  const results = await Promise.allSettled([executePlan(path, localPlan, "en"), executePlan(linked, linkedPlan, "en")]);

  const completed = results.findIndex((result) => result.status === "fulfilled" && !result.value.error);
  assert.notEqual(completed, -1);
  const refused = results[1 - completed];
  assert.equal(refused.status, "rejected");
  assert.match(refused.reason.message, /remote configuration changed/);
  assert.equal(git("config", "--get-all", "remote.origin.url"), [localPlan, linkedPlan][completed].args.url);
});
