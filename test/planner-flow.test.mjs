import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
const service = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));

const repo = mkdtempSync(join(tmpdir(), "branchline-repo-"));
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
const plan = (overrides) => ({
  intent: "git_operation",
  operation: "none",
  args: { name: "", onto: "", message: "" },
  repository: { localPath: "", repository: "", owner: "", host: "", protocol: "", remote: "", push: true, replaceRemote: false },
  summary: "", rationale: "", reply: "", risk: "low",
  ...overrides
});

test.beforeEach(() => { queue.length = 0; requests.length = 0; });

test("sin proveedor configurado no se interpreta nada", async () => {
  const result = await service.planAction(repo, "cámbiame a la rama main");
  assert.equal(result.allowed, false);
  assert.equal(result.source, "guardrail");
  assert.match(result.rationale, /necesita un proveedor LLM configurado/);
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
    intent: "git_operation", operation: "checkout", args: { name: "main", onto: "", message: "" },
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
});

test("el imperativo “Guarda este repositorio” llega a la creación de repositorio", async () => {
  reply(plan({
    intent: "create_repository",
    repository: { localPath: "/no/existe", repository: "mio-gato-software", owner: "eliaquin", host: "github.com", protocol: "ssh", remote: "origin", push: true, replaceRemote: false },
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
  reply(plan({ intent: "git_operation", operation: "delete_branch", args: { name: "--upload-pack=touch /tmp/x", onto: "", message: "" }, summary: "Borrar", rationale: "…", risk: "high" }));
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
  assert.match(result.rationale, /agotó el presupuesto de tokens/);
  assert.doesNotMatch(result.rationale, /plan local/);
});

test("un JSON que no cumple el esquema no activa ningún planificador local", async () => {
  reply({ allowed: true, operation: "push" });
  const result = await service.planAction(repo, "sube los cambios");
  assert.equal(result.allowed, false);
  assert.match(result.rationale, /no cumple el esquema del plan/);
});

test("el riesgo y la confirmación deterministas prevalecen sobre los del modelo", async () => {
  reply(plan({ intent: "git_operation", operation: "push", summary: "Push", rationale: "…", risk: "low" }));
  const result = await service.planAction(repo, "push it");
  assert.equal(result.risk, "high");
  assert.equal(result.requiresConfirmation, true);
});

test("una key que el proveedor rechaza no se guarda", async () => {
  queue.push({ ok: false, status: 401, raw: "invalid api key" });
  await assert.rejects(() => service.saveLlmConfig({ apiKey: "sk-malo", model: "otro-modelo" }), /No se guardó la configuración/);
  assert.equal(service.getLlmConfig().model, "gpt-5.6-luna");
});
