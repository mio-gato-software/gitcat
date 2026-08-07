import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stacked = await import(pathToFileURL(join(root, "dist-electron/electron/stacked-branches.js")));
const tree = await import(pathToFileURL(join(root, "dist-electron/shared/branch-tree.js")));

const branch = (name, extra = {}) => ({ name, presence: "local", mergedInto: [], ahead: 0, behind: 0, isCurrent: false, ...extra });
const rows = (nodes) => nodes.flatMap((node) => node.kind === "branch"
  ? [node.branch.name, ...node.stacked.map((item) => `  ${item.name}`)]
  : rows(node.group.children));
const allNames = (built) => built.groups.flatMap((group) => rows(group.children)).map((name) => name.trim());

test("un nombre abre a otro solo en una frontera de token", () => {
  assert.equal(stacked.opensName("feature/menu-import-openai", "feature/menu-import-openai-provider"), true);
  assert.equal(stacked.opensName("feature/menu", "feature/menu/sub"), true);
  assert.equal(stacked.opensName("feature/menu", "feature/menu_sub"), true);
  // "feature/menuitem" no continúa a "feature/menu": no hay separador donde acaba el nombre.
  assert.equal(stacked.opensName("feature/menu", "feature/menuitem"), false);
  assert.equal(stacked.opensName("feature/menu", "feature/menu"), false);
  assert.equal(stacked.opensName("feature/menu-largo", "feature/menu"), false);
});

test("cada rama propone solo su base más cercana", () => {
  const candidates = stacked.stackCandidates([
    "feature/a", "feature/a-b", "feature/a-b-c", "feature/suelta"
  ]);
  assert.deepEqual(candidates, [
    { base: "feature/a", stacked: "feature/a-b" },
    { base: "feature/a-b", stacked: "feature/a-b-c" }
  ]);
});

test("los nombres reducen los pares antes de preguntarle nada a Git", () => {
  const names = Array.from({ length: 62 }, (_, index) => `feature/rama-${index}`);
  // 62 ramas darían 3.782 pares; ninguna abre a otra en una frontera de token, así que no hay preguntas.
  assert.equal(stacked.stackCandidates(names).length, 0);
});

test("la rama que continúa a otra se dibuja dentro de ella", () => {
  const built = tree.buildBranchTree([
    branch("feature/menu-import-openai"),
    branch("feature/menu-import-openai-provider", { stackedOn: "feature/menu-import-openai" }),
    branch("feature/menu-level-currency"),
    branch("feature/menu-image-optimization")
  ]);
  assert.deepEqual(rows(built.groups[0].children), [
    "feature/menu-import-openai",
    "  feature/menu-import-openai-provider",
    "feature/menu-level-currency",
    "feature/menu-image-optimization"
  ]);
  assert.equal(built.groups[0].count, 4, "la rama anidada sigue contando");
});

test("una cadena no se aplana sobre su raíz, y ninguna rama se pierde", () => {
  const list = [
    branch("feature/a"),
    branch("feature/a-b", { stackedOn: "feature/a" }),
    branch("feature/a-b-c", { stackedOn: "feature/a-b" }),
    branch("feature/otra"), branch("feature/mas")
  ];
  const built = tree.buildBranchTree(list);
  const drawn = allNames(built);
  assert.equal(drawn.length, list.length);
  for (const item of list) assert.equal(drawn.includes(item.name), true, `falta ${item.name}`);
  // "a-b" va dentro de "a"; "a-b-c" se queda en su propio nivel en vez de fingir que continúa a "a".
  assert.deepEqual(rows(built.groups[0].children).slice(0, 3), ["feature/a", "  feature/a-b", "feature/a-b-c"]);
});

test("una base que no coincide con el filtro no arrastra su fila a la lista", () => {
  const built = tree.buildBranchTree([
    branch("feature/menu-import-openai"),
    branch("feature/menu-import-openai-provider", { stackedOn: "feature/menu-import-openai" }),
    branch("feature/otra-cosa"), branch("feature/tercera")
  ]);
  const found = tree.filterBranchTree(built, "provider");
  assert.deepEqual(allNames(found), ["feature/menu-import-openai-provider"]);
  assert.equal(found.groups[0].count, 1);
  // Si coincide la base, lo apilado que también coincide sigue dentro.
  assert.deepEqual(rows(tree.filterBranchTree(built, "openai").groups[0].children), [
    "feature/menu-import-openai", "  feature/menu-import-openai-provider"
  ]);
});

test("una rama apilada sabe qué grupos hay que abrir para verla", () => {
  const built = tree.buildBranchTree([
    branch("feature/menu-a"), branch("feature/menu-b"), branch("feature/menu-c"),
    branch("feature/menu-c-extra", { stackedOn: "feature/menu-c" }),
    branch("feature/add-otra")
  ]);
  assert.deepEqual(tree.groupPathFor(built, "feature/menu-c-extra"), ["feature", "feature/menu"]);
  assert.equal(tree.buildBranchTree([]).groups.length, 0);
});
