import { legacyAppName, migrateProfileFiles, profilePath } from "./app-identity.js";
import { exclusive } from "./repository-queue.js";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyConflictResolution, executePlan, fetchRemotes, generateCommitDescription, getCommitDetail, getCommitFileDiff, getLlmConfig, getSnapshot,
  getWorkingFileDiff, loadHistory, loadLlmConfig, loadMemory, planAction, planRecovery, prepareOperation,
  prepareBranchDelivery, prepareMergeToDefault, proposeConflictResolution, relocateRepositoryMemory, rootCommits, saveLlmConfig,
  type IssuedConflictProposal
} from "./git-service.js";
import { localized } from "./i18n.js";
import {
  classifyFailure, compareFingerprints, emptyWorkspace, errorText, fingerprintFrom, inspectProject, keepFingerprints, nearestExistingFolder,
  parseWorkspace, relocateProject, restoreProjects, type RepoFingerprint, type WorkspaceRecord
} from "./workspace-restore.js";
import type {
  ActionPlan, ConflictProposal, ConversationMessage, ExecutionFailure, HistoryRequest, LlmConfigInput, Locale, Operation, ProjectLocateResult,
  RepoSnapshot, RepositoryMatch, UnavailableProject
} from "../shared/types.js";

// Electron captures the encryption identity before app-ready. Keep the existing Keychain
// identity for upgrades, then use the new display name once startup has initialized it.
const userProfile = profilePath(app.getPath("appData"));
mkdirSync(userProfile, { recursive: true });
app.setPath("userData", userProfile);
app.setPath("sessionData", userProfile);
if (userProfile === join(app.getPath("appData"), legacyAppName)) app.setName(legacyAppName);

const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
const openedRepositories = new Set<string>();
const issuedPlans = new Map<string, ActionPlan>();
/** Conflict proposals keep their reviewed content and state binding here; the renderer only holds the id. */
const issuedProposals = new Map<string, IssuedConflictProposal>();
let persistedWorkspace: WorkspaceRecord = emptyWorkspace();
/** Saved projects that could not be opened. Their paths stay saved and only accept a retry, a new location or removal. */
const unavailableProjects = new Map<string, UnavailableProject>();
/** A folder offered as a project's new location that GitCat could not vouch for, waiting for the person's answer. */
const pendingLocations = new Map<string, { from: string; to: string; match: RepositoryMatch; fingerprint: RepoFingerprint }>();

function workspacePath() { return join(app.getPath("userData"), "gitcat-workspace.json"); }

function loadWorkspace() {
  try {
    persistedWorkspace = parseWorkspace(JSON.parse(readFileSync(workspacePath(), "utf8")));
  } catch (error) {
    // Nothing saved yet is normal. A file that exists but cannot be read is copied aside first, so the
    // next save cannot silently replace the only record of the saved projects.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try { copyFileSync(workspacePath(), `${workspacePath()}.unreadable`); } catch { /* nothing more can be kept */ }
    }
  }
}

function saveWorkspace() {
  mkdirSync(app.getPath("userData"), { recursive: true });
  const target = workspacePath();
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(persistedWorkspace, null, 2), { mode: 0o600 });
  renameSync(temporary, target);
}

/** For saves that follow a change already made in memory: the renderer's next save tries again and reports a failure. */
function saveWorkspaceQuietly() {
  try { saveWorkspace(); } catch (error) { console.error("No se pudo guardar el workspace.", error); }
}

/**
 * Records what identifies each opened repository, so a later "it moved, here it is" can be checked
 * against it. First commits are asked for once, in the background; remotes are refreshed each time.
 */
async function rememberFingerprints(projects: RepoSnapshot[]) {
  let changed = false;
  for (const project of projects) {
    const saved = persistedWorkspace.fingerprints[project.path];
    const roots = saved?.roots.length ? saved.roots : await rootCommits(project.path).catch(() => []);
    const next = fingerprintFrom(roots, project.remoteUrls);
    // The workspace may have changed while Git was answering; only projects still saved are recorded.
    if (!persistedWorkspace.paths.includes(project.path) || JSON.stringify(next) === JSON.stringify(saved)) continue;
    persistedWorkspace.fingerprints[project.path] = next;
    changed = true;
  }
  if (changed) saveWorkspaceQuietly();
}

