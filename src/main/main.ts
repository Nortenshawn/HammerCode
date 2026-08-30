import path from "node:path";
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { AppController, safeIpcError } from "./controller";
import { loadRuntimeConfig } from "./config";
import { ModelCredentialStore } from "./model-credential-store";
import { ProjectMemoryStore } from "./project-memory-store";
import { SessionStore } from "./session-store";
import { SkillStore } from "./skill-store";
import { systemClock, uuidGenerator } from "../core/utils";

let mainWindow: BrowserWindow | null = null;
let controller: AppController | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "HammerCode",
    backgroundColor: "#f7f7f5",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.HAMMERCODE_DEV_SERVER_URL;
    if (!devUrl || !url.startsWith(devUrl)) event.preventDefault();
  });

  const config = loadRuntimeConfig();
  const store = new SessionStore(path.join(app.getPath("userData"), "sessions"));
  const modelCredentials = new ModelCredentialStore(
    path.join(app.getPath("userData"), "settings"),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
  );
  const projectMemory = new ProjectMemoryStore(
    path.join(app.getPath("userData"), "project-memory"),
    systemClock,
    uuidGenerator,
    (snapshot) => controller?.handleProjectMemoryChange(snapshot),
  );
  const skillStore = new SkillStore(
    {
      builtinRoot: path.join(app.getAppPath(), "skills", "builtin"),
      userRoot: path.join(app.getPath("userData"), "skills", "packages"),
      settingsFile: path.join(app.getPath("userData"), "settings", "skill-settings.json"),
      trashRoot: path.join(app.getPath("userData"), "skills", "removed"),
    },
    systemClock,
    uuidGenerator,
    (snapshot) => controller?.handleSkillChange(snapshot),
  );
  controller = new AppController(mainWindow, config, store, modelCredentials, projectMemory, skillStore);
  await controller.initialize();
  registerIpc(controller);

  const devServerUrl = process.env.HAMMERCODE_DEV_SERVER_URL;
  if (devServerUrl) await mainWindow.loadURL(devServerUrl);
  else await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function registerIpc(appController: AppController): void {
  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    callback: (...args: TArgs) => TResult | Promise<TResult>,
  ): void => {
    ipcMain.handle(channel, async (_event, ...args: TArgs) => {
      try {
        return await callback(...args);
      } catch (error) {
        throw safeIpcError(error);
      }
    });
  };

  handle("hammercode:bootstrap", () => appController.bootstrap());
  handle("hammercode:choose-workspace", () => appController.chooseWorkspace());
  handle("hammercode:select-workspace", (workspaceRoot: unknown) =>
    appController.selectWorkspace(workspaceRoot),
  );
  handle("hammercode:new-chat", () => appController.newChat());
  handle("hammercode:select-session", (sessionId: unknown) =>
    appController.selectSession(sessionId),
  );
  handle("hammercode:archive-session", (sessionId: unknown) =>
    appController.archiveSession(sessionId),
  );
  handle("hammercode:restore-session", (sessionId: unknown) =>
    appController.restoreSession(sessionId),
  );
  handle("hammercode:archive-workspace-chats", (workspaceRoot: unknown) =>
    appController.archiveWorkspaceChats(workspaceRoot),
  );
  handle("hammercode:restore-workspace-chats", (workspaceRoot: unknown) =>
    appController.restoreWorkspaceChats(workspaceRoot),
  );
  handle("hammercode:set-project-pinned", (workspaceRoot: unknown, pinned: unknown) =>
    appController.setProjectPinned(workspaceRoot, pinned),
  );
  handle("hammercode:rename-project", (workspaceRoot: unknown, name: unknown) =>
    appController.renameProject(workspaceRoot, name),
  );
  handle("hammercode:archive-project", (workspaceRoot: unknown) =>
    appController.archiveProject(workspaceRoot),
  );
  handle("hammercode:restore-project", (workspaceRoot: unknown) =>
    appController.restoreProject(workspaceRoot),
  );
  handle("hammercode:remove-project", (workspaceRoot: unknown) =>
    appController.removeProject(workspaceRoot),
  );
  handle("hammercode:update-session-settings", (settings: unknown) =>
    appController.updateSessionSettings(settings),
  );
  handle("hammercode:test-model-connection", (input: unknown) =>
    appController.testModelConnection(input),
  );
  handle("hammercode:save-model-connection", (input: unknown) =>
    appController.saveModelConnection(input),
  );
  handle("hammercode:rename-model-connection", (connectionId: unknown, name: unknown) =>
    appController.renameModelConnection(connectionId, name),
  );
  handle("hammercode:delete-model-connection", (connectionId: unknown) =>
    appController.deleteModelConnection(connectionId),
  );
  handle("hammercode:compress-context", () => appController.compressContext());
  handle("hammercode:open-side-chat", () => appController.openSideChat());
  handle("hammercode:send-side-chat", (sideChatId: unknown, content: unknown) =>
    appController.sendSideChat(sideChatId, content),
  );
  handle("hammercode:cancel-side-chat", (sideChatId: unknown) =>
    appController.cancelSideChat(sideChatId),
  );
  handle("hammercode:close-side-chat", (sideChatId: unknown) =>
    appController.closeSideChat(sideChatId),
  );
  handle("hammercode:search-workspace-entries", (query: unknown) =>
    appController.searchWorkspaceEntries(query),
  );
  handle("hammercode:choose-workspace-entry", () =>
    appController.chooseWorkspaceEntry(),
  );
  handle("hammercode:preview-workspace-entry", (path: unknown) =>
    appController.previewWorkspaceEntry(path),
  );
  handle("hammercode:preview-skill", (skillKey: unknown) =>
    appController.previewSkill(skillKey),
  );
  handle("hammercode:list-project-memory", (workspaceRoot: unknown) => appController.listProjectMemory(workspaceRoot));
  handle("hammercode:update-project-memory-settings", (workspaceRoot: unknown, settings: unknown) =>
    appController.updateProjectMemorySettings(workspaceRoot, settings),
  );
  handle("hammercode:configure-project-memory-export", (workspaceRoot: unknown, mode: unknown) =>
    appController.configureProjectMemoryExport(workspaceRoot, mode),
  );
  handle("hammercode:export-project-memory", (workspaceRoot: unknown) => appController.exportProjectMemory(workspaceRoot));
  handle("hammercode:import-project-memory", (workspaceRoot: unknown) => appController.importProjectMemory(workspaceRoot));
  handle("hammercode:delete-project-memory", (workspaceRoot: unknown, memoryId: unknown) =>
    appController.deleteProjectMemory(workspaceRoot, memoryId),
  );
  handle("hammercode:update-skill-settings", (settings: unknown) =>
    appController.updateSkillSettings(settings),
  );
  handle("hammercode:set-skill-enabled", (skillKey: unknown, enabled: unknown, trustProject: unknown) =>
    appController.setSkillEnabled(skillKey, enabled, trustProject),
  );
  handle("hammercode:import-skill", () => appController.importSkill());
  handle("hammercode:export-skill", (skillKey: unknown) => appController.exportSkill(skillKey));
  handle("hammercode:uninstall-skill", (skillKey: unknown) => appController.uninstallSkill(skillKey));
  handle("hammercode:start-task", (request: unknown) => appController.startTask(request));
  handle("hammercode:request-undo", (changeId: unknown) => appController.requestUndo(changeId));
  handle("hammercode:cancel-task", () =>
    appController.cancelTask("用户点击了停止按钮，任务已安全取消。"),
  );
  handle("hammercode:resolve-approval", (id: unknown, approved: unknown) =>
    appController.resolveApproval(id, approved),
  );
  handle("hammercode:clear-session", () => appController.clearSession());
}

app.whenReady().then(createWindow).catch((error: unknown) => {
  console.error("HammerCode failed to start:", safeIpcError(error).message);
  app.quit();
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  controller?.shutdown();
});
