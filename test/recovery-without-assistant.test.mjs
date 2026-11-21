import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A failed Git action stays recoverable when the assistant is missing or silent: the facts come from
// the repository, the ways on are allow-listed operations, and a real choice is asked, never guessed.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronStub = pathToFileURL(join(root, "test/helpers/electron-stub.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const service = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));
const recovery = await import(pathToFileURL(join(root, "dist-electron/electron/failure-recovery.js")));
const { createPlanHandlers } = await import(pathToFileURL(join(root, "dist-electron/electron/plan-handlers.js")));

/** Stubbed Responses API: every call is recorded; the behaviour is set per test. */
const requests = [];
let provider = () => { throw new Error("llamada al proveedor no esperada"); };
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  if (body.text?.format?.name === "gitcat_commit_scope") return replyWith({ scope: "all", paths: [] })();
  requests.push(body);
  return provider(init);
};
const replyWith = (payload) => () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ status: "completed", output_text: typeof payload === "string" ? payload : JSON.stringify(payload) }) });
/** A provider that never answers: the request only ends when GitCat stops waiting for it. */
const silent = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));

async function withoutProvider() { await service.saveLlmConfig({ apiKey: "", model: "gpt-5.6-luna", clearApiKey: true }); }
async function withSilentProvider() {
  provider = replyWith("ok");
  await service.saveLlmConfig({ apiKey: "sk-prueba", model: "gpt-5.6-luna" });
  provider = silent;
}

test.beforeEach(async () => { requests.length = 0; await withoutProvider(); });
service.providerLimits.recoveryMs = 50;

function repository(prefix, { bare = false } = {}) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const run = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run("init", ...(bare ? ["--bare"] : []), "-b", "main");
  if (!bare) {
    run("config", "user.email", "prueba@example.com");
    run("config", "user.name", "Prueba Uno");
  }
  return { path, run };
}

function seeded(prefix) {
  const repo = repository(prefix);
  writeFileSync(join(repo.path, "README.md"), "hola\n");
  repo.run("add", "-A");
  repo.run("commit", "-m", "primer commit");
  return repo;
}

function clone(origin, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["clone", "-q", origin, path]);
  const run = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run("config", "user.email", "prueba@example.com");
  run("config", "user.name", "Prueba Uno");
  return { path, run };
}

function planIpc(assertOpenedRepository) {
  const handlers = new Map();
  const event = {};
  const plans = createPlanHandlers({
    assertTrustedSender: (sender) => assert.equal(sender, event),
    assertOpenedRepository,
    tracked: (_event, _path, _phase, task) => task()
  });
  plans.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  return {
    ...plans,
    prepareDelivery: (path, request) => handlers.get("action:prepare-delivery")(event, path, request, "en"),
    execute: (path, id) => handlers.get("action:execute")(event, path, id, "en")
  };
}

async function run(path, plan) {
  const ipc = planIpc((opened) => {
    assert.equal(opened, path);
    return plan.repoPath;
  });
  ipc.rememberPlan(plan);
  try {
    const result = await ipc.execute(path, plan.id);
    return { result, record: ipc.getFailure(plan.id) };
  } catch (error) {
    return { thrown: error, record: ipc.getFailure(plan.id) };
  }
}

test("the delivery IPC accepts a reviewed selection and executes its plan only once in its own repository", async (t) => {
  const source = seeded("gitcat-delivery-ipc-");
  const other = seeded("gitcat-delivery-ipc-other-");
  t.after(() => {
    rmSync(source.path, { recursive: true, force: true });
    rmSync(other.path, { recursive: true, force: true });
  });
  writeFileSync(join(source.path, "README.md"), "guardado desde IPC\n");
  writeFileSync(join(source.path, "extra.txt"), "sin guardar\n");
  const snapshot = await service.getSnapshot(source.path);
  const destination = await service.getSnapshot(other.path);
  const ipc = planIpc((path) => {
    assert.ok([snapshot.path, destination.path].includes(path));
    return path;
  });
  const change = snapshot.changes.find(({ path }) => path === "README.md");
  const request = {
    stateId: snapshot.stateId,
    mergeToDefault: false,
    message: "Save selected",
    selection: [{ path: change.path, version: change.version }]
  };
  await assert.rejects(ipc.prepareDelivery(snapshot.path, { ...request, selection: [{ path: change.path }] }), /Invalid delivery request/);
  const plan = await ipc.prepareDelivery(snapshot.path, request);
  assert.equal(plan.requiresConfirmation, true);

  await assert.rejects(ipc.execute(destination.path, plan.id), /pertenece a otro repositorio/);
  assert.equal(source.run("rev-parse", "HEAD").trim(), snapshot.head);
  assert.equal(other.run("rev-parse", "HEAD").trim(), destination.head);

  const reviewed = await ipc.prepareDelivery(snapshot.path, request);
  const result = await ipc.execute(snapshot.path, reviewed.id);
  assert.equal(result.error, undefined);
  assert.equal(source.run("show", "--format=", "--name-only", "HEAD").trim(), "README.md");
  assert.equal(source.run("status", "--short").trim(), "?? extra.txt");
  await assert.rejects(ipc.execute(snapshot.path, reviewed.id), /plan ya no es válido/);
  assert.equal(source.run("rev-parse", "HEAD").trim(), result.snapshot.head);
});

