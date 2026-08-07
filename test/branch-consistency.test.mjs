import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const consistency = await import(pathToFileURL(join(root, "dist-electron/shared/branch-consistency.js")));
const tree = await import(pathToFileURL(join(root, "dist-electron/shared/branch-tree.js")));

const branch = (name) => ({ name, presence: "local", mergedInto: [], ahead: 0, behind: 0, isCurrent: false });
const branches = (...names) => names.map(branch);
const many = (prefix, count) => Array.from({ length: count }, (_, index) => branch(`${prefix}/rama-${index}`));

test("una familia conocida se reconoce aunque la distancia de edición sea grande", () => {
  assert.equal(consistency.areSynonymPrefixes("feat", "feature"), true);
  assert.equal(consistency.areSynonymPrefixes("hotfix", "fix"), true);
  assert.equal(consistency.areSynonymPrefixes("chore", "chores"), true);
});

test("dos prefijos cortos y distintos no se funden por parecerse", () => {
  // "dev" y "demo" están a distancia 2 y son ideas distintas: ni uno abre al otro ni son largos.
  assert.equal(consistency.areSynonymPrefixes("dev", "demo"), false);
  assert.equal(consistency.areSynonymPrefixes("wip", "tmp"), false);
  assert.equal(consistency.areSynonymPrefixes("feature", "feature"), false);
  // Una errata en un prefijo largo sí se reconoce.
  assert.equal(consistency.areSynonymPrefixes("release", "relase"), true);
});

test("solo se sugiere cuando una grafía es claramente minoritaria", () => {
  const minority = consistency.prefixVariants([...many("feature", 41), branch("feat/uno")]);
  assert.equal(minority.length, 1);
  assert.equal(minority[0].variant, "feat");
  assert.equal(minority[0].canonical, "feature");
  assert.deepEqual(minority[0].renames, [{ from: "feat/uno", to: "feature/uno" }]);
  // Tres frente a ocho no es «claramente minoritario».
  assert.deepEqual(consistency.prefixVariants([...many("feature", 8), ...many("feat", 3)]), []);
});

test("el árbol agrupa la variante bajo la grafía mayoritaria sin renombrar la rama", () => {
  const list = [...many("feature", 41), branch("feat/uno")];
  const suggestions = consistency.branchSuggestions(list);
  const built = tree.buildBranchTree(list, { aliases: consistency.prefixAliases(suggestions) });
  assert.deepEqual(built.groups.map((group) => group.label), ["feature"]);
  assert.equal(built.groups[0].count, 42);
  const names = JSON.stringify(built);
  assert.equal(names.includes("feat/uno"), true, "la rama conserva su nombre real");
});

test("el separador solo se señala si el repo usa barras de forma dominante", () => {
  const withConvention = [...many("feature", 41), branch("demo-page-config"), branch("demo-page-improvement"), branch("main")];
  const found = consistency.separatorVariants(withConvention);
  assert.deepEqual(found.map((item) => item.token), ["demo"]);
  assert.deepEqual(found[0].renames, [
    { from: "demo-page-config", to: "demo/page-config" },
    { from: "demo-page-improvement", to: "demo/page-improvement" }
  ]);
  // Un repo sin convención de barras no recibe ninguna sugerencia.
  assert.deepEqual(consistency.separatorVariants(branches("main", "una-cosa", "otra-cosa")), []);
});

test("una sola rama con guion no es una inconsistencia, salvo que su token ya sea prefijo", () => {
  assert.deepEqual(consistency.separatorVariants([...many("feature", 41), branch("mi-experimento")]), []);
  const known = consistency.separatorVariants([...many("feature", 41), branch("feature-suelta")]);
  assert.deepEqual(known.map((item) => item.renames[0].to), ["feature/suelta"]);
});

test("las ramas reservadas nunca se proponen para renombrar", () => {
  const list = [...many("feature", 41), branch("main"), branch("master"), branch("develop"), branch("trunk")];
  const renamed = consistency.branchSuggestions(list).flatMap((item) => item.renames.map((rename) => rename.from));
  for (const reserved of ["main", "master", "develop", "trunk"]) assert.equal(renamed.includes(reserved), false);
});

test("una sugerencia descartada no vuelve", () => {
  const list = [...many("feature", 41), branch("feat/uno")];
  const [suggestion] = consistency.branchSuggestions(list);
  assert.equal(suggestion.id, "prefix:feat->feature");
  assert.deepEqual(consistency.branchSuggestions(list, [suggestion.id]), []);
});

test("el autocompletado ofrece lo que el repo ya escribe, por uso", () => {
  const list = [
    ...Array.from({ length: 5 }, (_, index) => branch(`feature/menu-${index}`)),
    ...Array.from({ length: 3 }, (_, index) => branch(`feature/add-${index}`)),
    branch("fix/algo"), branch("main")
  ];
  const completions = consistency.namingCompletions(list);
  assert.equal(completions[0], "feature/");
  assert.equal(completions.includes("feature/menu-"), true);
  assert.equal(completions.includes("feature/add-"), true);
  assert.equal(completions.includes("fix/"), true);
  assert.equal(completions.some((item) => item.startsWith("main")), false);
});

test("el aviso al crear rama es una observación y no llega a bloquear nada", () => {
  const list = [...many("feature", 41)];
  const hint = consistency.variantHint("feat/nueva", list);
  assert.deepEqual(hint, { typed: "feat", canonical: "feature", count: 41 });
  // Que ya exista una rama feat/ no convierte esa grafía en la convención del repo: el aviso sigue.
  assert.deepEqual(consistency.variantHint("feat/otra", [...list, branch("feat/uno")]), { typed: "feat", canonical: "feature", count: 41 });
  // La grafía mayoritaria no genera aviso, ni tampoco un prefijo nuevo sin parecido.
  assert.equal(consistency.variantHint("feature/nueva", [...list, branch("feat/uno")]), undefined);
  assert.equal(consistency.variantHint("spike/nueva", list), undefined);
  assert.equal(consistency.variantHint("sin-prefijo", list), undefined);
  // Un prefijo con presencia real es una convención, no un desliz.
  assert.equal(consistency.variantHint("feat/otra", [...many("feature", 8), ...many("feat", 3)]), undefined);
});
