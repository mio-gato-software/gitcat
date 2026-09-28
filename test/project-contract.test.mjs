import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("el proyecto usa Electron como entrada de escritorio", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.main, "dist-electron/electron/main.js");
  assert.match(packageJson.devDependencies.electron, /43\.3/);
  assert.match(packageJson.scripts["dist:mac"], /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.equal(packageJson.build.productName, "GitCat");
});

test("el instalador de mac construye el app y lo reemplaza en Applications", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const scriptPath = join(root, "scripts/install-mac.mjs");
  const script = await readFile(scriptPath, "utf8");
  const preview = execFileSync(process.execPath, [scriptPath, "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITCAT_APPLICATIONS_DIR: join(root, ".test-applications") }
  });

  assert.equal(packageJson.scripts["install:mac"], "node scripts/install-mac.mjs");
  assert.match(preview, /npm run build/);
  assert.match(preview, /npm run icons/);
  assert.match(preview, /npm exec -- electron-builder --mac --dir --(?:arm64|x64)/);
  assert.match(preview, /release\/mac-(?:arm64|x64)\/GitCat\.app/);
  assert.match(preview, /\.test-applications\/GitCat\.app/);
  assert.match(script, /execFileSync\("\/usr\/bin\/ditto"/);
  assert.match(script, /renameSync\(temporaryDestination, destination\)/);
});

test("el build tiene un asset de icono reproducible", async () => {
  const icon = await readFile(join(root, "build/icon.svg"), "utf8");
  assert.match(icon, /<svg/);
  assert.match(icon, /viewBox="0 0 1024 1024"/);
  assert.match(icon, /<path/);
  assert.doesNotMatch(icon, /<image|<script|href=/);
});

