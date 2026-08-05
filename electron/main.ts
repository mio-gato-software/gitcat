import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executePlan, getLlmConfig, getSnapshot, loadLlmConfig, planAction, prepareOperation, saveLlmConfig } from "./git-service.js";
import type { ActionPlan, LlmConfigInput, Operation } from "../shared/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
const openedRepositories = new Set<string>();
const issuedPlans = new Map<string, ActionPlan>();

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
  if (plan.allowed) {
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
  ipcMain.handle("project:select", async (event) => {
    assertTrustedSender(event);
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const snapshot = await getSnapshot(result.filePaths[0]);
    openedRepositories.add(snapshot.path);
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
