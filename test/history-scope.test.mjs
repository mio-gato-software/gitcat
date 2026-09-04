import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const graph = await import(pathToFileURL(join(root, "dist-electron/shared/commit-graph.js")));

/**
 * Un repositorio de verdad: el alcance del historial se decide con argumentos de Git, así que
 * comprobarlo contra la salida real es la única forma de saber que dice lo que dice.
 */
const repo = mkdtempSync(join(tmpdir(), "gitcat-history-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main", ".");
git("config", "user.email", "t@t.t");
git("config", "user.name", "T");
const commit = (message) => { writeFileSync(join(repo, "f.txt"), message); git("add", "-A"); git("commit", "-q", "-m", message); };
commit("base");
commit("main-1");
git("switch", "-qc", "feature/uno");
commit("feature-1");
commit("feature-2");
git("switch", "-q", "main");
commit("main-2");

const log = (...args) => git("log", "--topo-order", "--pretty=format:%s", ...args).split("\n").filter(Boolean);

test("el alcance «rama» muestra la rama, no todas las refs", () => {
  assert.deepEqual(log("main", "--"), ["main-2", "main-1", "base"]);
  assert.deepEqual(log("feature/uno", "--"), ["feature-2", "feature-1", "main-1", "base"]);
  // "--all" mezcla las dos ramas en una sola lista, que es lo que hacía el panel antes del alcance.
  assert.deepEqual(log("--all", "--").sort(), ["base", "feature-1", "feature-2", "main-1", "main-2"]);
});

test("«solo lo exclusivo» deja fuera lo que la rama por defecto ya tiene", () => {
  assert.deepEqual(log("feature/uno", "--not", "main", "--"), ["feature-2", "feature-1"]);
  // Excluir la rama de sí misma no dejaría nada, por eso ese caso no se pide nunca.
  assert.deepEqual(log("main", "--not", "main", "--"), []);
});

test("la paginación pide uno de más para saber si hay algo detrás", () => {
  const page = log("-n", "3", "--skip", "0", "main", "--");
  assert.equal(page.length, 3);
  assert.deepEqual(log("-n", "2", "--skip", "0", "main", "--"), ["main-2", "main-1"]);
  assert.deepEqual(log("-n", "2", "--skip", "2", "main", "--"), ["base"]);
});

test("el grafo de una rama concreta ocupa un solo carril", () => {
  const raw = git("log", "--topo-order", "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%P", "feature/uno", "--");
  const commits = raw.split("\n").filter(Boolean).map((line) => {
    const [hash, shortHash, author, email, date, subject, refs = "", parents = ""] = line.split("\x1f");
    return { hash, shortHash, author, email, date, subject, refs: refs.split(",").map((r) => r.trim()).filter(Boolean), parents: parents.split(" ").filter(Boolean) };
  });
  const built = graph.buildCommitGraph(commits, [], "main");
  assert.equal(built.laneCount, 1, "una sola rama no diverge de nada");
  assert.equal(built.rows.length, 4);
});

test("un nombre de rama con forma de opción nunca es un nombre de rama válido", async () => {
  const llm = await import(pathToFileURL(join(root, "dist-electron/electron/llm-plan.js")));
  // loadHistory pasa la rama a los argumentos de git, así que esta es la puerta que lo impide.
  for (const hostile of ["--all", "-n", "--output=/tmp/x", "--upload-pack=rm -rf /", "..", "main..other", "@{u}", "a b"]) {
    assert.equal(llm.isBranchNameSafe(hostile), false, `"${hostile}" no debería aceptarse`);
  }
  assert.equal(llm.isBranchNameSafe("feature/menu-import-openai"), true);
  assert.equal(llm.isBranchNameSafe("main"), true);
});
