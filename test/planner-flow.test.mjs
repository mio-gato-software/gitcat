import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, chmodSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronStub = pathToFileURL(join(root, "test/helpers/electron-stub.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const gitService = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));
// These tests are about planning, not about the sharing disclosure (see ai-sharing.test.mjs): every
// repository they plan in has already been shared with the assistant.
const service = {
  ...gitService,
  planAction: async (path, ...rest) => { await gitService.acknowledgeAiSharing(path); return gitService.planAction(path, ...rest); },
  planRecovery: async (path, ...rest) => { await gitService.acknowledgeAiSharing(path); return gitService.planRecovery(path, ...rest); }
};

const repo = mkdtempSync(join(tmpdir(), "gitcat-repo-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-b", "main");
git("config", "user.email", "prueba@example.com");
git("config", "user.name", "Prueba Uno");
writeFileSync(join(repo, "README.md"), "hola\n");
git("add", "-A");
git("commit", "-m", "primer commit");

/** Stubbed Responses API: each call consumes the next queued payload and records the request. */
const queue = [];
const requests = [];
const coverageRequests = [];
const coverageReplies = [];
const scopeReplies = [];
const scopeRequests = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  if (body.text?.format?.name === "gitcat_answer_coverage") {
    coverageRequests.push(body);
    const next = coverageReplies.shift() ?? { reads: [], uncovered: false };
    if (next instanceof Error) throw next;
    return { ok: true, json: async () => ({ output_text: JSON.stringify(next) }) };
  }
  if (body.text?.format?.name === "gitcat_commit_scope") {
    scopeRequests.push(body);
    const next = scopeReplies.shift() ?? { scope: "all", paths: [] };
    return { ok: true, json: async () => ({ output_text: JSON.stringify(next) }) };
  }
  requests.push(body);
  const next = queue.shift();
  if (!next) throw new Error("llamada al proveedor no esperada");
  if (next.error) throw next.error;
  return {
    ok: next.ok !== false,
    status: next.status ?? 200,
    text: async () => next.raw ?? "",
    json: async () => {
      if (next.jsonError) throw next.jsonError;
      return next.payload;
    }
  };
};
const reply = (value) => queue.push({ payload: { status: "completed", output_text: typeof value === "string" ? value : JSON.stringify(value) } });
const step = (operation, args = {}, argv = []) => ({ operation, argv, args: { name: "", onto: "", to: "", path: "", side: "", message: "", noVerify: "", ...args } });
const plan = (overrides) => ({
  intent: "git_operation",
  steps: [],
  reads: [],
  repository: { localPath: "", repository: "", owner: "", host: "", protocol: "", sshHost: "", remote: "", push: true, replaceRemote: false },
  summary: "", rationale: "", reply: "", risk: "low",
  ...overrides
});

test.beforeEach(() => {
  queue.length = 0;
  requests.length = 0;
  coverageRequests.length = 0;
  coverageReplies.length = 0;
  scopeReplies.length = 0;
  scopeRequests.length = 0;
});

test("sin proveedor configurado no se interpreta nada", async () => {
  const result = await service.planAction(repo, "cámbiame a la rama main");
  assert.equal(result.allowed, false);
  assert.equal(result.source, "guardrail");
  assert.match(result.rationale, /necesita un proveedor de IA conectado/);
  assert.equal(requests.length, 0, "no debe existir ningún camino que planifique sin modelo");
});

test("guardar la configuración verifica la key y el modelo contra el proveedor", async () => {
  reply("ok");
  const config = await service.saveLlmConfig({ apiKey: "sk-prueba", model: "gpt-5.6-luna" });
  assert.equal(config.configured, true);
  assert.equal(requests.length, 1);
});

test("una petición en inglés se convierte en una operación Git", async () => {
  reply(plan({
    intent: "git_operation", steps: [step("checkout", { name: "main" })],
    summary: "Switch to main", rationale: "Moves the active branch.", risk: "medium"
  }));
  const result = await service.planAction(repo, "hey, put me on the main branch please");
  assert.equal(result.allowed, true);
  assert.equal(result.operation, "checkout");
  assert.equal(result.command, "git switch main");
  assert.equal(result.summary, "Switch to main");
  assert.equal(result.source, "llm");
});

test("el asistente prepara la sincronización revisada con el estado posterior a fetch", async t => {
  const root = mkdtempSync(join(tmpdir(), "gitcat-assistant-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "local");
  execFileSync("git", ["clone", "-q", repo, path]);
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const writer = join(root, "writer");
  run(root, "clone", "-q", repo, writer);
  run(path, "remote", "set-url", "origin", writer);
  for (const cwd of [path, writer]) {
    run(cwd, "config", "user.name", "QA"); run(cwd, "config", "user.email", "qa@example.test");
    writeFileSync(join(cwd, "README.md"), cwd);
    run(cwd, "commit", "-qam", "edit");
  }
  run(path, "switch", "-q", "--detach", "origin/main");
  reply(plan({ steps: [step("git_command", {}, ["checkout", "origin/main"])] }));
  reply(plan({ steps: [step("sync_remote", { name: "origin/main", to: "main", side: "theirs" })] }));
  const prepared = await service.planAction(path, "Actualiza main desde origin/main priorizando el remoto");
  assert.equal(prepared.requiresConfirmation, true);
  assert.equal(prepared.stateId, (await service.getSnapshot(path)).stateId);
  assert.equal(requests.length, 2);
  assert.deepEqual(prepared.steps.map(item => item.operation), ["checkout", "sync_remote"]);
  assert.equal(prepared.steps[1].args.mode, "prefer_remote");
  assert.equal((await service.executePlan(path, prepared)).error, undefined);
  assert.equal(run(path, "branch", "--show-current"), "main");
  assert.equal(readFileSync(join(path, "README.md"), "utf8"), writer);
});

test("una respuesta factual utiliza el estado de Git aunque el modelo diga otra cosa", async () => {
  reply(plan({
    intent: "answer", answerLanguage: "en", reads: [{ kind: "repository", args: ["active_branch"] }],
    summary: "The branch is release", reply: "The active branch is release.", rationale: "Release is also clean."
  }));
  const result = await service.planAction(repo, "What branch am I on?", [], "es");
  assert.equal(result.answer, "The active branch is main.");
  assert.doesNotMatch(JSON.stringify(result), /release/i);
  assert.equal(result.requiresConfirmation, false);
  assert.equal(requests.length, 1);
  assert.equal(result.operation, "none");
  assert.match(requests[0].instructions, /same language as the user's latest message/);
  assert.match(requests[0].instructions, /"currentBranch": "main"/);
  assert.match(requests[0].instructions, /"author": "Prueba Uno"/);
  assert.match(requests[0].instructions, /"remembered"/, "el modelo ve lo que ya se confirmó antes");
});

test("las respuestas completas del proveedor aceptan los campos de cuentas del esquema estricto", async t => {
  const path = mkdtempSync(join(tmpdir(), "gitcat-full-planner-schema-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  execFileSync("git", ["clone", "-q", repo, path]);
  const run = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  const repository = { ...plan().repository, provider: "", connectionId: "" };
  const respond = (value) => queue.push({ payload: { status: "completed", output: [
    { type: "reasoning", summary: [] },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }
  ] } });

  respond(plan({ intent: "answer", repository, reads: [{ kind: "repository", args: ["active_branch"] }] }));
  const answer = await service.planAction(path, "What is the active branch?", [], "en");
  assert.deepEqual(Object.keys(repository).sort(), [...requests[0].text.format.schema.properties.repository.required].sort());
  assert.equal(answer.answer, "The active branch is main.");
  assert.equal(answer.operation, "none");

  respond(plan({ intent: "git_operation", repository, steps: [step("create_branch", { name: "qa/assistant-test" })] }));
  const prepared = await service.planAction(path, "Create qa/assistant-test from HEAD", [], "en");
  assert.equal(prepared.requiresConfirmation, true);
  assert.equal(prepared.steps[0].operation, "create_branch");
  assert.equal(run("branch", "--list", "qa/assistant-test"), "");
  const result = await service.executePlan(path, prepared, "en");
  assert.equal(result.error, undefined);
  assert.equal(run("branch", "--show-current"), "qa/assistant-test");
});

test("el imperativo “Guarda este repositorio” llega a la creación de repositorio", async () => {
  reply(plan({
    intent: "create_repository",
    repository: { localPath: "/no/existe", repository: "mio-gato-software", owner: "eliaquin", host: "github.com", protocol: "ssh", sshHost: "", remote: "origin", push: true, replaceRemote: false },
    summary: "Crear mio-gato-software", rationale: "El usuario pidió publicarlo.", risk: "high"
  }));
  reply(plan({ intent: "needs_information", summary: "Falta la ruta local", reply: "La ruta /no/existe no existe. Indícame la ruta del repositorio que quieres publicar." }));
  const result = await service.planAction(repo, "Guarda este repositorio en github.com/mio-gato-software. Mi usuario es eliaquin, con credenciales ssh.");
  assert.equal(requests.length, 2, "el bloqueo debe volver al modelo");
  assert.match(requests[1].instructions, /Validation issues \(JSON\)/);
  assert.match(requests[1].instructions, /does not exist or is not readable/);
  assert.equal(result.allowed, false);
  assert.equal(result.source, "llm");
  assert.equal(result.summary, "Falta la ruta local");
  assert.match(result.rationale, /Indícame la ruta del repositorio/);
});

test("un nombre de rama peligroso vuelve al modelo en vez de ejecutarse", async () => {
  reply(plan({ intent: "git_operation", steps: [step("delete_branch", { name: "--upload-pack=touch /tmp/x" })], summary: "Borrar", rationale: "…", risk: "high" }));
  reply(plan({ intent: "needs_information", summary: "¿Qué rama?", reply: "Ese nombre no es una rama válida. ¿Cuál quieres borrar?" }));
  const result = await service.planAction(repo, "borra esa rama");
  assert.equal(requests.length, 2);
  assert.match(requests[1].instructions, /is not a valid Git branch name/);
  assert.equal(result.allowed, false);
  assert.match(result.rationale, /¿Cuál quieres borrar\?/);
});

test("una respuesta truncada por tokens se reporta, no se disfraza de rechazo", async () => {
  queue.push({ payload: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }] } });
  const result = await service.planAction(repo, "¿qué ramas hay?");
  assert.equal(result.allowed, false);
  assert.match(result.rationale, /agotó su presupuesto de tokens/);
  assert.doesNotMatch(result.rationale, /plan local/);
});

test("un JSON que no cumple el esquema no activa ningún planificador local", async () => {
  reply({ allowed: true, operation: "push" });
  const result = await service.planAction(repo, "sube los cambios");
  assert.equal(result.allowed, false);
  assert.equal(result.assistantUnavailable, "invalid_response");
  assert.match(result.rationale, /no cumple el esquema del plan/);
  assert.doesNotMatch(result.rationale, /No pude consultar/);
});

test("distingue un cuerpo inválido de un fallo de conexión", async () => {
  queue.push({ jsonError: new SyntaxError("Invalid JSON") });
  const malformed = await service.planAction(repo, "what branch am I on?", [], "en");
  assert.equal(malformed.assistantUnavailable, "invalid_response");
  assert.match(malformed.rationale, /provider returned.*format/i);

  queue.push({ error: new TypeError("Network unavailable") });
  const disconnected = await service.planAction(repo, "what branch am I on?", [], "en");
  assert.equal(disconnected.assistantUnavailable, "unreachable");
  assert.match(disconnected.rationale, /could not query/i);
});

test("el riesgo y la confirmación deterministas prevalecen sobre los del modelo", async () => {
  reply(plan({ intent: "git_operation", steps: [step("push")], summary: "Push", rationale: "…", risk: "low" }));
  const result = await service.planAction(repo, "push it");
  assert.equal(result.risk, "high");
  assert.equal(result.requiresConfirmation, true);
});

test("push con --no-verify llega al comando cuando el usuario lo autorizó", async () => {
  const origin = mkdtempSync(join(tmpdir(), "gitcat-origin-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: origin, encoding: "utf8" });
  const clone = mkdtempSync(join(tmpdir(), "gitcat-clone-"));
  const local = (...args) => execFileSync("git", args, { cwd: clone, encoding: "utf8" });
  local("init", "-b", "main");
  local("config", "user.email", "prueba@example.com");
  local("config", "user.name", "Prueba Uno");
  writeFileSync(join(clone, "README.md"), "hola\n");
  local("add", "-A");
  local("commit", "-m", "primer commit");
  local("remote", "add", "origin", origin);
  local("push", "-u", "origin", "main");
  // Un hook pre-push que siempre falla: sin --no-verify el push no puede pasar.
  const hook = join(clone, ".git", "hooks", "pre-push");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(clone, "cambio.txt"), "algo que subir\n");
  local("add", "-A");
  local("commit", "-m", "segundo commit");

  const plain = await service.prepareOperation(clone, "push");
  assert.equal(plain.command, "git push");
  const blocked = await service.executePlan(clone, plain);
  assert.match(blocked.error ?? "", /pre-push hook declined|error: failed to push/);

  reply(plan({
    intent: "git_operation", steps: [step("push", { noVerify: "true" })],
    summary: "Push sin verificaciones", rationale: "El usuario autorizó omitir el hook.", risk: "high"
  }));
  const result = await service.planAction(clone, "push it with --no-verify");
  assert.equal(result.allowed, true, result.rationale);
  assert.equal(result.steps[0].command, "git push --no-verify");
  assert.equal(result.command, "git push --no-verify");
  assert.equal(result.requiresConfirmation, true, "saltarse los hooks siempre pasa por la tarjeta de confirmación");
  assert.match(result.steps[0].summary, /omitiendo las verificaciones/);

  const execution = await service.executePlan(clone, result);
  assert.equal(execution.error, undefined, execution.error);
  assert.deepEqual(execution.outcomes.map((item) => item.status), ["completed"]);
  assert.equal(local("rev-parse", "origin/main").trim(), local("rev-parse", "main").trim(), "el push llegó al remoto");
});

test("un push sin upstream se explica y ofrece publicar la rama por primera vez", async (t) => {
  const origin = mkdtempSync(join(tmpdir(), "gitcat-origin-upstream-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: origin, encoding: "utf8" });
  const work = mkdtempSync(join(tmpdir(), "gitcat-no-upstream-"));
  const local = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" });
  local("init", "-b", "main");
  local("config", "user.email", "prueba@example.com");
  local("config", "user.name", "Prueba Uno");
  writeFileSync(join(work, "README.md"), "hola\n");
  local("add", "-A");
  local("commit", "-m", "primer commit");
  local("remote", "add", "origin", origin);
  local("push", "-u", "origin", "main");
  local("switch", "-c", "feature/no-upstream");
  writeFileSync(join(work, "cambio.txt"), "algo que publicar\n");
  local("add", "-A");
  local("commit", "-m", "cambio pendiente");

  const pushPlan = await service.prepareOperation(work, "push");
  const failed = await service.executePlan(work, pushPlan);
  assert.match(failed.error ?? "", /todavía no está publicada/);
  assert.match(failed.error ?? "", /siguen a salvo/);

  const failedStep = failed.outcomes.find((item) => item.status === "failed");
  reply(plan({
    intent: "git_operation",
    steps: [step("git_command", {}, ["push", "--set-upstream", "origin", "feature/no-upstream"])],
    summary: "Publicar feature/no-upstream",
    rationale: "La rama aún no tiene una rama remota asociada; este primer push la publicará y recordará el destino.",
    risk: "high"
  }));
  const recovery = await service.planRecovery(work, {
    command: failedStep.command,
    summary: failedStep.summary,
    error: failed.error,
    skipped: []
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].instructions, /--set-upstream/);
  assert.equal(recovery.steps[0].command, "git push --set-upstream origin refs/heads/feature/no-upstream:refs/heads/feature/no-upstream");
  assert.equal(recovery.steps[0].operation, "push");
  assert.equal(recovery.steps[0].argv, undefined);
  assert.equal(recovery.requiresConfirmation, true);
  assert.deepEqual(recovery.steps[0].pushDestination.urls, [origin]);

  // A free-form push from the assistant uses the same confirmation boundary as the Push button.
  const other = mkdtempSync(join(tmpdir(), "gitcat-push-other-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "-q", other]);
  local("remote", "set-url", "--push", "origin", other);
  await assert.rejects(service.executePlan(work, recovery, "en"), /publishing destination changed/);
  assert.equal(execFileSync("git", ["--git-dir", other, "for-each-ref", "refs/heads"], { encoding: "utf8" }), "");
});

test("git_command convierte switch -c en la misma operación que usa el botón", async () => {
  reply(plan({
    intent: "git_operation",
    steps: [step("git_command", {}, ["switch", "-c", "libre"])],
    summary: "Crear la rama libre", rationale: "El usuario pidió un switch -c.", risk: "high"
  }));
  const result = await service.planAction(repo, "crea la rama libre con git switch -c");
  assert.equal(result.allowed, true, result.rationale);
  assert.equal(result.steps[0].operation, "create_branch");
  assert.equal(result.steps[0].argv, undefined);
  assert.equal(result.steps[0].command, "git switch -c libre");
  assert.equal(result.requiresConfirmation, true, "crear una rama siempre pasa por la tarjeta");

  const execution = await service.executePlan(repo, result);
  assert.equal(execution.error, undefined, execution.error);
  assert.equal(execution.snapshot.currentBranch, "libre");
  git("switch", "main");
  git("branch", "-d", "libre");
});

test("git_command no cuela el borrado de una rama protegida", async () => {
  reply(plan({
    intent: "git_operation",
    steps: [step("git_command", {}, ["branch", "-d", "main"])],
    summary: "Borrar main", rationale: "…", risk: "high"
  }));
  reply(plan({ intent: "needs_information", summary: "Rama protegida", reply: "main es la rama por defecto y está protegida; no puedo borrarla." }));
  const result = await service.planAction(repo, "borra main");
  assert.equal(requests.length, 2, "la protección vuelve al modelo como incidencia");
  assert.match(requests[1].instructions, /default branch and is protected/);
  assert.equal(result.allowed, false);
  assert.match(result.rationale, /protegida/);
});

test("crear y cambiar a la misma rama ejecuta un solo paso", async () => {
  reply(plan({ steps: [step("create_branch", { name: "qa/single-switch" }), step("checkout", { name: "qa/single-switch" })] }));
  const result = await service.planAction(repo, "Crea la rama qa/single-switch y cámbiame a ella");
  assert.deepEqual(result.steps.map(step => step.operation), ["create_branch"]);
  assert.equal(result.requiresConfirmation, true);
});

test("el asistente guarda y publica solo el archivo pedido aunque el plan original omita el alcance", async t => {
  const root = mkdtempSync(join(tmpdir(), "gitcat-assistant-selected-save-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const path = join(root, "work");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, path]);
  const run = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  run("config", "user.name", "QA");
  run("config", "user.email", "qa@example.test");
  run("commit", "--allow-empty", "-qm", "base");
  run("push", "-q", "-u", "origin", "main");
  writeFileSync(join(path, "picked.txt"), "picked contents\n");
  writeFileSync(join(path, "other.txt"), "unrelated staged contents\n");
  run("add", "other.txt");

  const message = "Guardar solo el archivo elegido";
  const saving = step("commit", { message });
  reply(plan({ steps: [saving, step("push")], summary: "Guardar todo", rationale: "Guardar ambos archivos" }));
  scopeReplies.push({ scope: "selected", paths: ["picked.txt"] });
  const approved = await service.planAction(path, "Guarda solo picked.txt y publica. Deja other.txt pendiente.");
  assert.equal(approved.allowed, true, approved.rationale);
  assert.equal(approved.requiresConfirmation, true);
  assert.deepEqual(approved.steps[0].paths, ["picked.txt"]);
  assert.deepEqual(approved.selection.changes.map(change => change.path), ["picked.txt"]);
  assert.doesNotMatch(approved.rationale, /ambos/);
  const result = await service.executePlan(path, approved);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ["completed", "completed"]);
  assert.equal(run("show", "-s", "--format=%s", "HEAD"), message);
  assert.equal(run("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "picked.txt");
  assert.equal(run("diff", "--cached", "--name-only"), "other.txt");
  assert.equal(run("rev-parse", "origin/main"), run("rev-parse", "HEAD"));
  assert.doesNotMatch(scopeRequests[0].input, /picked contents|unrelated staged contents/);
});

test("una selección explícita ausente o ambigua no se amplía a los archivos pendientes", async t => {
  const path = mkdtempSync(join(tmpdir(), "gitcat-assistant-missing-selection-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  execFileSync("git", ["clone", "-q", repo, path]);
  writeFileSync(join(path, "unrelated.txt"), "leave pending\n");
  const saving = step("commit", { message: "Guardar muestra" });
  reply(plan({ steps: [{ ...saving, paths: ["missing.txt"] }] }));
  const exact = await service.planAction(path, "Guarda solo missing.txt");
  assert.equal(exact.allowed, false);
  assert.deepEqual(exact.steps, []);
  assert.equal(scopeRequests.length, 0);
  reply(plan({ steps: [saving, { ...saving, paths: ["unrelated.txt"] }] }));
  const later = await service.planAction(path, "Primero guarda todo y después guarda únicamente unrelated.txt");
  assert.equal(later.allowed, false);
  assert.deepEqual(later.steps, []);
  assert.equal(scopeRequests.length, 0);
  reply(plan({ steps: [saving] }));
  scopeReplies.push({ scope: "unclear", paths: [] });
  const ambiguous = await service.planAction(path, "Guarda solo el archivo del que hablamos");
  assert.equal(ambiguous.allowed, false);
  assert.match(ambiguous.rationale, /Indica sus nombres/);
  assert.equal(readFileSync(join(path, "unrelated.txt"), "utf8"), "leave pending\n");
});

test("git_command sin argv vuelve al modelo como incidencia estructurada", async () => {
  reply(plan({
    intent: "git_operation",
    steps: [step("git_command")],
    summary: "…", rationale: "…", risk: "high"
  }));
  reply(plan({ intent: "out_of_scope", summary: "Sin comando", reply: "No puedo planificar eso sin el comando." }));
  const result = await service.planAction(repo, "haz algo raro");
  assert.equal(requests.length, 2);
  assert.match(requests[1].instructions, /git_command needs the full command/);
  assert.equal(result.allowed, false);
});

test("una lectura se contesta en el mismo turno, mientras un push sigue necesitando confirmación", async () => {
  const before = await service.getSnapshot(repo);
  reply(plan({
    intent: "git_operation",
    steps: [step("git_command", {}, ["rev-list", "--count", "HEAD"])],
    summary: "Hay 99 commits", reply: "Hay 99 commits."
  }));
  reply("Hay 99 commits.");
  const reading = await service.planAction(repo, "¿Cuántos commits hay en la rama activa?");
  assert.equal(reading.allowed, true, reading.rationale);
  assert.equal(reading.requiresConfirmation, false);
  assert.match(reading.answer, new RegExp(`^En esta copia, Git cuenta ${git("rev-list", "--count", "HEAD").trim()} commits? en el historial de main\\.$`));
  assert.doesNotMatch(JSON.stringify(reading), /99 commits/);
  assert.deepEqual(reading.steps, []);
  assert.equal(requests.length, 1, "no hay una síntesis del proveedor después de la lectura");
  assert.equal(coverageRequests.length, 1);
  assert.deepEqual(JSON.parse(coverageRequests[0].input).plannedReads, [{ kind: "git", argv: ["rev-list", "--count", "HEAD"] }]);
  assert.equal(queue.length, 1);
  queue.length = 0;
  assert.equal((await service.getSnapshot(repo)).stateId, before.stateId);

  reply(plan({
    intent: "git_operation",
    steps: [step("git_command", {}, ["push", "--no-verify"])],
    summary: "Push sin verificaciones", rationale: "…", risk: "high"
  }));
  const writing = await service.planAction(repo, "push it with --no-verify");
  assert.equal(writing.requiresConfirmation, true, "escribir siempre pasa por la tarjeta");
  assert.equal(writing.steps[0].command, "git push --no-verify");
  assert.equal(writing.steps[0].risk, "high");
});

test("una investigación conserva cada lectura y diferencia un resultado vacío de un fallo", async () => {
  reply(plan({
    intent: "answer",
    reads: [
      { kind: "git", args: ["log", "--diff-filter=A", "--follow", "--format=%an <%ae> %ad", "--", "README.md"] },
      { kind: "git", args: ["log", "--diff-filter=D", "--format=%an <%ae> %ad", "--", "README.md"] },
      { kind: "git", args: ["rev-list", "--count", "refs/heads/missing"] }
    ]
  }));
  const result = await service.planAction(repo, "investiga quién creó README.md, cuándo y quién lo eliminó");
  assert.equal(result.allowed, true, result.rationale);
  assert.equal(result.requiresConfirmation, false);
  assert.match(result.answer, /Prueba Uno/);
  assert.match(result.answer, /Git no encontró coincidencias/);
  assert.match(result.answer, /Git no pudo completar esta comprobación/);
  assert.doesNotMatch(result.answer, /--diff-filter/);
  assert.match(result.answerDetails, /--diff-filter=D/);
  assert.match(result.answerDetails, /refs\/heads\/missing/);
  assert.equal(requests.length, 1);
});

test("una respuesta sin evidencia reintenta la lectura y no acepta una operación de escritura", async () => {
  const before = await service.getSnapshot(repo);
  reply(plan({ intent: "answer", reply: "La rama activa es falsa." }));
  reply(plan({ intent: "git_operation", steps: [step("create_branch", { name: "falsa" })] }));
  const result = await service.planAction(repo, "¿En cuál rama estoy?");
  assert.match(result.answer, /verificar la respuesta/);
  assert.doesNotMatch(JSON.stringify(result), /falsa/);
  assert.deepEqual(result.steps, []);
  assert.match(requests[1].instructions, /cannot verify free-form reply text/);
  assert.equal((await service.getSnapshot(repo)).stateId, before.stateId);
});

test("una lectura rechaza argumentos de escritura y formatos que imprimen afirmaciones del modelo", async () => {
  for (const args of [["push"], ["log", "-1", "--format=Hay 99 commits"]]) {
    reply(plan({ intent: "answer", reads: [{ kind: "git", args }] }));
    reply(plan({ intent: "answer", reads: [{ kind: "git", args: ["rev-list", "--count", "HEAD"] }] }));
    const result = await service.planAction(repo, "¿Cuántos commits hay?");
    assert.match(result.answer, new RegExp(`^En esta copia, Git cuenta ${git("rev-list", "--count", "HEAD").trim()} commits? en el historial de main\\.$`));
    assert.equal(result.requiresConfirmation, false);
  }
  assert.equal(requests.length, 4);
});

test("la comparación separa árboles iguales, parches equivalentes e historial distinto", async t => {
  const path = mkdtempSync(join(tmpdir(), "gitcat-compare-branches-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const run = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.name", "QA");
  run("config", "user.email", "qa@example.test");
  run("commit", "-qm", "base", "--allow-empty");
  run("branch", "contained");
  run("switch", "-qc", "same-files");
  writeFileSync(join(path, "fix.txt"), "fix\n");
  run("add", "fix.txt");
  run("commit", "-qm", "patch on the source");
  run("switch", "-q", "main");
  run("cherry-pick", "--no-commit", "same-files");
  run("commit", "-qm", "the same patch with a different identity");
  assert.notEqual(run("rev-parse", "main"), run("rev-parse", "same-files"));
  assert.equal(run("rev-parse", "main^{tree}"), run("rev-parse", "same-files^{tree}"));
  run("branch", "target-with-extra");
  run("switch", "-q", "target-with-extra");
  writeFileSync(join(path, "extra.txt"), "extra\n");
  run("add", "extra.txt");
  run("commit", "-qm", "unrelated patch on target");
  run("switch", "-qc", "unmatched", "contained");
  writeFileSync(join(path, "pending.txt"), "pending\n");
  run("add", "pending.txt");
  run("commit", "-qm", "new patch on source");
  const before = await service.getSnapshot(path);
  reply(plan({ intent: "answer", reads: [
    { kind: "compare_branches", args: ["main"] },
    { kind: "compare_branches", args: ["target-with-extra", "same-files"] }
  ], reply: "Hay trabajo pendiente en todas las ramas." }));
  const result = await service.planAction(path, "¿Qué ramas tienen cambios que aún no llegaron a los destinos?");
  assert.match(result.answer, /^2 de 4 ramas locales/);
  assert.match(result.answer, /Conviene revisar .*unmatched/);
  assert.match(result.answerDetails, /contained — La rama de destino ya contiene este historial/);
  assert.match(result.answerDetails, /same-files — Los archivos de ambas puntas son idénticos/);
  assert.match(result.answerDetails, /unmatched — Parches sin equivalente individual: 1/);
  assert.match(result.answerDetails, /same-files — Git encontró parches equivalentes.*versiones actuales de los archivos difieren/);
  assert.doesNotMatch(result.answer, /en todas las ramas/);
  assert.equal(result.requiresConfirmation, false);
  assert.equal(requests.length, 1);
  assert.equal((await service.getSnapshot(path)).stateId, before.stateId);
});

test("el último merge usa su primer padre, se responde en el turno y conserva el repositorio", async (t) => {
  const path = mkdtempSync(join(tmpdir(), "gitcat-last-merge-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const run = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.name", "QA");
  run("config", "user.email", "qa@example.test");
  run("commit", "-qm", "base", "--allow-empty");
  run("switch", "-qc", "feature/retry");
  writeFileSync(join(path, "retry.txt"), "reintentar\n");
  run("add", "retry.txt");
  run("commit", "-qm", "Añadir reintentos");
  run("switch", "-q", "main");
  run("merge", "-q", "--no-ff", "feature/retry", "-m", "Integrar reintentos");
  const merge = run("rev-parse", "HEAD");
  run("commit", "-qm", "un commit posterior", "--allow-empty");
  const before = await service.getSnapshot(path);

  reply(plan({ intent: "answer", reads: [{ kind: "commit", args: ["latest_merge"] }] }));
  const result = await service.planAction(path, "que trajo este ultimo merge?", [], "es");
  assert.match(result.answer, /^La última fusión de main .* incorporó un commit y cambió un archivo/);
  assert.match(result.answerDetails, /primer padre\): 1/);
  assert.equal(result.answerCommit.hash, merge);
  assert.equal(result.requiresConfirmation, false);
  assert.match(result.answer, /Añadir reintentos[\s\S]*retry\.txt/);
  assert.doesNotMatch(result.answer, /un commit posterior/);
  assert.equal(requests.length, 1);
  assert.equal((await service.getSnapshot(path)).stateId, before.stateId);

  writeFileSync(join(path, "retry.txt"), "reintentar en el directorio de trabajo\n");
  reply(plan({ intent: "answer", reads: [{ kind: "commit", args: ["latest_merge", "main", "reintentar"] }] }));
  const excerpt = await service.planAction(path, "¿Qué cambió con los reintentos en la última fusión?");
  assert.match(excerpt.answer, /Añadido · reintentar\n?$/);
  assert.match(excerpt.answerDetails, /diff --git a\/retry\.txt b\/retry\.txt\n\+reintentar/);
  assert.doesNotMatch(excerpt.answerDetails, /directorio de trabajo/);
  assert.equal(excerpt.answerCommit.hash, merge);
  assert.equal(excerpt.localAnswer, true);
  run("restore", "--", "retry.txt");

  reply(plan({ intent: "answer", reads: [{ kind: "file_history", args: ["first_addition", "retry.txt"] }] }));
  const file = await service.planAction(path, "¿Quién añadió retry.txt y cuándo?");
  const [hash, day] = run("log", "-1", "--format=%h %as", "--", "retry.txt").split(" ");
  assert.equal(file.answer, `QA añadió retry.txt el ${day} en el commit ${hash}.`);
  assert.match(file.answerDetails, /Añadir reintentos/);

  const parent = mkdtempSync(join(tmpdir(), "gitcat-shallow-merge-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const shallow = join(parent, "clone");
  run("branch", "shallow-tip", merge);
  run("clone", "-q", "--branch", "shallow-tip", "--depth=1", pathToFileURL(path).href, shallow);
  reply(plan({ intent: "answer", reads: [
    { kind: "git", args: ["rev-list", "--count", "HEAD"] },
    { kind: "commit", args: ["latest_merge"] },
    { kind: "file_history", args: ["first_addition", "retry.txt"] }
  ] }));
  const partial = await service.planAction(shallow, "¿Cuántos commits tiene toda la historia, cuál fue su merge y cuándo apareció retry.txt?");
  assert.match(partial.answer, /Git cuenta 1 commit[s]? en el historial de shallow-tip.*historial superficial/);
  assert.match(partial.answer, /no puede confirmar cuál fue la última fusión/);
  assert.match(partial.answer, /No puedo comprobar cuándo apareció por primera vez retry\.txt/);
  assert.equal((await service.getSnapshot(shallow)).isShallow, true);
  assert.equal(partial.answerCommit, undefined);
});

test("las lecturas distinguen una rama sin commits, los conteos filtrados y el nombre histórico de un archivo", async t => {
  const path = mkdtempSync(join(tmpdir(), "gitcat-answer-history-coverage-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const run = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "trunk");
  run("config", "user.name", "QA");
  run("config", "user.email", "qa@example.test");
  reply(plan({ intent: "answer", reads: [{ kind: "git", args: ["rev-list", "--count", "trunk"] }] }));
  const unborn = await service.planAction(path, "¿Cuántos commits hay en trunk?");
  assert.equal(unborn.answer, "Aún no hay commits en trunk.");
  assert.equal(unborn.requiresConfirmation, false);
  writeFileSync(join(path, "antiguo [1].txt"), "base\n");
  run("add", "--", "antiguo [1].txt");
  run("commit", "-qm", "crear");
  const creation = run("rev-parse", "--short", "HEAD");
  run("switch", "-qc", "change");
  run("mv", "--", "antiguo [1].txt", "vigente [2].txt");
  run("commit", "-qm", "renombrar");
  run("switch", "-q", "trunk");
  run("merge", "-q", "--no-ff", "change", "-m", "integrar");
  reply(plan({ intent: "answer", reads: [
    { kind: "git", args: ["rev-list", "--no-merges", "--count", "HEAD", "--"] },
    { kind: "commit_count", args: ["--all", "all"] },
    { kind: "commit_count", args: ["trunk", "merges"] },
    { kind: "file_history", args: ["first_addition", "vigente [2].txt"] }
  ] }));
  const result = await service.planAction(path, "¿Cuántos commits hay y quién añadió el archivo renombrado?");
  assert.match(result.answer, /2 commits en el historial de trunk, sin contar las fusiones/);
  assert.match(result.answer, /3 commits entre las referencias de esta copia/);
  assert.match(result.answer, /1 fusión en el historial de trunk/);
  assert.match(result.answer, /QA añadió antiguo \[1\]\.txt/);
  assert.match(result.answer, /Git llegó a ese nombre al seguir el historial de vigente \[2\]\.txt/);
  assert.ok(result.answer.includes(creation));
});

test("una lectura inválida conserva los resultados válidos aunque el proveedor no logre repararla", async () => {
  reply(plan({ intent: "answer", reads: [
    { kind: "commit_count", args: ["HEAD", "all"] },
    { kind: "git", args: ["push"] }
  ] }));
  reply(plan({ intent: "out_of_scope", reply: "Fallo inventado." }));
  coverageReplies.push({ reads: [], uncovered: true });
  const result = await service.planAction(repo, "¿Cuántos commits hay y cuál es la URL de push?");
  assert.match(result.answer, /Git cuenta \d+ commits? en el historial de main/);
  assert.match(result.answer, /Parte de la pregunta quedó sin verificar/);
  assert.doesNotMatch(result.answer, /Fallo inventado/);
  assert.match(requests[1].instructions, /reads\[1\]/);
  assert.deepEqual(result.steps, []);
  assert.equal(result.requiresConfirmation, false);
});

test("la respuesta distingue el índice y el directorio de trabajo y lee las URL efectivas", async t => {
  const path = mkdtempSync(join(tmpdir(), "gitcat-answer-repository-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const run = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.name", "QA");
  run("config", "user.email", "qa@example.test");
  for (const name of ["both", "staged", "unstaged"]) writeFileSync(join(path, name), "base\n");
  run("add", "-A");
  run("commit", "-qm", "base");
  for (const name of ["both", "staged"]) writeFileSync(join(path, name), "staged\n");
  run("add", "both", "staged");
  for (const name of ["both", "unstaged", "new"]) writeFileSync(join(path, name), "worktree\n");
  run("remote", "add", "origin", "https://example.test/fetch/repo.git");
  run("config", "url.ssh://example.test/.pushInsteadOf", "https://example.test/");
  const before = await service.getSnapshot(path);
  reply(plan({ intent: "answer", reads: [{ kind: "repository", args: ["working_tree", "remotes"] }] }));
  const result = await service.planAction(path, "¿Qué archivos están preparados y qué URL usaría para publicar?");
  assert.match(result.answer, /Preparados para el próximo commit \(2\)\nboth, staged/);
  assert.match(result.answer, /Con cambios que aún no están preparados \(2\)\nboth, unstaged/);
  assert.match(result.answer, /Archivos nuevos que Git aún no sigue \(1\)\nnew/);
  assert.match(result.answer, /Para traer cambios de origin: https:\/\/example\.test\/fetch\/repo\.git/);
  assert.match(result.answer, /Para publicar en origin: ssh:\/\/example\.test\/fetch\/repo\.git/);
  assert.equal(result.localAnswer, true, "effective URLs stay out of provider follow-ups");
  assert.equal(result.requiresConfirmation, false);
  assert.equal((await service.getSnapshot(path)).stateId, before.stateId);
});

test("la revisión recupera partes omitidas aunque las lecturas originales sean válidas", async t => {
  const path = mkdtempSync(join(tmpdir(), "gitcat-answer-coverage-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const run = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Merge Author");
  run("config", "user.email", "qa@example.test");
  run("commit", "--allow-empty", "-qm", "base");
  run("switch", "-qc", "feature");
  writeFileSync(join(path, "largest.txt"), "private-contents\nline two\nline three\n");
  writeFileSync(join(path, "small.txt"), "one line\n");
  run("add", "-A");
  run("commit", "-qm", "change");
  run("switch", "-q", "main");
  run("merge", "--no-ff", "feature", "-qm", "integrate");
  const time = run("show", "-s", "--format=%cI", "HEAD");
  const question = "¿Cuántos commits hay sin fusiones, quién hizo la última fusión, cuándo y qué archivo ganó más líneas?";
  const original = { kind: "commit_count", args: ["main", "no_merges"] };
  reply(plan({ intent: "answer", reads: [original] }));
  coverageReplies.push({ reads: [
    original,
    { kind: "commit_identity", args: ["latest_merge", "main"] },
    { kind: "commit_lines", args: ["latest_merge", "main"] }
  ], uncovered: false });
  const before = (await service.getSnapshot(path)).stateId;
  const answer = await service.planAction(path, question, [{ role: "user", content: "Cuéntame sobre older-topic-ignored." }]);
  assert.equal((answer.answer.match(/2 commits/g) ?? []).length, 1);
  assert.ok(answer.answer.includes(`tiene como autor a Merge Author y se registró el ${time}`));
  assert.match(answer.answer, /Más líneas añadidas: largest\.txt \(\+3\)/);
  assert.doesNotMatch(answer.answer, /sin verificar|No pude revisar/);
  assert.equal(answer.requiresConfirmation, false);
  assert.equal((await service.getSnapshot(path)).stateId, before);
  assert.equal(coverageRequests.length, 1);
  assert.equal(JSON.parse(coverageRequests[0].input).question, question);
  assert.doesNotMatch(coverageRequests[0].input, /private-contents|largest\.txt|older-topic-ignored/);
});

test("la revisión no convierte una pregunta en acción y conserva las lecturas ante un fallo del proveedor", async () => {
  const read = { kind: "repository", args: ["active_branch"] };
  reply(plan({ intent: "answer", reads: [read] }));
  coverageReplies.push({ reads: [
    { kind: "git", args: ["push"] },
    { kind: "repository", args: ["active_branch", "working_tree"] }
  ], uncovered: false });
  const question = "¿En qué rama estoy y qué cambios tengo pendientes?";
  const result = await service.planAction(repo, question);
  assert.equal((result.answer.match(/La rama activa/g) ?? []).length, 1);
  assert.match(result.answer, /No tienes cambios sin guardar/);
  assert.match(result.answer, /Parte de la pregunta quedó sin verificar/);
  assert.deepEqual(result.steps, []);
  assert.equal(result.requiresConfirmation, false);

  reply(plan({ intent: "answer", reads: [read] }));
  coverageReplies.push(new Error("offline"));
  const fallback = await service.planAction(repo, question);
  assert.match(fallback.answer, /La rama activa es main/);
  assert.match(fallback.answer, /No pude revisar si estas lecturas cubren toda la pregunta/);
  assert.equal(fallback.assistantUnavailable, undefined);
});

test("“merge this branch to main” se planifica y se ejecuta de principio a fin", async () => {
  git("switch", "-c", "feature/x");
  writeFileSync(join(repo, "feature.txt"), "trabajo\n");
  git("add", "-A");
  git("commit", "-m", "trabajo de la rama");

  reply(plan({
    intent: "git_operation",
    steps: [step("checkout", { name: "main" }), step("merge", { name: "feature/x" })],
    summary: "Switch to main, then merge feature/x", rationale: "Merging needs main to be the active branch first.", risk: "high"
  }));
  const result = await service.planAction(repo, "merge this branch to main");
  assert.equal(requests.length, 1, "una sola pasada al modelo planifica toda la secuencia");
  assert.equal(result.allowed, true);
  assert.deepEqual(result.steps.map((item) => item.command), ["git switch main", "git merge --no-edit -- feature/x"]);
  assert.equal(result.command, "git switch main && git merge --no-edit -- feature/x");

  const execution = await service.executePlan(repo, result);
  assert.equal(execution.error, undefined, execution.error);
  assert.deepEqual(execution.outcomes.map((item) => item.status), ["completed", "completed"]);
  assert.equal(execution.snapshot.currentBranch, "main");
  assert.match(execution.output, /Switched to branch 'main'/);
  assert.match(execution.output, /feature\.txt/, "el resultado del merge se ve, no queda en silencio");
  assert.equal(git("log", "-1", "--pretty=%s").trim(), "trabajo de la rama", "main recibió el trabajo de la rama");
});

test("el menú contextual prepara fusionar la rama elegida en la rama por defecto", async () => {
  git("switch", "-c", "feature/context-menu");
  writeFileSync(join(repo, "context-menu.txt"), "trabajo desde el menú\n");
  git("add", "-A");
  git("commit", "-m", "trabajo desde el menú");

  const result = await service.prepareMergeToDefault(repo, "feature/context-menu");
  assert.equal(result.summary, "Merge feature/context-menu to main");
  assert.deepEqual(result.steps.map((item) => item.command), ["git switch main", "git merge --no-edit -- feature/context-menu"]);

  const execution = await service.executePlan(repo, result);
  assert.equal(execution.error, undefined, execution.error);
  assert.equal(execution.snapshot.currentBranch, "main");
  assert.match(execution.output, /context-menu\.txt/);
  assert.equal(git("log", "-1", "--pretty=%s").trim(), "trabajo desde el menú");
});

test("el menú contextual no prepara una fusión vacía cuando la rama ya está integrada", async () => {
  const work = mkdtempSync(join(tmpdir(), "gitcat-empty-merge-"));
  const run = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" });
  run("init", "-b", "main");
  run("config", "user.email", "prueba@example.com");
  run("config", "user.name", "Prueba Uno");
  writeFileSync(join(work, "README.md"), "hola\n");
  run("add", "-A");
  run("commit", "-m", "primer commit");
  run("switch", "-c", "feature/empty");

  const result = await service.prepareMergeToDefault(work, "feature/empty");
  assert.equal(result.allowed, false);
  assert.match(result.rationale, /ya está integrada en main/);
  assert.match(result.summary, /Nothing to merge/);
});

test("una fusión desde una rama sucia deja que el modelo decida si debe confirmar antes", async () => {
  const work = mkdtempSync(join(tmpdir(), "gitcat-dirty-merge-"));
  const run = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" });
  run("init", "-b", "main");
  run("config", "user.email", "prueba@example.com");
  run("config", "user.name", "Prueba Uno");
  writeFileSync(join(work, "README.md"), "hola\n");
  run("add", "-A");
  run("commit", "-m", "primer commit");
  run("switch", "-c", "feature/dirty");
  writeFileSync(join(work, "dirty.txt"), "cambio pendiente\n");

  reply(plan({
    intent: "git_operation",
    steps: [step("commit"), step("checkout", { name: "main" }), step("merge", { name: "feature/dirty" })],
    summary: "Commit the pending work, then merge feature/dirty to main",
    rationale: "The current branch has uncommitted work that belongs in the merge.",
    risk: "high"
  }));
  reply("Añade el cambio pendiente");
  const result = await service.planAction(work, "Merge feature/dirty to main", [], "en", true);
  assert.equal(requests.length, 2, "el modelo ve la petición y el diff se usa para escribir el commit");
  assert.match(requests[0].instructions, /workingTreeDiff/);
  assert.match(requests[0].instructions, /dirty\.txt/);
  assert.deepEqual(result.steps.map((item) => item.command), [
    'git add -A && git commit -m "Añade el cambio pendiente"',
    "git switch main",
    "git merge --no-edit -- feature/dirty"
  ]);

  const execution = await service.executePlan(work, result);
  assert.equal(execution.error, undefined, execution.error);
  assert.equal(execution.snapshot.currentBranch, "main");
  assert.equal(run("show", "main:dirty.txt"), "cambio pendiente\n");
});

test("una secuencia sigue anclada al estado que la creó: si el repositorio se movió, no se ejecuta", async () => {
  git("switch", "main");
  reply(plan({
    intent: "git_operation",
    steps: [step("status"), step("fetch")],
    summary: "Ver y actualizar", rationale: "…", risk: "low"
  }));
  const result = await service.planAction(repo, "mira el estado y trae los remotos");
  assert.equal(result.steps.length, 2);
  writeFileSync(join(repo, "movido.txt"), "el repositorio cambió después de planificar\n");
  await assert.rejects(() => service.executePlan(repo, result), /Los cambios locales variaron|El repositorio cambió/);
});

test("un paso que Git rechaza detiene el plan y nombra los pasos no ejecutados", async () => {
  git("switch", "main");
  const plans = await service.prepareOperation(repo, "status");
  // Una secuencia armada a mano: el segundo paso es imposible porque ya se borró la rama en el primero.
  const sequence = {
    ...plans,
    steps: [
      { operation: "delete_branch", args: { name: "feature/x" }, command: "git branch -d feature/x", summary: "Eliminar la rama feature/x", risk: "high" },
      { operation: "checkout", args: { name: "feature/x" }, command: "git switch feature/x", summary: "Cambiar a feature/x", risk: "medium" },
      { operation: "fetch", args: {}, command: "git fetch --prune", summary: "Actualizar referencias remotas", risk: "low" }
    ]
  };
  const execution = await service.executePlan(repo, sequence);
  assert.deepEqual(execution.outcomes.map((item) => item.status), ["completed", "failed", "skipped"]);
  assert.match(execution.error, /Se completaron 1 de 3 pasos/);
  assert.match(execution.error, /no existe localmente/);
  assert.match(execution.error, /No se ejecutó: Actualizar referencias remotas/);
  assert.match(execution.output, /✓ Eliminar la rama feature\/x/);
  assert.match(execution.output, /· Actualizar referencias remotas/);
});

test("una rama se distingue si está solo en local, solo en el remoto o en ambos", async () => {
  const origin = mkdtempSync(join(tmpdir(), "gitcat-origin-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: origin, encoding: "utf8" });
  const clone = mkdtempSync(join(tmpdir(), "gitcat-clone-"));
  const local = (...args) => execFileSync("git", args, { cwd: clone, encoding: "utf8" });
  local("init", "-b", "main");
  local("config", "user.email", "prueba@example.com");
  local("config", "user.name", "Prueba Uno");
  writeFileSync(join(clone, "README.md"), "hola\n");
  local("add", "-A");
  local("commit", "-m", "primer commit");
  local("remote", "add", "origin", origin);
  local("push", "-u", "origin", "main");
  local("switch", "-c", "solo-local");
  local("switch", "-c", "solo-remota");
  local("push", "-u", "origin", "solo-remota");
  local("switch", "main");
  local("branch", "-D", "solo-remota");

  const snapshot = await service.getSnapshot(clone);
  const byName = new Map(snapshot.branches.map((branch) => [branch.name, branch]));
  assert.equal(byName.get("main").presence, "both");
  assert.equal(byName.get("main").remoteRef, "origin/main");
  assert.equal(byName.get("solo-local").presence, "local");
  assert.equal(byName.get("solo-local").remoteRef, undefined);
  assert.equal(byName.get("solo-remota").presence, "remote", "la rama que solo vive en el remoto sigue siendo visible");
  assert.equal(byName.get("solo-remota").remoteRef, "origin/solo-remota");
  assert.equal(snapshot.branches.some((branch) => branch.name === "HEAD"), false, "origin/HEAD no es una rama");

  // Se puede cambiar a ella (Git crea la local), pero no fusionarla ni borrarla sin tenerla en local.
  const checkout = await service.prepareOperation(clone, "checkout", { name: "solo-remota" });
  assert.equal(checkout.allowed, true);
  await assert.rejects(() => service.prepareOperation(clone, "merge", { name: "solo-remota" }), /solo existe en el remoto/);
  await assert.rejects(() => service.prepareOperation(clone, "delete_branch", { name: "solo-remota" }), /solo existe en el remoto/);
});

test("pedir un commit no pregunta el mensaje: se escribe a partir del diff real", async () => {
  git("switch", "main");
  writeFileSync(join(repo, "auto.txt"), "algo que confirmar\n");

  reply(plan({
    intent: "git_operation",
    steps: [step("commit"), step("push")],
    summary: "Commit and push", rationale: "El usuario pidió confirmar y subir.", risk: "high"
  }));
  reply("Añade auto.txt con el contenido inicial");
  const result = await service.planAction(repo, "haz commit de lo que hay y súbelo", [], "es", true);

  assert.equal(result.allowed, true, result.rationale);
  assert.equal(result.kind, "plan", "no debe preguntar por el mensaje");
  assert.equal(result.steps[0].args.message, "Añade auto.txt con el contenido inicial");
  assert.match(result.steps[0].command, /git add -A && git commit -m "Añade auto\.txt con el contenido inicial"/);
  assert.match(requests[1].input, /Working tree diff:/, "el mensaje sale del diff, no de los nombres de archivo");
  assert.match(requests[1].input, /auto\.txt/);

  git("checkout", "--", ".");
  rmSync(join(repo, "auto.txt"), { force: true });
});

test("un commit planificado sin cambios locales lo dice en vez de inventar un mensaje", async () => {
  // Repositorio propio: los tests anteriores dejan cambios sin confirmar en el compartido.
  const clean = mkdtempSync(join(tmpdir(), "gitcat-limpio-"));
  const pristine = (...args) => execFileSync("git", args, { cwd: clean, encoding: "utf8" });
  pristine("init", "-b", "main");
  pristine("config", "user.email", "prueba@example.com");
  pristine("config", "user.name", "Prueba Uno");
  writeFileSync(join(clean, "README.md"), "hola\n");
  pristine("add", "-A");
  pristine("commit", "-m", "primer commit");

  reply(plan({ intent: "git_operation", steps: [step("commit")], summary: "Commit", rationale: "…", risk: "high" }));
  const result = await service.planAction(clean, "haz commit");
  assert.equal(result.allowed, false);
  assert.equal(result.kind, "question");
  assert.match(result.rationale, /No hay cambios locales que confirmar/);
  assert.equal(requests.length, 1, "sin cambios no se gasta una llamada describiendo el diff");
});

test("el estado dice qué ramas ya están integradas, aunque apunten a otro commit", async () => {
  const work = mkdtempSync(join(tmpdir(), "gitcat-integradas-"));
  const run = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" });
  run("init", "-b", "main");
  run("config", "user.email", "prueba@example.com");
  run("config", "user.name", "Prueba Uno");
  writeFileSync(join(work, "README.md"), "hola\n");
  run("add", "-A");
  run("commit", "-m", "primer commit");

  // Integrada de verdad: tiene su propio commit y main lo absorbió, así que su punta ya no es main.
  run("switch", "-c", "integrada");
  writeFileSync(join(work, "integrada.txt"), "trabajo\n");
  run("add", "-A");
  run("commit", "-m", "trabajo integrado");
  run("switch", "main");
  run("merge", "--no-ff", "--no-edit", "integrada");
  // Pendiente: su commit no está en main.
  run("switch", "-c", "pendiente");
  writeFileSync(join(work, "pendiente.txt"), "sin integrar\n");
  run("add", "-A");
  run("commit", "-m", "trabajo sin integrar");
  run("switch", "main");

  const snapshot = await service.getSnapshot(work);
  const byName = new Map(snapshot.branches.map((branch) => [branch.name, branch]));
  assert.equal(snapshot.defaultBranch, "main", "sin remoto decide un nombre convencional");
  assert.deepEqual(byName.get("integrada").mergedInto, ["main"]);
  assert.deepEqual(byName.get("pendiente").mergedInto, []);
  assert.deepEqual(byName.get("main").mergedInto, [], "una rama no se declara integrada en sí misma");
  // El dato que faltaba: la punta de "integrada" no coincide con main y aun así está integrada.
  assert.notEqual(run("rev-parse", "integrada").trim(), run("rev-parse", "main").trim());
  assert.equal(byName.get("integrada").ahead, 0, "ahead/behind son contra el upstream y aquí no dicen nada");
  assert.equal(byName.get("pendiente").ahead, 0);

  // El modelo recibe la integración verificada, no solo ahead/behind.
  reply(plan({ intent: "answer", reads: [{ kind: "repository", args: ["deletable_branches"] }] }));
  const answer = await service.planAction(work, "¿qué ramas puedo borrar?");
  assert.match(answer.answer, /• integrada/);
  assert.doesNotMatch(answer.answer, /• pendiente/);
  const state = JSON.parse(requests[0].instructions.slice(requests[0].instructions.indexOf("{")));
  assert.equal(state.defaultBranch, "main");
  assert.deepEqual(state.branches.find((branch) => branch.name === "integrada").mergedInto, ["main"]);
  assert.deepEqual(state.branches.find((branch) => branch.name === "pendiente").mergedInto, []);
  assert.match(requests[0].instructions, /only establishes ancestry/);
});

test("la rama por defecto sale del HEAD que publica el remoto, no de un nombre adivinado", async () => {
  const origin = mkdtempSync(join(tmpdir(), "gitcat-origen-def-"));
  execFileSync("git", ["init", "--bare", "-b", "produccion"], { cwd: origin, encoding: "utf8" });
  const work = mkdtempSync(join(tmpdir(), "gitcat-def-"));
  const run = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" });
  run("init", "-b", "produccion");
  run("config", "user.email", "prueba@example.com");
  run("config", "user.name", "Prueba Uno");
  writeFileSync(join(work, "README.md"), "hola\n");
  run("add", "-A");
  run("commit", "-m", "primer commit");
  run("remote", "add", "origin", origin);
  run("push", "-u", "origin", "produccion");
  run("remote", "set-head", "origin", "produccion");
  // Existe una rama llamada "main" que no es la de referencia: el nombre convencional no debe ganar.
  run("branch", "main");

  const snapshot = await service.getSnapshot(work);
  assert.equal(snapshot.defaultBranch, "produccion");
  assert.equal(snapshot.defaultBranchSource, "remote_head");
  assert.equal(snapshot.branches.some((branch) => branch.name === "HEAD"), false);
});

test("la rama principal se marca para el modelo y no se puede borrar", async () => {
  const work = mkdtempSync(join(tmpdir(), "gitcat-default-protected-"));
  const run = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" });
  run("init", "-b", "main");
  run("config", "user.email", "prueba@example.com");
  run("config", "user.name", "Prueba Uno");
  writeFileSync(join(work, "README.md"), "hola\n");
  run("add", "-A");
  run("commit", "-m", "primer commit");
  run("switch", "-c", "feature/demo");

  const snapshot = await service.getSnapshot(work);
  assert.equal(snapshot.defaultBranch, "main");
  assert.equal(snapshot.defaultBranchSource, "conventional_name");
  reply(plan({ intent: "answer", reads: [{ kind: "repository", args: ["primary_branch"] }] }));
  await service.planAction(work, "¿cuál es la rama principal?");
  const state = JSON.parse(requests[0].instructions.slice(requests[0].instructions.indexOf("{")));
  assert.equal(state.defaultBranch, "main");
  assert.equal(state.defaultBranchSource, "conventional_name");
  assert.equal(state.branches.find((branch) => branch.name === "main").isDefault, true);
  await assert.rejects(() => service.prepareOperation(work, "delete_branch", { name: "main" }), /rama por defecto/);
});

test("una key que el proveedor rechaza no se guarda", async () => {
  queue.push({ ok: false, status: 401, raw: "invalid api key" });
  await assert.rejects(() => service.saveLlmConfig({ apiKey: "sk-malo", model: "otro-modelo" }), /No se guardó la configuración/);
  assert.equal(service.getLlmConfig().model, "gpt-5.6-luna");
});


test("un fallo de red conserva su causa y no cambia la configuración guardada", async () => {
  const previousConfig = service.getLlmConfig();
  const providerFetch = globalThis.fetch;
  const networkError = new Error("connection reset");
  globalThis.fetch = async () => { throw networkError; };
  try {
    await assert.rejects(
      () => service.saveLlmConfig({ apiKey: "sk-unreachable", model: "unreachable-model" }),
      (error) => {
        assert.match(error.message, /No se guardó la configuración/);
        assert.match(error.cause.message, /No se pudo contactar con el proveedor/);
        assert.equal(error.cause.cause, networkError);
        return true;
      }
    );
    assert.deepEqual(service.getLlmConfig(), previousConfig);
  } finally {
    globalThis.fetch = providerFetch;
  }
});

for (const variant of ['output-equals', 'output-separate', 'external-diff', 'pager', 'global-option', 'other-project', 'unbound-push', 'force-delete', 'outside-diff', 'pathspec-magic']) {
  test(`el asistente rechaza un comando fuera del alcance que puede comprobar: ${variant}`, async t => {
    const sentinel = join(repo, 'README.md');
    const original = readFileSync(sentinel);
    t.after(() => writeFileSync(sentinel, original));
    const dirty = Buffer.from('trabajo local sin guardar\n');
    writeFileSync(sentinel, dirty);
    const argv = {
      'output-equals': ['log', '-1', `--output=${sentinel}`],
      'output-separate': ['log', '-1', '--output', sentinel],
      'external-diff': ['diff', '--ext-diff'],
      'pager': ['grep', '--open-files-in-pager=echo', 'trabajo'],
      'global-option': ['-c', 'alias.inspect=log', 'inspect'],
      'other-project': ['-C', tmpdir(), 'branch', 'outside'],
      'unbound-push': ['--no-optional-locks', 'push', 'origin', 'main'],
      'force-delete': ['branch', '-D', 'main'],
      'outside-diff': ['diff', '--', '../other.txt', 'README.md'],
      'pathspec-magic': ['diff', '--', ':(glob)../other.txt', 'README.md']
    }[variant];
    reply(plan({ steps: [step('git_command', {}, argv)], summary: 'Inspect', rationale: 'Read only', risk: 'low' }));
    reply(plan({ intent: 'out_of_scope', summary: 'Unsupported command', reply: 'Use an operation GitCat can review.' }));
    const proposed = await service.planAction(repo, 'Inspect the project');
    assert.equal(proposed.allowed, false, proposed.rationale);
    assert.match(requests[1].instructions, /unsupported command or options/);
    await assert.rejects(service.executePlan(repo, proposed), /acción no está permitida/);
    assert.deepEqual(readFileSync(sentinel), dirty);
  });
}

test("executePlan rechaza antes de ejecutar cualquier paso un git_command de escritura sin representación tipada", async t => {
  const other = mkdtempSync(join(tmpdir(), "gitcat-other-project-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other });
  execFileSync("git", ["config", "user.name", "Other"], { cwd: other });
  execFileSync("git", ["config", "user.email", "other@example.test"], { cwd: other });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "init"], { cwd: other });

  const snapshot = await service.getSnapshot(repo);
  const forgedStep = {
    operation: "git_command",
    args: {},
    argv: ["-C", other, "branch", "sneaky"],
    command: `git -C ${other} branch sneaky`,
    summary: "Run git",
    risk: "high"
  };
  const basePlan = {
    id: "forged-plan",
    repoPath: snapshot.path,
    head: snapshot.head,
    stateId: snapshot.stateId,
    allowed: true,
    steps: [forgedStep],
    operation: "git_command",
    args: {},
    command: forgedStep.command,
    summary: "Run git",
    rationale: "forged",
    risk: "high",
    requiresConfirmation: true,
    kind: "plan",
    source: "llm"
  };

  await assert.rejects(service.executePlan(repo, basePlan, "en"), /approved as a GitCat operation or an inspection query/);
  await assert.rejects(
    service.executePlan(repo, { ...basePlan, steps: [{ ...forgedStep, assistantQuery: true }] }, "en"),
    /not supported for this project/
  );
  // Even as a second step after a valid branch creation, the unapproved git_command stops the whole plan before step 0 runs.
  const createBranchPlan = await service.prepareOperation(repo, "create_branch", { name: "never-created" }, "en");
  await assert.rejects(
    service.executePlan(repo, { ...createBranchPlan, source: "llm", steps: [createBranchPlan.steps[0], forgedStep] }, "en"),
    /approved as a GitCat operation or an inspection query/
  );
  assert.equal(execFileSync("git", ["branch", "--list", "sneaky"], { cwd: other, encoding: "utf8" }).trim(), "");
  assert.equal(execFileSync("git", ["branch", "--list", "never-created"], { cwd: repo, encoding: "utf8" }).trim(), "");
});
