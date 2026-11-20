import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron"
      ? { url: new URL("./helpers/electron-stub.mjs", import.meta.url).href, shortCircuit: true }
      : nextResolve(specifier, context);
  }
});
const service = await import("../dist-electron/electron/git-service.js");
const { planSummary } = await import("../dist-electron/shared/plan-summary.js");

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "gitcat-switch-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "QA");
  git("config", "user.email", "qa@example.test");
  writeFileSync(join(path, "file"), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  git("branch", "other");
  return { path, git };
}

test("compatible edits carry only after review and remain unsaved", async (t) => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, "file"), "mine");
  const preview = await service.getSwitchWork(path, "other");
  assert.deepEqual(preview.blockers, []);
  const plan = await service.prepareSwitchWork(path, { mode: "carry", target: "other" }, "en");
  assert.match(planSummary(plan, preview.snapshot, "en").local.join(" "), /come with you.*keeping what you staged/);
  assert.equal(git("branch", "--show-current"), "main");
  assert.equal(plan.requiresConfirmation, true);

  const result = await service.executePlan(path, plan, "en");

  assert.equal(result.error, undefined);
  assert.equal(git("branch", "--show-current"), "other");
  assert.equal(readFileSync(join(path, "file"), "utf8"), "mine");
  assert.ok(git("status", "--porcelain"));
});

test("set aside keeps staged and unstaged versions and new files across reopening; restore retains entry", async (t) => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, "file"), "staged");
  git("add", "file");
  writeFileSync(join(path, "file"), "unstaged");
  writeFileSync(join(path, "new"), "new");
  const index = git("write-tree");

  const plan = await service.prepareSwitchWork(
    path,
    { mode: "set_aside", target: "other", label: "Pause feature", includeUntracked: true },
    "en"
  );
  const summary = planSummary(plan, await service.getSnapshot(path), "es");
  assert.match(summary.local.join(" "), /cambios en archivos seguidos y los archivos nuevos/);
  assert.doesNotMatch([...summary.local, ...summary.finalState].join(" "), /acompañan|asistente/);
  assert.match(summary.partial.join(" "), /la entrada de stash sigue disponible/);
  assert.doesNotMatch(plan.steps[0].summary, /git stash/);
  await service.executePlan(path, plan, "en");
  assert.equal(git("status", "--porcelain"), "");
  const preview = await service.getSwitchWork(path, "main");
  assert.equal(preview.entries.length, 1);
  const restore = await service.prepareSwitchWork(path, { mode: "restore", stash: preview.entries[0].hash }, "en");
  const restoreSummary = planSummary(restore, preview.snapshot, "en");
  assert.match(restoreSummary.local.join(" "), /staged versions/);
  assert.match(restoreSummary.finalState.join(" "), /stash entry stays available/);
  assert.match(restoreSummary.partial.join(" "), /conflict/);
  assert.doesNotMatch(restoreSummary.local.join(" "), /assistant/);
  assert.doesNotMatch(restore.steps[0].summary, /git stash/);
  const result = await service.executePlan(path, restore, "en");

  assert.equal(result.error, undefined);
  assert.equal(git("write-tree"), index);
  assert.equal(readFileSync(join(path, "file"), "utf8"), "unstaged");
  assert.equal(readFileSync(join(path, "new"), "utf8"), "new");
  assert.equal((await service.getSwitchWork(path, "main")).entries.length, 1);
});

test("setting aside tracked edits alone leaves only new files in the working folder", async (t) => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, "file"), "mine");
  writeFileSync(join(path, "new"), "new");
  const request = { mode: "set_aside", target: "other", label: "Pause feature", includeUntracked: false };
  const prepared = await service.prepareSwitchWork(path, request, "en");
  const summary = planSummary(prepared, await service.getSnapshot(path), "en");
  assert.match(summary.local.join(" "), /sets aside tracked edits/i);
  assert.match(summary.finalState.join(" "), /New files stay uncommitted in this folder/);
  assert.doesNotMatch(summary.finalState.join(" "), /2 files with uncommitted changes come along/);
  assert.equal((await service.executePlan(path, prepared, "en")).error, undefined);
  assert.equal(git("status", "--porcelain"), "?? new");
});

