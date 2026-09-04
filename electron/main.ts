import { legacyAppName, migrateProfileFiles, profilePath } from "./app-identity.js";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyConflictResolution, executePlan, generateCommitDescription, getCommitDetail, getCommitFileDiff, getLlmConfig, getSnapshot,
  getWorkingFileDiff, loadHistory, loadLlmConfig, loadMemory, planAction, planRecovery, prepareOperation,
  prepareBranchDelivery, prepareMergeToDefault, proposeConflictResolution, saveLlmConfig
} from "./git-service.js";
import type { ActionPlan, ConversationMessage, ExecutionFailure, HistoryRequest, LlmConfigInput, Locale, Operation } from "../shared/types.js";

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
let persistedWorkspace: { paths: string[]; activePath?: string } = { paths: [] };

function workspacePath() { return join(app.getPath("userData"), "gitcat-workspace.json"); }

function loadWorkspace() {
  try {
    const value = JSON.parse(readFileSync(workspacePath(), "utf8")) as { paths?: unknown; activePath?: unknown };
    const paths = Array.isArray(value.paths)
      ? [...new Set(value.paths.filter((path): path is string => typeof path === "string").map((path) => resolve(path)))]
      : [];
    const activePath = typeof value.activePath === "string" && paths.includes(resolve(value.activePath)) ? resolve(value.activePath) : undefined;
    persistedWorkspace = { paths, activePath };
  } catch { /* first launch or an unreadable workspace */ }
}

function saveWorkspace() {
  mkdirSync(app.getPath("userData"), { recursive: true });
  const target = workspacePath();
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(persistedWorkspace, null, 2), { mode: 0o600 });
  renameSync(temporary, target);
}

async function restoreWorkspace() {
  const projects = [];
  for (const path of persistedWorkspace.paths) {
    try {
      const snapshot = await getSnapshot(path);
      openedRepositories.add(snapshot.path);
      projects.push(snapshot);
    } catch { /* moved, deleted, or no longer a Git repository */ }
  }
  persistedWorkspace.paths = projects.map((project) => project.path);
  if (!persistedWorkspace.activePath || !persistedWorkspace.paths.includes(persistedWorkspace.activePath)) {
    persistedWorkspace.activePath = persistedWorkspace.paths[0];
  }
  saveWorkspace();
  return { projects, activePath: persistedWorkspace.activePath };
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
    if (normalized.some((path) => !openedRepositories.has(path))) throw new Error("El workspace contiene un repositorio no autorizado.");
    const normalizedActivePath = typeof activePath === "string" ? resolve(activePath) : undefined;
    persistedWorkspace = {
      paths: normalized,
      activePath: normalizedActivePath && normalized.includes(normalizedActivePath) ? normalizedActivePath : normalized[0]
    };
    for (const path of openedRepositories) if (!normalized.includes(path)) openedRepositories.delete(path);
    for (const [id, plan] of issuedPlans) if (!normalized.includes(plan.repoPath)) issuedPlans.delete(id);
    saveWorkspace();
  });
  ipcMain.handle("project:select", async (event) => {
    assertTrustedSender(event);
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const snapshot = await getSnapshot(result.filePaths[0]);
    openedRepositories.add(snapshot.path);
    persistedWorkspace.paths = [...persistedWorkspace.paths.filter((path) => path !== snapshot.path), snapshot.path];
    persistedWorkspace.activePath = snapshot.path;
    saveWorkspace();
    return snapshot;
  });
  ipcMain.handle("repo:snapshot", (event, cwd: string) => {
    assertTrustedSender(event);
    return getSnapshot(assertOpenedRepository(cwd));
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
  ipcMain.handle("conflicts:propose", (event, cwd: string, locale?: Locale) => {
    assertTrustedSender(event);
    return proposeConflictResolution(assertOpenedRepository(cwd), locale);
  });
  ipcMain.handle("conflicts:apply", (event, cwd: string, resolutions: unknown, locale?: Locale) => {
    assertTrustedSender(event);
    if (!Array.isArray(resolutions)) throw new Error("Las resoluciones no son válidas.");
    return applyConflictResolution(assertOpenedRepository(cwd), resolutions, locale);
  });
  ipcMain.handle("action:recover", async (event, cwd: string, failure: ExecutionFailure, context?: ConversationMessage[], locale?: Locale) => {
    assertTrustedSender(event);
    if (!failure || typeof failure !== "object" || typeof failure.error !== "string") throw new Error("El fallo reportado no es válido.");
    return rememberPlan(await planRecovery(assertOpenedRepository(cwd), failure, context, locale));
  });
  ipcMain.handle("action:plan", async (event, cwd: string, request: string, context?: ConversationMessage[], locale?: Locale) => {
    assertTrustedSender(event);
    // Shape is still checked; length is not. The model decides what it can handle.
    if (typeof request !== "string") throw new Error("La solicitud no es válida.");
    if (context !== undefined && (!Array.isArray(context) || context.some((message) =>
      !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string"
    ))) throw new Error("El contexto de conversación no es válido.");
    return rememberPlan(await planAction(assertOpenedRepository(cwd), request, context, locale));
  });
  ipcMain.handle("action:prepare", async (event, cwd: string, operation: Operation, args?: Record<string, string>, locale?: Locale) => {
    assertTrustedSender(event);
    return rememberPlan(await prepareOperation(assertOpenedRepository(cwd), operation, args, locale));
  });
  ipcMain.handle("action:prepare-delivery", async (event, cwd: string, request: { stateId: string; mergeToDefault: boolean; message?: string }, locale?: Locale) => {
    assertTrustedSender(event);
    if (!request || typeof request.stateId !== "string" || typeof request.mergeToDefault !== "boolean" || (request.message !== undefined && typeof request.message !== "string")) throw new Error("Invalid delivery request.");
    return rememberPlan(await prepareBranchDelivery(assertOpenedRepository(cwd), request, locale));
  });
  ipcMain.handle("action:prepare-merge-to-default", async (event, cwd: string, branch: string, locale?: Locale) => {
    assertTrustedSender(event);
    if (typeof branch !== "string") throw new Error("La rama que quieres fusionar no es válida.");
    return rememberPlan(await prepareMergeToDefault(assertOpenedRepository(cwd), branch, locale));
  });
  ipcMain.handle("commit:generate-description", async (event, cwd: string, locale?: Locale) => {
    assertTrustedSender(event);
    return generateCommitDescription(assertOpenedRepository(cwd), locale);
  });
  ipcMain.handle("action:execute", async (event, cwd: string, planId: string, locale?: Locale) => {
    assertTrustedSender(event);
    const repoPath = assertOpenedRepository(cwd);
    const plan = typeof planId === "string" ? issuedPlans.get(planId) : undefined;
    if (!plan) throw new Error("El plan ya no es válido. Prepara la acción de nuevo.");
    issuedPlans.delete(planId);
    if (plan.repoPath !== repoPath) throw new Error("El plan pertenece a otro repositorio.");
    return executePlan(repoPath, plan, locale);
  });
  ipcMain.handle("llm:get-config", (event) => { assertTrustedSender(event); return getLlmConfig(); });
  ipcMain.handle("llm:save-config", (event, input: LlmConfigInput) => { assertTrustedSender(event); return saveLlmConfig(input); });
  await createWindow();
  app.on("activate", async () => { if (BrowserWindow.getAllWindows().length === 0) await createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
