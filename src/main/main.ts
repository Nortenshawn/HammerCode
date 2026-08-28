import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { AppController, safeIpcError } from "./controller";
import { loadRuntimeConfig } from "./config";
import { SessionStore } from "./session-store";

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
  controller = new AppController(mainWindow, config, store);
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
  handle("hammercode:update-session-settings", (settings: unknown) =>
    appController.updateSessionSettings(settings),
  );
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
  controller?.cancelTask("应用关闭，正在运行的任务已安全取消；重新打开后不会重放工具调用。");
});