const failureOf = (plan, record, error) => {
  const failed = record.outcomes.find((outcome) => outcome.status === "failed");
  return {
    command: failed?.command ?? plan.command, summary: failed?.summary ?? plan.summary, error,
    skipped: record.outcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.summary), planId: plan.id
  };
};

/** The assistant path for a recovery, checked first with no provider and then with one that never answers. */
async function assistantFallsBack(path, failure, report) {
  await withoutProvider();
  const none = await service.planRecovery(path, failure, [], "en", report);
  assert.equal(none.assistantUnavailable, "not_configured");
  assert.equal(none.allowed, false);
  assert.equal(requests.length, 0, "no provider means no request at all");

  await withSilentProvider();
  await service.acknowledgeAiSharing(path);
  requests.length = 0;
  const timedOut = await service.planRecovery(path, failure, [], "en", report);
  assert.equal(timedOut.assistantUnavailable, "timeout");
  assert.equal(timedOut.allowed, false, "a silent provider never turns into an invented plan");
  assert.equal(requests.length, 1);
  assert.match(requests[0].instructions, new RegExp(`classified this as \\\\"${report.kind}\\\\"`));
  await withoutProvider();
}

const kinds = (actions = []) => actions.map((action) => action.option ?? action.kind);

test("push sin upstream: se explica, se ofrece publicar en el remoto y nada depende del asistente", async () => {
  const origin = repository("gitcat-rec-origin-", { bare: true });
  const work = seeded("gitcat-rec-upstream-");
  work.run("remote", "add", "origin", origin.path);
  work.run("push", "-q", "-u", "origin", "main");
  work.run("switch", "-c", "feature/sin-upstream");
  writeFileSync(join(work.path, "nuevo.txt"), "trabajo\n");
  work.run("add", "-A");
  work.run("commit", "-m", "trabajo sin publicar");

  const plan = await service.prepareOperation(work.path, "push", {}, "en");
  const { result, record } = await run(work.path, plan);
  assert.match(result.error, /is not published yet/);
  const failure = failureOf(plan, record, result.error);
  const report = await service.describeFailure(work.path, failure, record);
  assert.equal(report.kind, "missing_upstream");
  assert.equal(report.stage, "execute");
  assert.equal(report.failedSummary, plan.steps[0].summary);
  assert.match(report.detail, /has no upstream branch/, "Git's own words, not the translation");
  assert.deepEqual(report.completed, []);
  assert.equal(report.facts.branch, "feature/sin-upstream");
  assert.equal(report.facts.ahead, 0);
  assert.deepEqual(kinds(report.actions), ["publish"]);
  assert.deepEqual(report.actions[0].args, { setUpstream: "origin" });
  assert.equal(report.needsJudgment, false);

  await assistantFallsBack(work.path, failure, report);

  // The action is an ordinary direct control: prepared, shown and confirmed before it runs.
  const publish = await service.prepareOperation(work.path, report.actions[0].operation, report.actions[0].args, "en");
  assert.equal(publish.command, "git push --set-upstream origin refs/heads/feature/sin-upstream:refs/heads/feature/sin-upstream");
  assert.equal(publish.requiresConfirmation, true);
  assert.equal(execFileSync("git", ["--git-dir", origin.path, "branch", "--list", "feature/sin-upstream"], { encoding: "utf8" }).trim(), "", "preparing sends nothing");
  const published = await service.executePlan(work.path, publish);
  assert.equal(published.error, undefined, published.error);
  assert.equal(work.run("rev-parse", "--abbrev-ref", "@{upstream}").trim(), "origin/feature/sin-upstream");
  await assert.rejects(() => service.prepareOperation(work.path, "push", { setUpstream: "--exec=boom" }, "en"), /does not exist/);
});

