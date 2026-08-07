import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tree = await import(pathToFileURL(join(root, "dist-electron/shared/branch-tree.js")));

const branch = (name) => ({ name, presence: "local", mergedInto: [], ahead: 0, behind: 0, isCurrent: false });
const branches = (...names) => names.map(branch);
const labels = (nodes) => nodes.map((node) => node.kind === "branch" ? node.branch.name : `${node.group.label} (${node.group.count})`);
const groupNamed = (built, label) => built.groups.find((group) => group.label === label);

test("el primer segmento del nombre es el grupo, y cada grupo cuenta sus ramas", () => {
  const built = tree.buildBranchTree(branches("feature/a", "fix/b", "feature/c", "backup/pre-trailer-rewrite"));
  assert.deepEqual(built.groups.map((group) => [group.label, group.count]), [["feature", 2], ["fix", 1], ["backup", 1]]);
  assert.equal(built.showHeaders, true);
});

test("las ramas sin barra forman el grupo raíz, sin etiqueta y al final", () => {
  const built = tree.buildBranchTree(branches("main", "feature/a", "demo-page-config", "fix/b"));
  const last = built.groups[built.groups.length - 1];
  assert.equal(last.kind, "root");
  assert.equal(last.label, "");
  assert.deepEqual(labels(last.children), ["main", "demo-page-config"]);
});

test("un solo grupo no lleva cabecera: no aporta nada", () => {
  assert.equal(tree.buildBranchTree(branches("feature/a", "feature/b")).showHeaders, false);
  assert.equal(tree.buildBranchTree(branches("main", "develop")).showHeaders, false);
  assert.equal(tree.buildBranchTree(branches("main", "feature/a")).showHeaders, true);
});

test("tres ramas que comparten el primer token tras el prefijo forman un subgrupo", () => {
  const built = tree.buildBranchTree(branches(
    "feature/menu-import-openai", "feature/menu-currencies-tax-control", "feature/menu-image-optimization",
    "feature/add-favicon", "feature/add-rbac", "feature/app-internationalization"
  ));
  const feature = groupNamed(built, "feature");
  // El subgrupo ocupa el sitio de su primera rama, así que un orden de entrada se conserva.
  assert.deepEqual(labels(feature.children), ["menu (3)", "feature/add-favicon", "feature/add-rbac", "feature/app-internationalization"]);
  assert.equal(feature.count, 6);
});

test("por debajo del umbral no se crea subgrupo, y el umbral es configurable", () => {
  const list = branches("feature/menu-a", "feature/menu-b", "feature/otra");
  assert.deepEqual(labels(groupNamed(tree.buildBranchTree(list), "feature").children), ["feature/menu-a", "feature/menu-b", "feature/otra"]);
  assert.deepEqual(labels(groupNamed(tree.buildBranchTree(list, { subgroupThreshold: 2 }), "feature").children), ["menu (2)", "feature/otra"]);
});

test("un subgrupo que capturaría todas las ramas del padre no discrimina nada, así que no se crea", () => {
  const built = tree.buildBranchTree(branches("feature/menu-a", "feature/menu-b", "feature/menu-c"));
  assert.deepEqual(labels(groupNamed(built, "feature").children), ["feature/menu-a", "feature/menu-b", "feature/menu-c"]);
});

test("el anidamiento se detiene en dos niveles: el panel no es un explorador de archivos", () => {
  const built = tree.buildBranchTree(branches(
    "feature/menu-import-a", "feature/menu-import-b", "feature/menu-import-c",
    "feature/menu-level-x", "feature/menu-level-y", "feature/menu-level-z", "feature/otra"
  ));
  const menu = groupNamed(built, "feature").children.find((node) => node.kind === "group").group;
  assert.equal(menu.count, 6);
  assert.equal(menu.children.every((node) => node.kind === "branch"), true);
});

test("una barra adicional delimita igual que un guion", () => {
  const built = tree.buildBranchTree(branches("feature/menu/a", "feature/menu-b", "feature/menu_c", "feature/otra"));
  assert.deepEqual(labels(groupNamed(built, "feature").children), ["menu (3)", "feature/otra"]);
});

test("el filtro busca en el nombre completo y conserva la estructura", () => {
  const built = tree.buildBranchTree(branches(
    "feature/menu-import-openai", "feature/menu-import-openai-provider", "feature/menu-level-currency",
    "fix/menu-crash", "main"
  ));
  const found = tree.filterBranchTree(built, "IMPORT");
  assert.deepEqual(found.groups.map((group) => [group.label, group.count]), [["feature", 2]]);
  // Las cabeceras no cambian al filtrar: la lista no salta mientras se escribe.
  assert.equal(found.showHeaders, built.showHeaders);
  assert.deepEqual(tree.filterBranchTree(built, "menu").groups.map((group) => group.label), ["feature", "fix"]);
  assert.deepEqual(tree.filterBranchTree(built, "nada").groups, []);
  assert.equal(tree.filterBranchTree(built, "   "), built);
});

test("una rama sabe qué grupos hay que abrir para verla", () => {
  const built = tree.buildBranchTree(branches(
    "feature/menu-import-openai", "feature/menu-level-currency", "feature/menu-image-optimization", "feature/add-rbac", "main"
  ));
  assert.deepEqual(tree.groupPathFor(built, "feature/menu-level-currency"), ["feature", "feature/menu"]);
  assert.deepEqual(tree.groupPathFor(built, "feature/add-rbac"), ["feature"]);
  assert.deepEqual(tree.groupPathFor(built, "main"), [tree.rootGroupKey]);
  assert.deepEqual(tree.groupPathFor(built, "no-existe"), []);
});

test("62 ramas mayoritariamente feature/ caben en pocas filas de primer nivel", () => {
  const many = branches(
    ...Array.from({ length: 20 }, (_, index) => `feature/menu-${index}`),
    ...Array.from({ length: 21 }, (_, index) => `feature/add-${index}`),
    ...Array.from({ length: 8 }, (_, index) => `fix/${index}`),
    ...Array.from({ length: 3 }, (_, index) => `wip/${index}`),
    "backup/pre-trailer-rewrite", "main", "develop"
  );
  const built = tree.buildBranchTree(many);
  const firstLevel = built.groups.flatMap((group) => group.kind === "prefix" ? [group] : group.children);
  assert.equal(firstLevel.length <= 10, true, `filas de primer nivel: ${firstLevel.length}`);
  assert.equal(built.groups.reduce((total, group) => total + group.count, 0), many.length);
});
