import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executePlan, getLlmConfig, getSnapshot, loadLlmConfig, planAction, prepareOperation, saveLlmConfig } from "./git-service.js";
import type { ActionPlan, LlmConfigInput, Operation } from "../shared/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
const openedRepositories = new Set<string>();
const issuedPlans = new Map<string, ActionPlan>();
let persistedWorkspace: { paths: string[]; activePath?: string } = { paths: [] };

function workspacePath() { return join(app.getPath("userData"), "branchline-workspace.json"); }

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
  if (typeof cwd !== "string" || !openedRepositories.has(resolve(cwd))) throw new Error("El repositorio no está abierto en Branchline.");
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
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#0b1018",
    titleBarStyle: "hiddenInset",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 20 } } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedFrame(url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (!app.isPackaged) await mainWindow.loadURL("http://127.0.0.1:5173");
  else await mainWindow.loadFile(join(app.getAppPath(), "dist/index.html"));
}

app.whenReady().then(async () => {
  loadLlmConfig();
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
  ipcMain.handle("action:plan", async (event, cwd: string, request: string) => {
    assertTrustedSender(event);
    if (typeof request !== "string" || request.length > 1000) throw new Error("La solicitud no es válida.");
    return rememberPlan(await planAction(assertOpenedRepository(cwd), request));
  });
  ipcMain.handle("action:prepare", async (event, cwd: string, operation: Operation, args?: Record<string, string>) => {
    assertTrustedSender(event);
    return rememberPlan(await prepareOperation(assertOpenedRepository(cwd), operation, args));
  });
  ipcMain.handle("action:execute", async (event, cwd: string, planId: string) => {
    assertTrustedSender(event);
    const repoPath = assertOpenedRepository(cwd);
    const plan = typeof planId === "string" ? issuedPlans.get(planId) : undefined;
    if (!plan) throw new Error("El plan ya no es válido. Prepara la acción de nuevo.");
    issuedPlans.delete(planId);
    if (plan.repoPath !== repoPath) throw new Error("El plan pertenece a otro repositorio.");
    return executePlan(repoPath, plan);
  });
  ipcMain.handle("llm:get-config", (event) => { assertTrustedSender(event); return getLlmConfig(); });
  ipcMain.handle("llm:save-config", (event, input: LlmConfigInput) => { assertTrustedSender(event); return saveLlmConfig(input); });
  await createWindow();
  app.on("activate", async () => { if (BrowserWindow.getAllWindows().length === 0) await createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