test("overlapping tracked edits and new-file collisions guide toward setting work aside", async (t) => {
  const { path, git } = fixture(t);
  git("switch", "other");
  writeFileSync(join(path, "file"), "theirs");
  writeFileSync(join(path, "new"), "theirs");
  git("add", ".");
  git("commit", "-qm", "other");
  git("switch", "main");
  writeFileSync(join(path, "file"), "mine");
  writeFileSync(join(path, "new"), "mine");
  await assert.rejects(service.prepareSwitchWork(path, { mode: "carry", target: "other" }, "en"), /overlap/);
  await assert.rejects(
    service.prepareSwitchWork(
      path,
      { mode: "set_aside", target: "other", label: "pause", includeUntracked: false },
      "en"
    ),
    /New files would block/
  );
  const plan = await service.prepareSwitchWork(
    path,
    { mode: "set_aside", target: "other", label: "pause", includeUntracked: true },
    "en"
  );
  assert.equal((await service.executePlan(path, plan, "en")).error, undefined);
  assert.equal(readFileSync(join(path, "new"), "utf8"), "theirs");
  const entry = (await service.getSwitchWork(path, "main")).entries[0];
  const restore = await service.prepareSwitchWork(path, { mode: "restore", stash: entry.hash }, "en");
  const result = await service.executePlan(path, restore, "en");
  assert.ok(result.error);
  assert.equal((await service.getSwitchWork(path, "main")).entries[0].hash, entry.hash);
});
test("occupied worktree and stale review do not stash or switch", async (t) => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, "file"), "mine");
  const plan = await service.prepareSwitchWork(path, { mode: "set_aside", target: "other", label: "pause" }, "en");
  const other = path + "-other";
  t.after(() => rmSync(other, { recursive: true, force: true }));
  git("worktree", "add", other, "other");
  await assert.rejects(service.executePlan(path, plan, "en"), /open in/);
  assert.equal(git("stash", "list"), "");
  assert.equal(git("branch", "--show-current"), "main");
});
test("edits after review invalidate the whole set-aside plan", async (t) => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, "file"), "mine");
  const plan = await service.prepareSwitchWork(path, { mode: "set_aside", target: "other", label: "pause" }, "en");
  writeFileSync(join(path, "file"), "newer");
  await assert.rejects(service.executePlan(path, plan, "en"), /changes moved/);
  assert.equal(git("stash", "list"), "");
});

test("retry revalidates set-aside work after the stash lock is removed", async (t) => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, "file"), "mine");
  const request = { mode: "set_aside", target: "other", label: "Pause feature" };
  const plan = await service.prepareSwitchWork(path, request, "en");
  const lock = join(path, ".git", "refs", "stash.lock");
  writeFileSync(lock, "");
  const failed = await service.executePlan(path, plan, "en");
  assert.deepEqual(
    failed.outcomes.map((outcome) => outcome.status),
    ["failed", "skipped"]
  );
  rmSync(lock);
  const record = { plan, outcomes: failed.outcomes, stale: false };

  git("branch", "-d", "other");
  await assert.rejects(service.prepareRetry(path, record, "en"), /branch no longer exists/);
  git("branch", "other");
  writeFileSync(join(path, "file"), "newer work");
  const retry = await service.prepareRetry(path, record, "en");
  assert.equal(retry.requiresConfirmation, true);
  assert.deepEqual(retry.switchWork, request);
  assert.equal(git("stash", "list"), "");
  assert.equal(readFileSync(join(path, "file"), "utf8"), "newer work");
  const result = await service.executePlan(path, retry, "en");
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.status),
    ["completed", "completed"]
  );
  assert.equal(git("branch", "--show-current"), "other");
  assert.equal(git("show", "stash@{0}:file"), "newer work");
});

test("stopping after set-aside leaves a discoverable entry and the original branch active", async (t) => {
  const { trackOperation, cancelOperation } = await import("../dist-electron/electron/operation-progress.js");
  const { path, git } = fixture(t);
  writeFileSync(join(path, "file"), "mine");
  const plan = await service.prepareSwitchWork(
    path,
    { mode: "set_aside", target: "other", label: "Interrupted" },
    "en"
  );
  const result = await trackOperation(
    path,
    "executing",
    (p) => {
      if (p.step === 1 && !p.stopping) cancelOperation(path, p.id);
    },
    () => service.executePlan(path, plan, "en"),
    true
  );
  assert.deepEqual(
    result.outcomes.map((o) => o.status),
    ["completed", "skipped"]
  );
  assert.equal(git("branch", "--show-current"), "main");
  const entry = (await service.getSwitchWork(path, "other")).entries[0];
  assert.match(entry.label, /Interrupted/);
  const retry = await service.prepareRetry(path, { plan, outcomes: result.outcomes, stale: false }, "en");
  assert.deepEqual(retry.switchWork, { mode: "carry", target: "other" });
  assert.equal(retry.requiresConfirmation, true);
  assert.deepEqual(
    retry.steps.map((step) => step.operation),
    ["checkout"]
  );
  assert.equal((await service.executePlan(path, retry, "en")).error, undefined);
  assert.equal(git("branch", "--show-current"), "other");
  assert.equal(git("stash", "list", "--format=%H"), entry.hash);
  await service.executePlan(
    path,
    await service.prepareSwitchWork(path, { mode: "restore", stash: entry.hash }, "en"),
    "en"
  );
  assert.equal(readFileSync(join(path, "file"), "utf8"), "mine");
});
