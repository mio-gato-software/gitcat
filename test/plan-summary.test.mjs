import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { planSummary, completionSummary } = await import(pathToFileURL(join(root, "dist-electron/shared/plan-summary.js")));

const commit = (hash, subject) => ({ hash, shortHash: hash.slice(0, 7), subject, author: "A", email: "a@b.c", date: "2026-09-26" });
const branch = (name, extra = {}) => ({ name, presence: "both", mergedInto: [], ahead: 0, behind: 0, isCurrent: false, ...extra });
const snapshot = (extra = {}) => ({
  path: "/work/menu-app", name: "menu-app", head: "aaa1111", stateId: "s1", currentBranch: "feature/menu", defaultBranch: "main",
  isRebasing: false, conflicts: [], isDirty: false, changes: [], commits: [], remotes: ["origin"], remoteUrls: {},
  branches: [
    branch("main", { upstream: "origin/main", lastCommit: commit("main0000", "Base") }),
    branch("feature/menu", { isCurrent: true, upstream: "origin/feature/menu", lastCommit: commit("aaa1111", "Menu") })
  ],
  ...extra
});
const step = (operation, args, summary, extra = {}) => ({ operation, args, command: `git ${operation}`, summary, risk: "high", ...extra });
const plan = (steps, extra = {}) => ({
  id: "p", repoPath: "/work/menu-app", head: "aaa1111", stateId: "s1", allowed: true, steps, operation: steps[0].operation, args: steps[0].args,
  command: steps.map((item) => item.command).join(" && "), summary: steps.map((item) => item.summary).join(", "), rationale: "", risk: "high",
  requiresConfirmation: true, kind: "plan", source: "guardrail", ...extra
});
const done = (steps, statuses) => steps.map((item, index) => ({ command: item.command, summary: item.summary, status: statuses[index], output: "raw git output" }));
const has = (lines, pattern) => assert.ok(lines.some((line) => pattern.test(line)), `${pattern} not in ${JSON.stringify(lines)}`);
const change = (path) => ({ path, code: " M", staged: false, version: path });

test("a single-step save leads with the project, the files and what stays unpublished, in both languages", () => {
  const before = snapshot({ changes: [change("menu.txt"), change("notes.txt")], isDirty: true });
  const save = plan([step("commit", { message: "Add menu" }, "Create commit", { paths: ["menu.txt"] })]);
  const en = planSummary(save, before, "en");
  assert.equal(en.project, "menu-app");
  assert.deepEqual(en.files, { paths: ["menu.txt"], selected: true, left: 1 });
  has(en.local, /Saves 1 file as a commit on feature\/menu: “Add menu”/);
  has(en.finalState, /1 file stay uncommitted/);
  has(en.finalState, /new commits on feature\/menu stay on this computer until you publish/);
  assert.deepEqual(en.remote.effects, []);
  assert.deepEqual(en.partial, [], "one step that cannot conflict has no partial risk");
  const es = planSummary(save, before, "es");
  has(es.local, /Guarda 1 archivo como un commit en feature\/menu: «Add menu»/);
  has(es.finalState, /se quedan en este equipo hasta que los publiques/);

  const after = snapshot({ head: "bbb2222", stateId: "s2", changes: [change("notes.txt")], isDirty: true, branches: [
    branch("main", { upstream: "origin/main", lastCommit: commit("main0000", "Base") }),
    branch("feature/menu", { isCurrent: true, upstream: "origin/feature/menu", ahead: 1, lastCommit: commit("bbb2222", "Add menu") })
  ] });
  const result = completionSummary({ plan: save, outcomes: done(save.steps, ["completed"]), before, after }, "en");
  assert.equal(result.status, "completed");
  assert.equal(result.headline, "Done: Create commit.");
  has(result.changed, /Saved a commit on feature\/menu: “Add menu”/);
  has(result.remaining, /1 file still uncommitted/);
  has(result.remaining, /1 commit on feature\/menu not on origin yet/);
  assert.equal(result.next.action, "save_changes");
  assert.ok(!result.changed.concat(result.remaining, result.headline).some((line) => line.includes("raw git output")), "command output never stands in for the summary");
  const resultEs = completionSummary({ plan: save, outcomes: done(save.steps, ["completed"]), before, after }, "es");
  assert.equal(resultEs.headline, "Hecho: Create commit.");
  has(resultEs.changed, /Se guardó un commit en feature\/menu: «Add menu»/);
  has(resultEs.remaining, /1 archivo siguen sin guardar en este equipo/);
});

