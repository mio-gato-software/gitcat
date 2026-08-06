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
  assert.match(service, /runCommand\("git", args/);
  assert.match(service, /spawn\(command, args/);
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

test("la relevancia se clasifica con el LLM y admite consultas informativas", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.doesNotMatch(service, /function isGitRequest/);
  assert.match(service, /Decide por significado, no por palabras clave/);
  assert.match(service, /branch_last_author/);
  assert.match(service, /última persona en trabajar/);
  assert.match(app, /plan\.answer/);
});

test("el workspace persiste y restaura los proyectos abiertos", async () => {
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(main, /branchline-workspace\.json/);
  assert.match(main, /ipcMain\.handle\("workspace:restore"/);
  assert.match(main, /ipcMain\.handle\("workspace:save"/);
  assert.match(preload, /restoreWorkspace/);
  assert.match(app, /workspaceRestored/);
  assert.match(app, /saveWorkspace\(paths, activePath\)/);
});

test("macOS reserva espacio para los controles de ventana", async () => {
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const styles = await readFile(join(root, "src/styles.css"), "utf8");
  assert.match(main, /trafficLightPosition: \{ x: 16, y: 20 \}/);
  assert.match(styles, /\.app-shell\.platform-darwin \.topbar \{ padding-left: 88px; \}/);
});

test("las notificaciones de actividad se pueden cerrar y expiran", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const styles = await readFile(join(root, "src/styles.css"), "utf8");
  assert.match(app, /const dismissActivity/);
  assert.match(app, /activityTimers/);
  assert.match(app, /item\.tone === "warning" \? 10_000 : 6_000/);
  assert.match(app, /aria-label=\{`Cerrar notificación:/);
  assert.match(styles, /\.activity-dock \{ position: fixed; z-index: 8; top: 68px; right: 16px;/);
  assert.match(styles, /\.activity-close/);
});

test("la descripción de commit usa el diff real y conserva la confirmación", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(service, /export async function generateCommitDescription/);
  assert.match(service, /"diff", "--no-ext-diff", "--unified=3", "HEAD"/);
  assert.match(service, /"ls-files", "--others", "--exclude-standard", "-z"/);
  assert.match(service, /Los cambios variaron durante la generación/);
  assert.match(main, /ipcMain\.handle\("commit:generate-description"/);
  assert.match(preload, /generateCommitDescription/);
  assert.match(app, /Generar descripción/);
  assert.match(app, /prepare\("commit", \{ message \}\)/);
});

test("Cambios muestra estado, ruta y formulario manual sin LLM", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(app, /function changeStatus/);
  assert.match(app, /className="change-status"/);
  assert.match(app, /className="change-path"/);
  assert.match(app, /Configura un LLM para generar una descripción\. Puedes escribirla manualmente/);
  assert.match(app, /No hay cambios sin confirmar/);
});

test("el asistente conserva conversación y envía contexto acotado", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(types, /export type ConversationMessage/);
  assert.match(main, /context\.length > 20/);
  assert.match(service, /input: \[\.\.\.context\.slice\(-20\)/);
  assert.match(app, /type ConversationTurn/);
  assert.match(app, /const \[conversations, setConversations\]/);
  assert.match(app, /setRequest\(""\)/);
  assert.match(app, /Limpiar conversación/);
  assert.match(app, /Preparando respuesta/);
});

test("respuestas y planes quedan asociados a su turno", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(app, /function ConversationEntry/);
  assert.match(app, /updateTurn\(path, turnId/);
  assert.match(app, /applyPlan\(turn\.id, plan\)/);
  assert.match(app, /Plan descartado sin modificar el repositorio/);
});

test("GitHub privado usa una operación estructurada y confirmada", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(types, /\| "github_create_repo"/);
  assert.match(service, /"github_create_repo"/);
  assert.match(service, /gh repo create/);
  assert.match(service, /requiresConfirmation: true/);
  assert.match(app, /plan\.effects/);
});

test("la creación GitHub hace todas las comprobaciones sin leer tokens", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(service, /\["--version"\]/);
  assert.match(service, /\["auth", "status", "--active", "--hostname", host\]/);
  assert.match(service, /\["api", `repos\/\$\{owner\}\/\$\{name\}`/);
  assert.match(service, /viewerCanCreateRepositories/);
  assert.match(service, /\["remote", "get-url", remote\]/);
  assert.match(service, /No hay commits locales que publicar/);
  assert.doesNotMatch(service, /auth token|GH_TOKEN.*stdout|GITHUB_TOKEN.*stdout/);
});

test("la validación GitHub exige decisiones explícitas y evita rutas arbitrarias", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(service, /Indica explícitamente el propietario/);
  assert.match(service, /Indica explícitamente el host/);
  assert.match(service, /Indica explícitamente si quieres publicar/);
  assert.match(service, /abre ese repositorio como proyecto activo/);
  assert.match(service, /Ya existe el remoto/);
});

test("la ejecución gh no usa shell y revierte cambios locales ante fallo", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(service, /runCommand\("gh", args/);
  assert.match(service, /GH_PROMPT_DISABLED: "1"/);
  assert.match(service, /\["remote", "remove", plan\.args\.remote\]/);
  assert.match(service, /\["remote", "add", plan\.args\.remote, previousRemoteUrl\]/);
  assert.match(service, /existingRemoteHash/);
  assert.doesNotMatch(service, /existingRemoteUrl/);
  assert.doesNotMatch(service, /spawn\([^\n]+shell:\s*true/);
});
