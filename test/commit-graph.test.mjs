import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const graph = await import(pathToFileURL(join(root, "dist-electron/shared/commit-graph.js")));

const commit = (hash, parents = [], refs = []) => ({
  hash, shortHash: hash, subject: hash, author: "a", email: "a@b", date: "2026-01-01T00:00:00Z", refs, parents
});
const laneOf = (built, hash) => built.rows.find((row) => row.commit.hash === hash).lane;
const familyOf = (built, hash) => built.rows.find((row) => row.commit.hash === hash).family;

test("una historia lineal ocupa un solo carril", () => {
  const built = graph.buildCommitGraph([commit("c", ["b"]), commit("b", ["a"]), commit("a")]);
  assert.equal(built.laneCount, 1);
  assert.deepEqual(built.rows.map((row) => row.lane), [0, 0, 0]);
  // El primer commit no recibe nada de arriba; el último no manda nada hacia abajo.
  assert.deepEqual(built.rows[0].incoming, []);
  assert.deepEqual(built.rows[0].outgoing, [0]);
  assert.deepEqual(built.rows[2].outgoing, []);
});

test("dos ramas divergentes ocupan carriles distintos y vuelven a juntarse", () => {
  // tip-a y tip-b salen de "base": dos carriles que convergen al llegar a él.
  const built = graph.buildCommitGraph([
    commit("tip-a", ["base"], ["feature/uno"]),
    commit("tip-b", ["base"], ["fix/dos"]),
    commit("base", [])
  ]);
  assert.equal(built.laneCount, 2);
  assert.equal(laneOf(built, "tip-a"), 0);
  assert.equal(laneOf(built, "tip-b"), 1);
  const base = built.rows[2];
  assert.equal(base.lane, 0);
  // Los dos carriles que esperaban a "base" terminan en él.
  assert.deepEqual(base.incoming, [0, 1]);
});

test("un merge abre un carril por cada padre y el primero conserva la columna", () => {
  const built = graph.buildCommitGraph([
    commit("merge", ["main-1", "rama-1"], ["main"]),
    commit("main-1", ["base"]),
    commit("rama-1", ["base"], ["feature/x"]),
    commit("base", [])
  ]);
  const merge = built.rows[0];
  assert.equal(merge.lane, 0);
  assert.deepEqual(merge.outgoing, [0, 1]);
  assert.equal(laneOf(built, "main-1"), 0, "el primer padre se queda en la columna del merge");
  assert.equal(laneOf(built, "rama-1"), 1);
});

test("una rama que cruza sin tocar la fila se dibuja como línea recta", () => {
  const built = graph.buildCommitGraph([
    commit("tip-a", ["a-1"], ["feature/uno"]),
    commit("tip-b", ["base"], ["fix/dos"]),
    commit("a-1", ["base"]),
    commit("base", [])
  ]);
  // Al dibujar "a-1", el carril de tip-b sigue abierto esperando a "base" y no toca esta fila.
  const row = built.rows[2];
  assert.equal(row.commit.hash, "a-1");
  assert.deepEqual(row.through.map((line) => line.lane), [1]);
  assert.equal(row.through[0].family, "fix");
});

test("un padre fuera de la ventana deja su carril abierto en vez de romper el grafo", () => {
  const built = graph.buildCommitGraph([commit("c", ["fuera-de-la-lista"])]);
  assert.equal(built.rows.length, 1);
  assert.deepEqual(built.rows[0].outgoing, [0]);
  assert.equal(built.laneCount, 1);
});

test("la familia sale del ref y baja por el primer padre", () => {
  const built = graph.buildCommitGraph([
    commit("tip", ["mid"], ["feature/menu-import-openai"]),
    commit("mid", ["base"]),
    commit("base", [], ["main"])
  ]);
  assert.equal(familyOf(built, "tip"), "feature");
  assert.equal(familyOf(built, "mid"), "feature", "hereda de su hijo");
  assert.equal(familyOf(built, "base"), "main", "su propio ref manda sobre la herencia");
});

test("cuando varios refs apuntan al mismo commit, la rama por defecto deshace el empate", () => {
  const commits = [commit("tip", ["base"], ["origin/main", "feature/algo", "main"]), commit("base", [])];
  assert.equal(familyOf(graph.buildCommitGraph(commits, ["origin"], "main"), "tip"), "main");
  // Sin rama por defecto resuelta, manda el primer ref que Git haya listado.
  assert.equal(familyOf(graph.buildCommitGraph(commits, ["origin"]), "tip"), "main");
  const other = [commit("tip", ["base"], ["feature/algo", "main"]), commit("base", [])];
  assert.equal(familyOf(graph.buildCommitGraph(other, [], "main"), "tip"), "main");
  assert.equal(familyOf(graph.buildCommitGraph(other, []), "tip"), "feature");
});

