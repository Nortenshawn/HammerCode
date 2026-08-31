import { contextBridge, ipcRenderer } from "electron";
import type { HammerCodeApi, RendererEvent } from "../shared/contracts";

const api: HammerCodeApi = {
  bootstrap: () => ipcRenderer.invoke("hammercode:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("hammercode:choose-workspace"),
  selectWorkspace: (workspaceRoot) =>
    ipcRenderer.invoke("hammercode:select-workspace", workspaceRoot),
  newChat: () => ipcRenderer.invoke("hammercode:new-chat"),
  selectSession: (sessionId) => ipcRenderer.invoke("hammercode:select-session", sessionId),
  archiveSession: (sessionId) => ipcRenderer.invoke("hammercode:archive-session", sessionId),
  restoreSession: (sessionId) => ipcRenderer.invoke("hammercode:restore-session", sessionId),
  archiveWorkspaceChats: (workspaceRoot) => ipcRenderer.invoke("hammercode:archive-workspace-chats", workspaceRoot),
  restoreWorkspaceChats: (workspaceRoot) => ipcRenderer.invoke("hammercode:restore-workspace-chats", workspaceRoot),
  setProjectPinned: (workspaceRoot, pinned) => ipcRenderer.invoke("hammercode:set-project-pinned", workspaceRoot, pinned),
  renameProject: (workspaceRoot, name) => ipcRenderer.invoke("hammercode:rename-project", workspaceRoot, name),
  archiveProject: (workspaceRoot) => ipcRenderer.invoke("hammercode:archive-project", workspaceRoot),
  restoreProject: (workspaceRoot) => ipcRenderer.invoke("hammercode:restore-project", workspaceRoot),
  removeProject: (workspaceRoot) => ipcRenderer.invoke("hammercode:remove-project", workspaceRoot),
  updateSessionSettings: (settings) =>
    ipcRenderer.invoke("hammercode:update-session-settings", settings),
  testModelConnection: (input) =>
    ipcRenderer.invoke("hammercode:test-model-connection", input),
  saveModelConnection: (input) =>
    ipcRenderer.invoke("hammercode:save-model-connection", input),
  renameModelConnection: (connectionId, name) =>
    ipcRenderer.invoke("hammercode:rename-model-connection", connectionId, name),
  deleteModelConnection: (connectionId) =>
    ipcRenderer.invoke("hammercode:delete-model-connection", connectionId),
  compressContext: () => ipcRenderer.invoke("hammercode:compress-context"),
  openSideChat: () => ipcRenderer.invoke("hammercode:open-side-chat"),
  sendSideChat: (sideChatId, content) =>
    ipcRenderer.invoke("hammercode:send-side-chat", sideChatId, content),
  cancelSideChat: (sideChatId) =>
    ipcRenderer.invoke("hammercode:cancel-side-chat", sideChatId),
  closeSideChat: (sideChatId) =>
    ipcRenderer.invoke("hammercode:close-side-chat", sideChatId),
  searchWorkspaceEntries: (query) =>
    ipcRenderer.invoke("hammercode:search-workspace-entries", query),
  chooseWorkspaceEntry: () =>
    ipcRenderer.invoke("hammercode:choose-workspace-entry"),
  previewWorkspaceEntry: (path) =>
    ipcRenderer.invoke("hammercode:preview-workspace-entry", path),
  previewSkill: (skillKey) =>
    ipcRenderer.invoke("hammercode:preview-skill", skillKey),
  listProjectMemory: (workspaceRoot) => ipcRenderer.invoke("hammercode:list-project-memory", workspaceRoot),
  updateProjectMemorySettings: (workspaceRoot, settings) =>
    ipcRenderer.invoke("hammercode:update-project-memory-settings", workspaceRoot, settings),
  configureProjectMemoryExport: (workspaceRoot, mode) =>
    ipcRenderer.invoke("hammercode:configure-project-memory-export", workspaceRoot, mode),
  exportProjectMemory: (workspaceRoot) => ipcRenderer.invoke("hammercode:export-project-memory", workspaceRoot),
  importProjectMemory: (workspaceRoot) => ipcRenderer.invoke("hammercode:import-project-memory", workspaceRoot),
  deleteProjectMemory: (workspaceRoot, memoryId) => ipcRenderer.invoke("hammercode:delete-project-memory", workspaceRoot, memoryId),
  updateSkillSettings: (settings) => ipcRenderer.invoke("hammercode:update-skill-settings", settings),
  setSkillEnabled: (skillKey, enabled, trustProject) =>
    ipcRenderer.invoke("hammercode:set-skill-enabled", skillKey, enabled, trustProject),
  importSkill: () => ipcRenderer.invoke("hammercode:import-skill"),
  exportSkill: (skillKey) => ipcRenderer.invoke("hammercode:export-skill", skillKey),
  uninstallSkill: (skillKey) => ipcRenderer.invoke("hammercode:uninstall-skill", skillKey),
  startTask: (request) => ipcRenderer.invoke("hammercode:start-task", request),
  requestUndo: (changeId) => ipcRenderer.invoke("hammercode:request-undo", changeId),
  cancelTask: (sessionId) => ipcRenderer.invoke("hammercode:cancel-task", sessionId),
  resolveApproval: (sessionId, approvalId, approved) =>
    ipcRenderer.invoke("hammercode:resolve-approval", sessionId, approvalId, approved),
  clearSession: () => ipcRenderer.invoke("hammercode:clear-session"),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RendererEvent) => listener(payload);
    ipcRenderer.on("hammercode:event", handler);
    return () => ipcRenderer.removeListener("hammercode:event", handler);
  },
};

contextBridge.exposeInMainWorld("hammerCode", api);
