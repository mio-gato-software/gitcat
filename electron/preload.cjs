const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("branchline", {
  platform: process.platform,
  selectProject: () => ipcRenderer.invoke("project:select"),
  restoreWorkspace: () => ipcRenderer.invoke("workspace:restore"),
  saveWorkspace: (paths, activePath) => ipcRenderer.invoke("workspace:save", paths, activePath),
  getSnapshot: (path) => ipcRenderer.invoke("repo:snapshot", path),
  planAction: (path, request, context) => ipcRenderer.invoke("action:plan", path, request, context),
  prepareOperation: (path, operation, args) => ipcRenderer.invoke("action:prepare", path, operation, args),
  generateCommitDescription: (path) => ipcRenderer.invoke("commit:generate-description", path),
  executePlan: (path, planId) => ipcRenderer.invoke("action:execute", path, planId),
  getLlmConfig: () => ipcRenderer.invoke("llm:get-config"),
  saveLlmConfig: (config) => ipcRenderer.invoke("llm:save-config", config)
});
