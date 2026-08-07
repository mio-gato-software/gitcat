import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lifecycle = await import(pathToFileURL(join(root, "dist-electron/shared/branch-lifecycle.js")));
const order = await import(pathToFileURL(join(root, "dist-electron/shared/branch-order.js")));

const day = 86_400_000;
const now = Date.parse("2026-08-06T00:00:00Z");
const branch = (name, extra = {}) => ({
  name, presence: "local", mergedInto: [], ahead: 0, behind: 0, isCurrent: false, ...extra,
  ...(extra.date ? { lastCommit: { hash: "x", shortHash: "x", subject: "", author: "", email: "", date: extra.date, refs: [] } } : {})
});

test("el prefijo declara el ciclo de vida, y lo desconocido no recibe trato especial", () => {
  assert.equal(lifecycle.lifecycleOf("backup/pre-trailer-rewrite"), "permanent");
  assert.equal(lifecycle.lifecycleOf("wip/spike"), "ephemeral");
  assert.equal(lifecycle.lifecycleOf("hotfix/crash"), "short");
  assert.equal(lifecycle.lifecycleOf("feature/menu-import-openai"), "medium");
  assert.equal(lifecycle.lifecycleOf("loquesea/cosa"), "unknown");
  assert.equal(lifecycle.lifecycleOf("main"), "unknown");
  // Mayúsculas incluidas: la política la marca el prefijo, no su grafía exacta.
  assert.equal(lifecycle.lifecycleOf("Backup/algo"), "permanent");
});

test("la tabla es dato, no código: se puede sustituir entera", () => {
  const rules = [{ prefix: "archivo", lifecycle: "permanent" }];
  assert.equal(lifecycle.lifecycleOf("archivo/2024", rules), "permanent");
  // Con otra tabla, backup/ deja de estar protegida: la política no está incrustada en la lógica.
  assert.equal(lifecycle.isProtectedBranch("backup/x", rules), false);
  assert.equal(lifecycle.isProtectedBranch("backup/x"), true);
  assert.equal(Array.isArray(lifecycle.defaultLifecycleRules), true);
});

test("backup/pre-trailer-rewrite existe para sobrevivir: nunca cuenta como mergeada", () => {
  const integrated = branch("backup/pre-trailer-rewrite", { mergedInto: ["main"] });
  assert.equal(lifecycle.isProtectedBranch(integrated.name), true);
  assert.equal(order.isMergedIntoDefault(integrated, "main"), false);
  // Una rama corriente en la misma situación sí se marca.
  assert.equal(order.isMergedIntoDefault(branch("feature/vieja", { mergedInto: ["main"] }), "main"), true);
});

test("una rama de vida corta y quieta se señala; una de vida media no", () => {
  const old = new Date(now - 40 * day).toISOString();
  assert.equal(lifecycle.staleDays(branch("fix/olvidado", { date: old }), now), 40);
  assert.equal(lifecycle.staleDays(branch("feature/lenta", { date: old }), now), 0);
  // Justo por debajo del umbral no dice nada, y la rama en la que estás tampoco.
  assert.equal(lifecycle.staleDays(branch("fix/reciente", { date: new Date(now - 3 * day).toISOString() }), now), 0);
  assert.equal(lifecycle.staleDays(branch("fix/actual", { date: old, isCurrent: true }), now), 0);
  assert.equal(lifecycle.staleDays(branch("fix/sin-fecha"), now), 0);
});