async function restoreWorkspace() {
  const before = JSON.stringify(persistedWorkspace);
  const restored = await restoreProjects(persistedWorkspace, getSnapshot);
  unavailableProjects.clear();
  for (const project of restored.projects) openedRepositories.add(project.path);
  for (const project of restored.unavailable) unavailableProjects.set(project.path, project);
  persistedWorkspace = restored.record;
  // A project that could not be opened keeps its saved reference; the file only changes when a path was normalized.
  if (JSON.stringify(persistedWorkspace) !== before) saveWorkspaceQuietly();
  void rememberFingerprints(restored.projects);
  return { projects: restored.projects, unavailable: restored.unavailable, order: restored.record.paths, activePath: restored.activePath };
}

function assertUnavailableProject(path: unknown) {
  if (typeof path !== "string" || !unavailableProjects.has(resolve(path))) throw new Error("El proyecto no está en la lista de proyectos no disponibles.");
  return resolve(path);
}

/**
 * Puts a validated repository in the place of a saved project that went missing. Remembered choices
 * about pushing and identity move only when the repository is proven to be the same one.
 */
function adoptLocation(from: string, project: RepoSnapshot, fingerprint: RepoFingerprint, match: RepositoryMatch): ProjectLocateResult {
  unavailableProjects.delete(from);
  unavailableProjects.delete(project.path);
  for (const [id, pending] of pendingLocations) if (pending.from === from) pendingLocations.delete(id);
  openedRepositories.add(project.path);
  persistedWorkspace = relocateProject(persistedWorkspace, from, project.path, fingerprint);
  if (match === "same") relocateRepositoryMemory(from, project.path);
  saveWorkspaceQuietly();
  return { status: "relocated", previousPath: from, project, match, carriedOver: match !== "different" };
}

function isTrustedFrame(url: string) {
  const rendererUrl = pathToFileURL(join(app.getAppPath(), "dist/index.html")).href;
  return app.isPackaged ? url === rendererUrl : url.startsWith("http://127.0.0.1:5173/");
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent) {
  if (!event.senderFrame || !isTrustedFrame(event.senderFrame.url)) throw new Error("Origen de la solicitud no autorizado.");
}

function assertOpenedRepository(cwd: unknown) {
  if (typeof cwd !== "string" || !openedRepositories.has(resolve(cwd))) throw new Error("El repositorio no está abierto en GitCat.");
  return resolve(cwd);
}

function rememberPlan(plan: ActionPlan) {
  if (plan.allowed && !plan.answer) {
    if (issuedPlans.size >= 100) issuedPlans.delete(issuedPlans.keys().next().value ?? "");
    issuedPlans.set(plan.id, plan);
  }
  return plan;
}

/** One open review per repository: a newer proposal replaces the older one. */
function rememberProposal(proposal: IssuedConflictProposal): ConflictProposal {
  for (const [id, issued] of issuedProposals) if (issued.repoPath === proposal.repoPath) issuedProposals.delete(id);
  if (issuedProposals.size >= 20) issuedProposals.delete(issuedProposals.keys().next().value ?? "");
  issuedProposals.set(proposal.id, proposal);
  // The binding is the main process's own record; the renderer gets what it needs to show the review.
  return { id: proposal.id, repoPath: proposal.repoPath, resolutions: proposal.resolutions, skipped: proposal.skipped, current: proposal.current };
}

async function createWindow() {
  const window = mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#1b1d1e",
    titleBarStyle: "hiddenInset",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 20 } } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedFrame(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("context-menu", (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { role: "copy", enabled: Boolean(params.selectionText) }
    ]);
    menu.popup({ window });
  });
  window.webContents.on("before-input-event", (event, input) => {
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    if (input.type !== "keyDown" || input.key.toLowerCase() !== "c" || !modifier || input.alt) return;
    event.preventDefault();
    window.webContents.copy();
  });
  if (!app.isPackaged) await window.loadURL("http://127.0.0.1:5173");
  else await window.loadFile(join(app.getAppPath(), "dist/index.html"));
}

