import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(init.body));
  const next = queue.shift();
  if (!next) throw new Error("llamada al proveedor no esperada");
  return {
    ok: next.ok !== false,
    status: next.status ?? 200,
    text: async () => next.raw ?? "",
    json: async () => next.payload
  };
};
const reply = (value) => queue.push({ payload: { status: "completed", output_text: typeof value === "string" ? value : JSON.stringify(value) } });
const step = (operation, args = {}, argv = []) => ({ operation, argv, args: { name: "", onto: "", to: "", path: "", side: "", message: "", noVerify: "", ...args } });
const plan = (overrides) => ({
  intent: "git_operation",
  steps: [],
  repository: { localPath: "", repository: "", owner: "", host: "", protocol: "", sshHost: "", remote: "", push: true, replaceRemote: false },
  summary: "", rationale: "", reply: "", risk: "low",
  ...overrides
});

test.beforeEach(() => { queue.length = 0; requests.length = 0; });

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

test("una pregunta se responde con el texto del modelo sobre el estado real", async () => {
  reply(plan({ intent: "answer", summary: "Last author", reply: "Prueba Uno wrote the most recent commit on main.", rationale: "From the snapshot." }));
  const result = await service.planAction(repo, "who touched this branch last?");
  assert.equal(result.answer, "Prueba Uno wrote the most recent commit on main.");
  assert.equal(result.operation, "none");
  assert.match(requests[0].instructions, /same language as the user's latest message/);
  assert.match(requests[0].instructions, /"currentBranch": "main"/);
  assert.match(requests[0].instructions, /"author": "Prueba Uno"/);
  assert.match(requests[0].instructions, /"remembered"/, "el modelo ve lo que ya se confirmó antes");
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
  assert.match(result.rationale, /no cumple el esquema del plan/);
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

test("un push sin upstream se explica y ofrece publicar la rama por primera vez", async () => {
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
  assert.equal(recovery.steps[0].command, "git push --set-upstream origin feature/no-upstream");
  assert.equal(recovery.requiresConfirmation, true);
});

test("git_command ejecuta el comando completo que propone el modelo, sin shell", async () => {
  reply(plan({
    intent: "git_operation",
    steps: [step("git_command", {}, ["switch", "-c", "libre"])],
    summary: "Crear la rama libre", rationale: "El usuario pidió un switch -c.", risk: "high"
  }));
  const result = await service.planAction(repo, "crea la rama libre con git switch -c");
  assert.equal(result.allowed, true, result.rationale);
  assert.equal(result.steps[0].command, "git switch -c libre");
  assert.equal(result.steps[0].risk, "high");
  assert.equal(result.requiresConfirmation, true, "un comando libre que escribe siempre pasa por la tarjeta");

  const execution = await service.executePlan(repo, result);
  assert.equal(execution.error, undefined, execution.error);
  assert.equal(execution.snapshot.currentBranch, "libre");
  git("switch", "main");
  git("branch", "-d", "libre");
});

test("git_command no cuela el borrado de una rama protegida", async () => {
  reply(plan({
    intent: "git_operation",
    steps: [step("git_command", {}, ["branch", "-D", "main"])],
    summary: "Borrar main", rationale: "…", risk: "high"
  }));
  reply(plan({ intent: "needs_information", summary: "Rama protegida", reply: "main es la rama por defecto y está protegida; no puedo borrarla." }));
  const result = await service.planAction(repo, "borra main a la fuerza");
  assert.equal(requests.length, 2, "la protección vuelve al modelo como incidencia");
  assert.match(requests[1].instructions, /default branch and is protected/);
  assert.equal(result.allowed, false);
  assert.match(result.rationale, /protegida/);
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

test("un git_command de solo lectura corre sin confirmación; uno que escribe, no", async () => {
  reply(plan({
    intent: "git_operation",
    steps: [step("git_command", {}, ["log", "-1", "--format=%ad"])],
    summary: "Leer la fecha del último commit", rationale: "…", risk: "low"
  }));
  const reading = await service.planAction(repo, "¿cuándo fue el último commit?");
  assert.equal(reading.allowed, true, reading.rationale);
  assert.equal(reading.requiresConfirmation, false, "un comando de solo lectura no pide tarjeta");
  assert.equal(reading.risk, "low");

  const execution = await service.executePlan(repo, reading);
  assert.equal(execution.error, undefined, execution.error);
  assert.match(execution.output, /\d{2}:\d{2}:\d{2}/, "la salida del comando llega al usuario");

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

test("una investigación con varios comandos de solo lectura corre entera sin confirmación", async () => {
  reply(plan({
    intent: "git_operation",
    steps: [
      step("git_command", {}, ["log", "--diff-filter=A", "--follow", "--format=%an <%ae> %ad", "--", "README.md"]),
      step("git_command", {}, ["log", "--diff-filter=D", "--format=%an <%ae> %ad", "--", "README.md"])
    ],
    summary: "Consultar el historial del archivo", rationale: "El usuario pregunta quién lo creó y quién lo eliminó.", risk: "low"
  }));
  const result = await service.planAction(repo, "investiga quién creó README.md, cuándo y quién lo eliminó");
  assert.equal(result.allowed, true, result.rationale);
  assert.equal(result.requiresConfirmation, false, "investigar no pide tarjeta");
  assert.equal(result.steps.length, 2);

  const execution = await service.executePlan(repo, result);
  assert.equal(execution.error, undefined, execution.error);
  assert.deepEqual(execution.outcomes.map((item) => item.status), ["completed", "completed"]);
  assert.match(execution.output, /Prueba Uno/, "el autor del commit de creación aparece en la salida");
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
  assert.deepEqual(result.steps.map((item) => item.command), ["git switch main", "git merge --no-edit feature/x"]);
  assert.equal(result.command, "git switch main && git merge --no-edit feature/x");

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
  assert.deepEqual(result.steps.map((item) => item.command), ["git switch main", "git merge --no-edit feature/context-menu"]);

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
  const result = await service.planAction(work, "Merge feature/dirty to main");
  assert.equal(requests.length, 2, "el modelo ve la petición y el diff se usa para escribir el commit");
  assert.match(requests[0].instructions, /workingTreeDiff/);
  assert.match(requests[0].instructions, /dirty\.txt/);
  assert.deepEqual(result.steps.map((item) => item.command), [
    'git add -A && git commit -m "Añade el cambio pendiente"',
    "git switch main",
    "git merge --no-edit feature/dirty"
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
  const result = await service.planAction(repo, "haz commit de lo que hay y súbelo");

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
  reply(plan({ intent: "answer", summary: "Ramas", reply: "integrada ya está en main.", rationale: "Del estado." }));
  await service.planAction(work, "¿qué ramas puedo borrar?");
  const state = JSON.parse(requests[0].instructions.slice(requests[0].instructions.indexOf("{")));
  assert.equal(state.defaultBranch, "main");
  assert.deepEqual(state.branches.find((branch) => branch.name === "integrada").mergedInto, ["main"]);
  assert.deepEqual(state.branches.find((branch) => branch.name === "pendiente").mergedInto, []);
  assert.match(requests[0].instructions, /it is proof, not a guess/);
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
  reply(plan({ intent: "answer", summary: "Rama principal", reply: "main", rationale: "Del estado del repositorio." }));
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
