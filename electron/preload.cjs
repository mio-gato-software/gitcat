const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gitcat", {
  platform: process.platform,
  onOperationProgress: (listener) => {
    const receive = (_event, progress) => listener(progress);
    ipcRenderer.on("operation:progress", receive);
    return () => ipcRenderer.removeListener("operation:progress", receive);
  },
  listOperations: () => ipcRenderer.invoke("operation:list"),
  cancelOperation: (path, id) => ipcRenderer.invoke("operation:cancel", path, id),
  selectProject: (intent, labels) => ipcRenderer.invoke("project:select", intent, labels),
  startTracking: (setupId) => ipcRenderer.invoke("project:start-tracking", setupId),
  openParentProject: (setupId) => ipcRenderer.invoke("project:open-parent", setupId),
  chooseCloneParent: (labels) => ipcRenderer.invoke("clone:choose-parent", labels),
  previewClone: (url, parentId, name) => ipcRenderer.invoke("clone:preview", url, parentId, name),
  startClone: (url, parentId, name) => ipcRenderer.invoke("clone:start", url, parentId, name),
  onCloneProgress: (listener) => {
    const receive = (_event, progress) => listener(progress);
    ipcRenderer.on("clone:progress", receive);
    return () => ipcRenderer.removeListener("clone:progress", receive);
  },
  cancelClone: () => ipcRenderer.invoke("clone:cancel"),
  restoreWorkspace: () => ipcRenderer.invoke("workspace:restore"),
  saveWorkspace: (paths, activePath) => ipcRenderer.invoke("workspace:save", paths, activePath),
  retryProject: (path) => ipcRenderer.invoke("workspace:retry", path),
  locateProject: (path, labels) => ipcRenderer.invoke("workspace:locate", path, labels),
  confirmLocateProject: (candidateId) => ipcRenderer.invoke("workspace:confirm-locate", candidateId),
  getSnapshot: (path) => ipcRenderer.invoke("repo:snapshot", path),
  fetchRemotes: (path) => ipcRenderer.invoke("repo:fetch", path),
  loadHistory: (path, request) => ipcRenderer.invoke("history:load", path, request),
  getCommitDetail: (path, hash) => ipcRenderer.invoke("commit:detail", path, hash),
  getCommitFileDiff: (path, hash, file) => ipcRenderer.invoke("commit:file-detail", path, hash, file),
  proposeConflictResolution: (path, locale) => ipcRenderer.invoke("conflicts:propose", path, locale),
  applyConflictResolution: (path, proposalId, accepted, locale) => ipcRenderer.invoke("conflicts:apply", path, proposalId, accepted, locale),
  describeConflicts: (path, locale) => ipcRenderer.invoke("conflicts:describe", path, locale),
  chooseConflictResolutions: (path, guideId, choices, locale) => ipcRenderer.invoke("conflicts:choose", path, guideId, choices, locale),
  openConflictFile: (path, file, locale) => ipcRenderer.invoke("conflicts:open", path, file, locale),
  planRecovery: (path, failure, context, locale) => ipcRenderer.invoke("action:recover", path, failure, context, locale),
  describeFailure: (path, failure) => ipcRenderer.invoke("action:describe-failure", path, failure),
  prepareRetry: (path, planId, locale) => ipcRenderer.invoke("action:prepare-retry", path, planId, locale),
  getWorkingFileDiff: (path, file) => ipcRenderer.invoke("commit:file-diff", path, file),
  planAction: (path, request, context, locale) => ipcRenderer.invoke("action:plan", path, request, context, locale),
  prepareOperation: (path, operation, args, locale) => ipcRenderer.invoke("action:prepare", path, operation, args, locale),
  prepareBranchDelivery: (path, request, locale) => ipcRenderer.invoke("action:prepare-delivery", path, request, locale),
  prepareMergeToDefault: (path, branch, locale) => ipcRenderer.invoke("action:prepare-merge-to-default", path, branch, locale),
  generateCommitDescription: (path, locale, paths) => ipcRenderer.invoke("commit:generate-description", path, locale, paths),
  getSelectionDiff: (path, paths, locale) => ipcRenderer.invoke("commit:selection-diff", path, paths, locale),
  executePlan: (path, planId, locale) => ipcRenderer.invoke("action:execute", path, planId, locale),
  getAiSharing: (path, purpose, paths, locale) => ipcRenderer.invoke("sharing:get", path, purpose, paths, locale),
  acknowledgeAiSharing: (path) => ipcRenderer.invoke("sharing:acknowledge", path),
  setAiSharingExclusions: (path, exclusions, locale) => ipcRenderer.invoke("sharing:set-exclusions", path, exclusions, locale),
  setAiSharingReview: (path, file, share, locale) => ipcRenderer.invoke("sharing:review", path, file, share, locale),
  scanChangesForSecrets: (path) => ipcRenderer.invoke("changes:scan-secrets", path),
  getLlmConfig: () => ipcRenderer.invoke("llm:get-config"),
  saveLlmConfig: (config) => ipcRenderer.invoke("llm:save-config", config),
  verifyLlmConfig: () => ipcRenderer.invoke("llm:verify"),
  openProviderPage: (page) => ipcRenderer.invoke("llm:open-provider-page", page),
  checkReadiness: (path, request) => ipcRenderer.invoke("readiness:check", path, request),
  openHelpPage: (page) => ipcRenderer.invoke("help:open-page", page)
});