test("pull divergente: se preguntan las salidas reales, sin elegir ninguna, con y sin asistente", async () => {
  const origin = repository("gitcat-rec-div-origin-", { bare: true });
  const seed = seeded("gitcat-rec-div-seed-");
  seed.run("remote", "add", "origin", origin.path);
  seed.run("push", "-q", "-u", "origin", "main");
  const mine = clone(origin.path, "gitcat-rec-div-mine-");
  const theirs = clone(origin.path, "gitcat-rec-div-theirs-");
  writeFileSync(join(theirs.path, "README.md"), "versión remota\n");
  writeFileSync(join(theirs.path, "suyo.txt"), "de otra persona\n");
  theirs.run("add", "-A"); theirs.run("commit", "-m", "trabajo remoto"); theirs.run("push", "-q");
  writeFileSync(join(mine.path, "README.md"), "versión local\n");
  writeFileSync(join(mine.path, "mio.txt"), "mío\n");
  mine.run("add", "-A"); mine.run("commit", "-m", "trabajo local");
  mine.run("fetch", "-q");
  const head = mine.run("rev-parse", "HEAD").trim();

  const plan = await service.prepareOperation(mine.path, "pull", {}, "en");
  const { result, record } = await run(mine.path, plan);
  assert.ok(result.error);
  const failure = failureOf(plan, record, result.error);
  const report = await service.describeFailure(mine.path, failure, record);
  assert.equal(report.kind, "divergent");
  assert.equal(report.facts.ahead, 1);
  assert.equal(report.facts.behind, 1);
  assert.equal(report.facts.upstream, "origin/main");
  assert.deepEqual(kinds(report.choice), ["prefer_remote", "merge_upstream", "rebase_upstream", "keep"]);
  assert.equal(report.needsJudgment, false, "the local choices are complete without a provider call");
  assert.equal(report.actions.some((action) => action.kind === "retry"), false, "a pull that cannot fast-forward is not retried blindly");
  assert.equal(mine.run("rev-parse", "HEAD").trim(), head, "describing the failure changes nothing");

  await withoutProvider();

  // Each option is a real, confirmable operation against the upstream the branch follows.
  const prepareChoice = action => service.prepareOperation(mine.path, action.operation, action.args, "en");
  const preferred = await prepareChoice(report.choice[0]);
  assert.equal(preferred.requiresConfirmation, true);
  assert.match(preferred.command, /-Xtheirs/);
  const merge = await prepareChoice(report.choice[1]);
  assert.equal(merge.requiresConfirmation, true);
  assert.doesNotMatch(merge.command, /-Xtheirs/);
  const rebase = await prepareChoice(report.choice[2]);
  assert.equal(rebase.command, "git rebase origin/main");
  await assert.rejects(() => service.prepareOperation(mine.path, "merge", { name: "origin/otra" }, "en"), /does not exist locally/);
  assert.equal(mine.run("rev-parse", "HEAD").trim(), head);

  // With uncommitted work, replaying is left out: Git would refuse it, so it is not offered.
  writeFileSync(join(mine.path, "mio.txt"), "mío, editado\n");
  const dirty = await service.describeFailure(mine.path, failure, record);
  assert.deepEqual(kinds(dirty.choice), ["choose_sync", "keep"]);
  assert.ok(dirty.actions.some((action) => action.kind === "inspect_changes"));
  assert.deepEqual(dirty.choice[0].args, { ref: "origin/main", name: "main" });

  mine.run("restore", "--", "mio.txt");
  const remoteTip = mine.run("rev-parse", "origin/main").trim();
  const updated = await service.executePlan(mine.path, preferred, "en");
  assert.equal(updated.error, undefined);
  assert.equal(updated.snapshot.pending, undefined);
  assert.equal(mine.run("show", "HEAD:README.md").trim(), "versión remota");
  assert.equal(mine.run("show", "HEAD:mio.txt").trim(), "mío");
  assert.equal(mine.run("rev-parse", "HEAD^1").trim(), head);
  assert.equal(mine.run("rev-parse", "HEAD^2").trim(), remoteTip);
  assert.equal(theirs.run("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], remoteTip);
});

test("un hook pre-commit que falla: el trabajo sigue intacto y reintentar solo repite lo que no se completó", async () => {
  const work = seeded("gitcat-rec-hook-");
  const hook = join(work.path, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'lint: falta un punto y coma' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(work.path, "README.md"), "hola, editado\n");
  const status = work.run("status", "--porcelain");
  const head = work.run("rev-parse", "HEAD").trim();

  const plan = await service.prepareOperation(work.path, "commit", { message: "Editar el README" }, "en");
  const { result, record } = await run(work.path, plan);
  assert.match(result.error, /lint: falta un punto y coma/);
  assert.equal(work.run("status", "--porcelain"), status.replace(/^ M/m, "M "), "the change is still there, only staged");
  const failure = failureOf(plan, record, result.error);
  const report = await service.describeFailure(work.path, failure, record);
  assert.equal(report.kind, "hook");
  assert.equal(report.facts.hook, "pre-commit");
  assert.equal(report.facts.changes, 1);
  assert.deepEqual(kinds(report.actions), ["inspect_changes", "retry", "refresh"]);

  await assistantFallsBack(work.path, failure, report);

  writeFileSync(hook, "#!/bin/sh\nexit 0\n");
  const retried = await service.prepareRetry(work.path, record, "en");
  assert.deepEqual(retried.steps.map((step) => step.operation), ["commit"]);
  assert.equal(retried.steps[0].args.message, "Editar el README");
  assert.equal(retried.requiresConfirmation, true, "a retry that changes anything is confirmed again");
  assert.notEqual(retried.id, plan.id);
  assert.equal(work.run("rev-parse", "HEAD").trim(), head, "preparing a retry runs nothing");
  const done = await service.executePlan(work.path, retried);
  assert.equal(done.error, undefined, done.error);
  assert.equal(work.run("log", "-1", "--format=%s").trim(), "Editar el README");
});

test("un guardado de archivos elegidos que un hook rechaza se revisa de nuevo en vez de repetirse", async () => {
  const work = seeded("gitcat-rec-hook-selection-");
  const hook = join(work.path, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(work.path, "README.md"), "hola, editado\n");
  writeFileSync(join(work.path, "fuera.txt"), "no se guarda\n");
  const snapshot = await service.getSnapshot(work.path);
  const readme = snapshot.changes.find((change) => change.path === "README.md");
  const plan = await service.prepareBranchDelivery(work.path, { stateId: snapshot.stateId, mergeToDefault: false, message: "Solo el README", selection: [{ path: readme.path, version: readme.version }] }, "en");
  assert.equal(plan.allowed, true, plan.rationale);
  const { result, record } = await run(work.path, plan);
  assert.ok(result.error);
  const report = await service.describeFailure(work.path, failureOf(plan, record, result.error), record);
  assert.equal(report.kind, "hook");
  assert.deepEqual(kinds(report.actions), ["inspect_changes", "refresh"]);
  await assert.rejects(() => service.prepareRetry(work.path, record, "en"), /Review them again/);
  assert.equal(existsSync(join(work.path, "fuera.txt")), true);
});

test("un plan desfasado no se ejecuta, se explica como tal y se puede preparar de nuevo con el estado actual", async () => {
  const work = seeded("gitcat-rec-stale-");
  work.run("switch", "-c", "feature/desfase");
  const plan = await service.prepareOperation(work.path, "checkout", { name: "main" }, "en");
  writeFileSync(join(work.path, "fuera.txt"), "hecho en otra herramienta\n");
  work.run("add", "-A");
  work.run("commit", "-m", "commit desde la terminal");

  const { thrown, record } = await run(work.path, plan);
  assert.ok(thrown instanceof service.StalePlanError);
  assert.equal(record.stale, true);
  const failure = { command: plan.command, summary: plan.summary, error: thrown.message, skipped: plan.steps.map((step) => step.summary), planId: plan.id };
  const report = await service.describeFailure(work.path, failure, record);
  assert.equal(report.kind, "stale");
  assert.equal(report.stage, "stale");
  assert.equal(report.facts.moved, true);
  assert.deepEqual(report.completed, []);
  assert.deepEqual(report.notRun, [plan.steps[0].summary]);
  assert.deepEqual(kinds(report.actions), ["refresh", "retry"]);
  assert.equal(work.run("branch", "--show-current").trim(), "feature/desfase", "nothing ran");

  await assistantFallsBack(work.path, failure, report);

  const retried = await service.prepareRetry(work.path, record, "en");
  assert.equal(retried.head, work.run("rev-parse", "HEAD").trim(), "bound to the repository as it is now");
  assert.equal(retried.command, "git switch main");
  // A plan this process no longer holds is still explained as stale, just without a retry.
  const expired = await service.describeFailure(work.path, { ...failure, planId: "desconocido" }, undefined, { stale: true });
  assert.equal(expired.kind, "stale");
  assert.deepEqual(kinds(expired.actions), ["refresh"]);
});

test("una fusión que se detiene a medias dice qué se hizo, qué falló y no repite el cambio de rama", async () => {
  const work = seeded("gitcat-rec-partial-");
  work.run("switch", "-c", "feature/choque");
  writeFileSync(join(work.path, "README.md"), "versión de la rama\n");
  work.run("commit", "-am", "cambio en la rama");
  work.run("switch", "main");
  writeFileSync(join(work.path, "README.md"), "versión de main\n");
  work.run("commit", "-am", "cambio en main");
  work.run("switch", "feature/choque");

  const plan = await service.prepareMergeToDefault(work.path, "feature/choque", "en");
  assert.deepEqual(plan.steps.map((step) => step.operation), ["checkout", "merge"]);
  const { result, record } = await run(work.path, plan);
  assert.match(result.error, /1 of 2 steps completed/);
  const failure = failureOf(plan, record, result.error);
  const report = await service.describeFailure(work.path, failure, record);
  assert.equal(report.kind, "conflict", "a content conflict, not a remote or access problem");
  assert.deepEqual(report.completed, [plan.steps[0].summary]);
  assert.equal(report.failedSummary, plan.steps[1].summary);
  assert.deepEqual(report.notRun, []);
  assert.equal(report.facts.pending.kind, "merge");
  assert.equal(report.facts.conflicts, 1);
  assert.deepEqual(kinds(report.choice), ["resolve_conflicts", "abort"]);
  assert.equal(report.actions.some((action) => action.kind === "retry"), false, "the completed switch is never replayed");
  await assert.rejects(() => service.prepareRetry(work.path, record, "en"), /half-finished/);

  await assistantFallsBack(work.path, failure, report);

  const abort = await service.prepareOperation(work.path, "abort_operation", {}, "en");
  assert.equal(abort.requiresConfirmation, true);
  assert.equal(work.run("branch", "--show-current").trim(), "main", "the completed step stays completed");
});

test("una red caída y un remoto que niega el acceso se distinguen de un conflicto, y reintentar solo publica", async () => {
  const work = seeded("gitcat-rec-network-");
  work.run("remote", "add", "origin", "http://127.0.0.1:1/nadie.git");
  work.run("config", "branch.main.remote", "origin");
  work.run("config", "branch.main.merge", "refs/heads/main");
  writeFileSync(join(work.path, "README.md"), "hola, editado\n");

  // A two-step plan as the assistant would propose it: save, then publish.
  provider = replyWith("ok");
  await service.saveLlmConfig({ apiKey: "sk-prueba", model: "gpt-5.6-luna" });
  await service.acknowledgeAiSharing(work.path);
  const noArgs = { name: "", onto: "", to: "", path: "", side: "", message: "", noVerify: "" };
  provider = replyWith({
    intent: "git_operation", summary: "Guardar y publicar", rationale: "Pedido por el usuario.", reply: "", risk: "high",
    repository: { localPath: "", repository: "", owner: "", host: "", protocol: "", sshHost: "", remote: "", push: true, replaceRemote: false },
    steps: [{ operation: "commit", argv: [], args: { ...noArgs, message: "Editar el README" } }, { operation: "push", argv: [], args: noArgs }]
  });
  const plan = await service.planAction(work.path, "guarda y publica", [], "en");
  assert.deepEqual(plan.steps.map((step) => step.operation), ["commit", "push"], plan.rationale);
  await withoutProvider();

  const { result, record } = await run(work.path, plan);
  assert.ok(result.error);
  const commits = work.run("rev-list", "--count", "HEAD").trim();
  const report = await service.describeFailure(work.path, failureOf(plan, record, result.error), record);
  assert.equal(report.kind, "network");
  assert.deepEqual(report.completed, [plan.steps[0].summary]);
  assert.deepEqual(kinds(report.actions), ["retry", "refresh"]);
  const retried = await service.prepareRetry(work.path, record, "en");
  assert.deepEqual(retried.steps.map((step) => step.operation), ["push"], "the commit that completed is not replayed");
  assert.match(retried.effects.join(" "), /Already done, not repeated/);
  assert.equal(work.run("rev-list", "--count", "HEAD").trim(), commits);

  // A remote that is not there reads as access, not as a network outage or a conflict.
  work.run("remote", "set-url", "origin", join(tmpdir(), "gitcat-no-existe", "repo.git"));
  const fetch = await service.prepareOperation(work.path, "fetch", {}, "en");
  const refused = await run(work.path, fetch);
  const denied = await service.describeFailure(work.path, failureOf(fetch, refused.record, refused.result.error), refused.record);
  assert.equal(denied.kind, "auth");
  assert.deepEqual(kinds(denied.actions), ["retry", "refresh"]);
});

test("sin remoto ni identidad, las salidas son configurar lo que falta y se validan antes de prepararse", async () => {
  const work = seeded("gitcat-rec-config-");
  const plan = await service.prepareOperation(work.path, "push", {}, "en");
  const { result, record } = await run(work.path, plan);
  const report = await service.describeFailure(work.path, failureOf(plan, record, result.error), record);
  assert.equal(report.kind, "no_remote");
  assert.deepEqual(kinds(report.actions), ["configure_remote"]);
  const connect = await service.prepareOperation(work.path, "add_remote", { name: "origin", url: "git@github.com:gato/repo.git" }, "en");
  assert.equal(connect.command, "git remote add origin git@github.com:gato/repo.git");
  assert.equal(connect.requiresConfirmation, true);
  await assert.rejects(() => service.prepareOperation(work.path, "add_remote", { name: "origin", url: "--upload-pack=touch /tmp/x" }, "en"), /does not look like a repository address/);

  const identity = await service.prepareOperation(work.path, "set_identity", { user: " Ana Gato ", email: "ana@example.com" }, "en");
  assert.equal(identity.command, 'git config user.name "Ana Gato" && git config user.email "ana@example.com"');
  await assert.rejects(() => service.prepareOperation(work.path, "set_identity", { user: "Ana", email: "sin-arroba" }, "en"), /name@domain/);
  const done = await service.executePlan(work.path, identity);
  assert.equal(done.error, undefined, done.error);
  assert.equal(work.run("config", "--local", "user.name").trim(), "Ana Gato");
});

test("el clasificador distingue identidad, bloqueo, acceso, red y conflicto por los hechos de Git", () => {
  const snapshot = { currentBranch: "main", branches: [], remotes: ["origin"], conflicts: [], changes: [], pending: undefined };
  const kind = (detail, extra = {}) => recovery.classifyFailure({ command: "git commit", detail, stale: false, ...extra }, { ...snapshot, ...extra.snapshot });
  assert.equal(kind("Author identity unknown\n*** Please tell me who you are."), "identity");
  assert.equal(kind("fatal: Unable to create '/r/.git/index.lock': File exists."), "lock");
  assert.equal(kind("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", { operation: "push" }), "auth");
  assert.equal(kind("ssh: Could not resolve hostname github.com: nodename nor servname provided\nfatal: Could not read from remote repository.", { operation: "push" }), "network");
  assert.equal(kind("CONFLICT (content): Merge conflict in a.txt", { snapshot: { conflicts: [{ path: "a.txt", kind: "both-modified" }], pending: { kind: "merge" } } }), "conflict");
  assert.equal(kind("something nobody has seen before"), "unknown");
  assert.equal(kind("anything", { stale: true }), "stale");
  assert.equal(recovery.operationFromCommand("git fetch --all --prune"), "fetch");
});