test("a multi-step delivery names both branches, ends on the destination and warns about a stop halfway", () => {
  const before = snapshot();
  const delivery = plan([step("checkout", { name: "main" }, "Switch to main"), step("merge", { name: "feature/menu" }, "Merge feature/menu")]);
  const en = planSummary(delivery, before, "en");
  assert.equal(en.from, "feature/menu");
  assert.equal(en.to, "main");
  assert.equal(en.endsOn, "main");
  has(en.local, /Brings the commits of feature\/menu into main on this computer/);
  has(en.partial, /The 2 steps run in order\. If one fails, the ones before it stay done/);
  has(en.partial, /the merge stops halfway/);
  has(en.finalState, /new commits on main stay on this computer/);
  const es = planSummary(delivery, before, "es");
  has(es.partial, /Los 2 pasos se ejecutan en orden/);
  has(es.finalState, /Terminas en main/);

  const after = snapshot({ head: "ccc3333", currentBranch: "main", stateId: "s3", branches: [
    branch("main", { isCurrent: true, upstream: "origin/main", ahead: 1, lastCommit: commit("ccc3333", "Merge feature/menu") }),
    branch("feature/menu", { upstream: "origin/feature/menu", mergedInto: ["main"], lastCommit: commit("aaa1111", "Menu") })
  ] });
  const result = completionSummary({ plan: delivery, outcomes: done(delivery.steps, ["completed", "completed"]), before, after }, "en");
  assert.equal(result.headline, "All 2 steps completed.");
  has(result.changed, /You are now on main/);
  has(result.changed, /feature\/menu was brought into main on this computer/);
  has(result.remaining, /1 commit on main not on origin yet/);
  assert.equal(result.next.action, "publish_saved");
  assert.equal(completionSummary({ plan: delivery, outcomes: done(delivery.steps, ["completed", "completed"]), before, after }, "es").headline, "Se completaron los 2 pasos.");
});

test("a publication says what goes to the remote and that it cannot simply be taken back", () => {
  const before = snapshot({ branches: [branch("main", { upstream: "origin/main" }), branch("feature/menu", { isCurrent: true, presence: "local", lastCommit: commit("aaa1111", "Menu") })] });
  const publish = plan([step("push", { setUpstream: "origin", branch: "feature/menu" }, "Publish feature/menu to origin")]);
  const en = planSummary(publish, before, "en");
  assert.equal(en.remote.name, "origin");
  has(en.remote.effects, /Publishes feature\/menu to origin for the first time/);
  has(en.irreversible, /anyone with access can fetch these commits/);
  has(en.finalState, /feature\/menu matches origin/);
  has(planSummary(publish, before, "es").irreversible, /retirarlos obliga a reescribir el remoto/);

  const after = snapshot({ branches: [branch("main", { upstream: "origin/main" }), branch("feature/menu", { isCurrent: true, upstream: "origin/feature/menu", lastCommit: commit("aaa1111", "Menu") })] });
  const result = completionSummary({ plan: publish, outcomes: done(publish.steps, ["completed"]), before, after, fetchedAt: new Date().toISOString() }, "en");
  has(result.changed, /feature\/menu is now published on origin/);
  assert.deepEqual(result.remaining, []);
  has(completionSummary({ plan: publish, outcomes: done(publish.steps, ["completed"]), before, after }, "es").changed, /feature\/menu ya está publicada en origin/);

  const nowhere = planSummary(plan([step("push", {}, "Publish")]), snapshot({ remotes: [], branches: [branch("main", { isCurrent: true, presence: "local" })], currentBranch: "main" }), "en");
  has(nowhere.remote.effects, /not connected to a remote yet, so there is nowhere to send main/);
  assert.deepEqual(nowhere.irreversible, [], "a push with nowhere to go promises nothing it cannot do");
  assert.ok(!nowhere.finalState.some((line) => /matches/.test(line)));
  has(planSummary(plan([step("push", {}, "Publish")]), snapshot({ remotes: [], branches: [branch("main", { isCurrent: true, presence: "local" })], currentBranch: "main" }), "es").remote.effects, /no hay adónde enviar main/);

  const noVerify = planSummary(plan([step("push", { noVerify: "true" }, "Publish")]), snapshot({ branches: [branch("feature/menu", { isCurrent: true, upstream: "origin/feature/menu", ahead: 2 })] }), "en");
  has(noVerify.remote.effects, /Sends 2 commits of feature\/menu to origin/);
  has(noVerify.irreversible, /pre-push hooks\) are skipped/);
});

