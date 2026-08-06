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
  assert.match(service, /spawn\(executable, args/);
  assert.doesNotMatch(service, /exec\(.*command/);
});

test("las herramientas se localizan sin depender del PATH que hereda la app", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(service, /function loginShellPath/);
  assert.match(service, /\["-ilc", 'printf "%s" "\$PATH"'\]/);
  assert.match(service, /const executable = await resolveTool\(command\)/);
  assert.match(service, /env: \{ \.\.\.process\.env, PATH: searchPath/);
  assert.match(service, /no runnable gh was found in any of the/);
});

test("ninguna decisión sobre el mensaje del usuario se toma con palabras clave", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const repositoryPlan = await readFile(join(root, "electron/repository-plan.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.doesNotMatch(service, /function localPlan/);
  assert.doesNotMatch(service, /toLocaleLowerCase\("es"\)/);
  assert.doesNotMatch(service, /isRepositoryCreationConversation|collectRepositoryFields/);
  assert.doesNotMatch(repositoryPlan, /collectRepositoryFields|isRepositoryCreationConversation|requestedFields|parseRemoteUrl|bareValue/);
  assert.doesNotMatch(repositoryPlan, /crear|guardar|propietario|ruta local/i);
  assert.doesNotMatch(app, /showRecentAuthors|showChangesAnswer/);
  assert.match(app, /const askSuggestion/);
});

test("el proveedor LLM es obligatorio y no hay plan local de reserva", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(service, /const LLM_REQUIRED =/);
  assert.match(service, /if \(!isLlmConfigured\(\)\) return bindPlan\(snapshot, refused\(LLM_REQUIRED\)\)/);
  assert.match(service, /configured: isLlmConfigured\(\)/);
  assert.match(service, /await verifyLlmAccess\(\{ apiKey: nextApiKey, model: nextModel \}\)/);
  assert.doesNotMatch(service, /local-fallback/);
  assert.match(app, /!config\.configured \? <ProviderRequired/);
});

test("los fallos del proveedor se reportan, nunca se disfrazan de rechazo", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(service, /payload\?\.status === "incomplete"/);
  assert.match(service, /incomplete_details\?\.reason/);
  assert.match(service, /El proveedor devolvió una respuesta vacía/);
  assert.match(service, /no cumple el esquema del plan/);
  assert.doesNotMatch(service, /se generó y validó un plan local seguro/);
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
  assert.match(app, /askSuggestion\("¿Quién hizo cambios recientemente\?"\)/);
  assert.doesNotMatch(app, /MoreHorizontal/);
});

test("el modelo clasifica la intención, responde preguntas y escribe en el idioma del usuario", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.doesNotMatch(service, /function isGitRequest/);
  assert.match(planner, /never by matching words or verb forms/);
  assert.match(planner, /same language as the user's latest message/);
  assert.match(planner, /"git_operation", "create_repository", "answer", "needs_information", "out_of_scope"/);
  assert.match(service, /function plannerState/);
  assert.match(service, /if \(plan\.intent === "answer"\) return answerDraft\(plan\)/);
  assert.match(app, /plan\.answer/);
});

test("los defectos vuelven al modelo como datos estructurados, no como texto en español", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const repositoryPlan = await readFile(join(root, "electron/repository-plan.ts"), "utf8");
  assert.match(planner, /export function operationIssues/);
  assert.match(planner, /Validation issues \(JSON\)/);
  assert.match(repositoryPlan, /export type RepositoryIssue = \{ field: RepositoryFieldName; problem: string \}/);
  assert.match(service, /type RepositoryPreparation = \{ draft: PlanDraft \} \| \{ blockers: PlanIssue\[\] \}/);
  assert.match(service, /return issues\.length \? retry\(issues\) : gitOperationDraft\(plan, snapshot\)/);
  assert.match(service, /if \("blockers" in preparation\) return retry\(preparation\.blockers\)/);
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
  assert.match(app, /sigue el idioma del historial de commits/);
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
  assert.match(service, /the local repository has no commits, so there is nothing to push/);
  assert.doesNotMatch(service, /auth token|GH_TOKEN.*stdout|GITHUB_TOKEN.*stdout/);
});

test("la validación GitHub cubre todos los campos y evita rutas arbitrarias", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const repositoryPlan = await readFile(join(root, "electron/repository-plan.ts"), "utf8");
  assert.match(service, /repositoryFieldsFromPlan/);
  assert.match(service, /validateRepositoryFields/);
  assert.match(repositoryPlan, /if \(!fields\.localPath\) issues\.push\(missing\("localPath"\)\)/);
  assert.match(repositoryPlan, /if \(!fields\.repository\) issues\.push\(missing\("repository"\)\)/);
  assert.doesNotMatch(repositoryPlan, /basename\(.*localPath|basename\(.*source/);
  assert.match(service, /is not the project currently open in Branchline/);
  assert.match(service, /already points to/);
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
