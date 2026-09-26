import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

/** Stubbed Responses API: never a paid call. Each request consumes the next queued answer. */
const queue = [];
globalThis.fetch = async () => {
  const next = queue.shift();
  if (!next) throw new Error("llamada al proveedor no esperada");
  return { ok: true, status: 200, text: async () => "", json: async () => ({ status: "completed", output_text: next }) };
};
queue.push("ok");
await service.saveLlmConfig({ apiKey: "sk-prueba", model: "gpt-5.6-luna" });

const resolved = (path) => `${path}: resuelto\n`;
const answerFor = (paths) => queue.push(JSON.stringify({
  resolutions: paths.map((path) => ({ path, content: resolved(path), rationale: "une los dos lados", confidence: "high" })),
  skipped: []
}));

/** A real repository stopped in a merge where every file in `files` conflicts. */
function conflictedRepository(files = ["a.txt", "b.txt"]) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gitcat-apply-")));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  for (const file of files) writeFileSync(join(repo, file), "base\n");
  git("add", "-A"); git("commit", "-qm", "base");
  git("switch", "-qc", "otra");
  for (const file of files) writeFileSync(join(repo, file), "suyo\n");
  git("commit", "-qam", "su cambio");
  git("switch", "-qc", "tercera", "main");
  for (const file of files) writeFileSync(join(repo, file), "tercero\n");
  git("commit", "-qam", "tercer cambio");
  git("switch", "-q", "main");
  for (const file of files) writeFileSync(join(repo, file), "mio\n");
  git("commit", "-qam", "mi cambio");
  try { git("merge", "otra"); } catch { /* el conflicto es lo que se provoca */ }
  const read = (file) => readFileSync(join(repo, file), "utf8");
  const unmerged = () => git("ls-files", "-u");
  return { repo, git, read, unmerged };
}

async function propose(repo, paths = ["a.txt", "b.txt"]) {
  answerFor(paths);
  return service.proposeConflictResolution(repo, "en");
}

test.beforeEach(() => { queue.length = 0; });

test("sin cambios de por medio, lo aceptado se escribe y se marca como resuelto", async () => {
  const { repo, read, unmerged } = conflictedRepository();
  const proposal = await propose(repo);
  assert.equal(typeof proposal.id, "string");
  assert.equal(proposal.repoPath, repo);
  const result = await service.applyConflictResolution(repo, proposal, ["a.txt", "b.txt"], "en");
  assert.equal(result.complete, true);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["applied", "applied"]);
  assert.equal(read("a.txt"), resolved("a.txt"));
  assert.equal(unmerged(), "");
  assert.deepEqual(result.snapshot.conflicts, []);
});

test("una edición que deja el mismo estado de conflicto no se sobrescribe", async () => {
  const { repo, read, unmerged } = conflictedRepository(["a.txt"]);
  const proposal = await propose(repo, ["a.txt"]);
  const before = unmerged();
  // Sigue siendo «UU», pero ya no es el archivo que se revisó.
  const edited = `${read("a.txt")}una línea que añadí mientras revisaba\n`;
  writeFileSync(join(repo, "a.txt"), edited);
  const result = await service.applyConflictResolution(repo, proposal, ["a.txt"], "en");
  assert.equal(result.complete, false);
  assert.equal(result.stale, "files");
  assert.deepEqual(result.outcomes, [{ path: "a.txt", status: "changed" }]);
  assert.equal(read("a.txt"), edited, "la edición se conserva");
  assert.equal(unmerged(), before, "el índice sigue en conflicto como estaba");
  assert.equal(result.snapshot.conflicts[0]?.path, "a.txt");
});

test("un índice que cambió por debajo invalida la propuesta aunque el archivo sea idéntico", async () => {
  const { repo, git, read, unmerged } = conflictedRepository(["a.txt"]);
  const proposal = await propose(repo, ["a.txt"]);
  const content = read("a.txt");
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "otro lado\n", encoding: "utf8" }).trim();
  execFileSync("git", ["update-index", "--index-info"], { cwd: repo, input: `100644 ${blob} 3\ta.txt\n` });
  assert.match(git("status", "--short"), /^UU a\.txt/, "el estado no cambia");
  const stages = unmerged();
  const result = await service.applyConflictResolution(repo, proposal, ["a.txt"], "en");
  assert.equal(result.stale, "files");
  assert.equal(read("a.txt"), content);
  assert.equal(unmerged(), stages);
});