test("el tronco tiñe su propia línea aunque una rama sin divergir apunte al mismo commit", () => {
  const commits = [
    commit("trunk-tip", ["shared"], ["main"]),
    // "shared" es a la vez punta de una rama de trabajo y parte de la historia del tronco.
    commit("shared", ["merge"], ["feature/algo"]),
    commit("merge", ["trunk-1", "rama-1"]),
    commit("rama-1", ["trunk-1"], ["feature/vieja"]),
    commit("trunk-1", [])
  ];
  const built = graph.buildCommitGraph(commits, [], "main");
  assert.equal(familyOf(built, "shared"), "main", "el primer padre del tronco es tronco");
  assert.equal(familyOf(built, "merge"), "main");
  assert.equal(familyOf(built, "trunk-1"), "main");
  // El segundo padre de un merge no hereda: esa rama es suya.
  assert.equal(familyOf(built, "rama-1"), "feature");
  // Sin rama por defecto no hay tronco que imponer nada, y manda el ref de cada commit.
  assert.equal(familyOf(graph.buildCommitGraph(commits, []), "shared"), "feature");
});

test("el ref dice a qué familia pertenece, y una etiqueta no reclama nada", () => {
  assert.equal(graph.familyOfRef("HEAD -> feature/menu-import-openai"), "feature");
  assert.equal(graph.familyOfRef("origin/feature/x", ["origin"]), "feature");
  assert.equal(graph.familyOfRef("main"), "main");
  assert.equal(graph.familyOfRef("tag: v1.0"), "");
  assert.equal(graph.familyOfRef("origin/HEAD", ["origin"]), "");
  assert.equal(graph.familyOfRef(""), "");
});

test("el color de una familia es el mismo en cada sesión y en cada máquina", () => {
  const once = graph.familyColour("feature");
  assert.equal(once, graph.familyColour("feature"));
  assert.notEqual(once, graph.familyColour("fix"));
  assert.match(once, /^hsl\(\d+ 62% 68%\)$/);
  // Un commit que ninguna rama reclama no finge pertenecer a ninguna.
  assert.equal(graph.familyColour(""), graph.neutralFamilyColour);
});

test("un historial ancho se calcula entero y deja el recorte a quien lo dibuja", () => {
  // 40 puntas independientes: el cálculo es honesto, el límite de dibujo es aparte.
  const commits = Array.from({ length: 40 }, (_, index) => commit(`tip-${index}`, ["base"], [`feature/r${index}`]));
  const built = graph.buildCommitGraph([...commits, commit("base", [])]);
  assert.equal(built.laneCount, 40);
  assert.equal(graph.maxLanes, 12);
  assert.equal(built.rows.length, 41);
});

test("los carriles liberados se reutilizan en vez de crecer sin fin", () => {
  // Cuatro ramas cortas que nacen y mueren una tras otra caben en dos carriles.
  const built = graph.buildCommitGraph([
    commit("t1", ["m1"], ["feature/a"]), commit("m1", ["m2"]),
    commit("t2", ["m2"], ["feature/b"]), commit("m2", ["m3"]),
    commit("t3", ["m3"], ["feature/c"]), commit("m3", [])
  ]);
  assert.equal(built.laneCount <= 2, true, `carriles: ${built.laneCount}`);
});

test("el trabajo sin guardar se dibuja encima de HEAD, en su carril y con su color", async () => {
  const { buildCommitGraph, withWorkInProgress, workInProgressHash } = graph;
  const commits = [
    { hash: "b", shortHash: "b", subject: "otra", author: "", email: "", date: "", refs: ["other"], parents: ["a"] },
    { hash: "h", shortHash: "h", subject: "head", author: "", email: "", date: "", refs: ["HEAD -> feature/x"], parents: ["a"] },
    { hash: "a", shortHash: "a", subject: "base", author: "", email: "", date: "", refs: ["main"], parents: [] }
  ];
  const listed = withWorkInProgress(commits, "h", "feature/x");
  assert.equal(listed[0].hash, workInProgressHash);
  assert.deepEqual(listed[0].parents, ["h"]);
  const built = buildCommitGraph(listed, [], "main");
  const wip = built.rows[0];
  const head = built.rows.find((row) => row.commit.hash === "h");
  // La línea que sale del WIP llega a HEAD: el trabajo continúa desde el commit sobre el que se escribe.
  assert.deepEqual(head.incoming, [wip.outgoing[0]]);
  assert.equal(wip.family, "feature");
  // Sin HEAD no hay nada de lo que continuar, así que no se inventa una fila.
  assert.equal(withWorkInProgress(commits, "", "feature/x").length, 3);
});