app.whenReady().then(async () => {
  app.setName("GitCat");
  app.setAboutPanelOptions({ applicationName: "GitCat" });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const, label: "GitCat" }] : [{ role: "fileMenu" as const }]),
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }
  ]));
  migrateProfileFiles(app.getPath("userData"));
  loadLlmConfig();
  loadMemory();
  loadWorkspace();
  ipcMain.handle("workspace:restore", async (event) => {
    assertTrustedSender(event);
    return restoreWorkspace();
  });
  ipcMain.handle("workspace:save", (event, paths: string[], activePath?: string) => {
    assertTrustedSender(event);
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) throw new Error("El estado del workspace no es válido.");
    const normalized = [...new Set(paths.map((path) => resolve(path)))];
    // A saved project that could not be opened is still a saved project; anything else must have been opened here.
    if (normalized.some((path) => !openedRepositories.has(path) && !unavailableProjects.has(path))) throw new Error("El workspace contiene un repositorio no autorizado.");
    const normalizedActivePath = typeof activePath === "string" ? resolve(activePath) : undefined;
    persistedWorkspace = {
      paths: normalized,
      activePath: normalizedActivePath && normalized.includes(normalizedActivePath) ? normalizedActivePath : normalized[0],
      fingerprints: keepFingerprints(persistedWorkspace.fingerprints, normalized)
    };
    for (const path of openedRepositories) if (!normalized.includes(path)) openedRepositories.delete(path);
    for (const path of unavailableProjects.keys()) if (!normalized.includes(path)) unavailableProjects.delete(path);
    for (const [id, pending] of pendingLocations) if (!normalized.includes(pending.from)) pendingLocations.delete(id);
    for (const [id, plan] of issuedPlans) if (!normalized.includes(plan.repoPath)) issuedPlans.delete(id);
    for (const [id, proposal] of issuedProposals) if (!normalized.includes(proposal.repoPath)) issuedProposals.delete(id);
    saveWorkspace();
  });
  ipcMain.handle("project:select", async (event) => {
    assertTrustedSender(event);
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const snapshot = await getSnapshot(result.filePaths[0]);
    openedRepositories.add(snapshot.path);
    // Opening a saved project that was unavailable brings it back; it is not listed twice.
    unavailableProjects.delete(snapshot.path);
    if (!persistedWorkspace.paths.includes(snapshot.path)) persistedWorkspace.paths = [...persistedWorkspace.paths, snapshot.path];
    persistedWorkspace.activePath = snapshot.path;
    saveWorkspace();
    void rememberFingerprints([snapshot]);
    return snapshot;
  });
  ipcMain.handle("workspace:retry", async (event, path: unknown) => {
    assertTrustedSender(event);
    const saved = assertUnavailableProject(path);
    const outcome = await inspectProject(saved, getSnapshot);
    if ("unavailable" in outcome) {
      unavailableProjects.set(saved, outcome.unavailable);
      return outcome;
    }
    unavailableProjects.delete(saved);
    openedRepositories.add(outcome.project.path);
    if (outcome.project.path !== saved) {
      persistedWorkspace = relocateProject(persistedWorkspace, saved, outcome.project.path, persistedWorkspace.fingerprints[saved]);
      saveWorkspaceQuietly();
    }
    void rememberFingerprints([outcome.project]);
    return outcome;
  });
  ipcMain.handle("workspace:locate", async (event, path: unknown, labels: unknown): Promise<ProjectLocateResult> => {
    assertTrustedSender(event);
    const from = assertUnavailableProject(path);
    if (!mainWindow) return { status: "canceled" };
    const text = (value: unknown) => typeof value === "string" ? value.slice(0, 200) : undefined;
    const label = (labels && typeof labels === "object" ? labels : {}) as Record<string, unknown>;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: text(label.title),
      buttonLabel: text(label.button),
      defaultPath: nearestExistingFolder(from),
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return { status: "canceled" };
    const chosen = resolve(result.filePaths[0]);
    // The folder is checked as a repository before anything about the saved project changes.
    const outcome = await inspectProject(chosen, getSnapshot, { exactRoot: false });
    if ("unavailable" in outcome) return { status: "invalid", path: chosen, reason: outcome.unavailable.reason, detail: outcome.unavailable.detail };
    const project = outcome.project;
    const fingerprint = fingerprintFrom(await rootCommits(project.path).catch(() => []), project.remoteUrls);
    const match = compareFingerprints(persistedWorkspace.fingerprints[from], fingerprint);
    if (match === "same") return adoptLocation(from, project, fingerprint, match);
    for (const [id, pending] of pendingLocations) if (pending.from === from) pendingLocations.delete(id);
    const candidateId = randomUUID();
    pendingLocations.set(candidateId, { from, to: project.path, match, fingerprint });
    return { status: "confirm", candidateId, path: project.path, name: project.name, match };
  });
  ipcMain.handle("workspace:confirm-locate", async (event, candidateId: unknown): Promise<ProjectLocateResult> => {
    assertTrustedSender(event);
    const pending = typeof candidateId === "string" ? pendingLocations.get(candidateId) : undefined;
    if (pending) pendingLocations.delete(candidateId as string);
    if (!pending || !unavailableProjects.has(pending.from)) throw new Error("Esa carpeta ya no está pendiente de confirmar.");
    // Validated again: the folder may have changed while the question was on screen.
    let project: RepoSnapshot;
    try {
      project = await getSnapshot(pending.to);
    } catch (error) {
      return { status: "invalid", path: pending.to, reason: classifyFailure(pending.to, error), detail: errorText(error) };
    }
    if (project.path !== pending.to) return { status: "invalid", path: pending.to, reason: "not_repository", detail: `git rev-parse --show-toplevel: ${project.path}` };
    return adoptLocation(pending.from, project, pending.fingerprint, pending.match);
  });
  ipcMain.handle("repo:snapshot", (event, cwd: string) => {
    assertTrustedSender(event);
    return getSnapshot(assertOpenedRepository(cwd));
  });
  ipcMain.handle("repo:fetch", (event, cwd: string) => {
    assertTrustedSender(event);
    const repoPath = assertOpenedRepository(cwd);
    return exclusive(repoPath, () => fetchRemotes(repoPath));
  });
  ipcMain.handle("history:load", (event, cwd: string, request: HistoryRequest) => {
    assertTrustedSender(event);
    if (!request || typeof request !== "object") throw new Error("La petición de historial no es válida.");
    // Shape only: which branch is real, and whether the scope is one of the three, is Git's answer.
    if (request.branch !== undefined && typeof request.branch !== "string") throw new Error("La rama del historial no es válida.");
    return loadHistory(assertOpenedRepository(cwd), request);
  });
  ipcMain.handle("commit:detail", (event, cwd: string, hash: string) => {
    assertTrustedSender(event);
    if (typeof hash !== "string") throw new Error("El commit solicitado no es válido.");
    return getCommitDetail(assertOpenedRepository(cwd), hash);
  });
  ipcMain.handle("commit:file-detail", (event, cwd: string, hash: string, file: string) => {
    assertTrustedSender(event);
    if (typeof hash !== "string") throw new Error("El commit solicitado no es válido.");
    if (typeof file !== "string" || !file) throw new Error("El archivo solicitado no es válido.");
    return getCommitFileDiff(assertOpenedRepository(cwd), hash, file);
  });
  ipcMain.handle("commit:file-diff", (event, cwd: string, file: string) => {
    assertTrustedSender(event);
    if (typeof file !== "string" || !file) throw new Error("El archivo solicitado no es válido.");
    return getWorkingFileDiff(assertOpenedRepository(cwd), file);
  });
  ipcMain.handle("conflicts:propose", async (event, cwd: string, locale?: Locale) => {
    assertTrustedSender(event);
    const repoPath = assertOpenedRepository(cwd);
    return rememberProposal(await exclusive(repoPath, () => proposeConflictResolution(repoPath, locale)));
  });
  ipcMain.handle("conflicts:apply", async (event, cwd: string, proposalId: unknown, accepted: unknown, locale?: Locale) => {
    assertTrustedSender(event);
    if (typeof proposalId !== "string" || !Array.isArray(accepted) || accepted.some((path) => typeof path !== "string")) {
      throw new Error(localized(locale, "Las resoluciones no son válidas.", "The resolutions are invalid."));
    }
    const repoPath = assertOpenedRepository(cwd);
    const proposal = issuedProposals.get(proposalId);
    if (!proposal) {
      throw new Error(localized(locale,
        "Esta propuesta ya no está disponible y no se escribió nada. Pulsa «Proponer resolución» para pedir una nueva.",
        "This proposal is no longer available and nothing was written. Press “Propose resolution” to get a fresh one."));
    }
    // The service refuses a proposal from another repository; it stays issued for the one it belongs to.
    const result = await exclusive(repoPath, () => applyConflictResolution(repoPath, proposal, accepted as string[], locale));
    if (result.complete) issuedProposals.delete(proposalId);
    else {
      // What was applied is done; the rest stays available for another try against the same binding.
      const applied = new Set(result.outcomes.filter((outcome) => outcome.status === "applied").map((outcome) => outcome.path));
      if (applied.size) issuedProposals.set(proposalId, { ...proposal, resolutions: proposal.resolutions.filter((item) => !applied.has(item.path)) });
    }
    return result;
  });
  ipcMain.handle("action:recover", async (event, cwd: string, failure: ExecutionFailure, context?: ConversationMessage[], locale?: Locale) => {
    assertTrustedSender(event);
    if (!failure || typeof failure !== "object" || typeof failure.error !== "string") throw new Error("El fallo reportado no es válido.");
    const repoPath = assertOpenedRepository(cwd);
    return rememberPlan(await exclusive(repoPath, () => planRecovery(repoPath, failure, context, locale)));
  });
  ipcMain.handle("action:plan", async (event, cwd: string, request: string, context?: ConversationMessage[], locale?: Locale) => {
    assertTrustedSender(event);
    // Shape is still checked; length is not. The model decides what it can handle.
    if (typeof request !== "string") throw new Error("La solicitud no es válida.");
    if (context !== undefined && (!Array.isArray(context) || context.some((message) =>
      !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string"
    ))) throw new Error("El contexto de conversación no es válido.");
    const repoPath = assertOpenedRepository(cwd);
    return rememberPlan(await exclusive(repoPath, () => planAction(repoPath, request, context, locale)));
  });
  ipcMain.handle("action:prepare", async (event, cwd: string, operation: Operation, args?: Record<string, string>, locale?: Locale) => {
    assertTrustedSender(event);
    const repoPath = assertOpenedRepository(cwd);
    return rememberPlan(await exclusive(repoPath, () => prepareOperation(repoPath, operation, args, locale)));
  });
  ipcMain.handle("action:prepare-delivery", async (event, cwd: string, request: { stateId: string; mergeToDefault: boolean; message?: string }, locale?: Locale) => {
    assertTrustedSender(event);
    if (!request || typeof request.stateId !== "string" || typeof request.mergeToDefault !== "boolean" || (request.message !== undefined && typeof request.message !== "string")) throw new Error("Invalid delivery request.");
    const repoPath = assertOpenedRepository(cwd);
    return rememberPlan(await exclusive(repoPath, () => prepareBranchDelivery(repoPath, request, locale)));
  });
  ipcMain.handle("action:prepare-merge-to-default", async (event, cwd: string, branch: string, locale?: Locale) => {
    assertTrustedSender(event);
    if (typeof branch !== "string") throw new Error("La rama que quieres fusionar no es válida.");
    const repoPath = assertOpenedRepository(cwd);
    return rememberPlan(await exclusive(repoPath, () => prepareMergeToDefault(repoPath, branch, locale)));
  });
  ipcMain.handle("commit:generate-description", async (event, cwd: string, locale?: Locale) => {
    assertTrustedSender(event);
    const repoPath = assertOpenedRepository(cwd);
    return exclusive(repoPath, () => generateCommitDescription(repoPath, locale));
  });
  ipcMain.handle("action:execute", async (event, cwd: string, planId: string, locale?: Locale) => {
    assertTrustedSender(event);
    const repoPath = assertOpenedRepository(cwd);
    const plan = typeof planId === "string" ? issuedPlans.get(planId) : undefined;
    if (!plan) throw new Error("El plan ya no es válido. Prepara la acción de nuevo.");
    issuedPlans.delete(planId);
    if (plan.repoPath !== repoPath) throw new Error("El plan pertenece a otro repositorio.");
    return exclusive(repoPath, () => executePlan(repoPath, plan, locale));
  });
  ipcMain.handle("llm:get-config", (event) => { assertTrustedSender(event); return getLlmConfig(); });
  ipcMain.handle("llm:save-config", (event, input: LlmConfigInput) => { assertTrustedSender(event); return saveLlmConfig(input); });
  await createWindow();
  app.on("activate", async () => { if (BrowserWindow.getAllWindows().length === 0) await createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
