import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const order = await import(pathToFileURL(join(root, "dist-electron/shared/branch-order.js")));
const tree = await import(pathToFileURL(join(root, "dist-electron/shared/branch-tree.js")));
const worktrees = await import(pathToFileURL(join(root, "dist-electron/electron/worktrees.js")));

const branch = (name, extra = {}) => ({
  name, presence: "local", mergedInto: [], ahead: 0, behind: 0, isCurrent: false,
  ...extra,
  ...(extra.date ? { lastCommit: { hash: name, shortHash: name, subject: "", author: "", email: "", date: extra.date, refs: [] } } : {})
});
const names = (list) => list.map((item) => item.name);
const clean = { dirty: false };

test("el orden por defecto es la actividad, no el alfabético", () => {
  assert.equal(order.defaultBranchOrder, "activity");
  const list = [
    branch("a-vieja", { date: "2024-01-01T00:00:00Z" }),
    branch("z-nueva", { date: "2026-07-01T00:00:00Z" }),
    branch("m-media", { date: "2025-06-01T00:00:00Z" })
  ];
  assert.deepEqual(names(order.sortBranches(list, "activity", clean)), ["z-nueva", "m-media", "a-vieja"]);
  assert.deepEqual(names(order.sortBranches(list, "alphabetical", clean)), ["a-vieja", "m-media", "z-nueva"]);
});

test("una rama sin fecha legible baja al final en vez de encabezar lo reciente", () => {
  const list = [branch("sin-fecha"), branch("rota", { date: "no es una fecha" }), branch("con-fecha", { date: "2025-01-01T00:00:00Z" })];
  assert.deepEqual(names(order.sortBranches(list, "activity", clean))[0], "con-fecha");
});

test("«activas primero» sube lo que está en checkout, y los cambios sin confirmar mandan", () => {
  const list = [
    branch("vieja-reciente", { date: "2026-08-01T00:00:00Z" }),
    branch("en-otro-worktree", { date: "2024-01-01T00:00:00Z", checkedOutIn: "/tmp/wt" }),
    branch("actual", { date: "2023-01-01T00:00:00Z", isCurrent: true })
  ];
  assert.deepEqual(names(order.sortBranches(list, "active", { dirty: true })), ["actual", "en-otro-worktree", "vieja-reciente"]);
  // Sin cambios locales la rama actual sigue por delante de las inactivas, pero el resto se ordena por actividad.
  assert.deepEqual(names(order.sortBranches(list, "active", clean)), ["actual", "en-otro-worktree", "vieja-reciente"]);
});

test("ordenar no muta la lista que produjo el servicio", () => {
  const list = [branch("b"), branch("a")];
  assert.deepEqual(names(order.sortBranches(list, "alphabetical", clean)), ["a", "b"]);
  assert.deepEqual(names(list), ["b", "a"]);
});

test("los grupos se ordenan por la rama más reciente que contienen", () => {
  const list = [
    branch("fix/vieja", { date: "2024-01-01T00:00:00Z" }),
    branch("feature/nueva", { date: "2026-07-01T00:00:00Z" }),
    branch("fix/otra", { date: "2024-02-01T00:00:00Z" })
  ];
  const built = tree.buildBranchTree(order.sortBranches(list, "activity", clean));
  assert.deepEqual(built.groups.map((group) => group.label), ["feature", "fix"]);
});

test("está integrada quien el default ya contiene, y nunca la rama en la que estás", () => {
  assert.equal(order.isMergedIntoDefault(branch("vieja", { mergedInto: ["main"] }), "main"), true);
  assert.equal(order.isMergedIntoDefault(branch("suelta", { mergedInto: ["otra"] }), "main"), false);
  assert.equal(order.isMergedIntoDefault(branch("actual", { mergedInto: ["main"], isCurrent: true }), "main"), false);
  assert.equal(order.isMergedIntoDefault(branch("main", { mergedInto: [] }), "main"), false);
  // Sin rama por defecto resuelta no hay nada contra lo que medir la integración.
  assert.equal(order.isMergedIntoDefault(branch("vieja", { mergedInto: ["main"] }), undefined), false);
});

test("el worktree de cada rama sale del porcelain, y el repositorio abierto no se cuenta", () => {
  const raw = [
    "worktree /repo", "HEAD abc", "branch refs/heads/main", "",
    "worktree /repo/../wt-a", "HEAD def", "branch refs/heads/feature/menu-import-openai", "",
    "worktree /repo-suelto", "HEAD 123", "detached", ""
  ].join("\n");
  const found = worktrees.parseWorktrees(raw, "/repo");
  assert.deepEqual([...found], [["feature/menu-import-openai", "/wt-a"]]);
  assert.equal(found.has("main"), false);
});

test("una salida vacía o sin ramas no inventa worktrees", () => {
  assert.equal(worktrees.parseWorktrees("", "/repo").size, 0);
  assert.equal(worktrees.parseWorktrees("worktree /otro\nHEAD abc\ndetached\n", "/repo").size, 0);
  // Un registro cerrado no le presta su ruta al siguiente.
  assert.equal(worktrees.parseWorktrees("worktree /otro\nHEAD abc\n\nbranch refs/heads/suelta\n", "/repo").size, 0);
});
