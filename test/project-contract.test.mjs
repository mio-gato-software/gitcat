import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("el proyecto usa Electron como entrada de escritorio", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.main, "dist-electron/electron/main.js");
  assert.match(packageJson.devDependencies.electron, /43\.3/);
  assert.match(packageJson.scripts["dist:mac"], /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.equal(packageJson.build.productName, "Branchline");
});

test("el build tiene un asset de icono reproducible", async () => {
  const icon = await readFile(join(root, "build/icon.svg"), "utf8");
  assert.match(icon, /<svg/);
  assert.match(icon, /#6be0cf|#86ecde/);
});

test("la capa de Git evita ejecutar comandos libres", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(service, /const allowedOperations = new Set/);
  assert.match(service, /spawn\("git", args/);
  assert.doesNotMatch(service, /exec\(.*command/);
});

test("el guardrail de alcance está presente", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(service, /Solo puedo ayudarte con ramas, historial, cambios y operaciones Git/);
  assert.match(service, /source\s*\n/);
});

test("la aplicación empaquetada resuelve el renderer desde app.getAppPath", async () => {
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  assert.match(main, /loadFile\(join\(app\.getAppPath\(\), "dist\/index\.html"\)\)/);
  assert.doesNotMatch(main, /loadFile\(join\(__dirname, "\.\.\/dist/);
});

test("los planes están ligados al repositorio y al estado que los creó", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  assert.match(types, /repoPath: string/);
  assert.match(types, /stateId: string/);
  assert.match(service, /plan\.stateId !== snapshot\.stateId/);
  assert.match(main, /issuedPlans\.delete\(planId\)/);
});

test("las ramas usan el separador binario soportado por for-each-ref", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(service, /--format=%\(refname:short\)%00/);
  assert.match(service, /line\.split\("\\0"\)/);
});

test("los controles principales tienen implementaciones concretas", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(app, /function ChangesView/);
  assert.match(app, /prepare\("delete_branch"/);
  assert.match(app, /function CommitModal/);
  assert.match(app, /showRecentAuthors/);
  assert.doesNotMatch(app, /MoreHorizontal/);
});