test("la capa de Git evita ejecutar comandos libres", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  assert.match(service, /const allowedOperations = new Set/);
  assert.match(service, /runCommand\("git", args/);
  assert.match(service, /spawn\(executable, args/);
  assert.doesNotMatch(service, /exec\(.*command/);
});

test("git_command da libertad al modelo sin shell y sin saltarse protecciones", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  // El comando libre se ejecuta como lista de argumentos: nunca se interpreta por un shell.
  assert.match(service, /case "git_command": return reportedGit\(cwd, step\.argv \?\? \[\]\)/);
  assert.doesNotMatch(service, /exec\(.*command/);
  assert.match(planner, /there is no shell/);
  // Investigar es su primer instinto: los de solo lectura corren sin confirmación; el resto, jamás.
  assert.match(service, /readOnlyGitSubcommands/);
  assert.match(planner, /first instinct/);
  // Anunciar que lo hará no vale: la investigación es un git_operation, en este turno.
  assert.match(planner, /is "git_operation" with read-only "git_command" steps, never "answer" or\n"needs_information"/);
  assert.match(planner, /is a failed turn/);
  // La protección de ramas también cubre los borrados por comando libre.
  assert.match(service, /gitBranchDeletions/);
  assert.match(planner, /only git_command takes an argument list/);
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
  assert.match(service, /if \(index > 0\) \{\s*\n\s*snapshot = await getSnapshot\(cwd\);\s*\n\s*validateStep\(step, snapshot, language\);/);
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

test("un clic selecciona la rama, un doble clic cambia a ella, y los impedimentos se explican", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(app, /const switchBranch = async \(name: string\)/);
  // Seleccionar no es una operación de Git: decide de qué rama habla la ventana y nada más.
  assert.match(app, /onClick=\{onSelect\} onDoubleClick=\{onSwitchNow\}/);
  assert.doesNotMatch(app, /window\.setTimeout\(onSwitch/, "el clic ya no prepara un checkout con retardo");
  // Cambiar de rama sigue siendo explícito: el doble clic, o el botón de la fila.
  assert.match(app, /className="branch-switch"/);
  assert.match(app, /addTurn\(path, t\("branchSwitchQuestion", \{ name \}\), false\)/);
  assert.match(app, /error: message, status: "error"/);
  // Una rama que deja de existir no puede dejar el historial apuntando a un nombre que Git no conoce.
  assert.match(app, /snapshot\.branches\.some\(\(branch\) => branch\.name === selectedBranch\) \? selectedBranch : snapshot\.currentBranch/);
});

test("el panel de ramas agrupa por convención sin renombrar nada, y la lista plana sigue estando", async () => {
  const branchTree = await readFile(join(root, "shared/branch-tree.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  // La agrupación es una capa de vista: vive fuera de la capa de comandos y no toca ninguna operación Git.
  assert.doesNotMatch(branchTree, /runGit|spawn\(|checkedGit|renameSync|window\.gitcat/);
  assert.doesNotMatch(service, /branch-tree/);
  assert.match(branchTree, /export const defaultSubgroupThreshold = 3/);
  assert.match(branchTree, /export function buildBranchTree/);
  assert.match(branchTree, /export function filterBranchTree/);
  // El árbol es el modo por defecto, no el único: la lista plana con filtro sigue a un clic.
  assert.match(app, /function BranchPanel/);
  assert.match(app, /view\.mode === "tree" \? renderNodes\(topLevel, 0, ""\) : matches\.map/);
  assert.match(app, /aria-label=\{t\("branchListMode"\)\}/);
  assert.match(app, /aria-label=\{t\("filterBranches"\)\}/);
  // El modo y los grupos abiertos se recuerdan por repositorio.
  assert.match(app, /const branchViewStorageKey = \(path: string\) => `gitcat-branch-view:\$\{path\}`/);
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
  assert.match(app, /t\("mergedHiddenTitle", \{ count: merged\.length, branch: snapshot\.defaultBranch/);
  assert.doesNotMatch(branchOrder, /delete|prune|borrar/i);
  assert.match(styles, /\.branch-row\.merged \.branch-main \{ opacity/);
  // Los worktrees salen del porcelain de Git y llegan a la fila, al tooltip y al modelo.
  assert.match(types, /checkedOutIn\?: string/);
  assert.match(service, /\["worktree", "list", "--porcelain", "-z"\]/);
  assert.match(service, /branch\.checkedOutIn = worktrees\.get\(branch\.name\)/);
  assert.match(service, /checkedOutIn: branch\.checkedOutIn \?\? null/);
  assert.match(app, /t\("worktreeUse", \{ path: branch\.checkedOutIn \}\)/);
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
  assert.match(app, /writeHistoryPrefs\(snapshot\.path, merged\)/);
  assert.match(app, /byFamily \? familyColour\(rows\.get\(commit\.hash\)\?\.family \?\? ""\) : branchColor\(index\)/);
  // Una lista filtrada no es un grafo: sin continuidad, no se dibujan carriles.
  assert.match(app, /const lanes = needle \? 0 :/);
  assert.match(styles, /\.graph-lanes line, \.graph-lanes path \{[^}]*vector-effect: non-scaling-stroke/);
});

test("el historial habla de una rama, se puede paginar y enseña qué cambió cada commit", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const styles = await readFile(join(root, "src/styles.css"), "utf8");
  // La vista principal abre con todas las ramas; limitarla a una sigue a un clic en su cabecera.
  assert.match(types, /export type HistoryScope = "all" \| "branch" \| "branch-only"/);
  assert.match(app, /scope: \["all", "branch", "branch-only"\]\.includes\(stored\?\.scope\) \? stored\.scope : "all"/);
  // Una rama acaba en los argumentos de git, así que se comprueba la forma y luego se resuelve la ref.
  assert.match(service, /async function verifiedRevision/);
  assert.match(service, /if \(!isBranchNameSafe\(name\)\) throw new Error/);
  assert.match(service, /\["rev-parse", "--verify", "--quiet", `\$\{name\}\^\{commit\}`\]/);
  assert.match(service, /args\.push\("--"\)/);
  // Los canales nuevos pasan por los mismos guardas que el resto.
  for (const channel of ["history:load", "commit:detail", "commit:file-detail", "commit:file-diff"]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}"`));
  }
  assert.equal((main.match(/assertOpenedRepository\(cwd\)/g) ?? []).length >= 6, true);
  assert.match(preload, /loadHistory: \(path, request\)/);
  // Paginación honesta: se pide uno de más para saber si hay algo detrás en vez de suponerlo.
  assert.match(service, /"-n", String\(limit \+ 1\)/);
  assert.match(service, /hasMore: parsed\.length > limit/);
  assert.match(app, /className="load-more"/);
  // Un merge se lee contra su primer padre; "git show" a secas contestaría que no cambió nada.
  assert.match(service, /const base = lineage\[1\]/);
  assert.match(service, /export async function getCommitDetail/);
  assert.match(service, /export async function getCommitFileDiff/);
  assert.match(service, /Ese archivo no forma parte de este commit/);
  assert.match(app, /function DiffView/);
  assert.match(app, /function PendingDiffView/);
  assert.match(app, /fileDetail\?\.path === selectedFile\.path/);
  assert.doesNotMatch(app, /setFileDetail\(undefined\);\n\s*setFileError\(undefined\);\n\s*window\.gitcat\.getCommitFileDiff/);
  assert.match(app, /getCommitFileDiff\(repoPath, commit\.hash, selectedFile\.path\)/);
  assert.match(app, /t\("showAllFiles"\)/);
  // Una ruta que llega de la interfaz sigue siendo una ruta: tiene que caer dentro del repositorio.
  assert.match(service, /La ruta no pertenece a este repositorio/);
  // Y los dos desajustes del grafo: el nodo se ancla donde empalma el SVG, y las columnas al carril real.
  assert.match(styles, /\.commit-node \{ top: 50%; left: auto; transform: translateY\(-50%\); \}/);
  const workspace = await readFile(join(root, "src/workspace.css"), "utf8");
  assert.match(workspace, /\.graph-columns, \.commit-row \{ display: grid; grid-template-columns: var\(--refs-w\) var\(--track-w, 40px\)/);
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
  assert.match(service, /requiresConfirmation: steps\.some\(\(step\) => !isUnattended\(step\)\)/);
  // Un comando libre solo corre desatendido si su subcomando es de solo lectura.
  assert.match(service, /if \(step\.operation === "git_command"\) return argv\.length > 0 && readOnlyGitSubcommands\.has\(argv\[0\]\)/);
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
  assert.match(service, /env: \{ \.\.\.process\.env, PATH: searchPath,/);
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

test("el asistente es opcional: interpretar sigue siendo del modelo y Git funciona sin él", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const i18n = await readFile(join(root, "src/i18n.ts"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  assert.match(service, /const LLM_REQUIRED =/);
  assert.match(service, /if \(!isLlmConfigured\(\)\) return bindPlan\(snapshot, refused\(llmRequired\(language\)\)\)/);
  assert.match(service, /configured: isLlmConfigured\(\)/);
  assert.match(service, /await verifyLlmAccess\(\{ apiKey: nextApiKey, model: nextModel \}\)/);
  assert.doesNotMatch(service, /local-fallback/);
  // No first-run gate: Welcome opens a project and the repository view works without a provider.
  assert.doesNotMatch(app, /ProviderRequired|exploring|provider-banner/);
  assert.match(app, /!snapshot \? <Welcome onOpen=\{\(\) => void openProject\(\)\} onClone=\{\(\) => setSetup\(\{ kind: "clone" \}\)\} onTrack=\{\(\) => void openProject\("track"\)\} config=\{config\} onConnect=\{openSettings\} readiness=\{readiness\} onPractice=\{\(\) => void startPractice\(\)\} practiceBusy=\{practiceBusy\} \/>/);
  assert.doesNotMatch(i18n, /LLM PROVIDER REQUIRED|PROVEEDOR LLM REQUERIDO/);
  // The assistant box explains how to connect instead of blocking; natural language still needs the model.
  assert.match(app, /config\.configured \? <p className="assistant-copy">\{t\("assistantConfiguredCopy"\)\}<\/p> : <AssistantSetupCard onConnect=\{openSettings\} \/>/);
  assert.match(app, /conversation\.length === 0 && config\.configured &&/);
  assert.match(app, /disabled=\{planning \|\| !request\.trim\(\) \|\| !config\.configured\}/);
  // Guided connection: a supported model or an advanced override, verified, with a reason and a retry.
  assert.match(app, /isSupportedModel\(config\.model\) \? "recommended" : "custom"/);
  assert.match(app, /t\("modelCustom"\)/);
  assert.match(app, /aiProblemTitle_\$\{problem\.kind\}/);
  assert.match(app, /t\("tryAgain"\)/);
  assert.match(service, /export async function connectLlm\(input: LlmConfigInput\): Promise<LlmConnectResult>/);
  assert.match(service, /export async function verifyLlmConfig\(\): Promise<LlmConnectResult>/);
  // A key is never kept without encryption.
  assert.match(service, /if \(nextApiKey && !secureStorageAvailable\(\)\)/);
  // Only the provider's own pages are opened, by name, from the main process.
  assert.match(main, /api_keys: "https:\/\/platform\.openai\.com\/api-keys"/);
  assert.match(main, /Object\.hasOwn\(providerPages, page\)/);
  // The three sign-ins are told apart where settings show them.
  for (const key of ["accountAiTitle", "accountAuthorTitle", "accountRemoteTitle"]) assert.match(app, new RegExp(`t\\("${key}"\\)`));
});

test("cada motivo de conexión tiene título y ayuda en todos los idiomas", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const i18n = await readFile(join(root, "src/i18n.ts"), "utf8");
  const kinds = [...types.match(/export type AiProblemKind =([^;]+);/)[1].matchAll(/"(\w+)"/g)].map((match) => match[1]);
  assert.ok(kinds.length >= 10);
  const es = i18n.slice(i18n.indexOf("\nconst es"));
  const en = i18n.slice(0, i18n.indexOf("\nconst es"));
  for (const kind of kinds) for (const block of [en, es]) {
    assert.match(block, new RegExp(`aiProblemTitle_${kind}:`));
    assert.match(block, new RegExp(`aiProblemHelp_${kind}:`));
  }
  for (const state of ["none", "verifying", "connected", "attention", "failed"]) for (const block of [en, es]) assert.match(block, new RegExp(`aiState_${state}:`));
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
  assert.match(app, /function suggestionsFor\(snapshot: RepoSnapshot, t: Translate\)/);
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
  assert.match(service, /return issues\.length \? retry\(issues\) : gitOperationDraft\(plan, snapshot, locale, notes\)/);
  assert.match(service, /if \("blockers" in preparation\) return retry\(preparation\.blockers\)/);
});

test("el workspace persiste y restaura los proyectos abiertos", async () => {
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(main, /gitcat-workspace\.json/);
  assert.match(main, /ipcMain\.handle\("workspace:restore"/);
  assert.match(main, /ipcMain\.handle\("workspace:save"/);
  assert.match(preload, /restoreWorkspace/);
  assert.match(app, /workspaceRestored/);
  assert.match(app, /saveWorkspace\(paths, activePath\)/);
});

test("un proyecto que no se pudo abrir sigue guardado y solo se quita a petición", async () => {
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  // Restoration reports what failed instead of dropping it from the saved list.
  assert.doesNotMatch(main, /catch \{ \/\* moved, deleted, or no longer a Git repository \*\/ \}/);
  assert.match(main, /const restored = await restoreProjects\(persistedWorkspace, getSnapshot\)/);
  assert.match(main, /!openedRepositories\.has\(path\) && !unavailableProjects\.has\(path\)/);
  // Retry, locate and confirm only act on a saved project that is unavailable, from the trusted renderer.
  for (const channel of ["workspace:retry", "workspace:locate", "workspace:confirm-locate"]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}", async \\(event[^)]*\\)(?:: Promise<ProjectLocateResult>)? => \\{\\n    assertTrustedSender\\(event\\);`));
  }
  assert.match(main, /const from = assertUnavailableProject\(path\);/);
  assert.match(main, /inspectProject\(chosen, getSnapshot, \{ exactRoot: false \}\)/);
  assert.match(main, /if \(match === "same"\) return adoptLocation/);
  assert.match(preload, /retryProject: \(path\) => ipcRenderer\.invoke\("workspace:retry", path\)/);
  assert.match(preload, /locateProject: \(path, labels\) => ipcRenderer\.invoke\("workspace:locate", path, labels\)/);
  assert.match(preload, /confirmLocateProject: \(candidateId\) => ipcRenderer\.invoke\("workspace:confirm-locate", candidateId\)/);
  assert.match(app, /<UnavailableProjectPanel/);
  assert.match(app, /if \(result\.carriedOver\) moveRepositoryViewState\(from, next\.path\)/);
});

test("macOS reserva espacio para los controles de ventana", async () => {
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const styles = await readFile(join(root, "src/styles.css"), "utf8");
  assert.match(main, /trafficLightPosition: \{ x: 16, y: 20 \}/);
  assert.match(styles, /\.app-shell\.platform-darwin \.topbar \{ padding-left: 88px; \}/);
});

test("las notificaciones usan un espacio fijo y el detalle se abre solo a petición", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const center = await readFile(join(root, "src/NotificationCenter.tsx"), "utf8");
  const styles = await readFile(join(root, "src/styles.css"), "utf8");
  assert.match(app, /<NotificationCenter items=\{activity\}/);
  assert.match(center, /open && <section/);
  assert.match(center, /notificationDuration\(preview.tone\)/);
  assert.match(center, /setPreviewId\(undefined\)/);
  assert.match(styles, /\.notification-root \{ position: fixed; bottom: 0;/);
  assert.match(styles, /height: 30px;/);
  assert.doesNotMatch(styles, /\.notification-center|\.activity-dock|\.toast/);
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
  assert.match(app, /t\(generating \? "generatingSaveDescription" : "generateDescription"\)/);
  assert.match(app, /showPlan\(t\(merge \? "saveAndIntegrate" : "saveChanges"/);
  assert.match(app, /window\.gitcat\.prepareBranchDelivery\(path, \{ stateId: snapshot\.stateId, message, mergeToDefault: merge, selection \}, locale\)/);
  assert.match(app, /window\.gitcat\.generateCommitDescription\(repoPath, locale, paths\)/);
  assert.match(preload, /generateCommitDescription: \(path, locale, paths\) => ipcRenderer\.invoke\("commit:generate-description", path, locale, paths\)/);
});

test("Cambios muestra estado, ruta y formulario manual sin LLM", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(app, /function changeStatus/);
  assert.match(app, /className="change-status"/);
  assert.match(app, /className="change-path"/);
  assert.match(app, /t\(configured \? "editableDescription" : "manualSaveDescription"\)/);
  assert.match(app, /t\("noUncommittedChanges"\)/);
});

test("el asistente conserva la conversación completa y la envía entera", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(types, /export type ConversationMessage/);
  assert.match(service, /input: \[\.\.\.context, \{ role: "user", content: request \}\]/);
  assert.match(app, /type ConversationTurn/);
  assert.match(app, /const \[conversations, setConversations\]/);
  assert.match(app, /setRequest\(""\)/);
  assert.match(app, /t\("clearConversation"\)/);
  assert.match(app, /t\("preparingResponse"\)/);
});

test("respuestas y planes quedan asociados a su turno", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(app, /function ConversationEntry/);
  assert.match(app, /updateTurn\(path, turnId/);
  assert.match(app, /applyPlan\(turn\.id, plan\)/);
  assert.match(app, /t\("planDiscarded"\)/);
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
  assert.doesNotMatch(repositoryPlan, /basename\(.*localPath|basename\(.*source\)/);
  assert.match(service, /is not the project currently open in GitCat/);
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

test("una rama que está en local y en el remoto es un chip, no dos", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const chips = await readFile(join(root, "shared/ref-chips.ts"), "utf8");
  // Pintar "feature/x" y "origin/feature/x" gastaba todo el ancho diciendo el mismo nombre dos veces,
  // y truncaba ambos por el camino. Se agrupan por el nombre sin remoto.
  assert.match(chips, /const label = remote \? name\.slice\(remote\.length \+ 1\) : name;/);
  assert.match(chips, /note\(label, remote \? "remote" : "local"\)/);
  // Lo que solo existe en el remoto conserva su marca: eso no lo tienes aquí.
  assert.match(app, /chip\.kind === "remote" \? `\$\{chip\.label\} · \$\{t\("remoteOnlyTitle"\)\}`/);
  assert.match(chips, /origin\/HEAD/, "el puntero simbólico se sigue descartando");
});

test("una operación a medias es un estado del que se puede salir, no un callejón", async () => {
  const types = await readFile(join(root, "shared/types.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  // El trabajo a medias existe en los datos: qué operación, por qué commit y qué lo bloquea.
  assert.match(types, /export type PendingOperationKind = "rebase" \| "merge" \| "cherry_pick" \| "revert"/);
  assert.match(types, /conflicts: Conflict\[\]/);
  assert.match(service, /async function readPendingOperation/);
  assert.match(service, /conflicts: conflictsFrom\(changes\)/);
  // Las operaciones valen para cualquier trabajo a medias; el subcomando lo pone el estado, no el modelo.
  assert.match(service, /case "continue_operation": return reportedGit\(cwd, \[pendingCommands\[snapshot\.pending!\.kind\], "--continue"\]\)/);
  assert.match(service, /No hay ninguna operación de Git a medias/);
  assert.match(service, /Todavía quedan \$\{snapshot\.conflicts\.length\} archivos en conflicto/);
  // El fallo vuelve al modelo en vez de morir en la conversación, y lo que propone se confirma.
  assert.match(service, /export async function planRecovery/);
  assert.match(app, /await recoverFrom\(plan\.repoPath, \{/);
  // Recovery no longer depends on a provider: the facts come first, the assistant only when configured.
  assert.doesNotMatch(app, /config\.configured\) await recoverFrom|failed && config\.configured/);
  assert.match(app, /report = await window\.gitcat\.describeFailure\(path, failure\)/);
  assert.match(app, /if \(report && !report\.needsJudgment\) return;\n {4}if \(!config\.configured\)/);
  assert.match(main, /rememberFailure\(\{ plan, outcomes: result\.outcomes, stale: false \}\)/);
  assert.match(main, /stale: error instanceof StalePlanError/);
  assert.match(service, /function explainGitFailure/);
  assert.match(service, /todavía no está publicada ni tiene un destino remoto asociado/);
  // La salida de un lío se propone, nunca se ejecuta sola: recoverFrom deja el plan esperando.
  assert.match(app, /updateTurn\(path, turnId, \(turn\) => \(\{ \.\.\.turn, plan, status: plan\.allowed \? "ready" : "completed" \}\)\)/);
  assert.doesNotMatch(app, /recoverFrom[\s\S]{0,600}?await runPlan/, "recoverFrom no ejecuta nada por su cuenta");
  // Y el modelo sabe qué cuesta cada salida.
  assert.match(planner, /Aborting throws away the half-finished work/);
  assert.match(planner, /so they are "theirs", which is the\nopposite of what most people expect/);
});

test("resolver un conflicto con el modelo se propone, se revisa y solo entonces se escribe", async () => {
  const resolution = await readFile(join(root, "electron/conflict-resolution.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  // El módulo que habla con el modelo no escribe nada: produce una propuesta.
  assert.doesNotMatch(resolution, /writeFileSync|runGit|checkedGit/);
  assert.match(resolution, /export function validateProposal/);
  assert.match(resolution, /strict: true/);
  // Escribir es un paso aparte: la propuesta la emite y la guarda el proceso principal, ligada al
  // repositorio, la operación, las etapas del índice y los bytes revisados, y se revalida entera antes de escribir.
  assert.match(service, /export async function applyConflictResolution/);
  assert.match(service, /if \(proposal\.repoPath !== repoRoot\)/);
  assert.match(service, /if \(await conflictOperation\(repoRoot\) !== proposal\.binding\.operation\)/);
  assert.match(service, /\["ls-files", "-u", "-z"\]/);
  assert.match(service, /todavía contiene marcas de conflicto/);
  assert.match(main, /const issuedProposals = new Map<string, IssuedConflictProposal>\(\)/);
  assert.match(main, /ipcMain\.handle\("conflicts:apply", async \(event, cwd: string, proposalId: unknown, accepted: unknown, locale\?: Locale\)/);
  assert.match(main, /tracked\(event, repoPath, "planning", \(\) => proposeConflictResolution\(repoPath, locale\)\)/);
  assert.match(main, /exclusive\(repoPath, \(\) => applyConflictResolution\(repoPath, proposal, accepted as string\[\], locale\)\)/);
  assert.match(service, /if \(!absolute\.startsWith\(`\$\{repoRoot\}\$\{sep\}`\)\) throw new Error\(localized\(locale, "La ruta no pertenece a este repositorio\."/);
  // Nunca en automático: hay un botón, y la propuesta se revisa archivo a archivo antes de aceptarla.
  assert.match(main, /ipcMain\.handle\("conflicts:propose"/);
  assert.match(app, /function ConflictProposalModal/);
  assert.match(app, /t\("nothingWritten"\)/);
  assert.match(app, /onApply=\{\(accepted\) => void applyResolutions\(accepted\)\}/);
  assert.match(app, /window\.gitcat\.applyConflictResolution\(path, proposal\.id, accepted, locale\)/);
  // La duda del propio modelo se enseña en vez de enterrarse.
  assert.match(app, /resolution\.confidence === "low" && <span className="resolution-doubt"/);
  // Confidence is shown, never used to accept: nothing starts ticked.
  assert.doesNotMatch(app, /proposal\.resolutions\.filter\(\(item\) => item\.confidence === "high"\)/);
  assert.match(app, /const \[accepted, setAccepted\] = useState<string\[\]>\(\[\]\)/);
  assert.match(app, /t\("proposalReviewEach"\)/);
});

test("the guided resolver works from repository facts, with the assistant as an optional extra", async () => {
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  // Choices are bound in the main process like proposals: the renderer sends an id and choices, never content.
  assert.match(main, /const issuedGuides = new Map<string, IssuedConflictGuide>\(\)/);
  assert.match(main, /exclusive\(repoPath, \(\) => describeConflicts\(repoPath, locale\)\)/);
  assert.match(main, /exclusive\(repoPath, \(\) => applyConflictChoices\(repoPath, guide, requested, locale\)\)/);
  assert.match(main, /shell\.openPath\(absolute\)/);
  // Something the system would run instead of show is only revealed in its folder.
  assert.match(main, /if \(!opensSafely\(absolute\)\) \{\n\s+shell\.showItemInFolder\(absolute\);/);
  assert.match(preload, /chooseConflictResolutions: \(path, guideId, choices, locale\) => ipcRenderer\.invoke\("conflicts:choose"/);
  assert.match(service, /if \(await conflictOperation\(repoRoot\) !== guide\.binding\.operation\)/);
  assert.doesNotMatch(service.slice(service.indexOf("export async function describeConflicts"), service.indexOf("async function applyConflictChoicesBody")), /askProvider|isLlmConfigured/);
  // The banner always offers the resolver; the assistant's draft only when one is configured.
  assert.match(app, /onGuide=\{\(\) => void openGuide\(\)\}/);
  assert.match(app, /blocked > 0 && configured && <button className="outline-button small" onClick=\{onResolve\}/);
  assert.match(app, /case "resolve_conflicts": await openGuide\(\); return;/);
  assert.match(app, /function ConflictResolverModal/);
  assert.match(app, /t\("guideNoAssistant"\)/);
  // Every way on is explained before it is prepared, and still confirmed as a plan.
  assert.match(app, /onNext=\{\(operation\) => \{ closeGuide\(\); void prepare\(operation\); \}\}/);
  assert.match(service, /async function pendingEffects/);
});

test("el error crudo de Electron no llega nunca a la interfaz", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  assert.match(app, /function cleanError/);
  assert.match(app, /Error invoking remote method/);
  // Ningún sitio vuelve a enseñar el mensaje tal cual llega del canal.
  assert.doesNotMatch(app, /error instanceof Error \? error\.message : "No se pudo preparar la acción\."/);
  assert.doesNotMatch(app, /reason instanceof Error \? reason\.message : "No se pudo leer el historial\."/);
});

test("las ramas ofrecen fusionarse en la rama por defecto desde su menú contextual", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  assert.match(app, /onContextMenu=\{onContextMenu\}/);
  // El menú de una rama es el mismo en el panel y en el grafo, y sigue ofreciendo integrarla en la principal.
  assert.match(app, /onMenu=\{\(branch, x, y\) => setMenu\(\{ x, y, branch: branch\.name \}\)\}/);
  assert.match(app, /key: "merge-default", icon: GitMerge, label: t\("mergeBranchTo", \{ name, target: base \}\), onSelect: \(\) => void prepareMergeToDefault\(name\)/);
  assert.match(app, /prepareMergeToDefault/);
  assert.match(service, /export async function prepareMergeToDefault/);
  assert.match(service, /git switch/);
  assert.match(main, /action:prepare-merge-to-default/);
  assert.match(preload, /prepareMergeToDefault/);
});

test("las fusiones desde el menú respetan cambios pendientes y la guía del agente", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");
  const planner = await readFile(join(root, "electron/llm-plan.ts"), "utf8");
  const guide = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.match(app, /snapshot\.isDirty\s*\n?\s*\? \(\) => window\.gitcat\.planAction/);
  assert.match(service, /if \(snapshot\.isDirty\) throw new Error\(localized\(language, "Hay cambios locales sin confirmar/);
  assert.match(service, /branch\.mergedInto\.includes\(target\)/);
  assert.match(service, /async function plannerState/);
  assert.match(service, /workingTreeDiff/);
  assert.match(planner, /A branch tip never includes uncommitted working-tree changes/);
  assert.match(guide, /Read this file before starting a task/);
  assert.match(guide, /GitCat is for people who need Git, not necessarily for people who already know Git/);
  assert.match(guide, /Start from the user's goal, not from Git commands/);
  assert.match(guide, /The product owns the translation/);
  assert.match(guide, /Treat errors as moments to guide/);
  assert.match(guide, /Do not leave a blocked action at an error message/);
  assert.match(guide, /Never treat an empty or already-contained branch as a meaningful merge/);
  assert.match(guide, /Preserve uncommitted work/);
});

test("el texto seleccionado tiene menú y atajos de copiar multiplataforma", async () => {
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  assert.match(main, /webContents\.on\("context-menu"/);
  assert.match(main, /role: "copy"/);
  assert.match(main, /enabled: Boolean\(params\.selectionText\)/);
  assert.match(main, /webContents\.on\("before-input-event"/);
  assert.match(main, /process\.platform === "darwin" \? input\.meta : input\.control/);
  assert.match(main, /input\.key\.toLowerCase\(\) !== "c"/);
  assert.match(main, /window\.webContents\.copy\(\)/);
});
