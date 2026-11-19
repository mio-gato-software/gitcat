import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stub = new URL("./helpers/electron-stub.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "electron" ? { url: stub, shortCircuit: true } : next(specifier, context);
  }
});
const { executePlan, getSnapshot, prepareOperation, StalePlanError } = await import("../dist-electron/electron/git-service.js");
const { parsePushOperation, pushArguments, pushRepository } = await import("../dist-electron/electron/push-destination.js");
const { planSummary } = await import("../dist-electron/shared/plan-summary.js");

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gitcat-push-destination-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "work");
  const first = join(root, "first.git");
  const second = join(root, "second.git");
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(repo);
  const git = (...args) => run(repo, ...args);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "GitCat QA");
  git("config", "user.email", "qa@example.test");
  git("commit", "--allow-empty", "-qm", "reviewed commit");
  run(root, "init", "--bare", "-q", "-b", "main", first);
  run(root, "init", "--bare", "-q", "-b", "main", second);
  const published = (path) => run(path, "for-each-ref", "--format=%(objectname)", "refs/heads");
  return { repo, first, second, git, published };
}

test("a changed push URL invalidates the reviewed destination without publishing to either repository", async t => {
  const { repo, first, second, git, published } = fixture(t);
  git("remote", "add", "origin", first);
  const plan = await prepareOperation(repo, "push", { setUpstream: "origin" }, "en");
  assert.equal(plan.requiresConfirmation, true);
  assert.deepEqual(plan.steps[0].pushDestination.urls, [first]);

  git("remote", "set-url", "--push", "origin", second);
  const after = await getSnapshot(repo);
  assert.equal(after.stateId, plan.stateId);
  assert.equal(after.remoteUrls.origin, first);
  await assert.rejects(executePlan(repo, plan, "en"), { name: StalePlanError.name, message: /publishing destination changed/ });
  assert.equal(published(first), "");
  assert.equal(published(second), "");

  const reviewedAgain = await prepareOperation(repo, "push", { setUpstream: "origin" }, "en");
  assert.deepEqual(reviewedAgain.steps[0].pushDestination.urls, [second]);
  assert.ok(planSummary(reviewedAgain, after, "en").remote.effects.some(effect => effect.includes(second)));
  assert.equal((await executePlan(repo, reviewedAgain, "en")).error, undefined);
  assert.equal(published(first), "");
  assert.equal(published(second), git("rev-parse", "HEAD"));
  assert.equal(git("config", "--get", "branch.main.remote"), "origin");
});

test("the default push honors the branch's publishing remote and binds every push URL", async t => {
  const { repo, first, second, git, published } = fixture(t);
  git("remote", "add", "origin", first);
  git("remote", "add", "work", second);
  git("config", "push.default", "current");
  git("config", "remote.pushDefault", "origin");
  git("config", "branch.main.pushRemote", "work");
  git("remote", "set-url", "--add", "--push", "work", second);
  git("remote", "set-url", "--add", "--push", "work", first);
  const plan = await prepareOperation(repo, "push", {}, "en");
  assert.equal(plan.steps[0].pushDestination.remote, "work");
  assert.deepEqual(plan.steps[0].pushDestination.urls, [second, first]);

  git("config", "--fixed-value", "--unset-all", "remote.work.pushurl", first);
  await assert.rejects(executePlan(repo, plan, "en"), /publishing destination changed/);
  assert.equal(published(first), "");
  assert.equal(published(second), "");

  const reviewedAgain = await prepareOperation(repo, "push", {}, "en");
  assert.equal((await executePlan(repo, reviewedAgain, "en")).error, undefined);
  assert.equal(published(first), "");
  assert.equal(published(second), git("rev-parse", "HEAD"));
});

test("the ordinary publish action refuses to mirror or force configured refs", async t => {
  const { repo, first, git, published } = fixture(t);
  git("remote", "add", "origin", first);
  git("push", "origin", "main:refs/heads/remote-only");
  const before = published(first);
  git("config", "remote.origin.mirror", "true");
  await assert.rejects(prepareOperation(repo, "push", {}, "en"), /mirrors references/);
  assert.equal(published(first), before);

  git("config", "--unset", "remote.origin.mirror");
  git("config", "remote.origin.push", "+refs/heads/*:refs/heads/*");
  await assert.rejects(prepareOperation(repo, "push", {}, "en"), /custom push refspec/);
  assert.equal(published(first), before);
  const explicit = await prepareOperation(repo, "push", { remote: "origin" }, "en");
  assert.equal(explicit.steps[0].pushDestination.targetRef, "refs/heads/main");
  assert.equal((await executePlan(repo, explicit, "en")).error, undefined);
  assert.equal(published(first).split("\n").length, 2);
});

test("typed push operations share arguments between confirmation and execution and detect global-option pushes", async t => {
  assert.equal(pushRepository({ operation: "git_command", args: {}, argv: ["--no-optional-locks", "push", "origin", "main"], command: "", summary: "", risk: "high" }), "origin");
  assert.equal(pushRepository({ operation: "git_command", args: {}, argv: ["-c", "remote.origin.url=/evil", "push"], command: "", summary: "", risk: "high" }), null);
  assert.equal(pushRepository({ operation: "git_command", args: {}, argv: ["log", "-1", "push"], command: "", summary: "", risk: "low" }), undefined);

  assert.throws(() => parsePushOperation({ setUpstream: "origin", remote: "work", branch: "main" }, "en"), /push arguments are invalid/);
  assert.throws(() => parsePushOperation({ remote: "origin" }, "en"), /active branch/);
  assert.throws(() => parsePushOperation({ noVerify: "yes" }, "en"), /push arguments are invalid/);

  const typed = parsePushOperation({ remote: "origin", branch: "main", noVerify: "true" }, "en");
  assert.deepEqual(pushArguments(typed), ["push", "--no-verify", "origin", "refs/heads/main:refs/heads/main"]);

  const { repo, first, second, git, published } = fixture(t);
  git("remote", "add", "origin", first);
  const plan = await prepareOperation(repo, "push", { remote: "origin" }, "en");
  assert.equal(plan.steps[0].command, "git push origin refs/heads/main:refs/heads/main");
  assert.deepEqual(plan.steps[0].pushDestination.urls, [first]);

  git("remote", "set-url", "--push", "origin", second);
  await assert.rejects(executePlan(repo, plan, "en"), { name: StalePlanError.name, message: /publishing destination changed/ });
  assert.equal(published(first), "");
  assert.equal(published(second), "");
});
