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

test("un plan es una secuencia que el modelo compone y la app ejecuta de principio a fin", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(types, /export type PlanStep/);
  assert.match(types, /steps: PlanStep\[\]/);
  // El modelo decide qué pasos y en qué orden; el esquema no lo limita a uno solo.
  assert.match(planner, /steps: \{\s*\n\s*type: "array"/);
  assert.match(planner, /export function planIssues/);
  assert.match(planner, /export const planStepLimit/);
  // Cada paso se valida contra el repositorio que dejó el anterior, y el primer fallo detiene la secuencia.
  assert.match(service, /for \(const \[index, step\] of plan\.steps\.entries\(\)\)/);
  assert.match(service, /if \(index > 0\) \{\s*\n\s*snapshot = await getSnapshot\(cwd\);\s*\n\s*validateStep\(step, snapshot\);/);
  assert.match(service, /status: "failed"/);
  assert.match(service, /function failureReport/);
  assert.doesNotMatch(service, /switch \(plan\.operation\)/, "la ejecución ya no depende de una sola operación del plan");
  // La tarjeta muestra la secuencia completa antes de aprobarla.
  assert.match(app, /plan\.steps\.length > 1/);
  assert.match(app, /plan\.steps\.map\(\(step, index\)/);
});

test("las columnas se redimensionan con el ratón y el ancho sobrevive al reinicio", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const styles = await readFile(join(root, "src/styles.css"), "utf8");
  assert.match(app, /function PaneDivider/);
  assert.match(app, /setPointerCapture\(event\.pointerId\)/);
  assert.match(app, /localStorage\.setItem\(paneStorageKey/);
  assert.match(app, /function clampPanes/);
  // Accesible con teclado, no solo con el ratón.
  assert.match(app, /role="separator"/);
  assert.match(app, /aria-orientation="vertical"/);
  // El grid se controla por variables, así que las media queries siguen mandando en pantallas estrechas.
  assert.match(styles, /grid-template-columns: var\(--sidebar-w, 235px\).*var\(--inspector-w, 330px\)/);
  assert.match(styles, /\.pane-divider \{[^}]*cursor: col-resize/);
});

test("doble clic cambia de rama y los impedimentos se explican en la columna del asistente", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(app, /const switchBranch = async \(name: string\)/);
  assert.match(app, /onDoubleClick=\{doubleClick\}/);
  // El clic simple espera la ventana del doble clic para que un gesto no dispare las dos cosas.
  assert.match(app, /pendingClick\.current = window\.setTimeout\(onSwitch, 230\)/);
  assert.match(app, /addTurn\(path, `Cambiar a la rama \$\{name\}`\)/);
  assert.match(app, /error: message, status: "error"/);
});

test("el panel de ramas agrupa por convención sin renombrar nada, y la lista plana sigue estando", async () => {
  const branchTree = await readFile(join(root, "shared/branch-tree.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  // La agrupación es una capa de vista: vive fuera de la capa de comandos y no toca ninguna operación Git.
  assert.doesNotMatch(branchTree, /runGit|spawn\(|checkedGit|renameSync|window\.branchline/);
  assert.doesNotMatch(service, /branch-tree/);
  assert.match(branchTree, /export const defaultSubgroupThreshold = 3/);
  assert.match(branchTree, /export function buildBranchTree/);
  assert.match(branchTree, /export function filterBranchTree/);
  // El árbol es el modo por defecto, no el único: la lista plana con filtro sigue a un clic.
  assert.match(app, /function BranchPanel/);
  assert.match(app, /view\.mode === "tree" \? renderNodes\(topLevel, 0, ""\) : matches\.map/);
  assert.match(app, /aria-label="Modo de la lista de ramas"/);
  assert.match(app, /aria-label="Filtrar ramas"/);
  // El modo y los grupos abiertos se recuerdan por repositorio.
  assert.match(app, /const branchViewStorageKey = \(path: string\) => `branchline-branch-view:\$\{path\}`/);
  assert.match(app, /writeBranchView\(snapshot\.path, updated\)/);
  // Cambiar de modo no pierde ni el scroll ni la rama que tenía el foco.
  assert.match(app, /pending\.current = \{ scrollTop: listRef\.current\?\.scrollTop \?\? 0, focused \}/);
  assert.match(app, /node\.focus\(\); node\.scrollIntoView/);
});

test("el panel ordena por actividad, marca lo ya integrado y dice qué worktree usa cada rama", async () => {
  const branchOrder = await readFile(join(root, "shared/branch-order.ts"), "utf8");
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const styles = await readFile(join(root, "src/styles.css"), "utf8");
  // El alfabético deja de ser el default, pero se conserva como opción.
  assert.match(branchOrder, /export const defaultBranchOrder: BranchOrder = "activity"/);
  assert.match(branchOrder, /alphabetical: "Alfabético"/);
  // Ordenar antes de agrupar es lo que ordena los grupos por su rama más reciente.
  assert.match(app, /return sortBranches\(kept, order, \{ dirty: snapshot\.isDirty \}\)/);
  assert.match(app, /const tree = useMemo\(\(\) => buildBranchTree\(listed, \{ aliases \}\)/);
  // Integración: visibilidad, nunca borrado. El filtro es reversible y se recuerda.
  assert.match(branchOrder, /export function isMergedIntoDefault/);
  assert.match(app, /update\(\{ hideMerged: !hideMerged \}\)/);
  assert.match(app, /Ocultarlas no borra nada/);
  assert.doesNotMatch(branchOrder, /delete|prune|borrar/i);
  assert.match(styles, /\.branch-row\.merged \.branch-main \{ opacity/);
  // Los worktrees salen del porcelain de Git y llegan a la fila, al tooltip y al modelo.
  assert.match(types, /checkedOutIn\?: string/);
  assert.match(service, /\["worktree", "list", "--porcelain"\]/);
  assert.match(service, /branch\.checkedOutIn = worktrees\.get\(branch\.name\)/);
  assert.match(service, /checkedOutIn: branch\.checkedOutIn \?\? null/);
  assert.match(app, /en uso por el worktree \$\{branch\.checkedOutIn\}/);
});

test("la consistencia de nombres se sugiere, nunca se aplica sola", async () => {
  const consistency = await readFile(join(root, "shared/branch-consistency.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  // La detección es lógica pura: no ejecuta comandos ni conoce la capa de Git.
  assert.doesNotMatch(consistency, /runGit|spawn\(|checkedGit|prepareOperation|executePlan/);
  assert.match(consistency, /export const reservedNames/);
  assert.match(consistency, /export const minorityRatio/);
  // Renombrar es una operación como las demás: tabla determinista, confirmación y comando a la vista.
  assert.match(service, /case "rename_branch": return `git branch -m \$\{args\.name\} \$\{args\.to\}`/);
  assert.match(service, /case "rename_branch": return reportedGit\(cwd, \["branch", "-m", "--", args\.name, args\.to\]\)/);
  assert.doesNotMatch(service, /"branch", "-M"/, "nunca se fuerza un renombrado sobre una rama existente");
  assert.match(service, /No puedes renombrar la rama por defecto/);
  assert.match(service, /rename_branch.*medium/);
  assert.match(service, /function renameEffects/);
  assert.match(service, /el renombrado es local y no cambia la rama remota/);
  // Ni el modelo ni la interfaz renombran por su cuenta.
  assert.match(planner, /A naming\nconvention you notice on your own is never a reason to rename anything/);
  assert.match(app, /function NamingSuggestion/);
  assert.match(app, /onRename=\{\(name, to\) => void prepare\("rename_branch", \{ name, to \}\)\}/);
  // El descarte se recuerda; el aviso al crear rama no bloquea.
  assert.match(app, /update\(\{ dismissed: \[\.\.\.dismissed, suggestion\.id\] \}\)/);
  assert.match(app, /disabled=\{!dialog\.value\.trim\(\)\}/);
  assert.doesNotMatch(app, /disabled=\{.*hint/, "un aviso de convención nunca impide crear la rama");
});

test("el prefijo declara una política y las acciones protegidas la aplican", async () => {
  const table = await readFile(join(root, "shared/branch-lifecycle.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  // Una tabla de datos que ambos procesos resuelven, no reglas repartidas por el código.
  assert.match(table, /export const defaultLifecycleRules: LifecycleRule\[\]/);
  assert.match(table, /\{ prefix: "backup", lifecycle: "permanent" \}/);
  assert.doesNotMatch(table, /if \(prefix === "backup"\)/);
  // La protección es una guardia real en la capa que ejecuta, no solo un adorno de la interfaz.
  assert.match(service, /if \(operation === "delete_branch" && isProtectedBranch\(args\.name\)\)/);
  assert.match(service, /está protegida por su prefijo/);
  assert.match(service, /function protectedBranchIssues/);
  assert.match(service, /lifecycle: lifecycleOf\(branch\.name\)/);
  assert.match(planner, /never deletion\ncandidates/);
  // Y una rama permanente jamás se pinta como integrada ni ofrece su papelera.
  assert.match(app, /!protectedByPrefix && branch\.presence !== "remote"/);
  assert.match(app, /const protectedByPrefix = isProtectedBranch\(branch\.name\)/);
});

test("una rama apilada lo está porque Git lo confirma, no porque el nombre lo sugiera", async () => {
  const candidates = await readFile(join(root, "electron/stacked-branches.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  // Los nombres solo proponen los pares; nunca deciden.
  assert.doesNotMatch(candidates, /runGit|spawn\(|merge-base/);
  assert.match(candidates, /export function stackCandidates/);
  assert.match(service, /\["merge-base", "--is-ancestor", ancestor, descendant\]/);
  assert.match(service, /if \(await isAncestor\(repoRoot, baseTip, stackedTip\)\)/);
  // El cálculo se cachea por las dos puntas, que es lo que lo hace válido para siempre.
  assert.match(service, /const key = `\$\{ancestor\}\\0\$\{descendant\}`/);
  assert.match(service, /result\.code !== 0 && result\.code !== 1/, "un fallo del comando no se cachea como respuesta");
  assert.match(types, /stackedOn\?: string/);
  assert.match(service, /stackedOn: branch\.stackedOn \?\? null/);
  // Solo relaciones directas: el árbol anida un nivel y no reconstruye cadenas.
  assert.match(app, /\.\.\.node\.stacked\.map\(\(branch\) => branchRow\(branch, depth \+ 1, trim\)\)/);
});

test("el historial es un grafo con carriles, y su color significa algo", async () => {
  const commitGraph = await readFile(join(root, "shared/commit-graph.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const styles = await readFile(join(root, "src/styles.css"), "utf8");
  // El orden topológico es lo que permite asignar carriles en una sola pasada.
  assert.match(service, /"log", "--all", "--topo-order", "-n", "80"/);
  assert.match(service, /%s%x1f%D%x1f%P/);
  assert.match(types, /parents: string\[\]/);
  assert.match(commitGraph, /export function buildCommitGraph/);
  assert.doesNotMatch(commitGraph, /runGit|spawn\(|branchColor/);
  // El color sale del nombre de la familia, así que es el mismo entre sesiones y entre máquinas.
  assert.match(commitGraph, /hash = Math\.imul\(hash, 16777619\)/);
  assert.match(commitGraph, /export const neutralFamilyColour/);
  assert.doesNotMatch(commitGraph, /Math\.random|Date\.now/);
  // Y se puede volver al coloreado anterior, que se recuerda por repositorio.
  assert.match(app, /writeGraphColour\(snapshot\.path, next\)/);
  assert.match(app, /byFamily \? familyColour\(rows\.get\(commit\.hash\)\?\.family \?\? ""\) : branchColor\(index\)/);
  // Una lista filtrada no es un grafo: sin continuidad, no se dibujan carriles.
  assert.match(app, /const lanes = filtering \? 0 :/);
  assert.match(styles, /\.graph-lanes line, \.graph-lanes path \{[^}]*vector-effect: non-scaling-stroke/);
});

test("una rama dice si vive en local, en el remoto o en ambos", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(types, /export type BranchPresence = "local" \| "remote" \| "both"/);
  assert.match(service, /function parseRemoteRefs/);
  assert.match(service, /"refs\/remotes"/);
  assert.match(service, /presence: "remote"/);
  assert.match(service, /solo existe en el remoto/);
  assert.match(app, /function PresenceBadge/);
  assert.match(app, /presenceLabel/);
});

test("un commit pedido al asistente deduce su mensaje del diff, nunca lo pregunta", async () => {
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(planner, /never ask the user what the commit\nmessage should be/);
  assert.doesNotMatch(planner, /a commit needs a message written by you or given by the user/);
  assert.match(service, /async function describeChanges/);
  assert.match(service, /async function writeCommitMessages/);
  assert.match(service, /if \("blocker" in steps\) return asking\(steps\.blocker, plan\.summary\)/);
});

test("la integración de una rama es un hecho de Git en el estado, no algo que el modelo deduzca", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(types, /mergedInto: string\[\]/);
  assert.match(types, /defaultBranchSource\?: DefaultBranchSource/);
  assert.match(service, /async function markIntegration/);
  assert.match(service, /"--merged", target, "refs\/heads", "refs\/remotes"/);
  assert.match(service, /async function resolveDefaultBranch/);
  // El HEAD que publica el remoto manda sobre cualquier nombre convencional.
  assert.match(service, /symbolic-ref", "--short", `refs\/remotes\/\$\{remote\}\/HEAD/);
  assert.match(service, /mergedInto: branch\.mergedInto/);
  assert.match(service, /isDefault: branch\.name === snapshot\.defaultBranch/);
  assert.match(service, /No puedes borrar la rama por defecto/);
  // El modelo tiene que saber que ahead\/behind no responden esta pregunta.
  assert.match(planner, /Treat the default branch and the current branch\n+as protected/);
  assert.match(planner, /Never fall back to\ncomparing "ahead" and "behind" for this/);
  assert.match(app, /mergedInto\.length/);
});

test("una acción que no puede perder trabajo se ejecuta sin pedir confirmación", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  // El criterio vive en un solo sitio y es restrictivo a propósito.
  assert.match(service, /const unattendedOperations = new Set<Operation>\(\["status", "fetch"\]\)/);
  assert.match(service, /requiresConfirmation: steps\.some\(\(step\) => !unattendedOperations\.has\(step\.operation\)\)/);
  // El flag ahora manda: se ejecuta solo, y la tarjeta no ofrece un botón que no decide nada.
  assert.match(app, /if \(unattended\) await runPlan\(turnId, plan\)/);
  assert.match(app, /plan\.allowed && !plan\.requiresConfirmation/);
  assert.doesNotMatch(app, /"Confirmar acción" : "Aplicar"/, "ya no hay una variante del botón para lo que no se confirma");
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
  // Se puede mirar la interfaz sin proveedor, pero el asistente queda inerte y lo dice.
  assert.match(app, /!config\.configured && !exploring \? <ProviderRequired/);
  assert.match(app, /provider-banner/);
  assert.match(app, /conversation\.length === 0 && config\.configured &&/);
  assert.match(app, /disabled=\{planning \|\| !request\.trim\(\) \|\| !config\.configured\}/);
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
  assert.match(app, /function suggestionsFor\(snapshot: RepoSnapshot\)/);
  assert.match(app, /askSuggestion\(suggestion\.question\)/);
  assert.match(app, /if \(snapshot\.isRebasing\) options\.push/);
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

test("el asistente conserva la conversación completa y la envía entera", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(types, /export type ConversationMessage/);
  assert.match(service, /input: \[\.\.\.context, \{ role: "user", content: request \}\]/);
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
  assert.match(service, /\["auth", "status", "--hostname", host, "--json", "hosts"\]/);
  assert.match(service, /\["api", `repos\/\$\{owner\}\/\$\{name\}`/);
  assert.match(service, /viewerCanCreateRepositories/);
  assert.match(service, /\["remote", "get-url", remote\]/);
  assert.match(service, /the local repository has no commits, so there is nothing to push/);
  assert.match(service, /gh has no per-command account flag/);
  assert.match(service, /\["auth", "switch", "--hostname", plan\.args\.host, "--user", plan\.args\.activeAccount\]/);
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

test("la cuenta gh y la clave SSH se resuelven por identidad, no se asumen", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const identity = await readFile(join(root, "electron/host-identity.ts"), "utf8");
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  assert.match(identity, /export function parseSshGreeting/);
  assert.match(identity, /export function parseGhAccounts/);
  assert.match(service, /async function resolveSshHost/);
  assert.match(service, /identity\.login\.toLowerCase\(\) === owner\.toLowerCase\(\)/);
  assert.match(service, /const ownerAccount = findAccount\(accounts, owner\)/);
  assert.match(types, /sshHost: string/);
  // Una cuenta inactiva pero autenticada es utilizable; la activa deja de ser la única opción.
  assert.doesNotMatch(service, /"auth", "status", "--active"/);
});

test("las preguntas del asistente no se presentan como errores", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const styles = await readFile(join(root, "src/styles.css"), "utf8");
  assert.match(types, /kind: "plan" \| "question" \| "refusal"/);
  assert.match(service, /function asking/);
  assert.match(service, /if \(plan\.intent === "needs_information"\) return asking/);
  assert.match(planner, /never ask "shall I proceed\?"/);
  assert.match(app, /const asking = plan\.kind === "question"/);
  assert.match(app, /tone: plan\.kind === "refusal" \? "warning" : "neutral"/);
  assert.match(styles, /\.plan-card\.asking/);
});

test("no hay límites artificiales en lo que se envía o se recibe del LLM", async () => {
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.doesNotMatch(main, /request\.length > \d+|context\.length > \d+|content\.length > \d+/);
  assert.doesNotMatch(service, /context\.slice\(-\d+\)/);
  assert.match(service, /input: \[\.\.\.context, \{ role: "user", content: request \}\]/);
  assert.doesNotMatch(service, /max_output_tokens: 4_000|max_output_tokens: 2_000/);
  assert.doesNotMatch(app, /\.slice\(-20\)|\.slice\(-40\)/);
});

test("solo se recuerdan decisiones confirmadas, nunca estado del entorno", async () => {
  const memory = await readFile(join(root, "electron/memory.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  assert.match(memory, /never measured state/);
  assert.match(memory, /export function identityKey/);
  // Se escribe solo tras una ejecución confirmada y correcta, nunca al proponer un plan.
  assert.match(service, /const pushOutput = plan\.args\.push === "true"[\s\S]{0,400}saveMemory\(rememberRepository\(/);
  assert.doesNotMatch(service, /saveMemory\([\s\S]{0,80}\)\s*;?\s*return \{\s*draft:/);
  // Lo recordado reordena la búsqueda; la verificación sigue ocurriendo.
  assert.match(service, /Memory only reorders the search/);
  assert.match(service, /if \(candidate === remembered\) saveMemory\(forgetSshHost\(memory, host, owner\)\)/);
  assert.match(service, /remembered: \{\s*\n\s*thisRepository: recallRepository/);
  assert.match(planner, /"remembered" in the state holds choices the user already confirmed/);
  // Nada de persistir lo que se puede volver a medir.
  assert.doesNotMatch(memory, /toolDirectories|isExecutableFile|ghVersion/);
});