test("una operación distinta con el mismo archivo en conflicto invalida la propuesta", async () => {
  const { repo, git, read } = conflictedRepository(["a.txt"]);
  const proposal = await propose(repo, ["a.txt"]);
  const reviewed = read("a.txt");
  git("merge", "--abort");
  try { git("merge", "tercera"); } catch { /* otro conflicto en el mismo archivo */ }
  // Incluso con los mismos bytes que se revisaron, ya es otra fusión.
  writeFileSync(join(repo, "a.txt"), reviewed);
  assert.match(git("status", "--short"), /^UU a\.txt/);
  const result = await service.applyConflictResolution(repo, proposal, ["a.txt"], "en");
  assert.equal(result.complete, false);
  assert.equal(result.stale, "operation");
  assert.equal(read("a.txt"), reviewed);
  assert.match(git("ls-files", "-u"), /a\.txt/);
});

test("si el segundo archivo ya no vale, tampoco se escribe el primero", async () => {
  const { repo, git, read, unmerged } = conflictedRepository();
  const proposal = await propose(repo);
  const firstBefore = read("a.txt");
  // El segundo se resolvió a mano mientras la propuesta estaba abierta.
  writeFileSync(join(repo, "b.txt"), "lo resolví yo\n");
  git("add", "b.txt");
  const stagesBefore = unmerged();
  const result = await service.applyConflictResolution(repo, proposal, ["a.txt", "b.txt"], "en");
  assert.equal(result.stale, "files");
  assert.deepEqual(result.outcomes, [{ path: "a.txt", status: "not_applied" }, { path: "b.txt", status: "changed" }]);
  assert.equal(read("a.txt"), firstBefore, "el primero no se tocó");
  assert.equal(read("b.txt"), "lo resolví yo\n");
  assert.equal(unmerged(), stagesBefore);
  // Una ruta que no forma parte de la propuesta se rechaza antes de escribir nada.
  await assert.rejects(service.applyConflictResolution(repo, proposal, ["a.txt", "c.txt"], "en"), /c\.txt is not part of this proposal/);
  assert.equal(read("a.txt"), firstBefore);
  // Lo que no cambió se puede seguir aceptando por separado.
  const rest = await service.applyConflictResolution(repo, proposal, ["a.txt"], "en");
  assert.equal(rest.complete, true);
  assert.equal(read("a.txt"), resolved("a.txt"));
});

test("una propuesta de otro repositorio no escribe en ninguno", async () => {
  const first = conflictedRepository(["a.txt"]);
  const second = conflictedRepository(["a.txt"]);
  const proposal = await propose(first.repo, ["a.txt"]);
  const firstBefore = first.read("a.txt");
  const secondBefore = second.read("a.txt");
  const result = await service.applyConflictResolution(second.repo, proposal, ["a.txt"], "en");
  assert.equal(result.complete, false);
  assert.equal(result.stale, "repository");
  assert.equal(result.snapshot.path, second.repo);
  assert.deepEqual(result.outcomes, [{ path: "a.txt", status: "not_applied" }]);
  assert.equal(first.read("a.txt"), firstBefore);
  assert.equal(second.read("a.txt"), secondBefore);
  assert.match(first.unmerged(), /a\.txt/);
  assert.match(second.unmerged(), /a\.txt/);
});

test("si Git no puede marcar un archivo como resuelto, el resultado lo dice archivo a archivo", async () => {
  const { repo, git, read, unmerged } = conflictedRepository();
  const proposal = await propose(repo);
  const secondBefore = read("b.txt");
  // Un filtro obligatorio que falla hace que `git add` rechace solo b.txt.
  git("config", "filter.roto.clean", "false");
  git("config", "filter.roto.required", "true");
  writeFileSync(join(repo, ".git/info/attributes"), "b.txt filter=roto\n");
  const result = await service.applyConflictResolution(repo, proposal, ["a.txt", "b.txt"], "en");
  assert.equal(result.complete, false, "una aplicación parcial nunca se presenta como completa");
  assert.equal(result.stale, undefined);
  assert.deepEqual(result.outcomes.map(({ path, status, restored }) => ({ path, status, restored })), [
    { path: "a.txt", status: "applied", restored: undefined },
    { path: "b.txt", status: "failed", restored: true }
  ]);
  assert.ok(result.outcomes[1].detail, "lo que dijo Git viaja con el fallo");
  assert.equal(read("a.txt"), resolved("a.txt"));
  assert.equal(read("b.txt"), secondBefore, "el archivo que falló se deja como estaba");
  assert.doesNotMatch(unmerged(), /\ta\.txt/);
  assert.match(unmerged(), /\tb\.txt/, "sigue en conflicto, no a medio resolver");
  assert.deepEqual(result.snapshot.conflicts.map((conflict) => conflict.path), ["b.txt"]);
});