test("a plan that only reads is a no-op, and a run that changed nothing says so instead of claiming work", () => {
  const before = snapshot();
  const fetch = plan([step("fetch", {}, "Update remote references", { risk: "low" })], { requiresConfirmation: false, risk: "low" });
  const en = planSummary(fetch, before, "en");
  assert.equal(en.noop, true);
  has(en.remote.effects, /Reads what is new on origin\. Nothing is sent/);
  has(en.finalState, /stay exactly as they are/);
  has(planSummary(fetch, before, "es").finalState, /se quedan exactamente como están/);
  const result = completionSummary({ plan: fetch, outcomes: done(fetch.steps, ["completed"]), before, after: snapshot() }, "en");
  assert.equal(result.status, "no_change");
  assert.equal(result.headline, "Git ran and nothing needed to change.");
  assert.deepEqual(result.changed, []);
  assert.equal(completionSummary({ plan: fetch, outcomes: done(fetch.steps, ["completed"]), before, after: snapshot() }, "es").headline, "Git se ejecutó y no hacía falta cambiar nada.");
});

test("a plan prepared against an older state is flagged, and a refusal before the first step says nothing ran", () => {
  const save = plan([step("commit", { message: "Add menu" }, "Create commit")]);
  assert.equal(planSummary(save, snapshot(), "en").stale, false);
  assert.equal(planSummary(save, snapshot({ stateId: "moved" }), "en").stale, true);
  assert.equal(planSummary(save, snapshot({ head: "other" }), "es").stale, true);
  const en = completionSummary({ plan: save, error: "The repository changed after this plan was prepared." }, "en");
  assert.equal(en.status, "not_run");
  assert.match(en.headline, /^Nothing ran: GitCat stopped before the first step/);
  assert.deepEqual(en.steps.map((item) => item.status), ["skipped"]);
  assert.equal(en.next, undefined);
  assert.match(completionSummary({ plan: save, error: "x" }, "es").headline, /^No se ejecutó nada/);
});

test("a partial failure tells completed, failed and unrun steps apart and is never a success", () => {
  const before = snapshot({ changes: [change("menu.txt")], isDirty: true });
  const delivery = plan([
    step("commit", { message: "Add menu" }, "Create commit"),
    step("checkout", { name: "main" }, "Switch to main"),
    step("merge", { name: "feature/menu" }, "Merge feature/menu")
  ]);
  const after = snapshot({ head: "bbb2222", stateId: "s2", branches: [
    branch("main", { upstream: "origin/main", lastCommit: commit("main0000", "Base") }),
    branch("feature/menu", { isCurrent: true, upstream: "origin/feature/menu", ahead: 1, lastCommit: commit("bbb2222", "Add menu") })
  ] });
  const outcomes = done(delivery.steps, ["completed", "failed", "skipped"]);
  const en = completionSummary({ plan: delivery, outcomes, before, after, error: "checkout failed" }, "en");
  assert.equal(en.status, "partial");
  assert.equal(en.headline, "Stopped partway: 1 of 3 steps completed. “Switch to main” failed.");
  assert.deepEqual(en.steps.map((item) => item.status), ["completed", "failed", "skipped"]);
  has(en.changed, /Saved a commit on feature\/menu/);
  has(en.remaining, /1 commit on feature\/menu not on origin yet/);
  assert.equal(en.next, undefined, "the way on after a stop comes from recovery, not a success path");
  const es = completionSummary({ plan: delivery, outcomes, before, after, error: "x" }, "es");
  assert.equal(es.headline, "Se detuvo a medias: se completaron 1 de 3 pasos. Falló «Switch to main».");

  const first = completionSummary({ plan: delivery, outcomes: done(delivery.steps, ["failed", "skipped", "skipped"]), before, after: before, error: "x" }, "en");
  assert.equal(first.status, "failed");
  assert.match(first.headline, /did not complete, so the other steps did not run/);
  assert.match(completionSummary({ plan: delivery, outcomes: done(delivery.steps, ["failed", "skipped", "skipped"]), before, after: before, error: "x" }, "es").headline, /no se completó, así que los demás pasos no se ejecutaron/);
});
