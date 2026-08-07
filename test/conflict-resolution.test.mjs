import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const resolution = await import(pathToFileURL(join(root, "dist-electron/electron/conflict-resolution.js")));

const proposal = (resolutions = [], skipped = []) => JSON.stringify({ resolutions, skipped });
const entry = (path, content, extra = {}) => ({ path, content, rationale: "r", confidence: "high", ...extra });

test("solo se acepta la forma exacta, como con los planes", () => {
  assert.ok(resolution.parseConflictProposal(proposal([entry("a.txt", "hola")], [])));
  // Una clave de más, una de menos o un tipo distinto no es una respuesta.
  assert.equal(resolution.parseConflictProposal('{"resolutions":[]}'), undefined);
  assert.equal(resolution.parseConflictProposal(proposal([{ path: "a", content: "x", rationale: "r" }])), undefined);
  assert.equal(resolution.parseConflictProposal(proposal([entry("a", "x", { confidence: "media" })])), undefined);
  assert.equal(resolution.parseConflictProposal(proposal([entry("a", 5)])), undefined);
  assert.equal(resolution.parseConflictProposal("no soy json"), undefined);
});

test("se extrae aunque venga envuelto en prosa o en una valla de markdown", () => {
  const wrapped = "Claro, aquí tienes:\n```json\n" + proposal([entry("a.txt", "hola")]) + "\n```\nEso es todo.";
  assert.equal(resolution.parseConflictProposal(wrapped)?.resolutions[0].path, "a.txt");
});

test("un archivo que el modelo no tenía delante no se cuela", () => {
  const validated = resolution.validateProposal(
    { resolutions: [entry("real.txt", "ok"), entry("/etc/passwd", "malo")], skipped: [] },
    ["real.txt"]
  );
  assert.deepEqual(validated.resolutions.map((item) => item.path), ["real.txt"]);
  assert.equal(validated.skipped.length, 0);
});

test("una «resolución» que aún trae marcas de conflicto no ha resuelto nada", () => {
  const marked = "uno\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> otro\n";
  const validated = resolution.validateProposal({ resolutions: [entry("a.txt", marked)], skipped: [] }, ["a.txt"]);
  assert.deepEqual(validated.resolutions, []);
  // Y no desaparece en silencio: pasa a la lista de lo que sigue sin resolver.
  assert.deepEqual(validated.skipped.map((item) => item.path), ["a.txt"]);
});

test("lo que el modelo se dejó sin contestar se reporta, no se pierde", () => {
  const validated = resolution.validateProposal(
    { resolutions: [entry("a.txt", "ok")], skipped: [{ path: "b.txt", reason: "no sé" }] },
    ["a.txt", "b.txt", "c.txt"]
  );
  assert.deepEqual(validated.resolutions.map((item) => item.path), ["a.txt"]);
  assert.deepEqual(validated.skipped.map((item) => item.path).sort(), ["b.txt", "c.txt"]);
  assert.match(validated.skipped.find((item) => item.path === "c.txt").reason, /no dijo nada/);
});

test("un archivo repetido cuenta una sola vez", () => {
  const validated = resolution.validateProposal(
    { resolutions: [entry("a.txt", "primera"), entry("a.txt", "segunda")], skipped: [] },
    ["a.txt"]
  );
  assert.equal(validated.resolutions.length, 1);
  assert.equal(validated.resolutions[0].content, "primera");
});

test("las instrucciones avisan de que en un rebase los lados van al revés", () => {
  const instructions = resolution.buildResolutionInstructions({
    operation: "rebase", branch: "feature/x", onto: "main", ours: "the base", theirs: "your commits"
  });
  assert.match(instructions, /they\nare the reverse of what people expect/);
  assert.match(instructions, /do not guess/);
  assert.match(instructions, /Never invent code that was in neither side/);
  assert.match(instructions, /set "confidence" to "low"/);
});
