const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("branchline", {
  platform: process.platform,
  selectProject: () => ipcRenderer.invoke("project:select"),
  restoreWorkspace: () => ipcRenderer.invoke("workspace:restore"),
  saveWorkspace: (paths, activePath) => ipcRenderer.invoke("workspace:save", paths, activePath),
  getSnapshot: (path) => ipcRenderer.invoke("repo:snapshot", path),
  loadHistory: (path, request) => ipcRenderer.invoke("history:load", path, request),
  getCommitDetail: (path, hash) => ipcRenderer.invoke("commit:detail", path, hash),
  getCommitFileDiff: (path, hash, file) => ipcRenderer.invoke("commit:file-detail", path, hash, file),
  proposeConflictResolution: (path) => ipcRenderer.invoke("conflicts:propose", path),
  applyConflictResolution: (path, resolutions) => ipcRenderer.invoke("conflicts:apply", path, resolutions),
  planRecovery: (path, failure, context) => ipcRenderer.invoke("action:recover", path, failure, context),
  getWorkingFileDiff: (path, file) => ipcRenderer.invoke("commit:file-diff", path, file),
  planAction: (path, request, context) => ipcRenderer.invoke("action:plan", path, request, context),
  prepareOperation: (path, operation, args) => ipcRenderer.invoke("action:prepare", path, operation, args),
  prepareMergeToDefault: (path, branch) => ipcRenderer.invoke("action:prepare-merge-to-default", path, branch),
  generateCommitDescription: (path) => ipcRenderer.invoke("commit:generate-description", path),
  executePlan: (path, planId) => ipcRenderer.invoke("action:execute", path, planId),
  getLlmConfig: () => ipcRenderer.invoke("llm:get-config"),
  saveLlmConfig: (config) => ipcRenderer.invoke("llm:save-config", config)
});
