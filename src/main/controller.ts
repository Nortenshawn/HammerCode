import { dialog, type BrowserWindow } from "electron";
import { z } from "zod";
import { AgentRunner } from "../core/agent-runner";
import { DeepSeekChatClient } from "../core/model/deepseek-client";
import { WorkspaceBoundary } from "../core/security/path-boundary";
import { DEFAULT_SYSTEM_PROMPT } from "../core/system-prompt";
import { LocalToolExecutor } from "../core/tools/tool-executor";
import { HammerCodeError } from "../core/types";
import { redactSecrets, systemClock, toErrorMessage, uuidGenerator } from "../core/utils";
import type { AgentSession, AppBootstrap, RendererEvent } from "../shared/contracts";
import { PendingApprovalGateway } from "./approval-gateway";
import type { RuntimeConfig } from "./config";
import { toPublicConfig } from "./config";
import { SessionStore } from "./session-store";

const taskSchema = z.string().trim().min(1).max(100_000);
const approvalIdSchema = z.string().min(1).max(200);

export class AppController {
  private workspaceRoot: string | null = null;
  private currentSession: AgentSession | null = null;
  private runner: AgentRunner | null = null;
  private approvals: PendingApprovalGateway | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly config: RuntimeConfig,
    private readonly store: SessionStore,
  ) {}

  async initialize(): Promise<void> {
    this.currentSession = await this.store.load();
    this.workspaceRoot = this.currentSession?.workspaceRoot ?? null;
  }

  bootstrap(): AppBootstrap {
    return {
      session: this.currentSession,
      workspaceRoot: this.workspaceRoot,
      config: toPublicConfig(this.config),
    };
  }

  async chooseWorkspace(): Promise<string | null> {
    if (this.isRunning()) throw new HammerCodeError("任务运行时不能切换工作区", "SESSION_BUSY", true);
    const result = await dialog.showOpenDialog(this.window, {
      title: "选择 HammerCode 工作区",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "选择工作区",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const boundary = await WorkspaceBoundary.create(result.filePaths[0]);
    this.workspaceRoot = boundary.root;
    return this.workspaceRoot;
  }

  async startTask(input: unknown): Promise<{ sessionId: string }> {
    const task = taskSchema.parse(input);
    if (!this.workspaceRoot) {
      throw new HammerCodeError("请先选择工作区", "WORKSPACE_REQUIRED", true);
    }
    if (!this.config.apiKey) {
      throw new HammerCodeError("未配置 DEEPSEEK_API_KEY", "API_KEY_REQUIRED", true);
    }
    if (this.isRunning()) throw new HammerCodeError("已有任务正在运行", "SESSION_BUSY", true);

    const boundary = await WorkspaceBoundary.create(this.workspaceRoot);
    const approvals = new PendingApprovalGateway();
    const tools = new LocalToolExecutor(boundary, uuidGenerator);
    const model = new DeepSeekChatClient({
      apiKey: this.config.apiKey,
      baseUrl: this.config.apiBaseUrl,
      model: this.config.model,
      thinking: this.config.thinking,
      reasoningEffort: this.config.reasoningEffort,
      maxOutputTokens: this.config.maxOutputTokens,
      requestTimeoutMs: this.config.requestTimeoutMs,
    });
    const runner = new AgentRunner(
      {
        model,
        tools,
        approvals,
        clock: systemClock,
        ids: uuidGenerator,
        onSessionChange: async (session) => {
          this.currentSession = session;
          await this.store.save(session);
          this.emit({ type: "session_snapshot", session });
        },
      },
      {
        maxRounds: this.config.maxAgentRounds,
        contextTokenBudget: this.config.contextTokenBudget,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
      },
    );
    this.runner = runner;
    this.approvals = approvals;
    const run = runner.start(task, boundary.root);
    const snapshot = runner.snapshot;
    if (!snapshot) throw new HammerCodeError("无法创建会话", "SESSION_CREATE_FAILED");
    void run.catch((error: unknown) => {
      this.emit({ type: "notification", level: "error", message: toErrorMessage(error) });
    });
    return { sessionId: snapshot.id };
  }

  cancelTask(): void {
    this.runner?.cancel();
    this.approvals?.cancel();
  }

  resolveApproval(idInput: unknown, approved: unknown): void {
    const id = approvalIdSchema.parse(idInput);
    if (typeof approved !== "boolean") {
      throw new HammerCodeError("审批结果必须为布尔值", "INVALID_APPROVAL", true);
    }
    this.approvals?.resolve(id, approved);
  }

  async clearSession(): Promise<void> {
    if (this.isRunning()) throw new HammerCodeError("请先取消当前任务", "SESSION_BUSY", true);
    this.currentSession = null;
    this.runner = null;
    this.approvals = null;
    await this.store.clear();
    this.emit({ type: "session_cleared" });
  }

  private isRunning(): boolean {
    return Boolean(
      this.currentSession &&
        ["requesting", "awaiting_approval", "executing_tool"].includes(
          this.currentSession.status,
        ),
    );
  }

  private emit(event: RendererEvent): void {
    if (!this.window.isDestroyed()) this.window.webContents.send("hammercode:event", event);
  }
}

export function safeIpcError(error: unknown): Error {
  return new Error(redactSecrets(toErrorMessage(error)));
}
