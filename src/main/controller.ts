import path from "node:path";
import { dialog, type BrowserWindow } from "electron";
import { z } from "zod";
import { AgentRunner } from "../core/agent-runner";
import { fallbackChatTitle, generateChatTitle } from "../core/chat-title";
import { compactContextWithModel, type ModelContextCompactionResult } from "../core/context-compactor";
import { estimateTokens, systemPromptWithContextMemory } from "../core/context";
import { reconcilePendingUndo } from "../core/file-state";
import { prepareFileUndo } from "../core/file-undo";
import { OpenAICompatibleChatClient } from "../core/model/openai-compatible-client";
import { EphemeralSideChat } from "../core/side-chat";
import { WorkspaceBoundary } from "../core/security/path-boundary";
import { DEFAULT_SYSTEM_PROMPT } from "../core/system-prompt";
import { LocalToolExecutor } from "../core/tools/tool-executor";
import { HammerCodeError } from "../core/types";
import { isAbortError, redactSecrets, systemClock, toErrorMessage, uuidGenerator } from "../core/utils";
import {
  BUILTIN_MODEL_REFS,
  MODEL_TIERS,
  PERMISSION_MODES,
  type AgentSession,
  type AppBootstrap,
  type EphemeralSideChatState,
  type ModelConnectionInput,
  type ModelRef,
  type RendererEvent,
  type SessionSettings,
  type SessionSummary,
  type WorkspaceSummary,
} from "../shared/contracts";
import { PendingApprovalGateway } from "./approval-gateway";
import type { RuntimeConfig } from "./config";
import { toPublicConfig } from "./config";
import { ModelCredentialStore } from "./model-credential-store";
import { SessionStore } from "./session-store";
import { searchWorkspace } from "./workspace-search";

const startTaskSchema = z
  .object({
    task: z.string().trim().min(1).max(100_000),
    modelTier: z.enum(MODEL_TIERS),
    modelRef: z.enum(BUILTIN_MODEL_REFS).optional(),
    permissionMode: z.enum(PERMISSION_MODES),
  })
  .strict();
const settingsSchema = startTaskSchema.omit({ task: true });
const approvalIdSchema = z.string().min(1).max(200);
const sessionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const changeIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const workspaceRootSchema = z.string().min(1).max(4096);
const workspaceQuerySchema = z.string().max(240);
const modelConnectionSchema = z.object({
  tier: z.enum(MODEL_TIERS),
  apiBaseUrl: z.string().trim().min(1).max(2_048),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
}).strict();
const sideChatIdSchema = z.string().regex(/^btw_[a-zA-Z0-9_-]{1,200}$/);
const sideChatContentSchema = z.string().trim().min(1).max(20_000);

function toSummary(session: AgentSession): SessionSummary {
  return {
    id: session.id,
    workspaceRoot: session.workspaceRoot,
    title: fallbackChatTitle(session.title ?? session.task),
    status: session.status,
    turnCount: session.turns.length,
    changedFileCount: new Set(
      session.fileChanges
        .filter((change) => change.status === "applied")
        .map((change) => change.path),
    ).size,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export class AppController {
  private workspaceRoot: string | null = null;
  private workspaces: WorkspaceSummary[] = [];
  private currentSession: AgentSession | null = null;
  private sessions: SessionSummary[] = [];
  private runner: AgentRunner | null = null;
  private approvals: PendingApprovalGateway | null = null;
  private undoAbort: AbortController | null = null;
  private contextCompactionAbort: AbortController | null = null;
  private runningSessionId: string | null = null;
  private sideChat: EphemeralSideChat | null = null;
  private readonly titleRequests = new Set<string>();
  private readonly pendingTitles = new Map<string, string>();
  private navigationRevision = 0;

  constructor(
    private readonly window: BrowserWindow,
    private readonly config: RuntimeConfig,
    private readonly store: SessionStore,
    private readonly modelCredentials: ModelCredentialStore,
  ) {}

  async initialize(): Promise<void> {
    await this.modelCredentials.load(this.config.models);
    await this.refreshNavigation();
    await this.reconcileInterruptedUndo();
  }

  bootstrap(): AppBootstrap {
    return {
      session: this.currentSession,
      sessions: this.sessions,
      workspaces: this.workspaces,
      workspaceRoot: this.workspaceRoot,
      config: this.publicConfig(),
    };
  }

  async chooseWorkspace(): Promise<string | null> {
    if (this.isUndoBusy()) throw new HammerCodeError("撤销运行时不能切换工作区", "SESSION_BUSY", true);
    const result = await dialog.showOpenDialog(this.window, {
      title: "选择 HammerCode 工作区",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "选择工作区",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    this.destroySideChat();
    const boundary = await WorkspaceBoundary.create(result.filePaths[0]);
    this.navigationRevision += 1;
    await this.store.setWorkspaceRoot(boundary.root);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
    return this.workspaceRoot;
  }

  async selectWorkspace(input: unknown): Promise<void> {
    if (this.isUndoBusy()) throw new HammerCodeError("撤销运行时不能切换工作区", "SESSION_BUSY", true);
    const requestedRoot = workspaceRootSchema.parse(input);
    if (!this.workspaces.some((workspace) => workspace.root === requestedRoot)) {
      throw new HammerCodeError("找不到这个工作区", "WORKSPACE_NOT_FOUND", true);
    }
    const boundary = await WorkspaceBoundary.create(requestedRoot);
    if (boundary.root !== requestedRoot) {
      throw new HammerCodeError("工作区真实路径已经变化，请重新添加", "WORKSPACE_PATH_CHANGED", true);
    }
    this.destroySideChat();
    this.navigationRevision += 1;
    await this.store.selectWorkspace(boundary.root);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async newChat(): Promise<void> {
    if (this.isUndoBusy()) throw new HammerCodeError("请先完成或取消当前撤销", "SESSION_BUSY", true);
    this.destroySideChat();
    this.navigationRevision += 1;
    this.currentSession = null;
    if (this.workspaceRoot) await this.store.setActive(null);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async selectSession(idInput: unknown): Promise<void> {
    if (this.isUndoBusy()) throw new HammerCodeError("撤销运行时不能切换聊天", "SESSION_BUSY", true);
    const id = sessionIdSchema.parse(idInput);
    const session = await this.store.loadSession(id, {
      preserveActive: id === this.runningSessionId,
    });
    if (!session) throw new HammerCodeError("找不到这条聊天记录", "SESSION_NOT_FOUND", true);
    if (!this.workspaces.some((workspace) => workspace.root === session.workspaceRoot)) {
      throw new HammerCodeError("聊天所属工作区不在项目索引中", "SESSION_WORKSPACE_MISMATCH", true);
    }
    this.destroySideChat();
    this.navigationRevision += 1;
    await this.store.selectWorkspace(session.workspaceRoot);
    await this.store.setActive(id);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async updateSessionSettings(input: unknown): Promise<void> {
    const settings = settingsSchema.parse(input);
    const session = this.currentSession;
    if (!session) throw new HammerCodeError("当前没有聊天", "NO_SESSION", true);
    if (this.runningSessionId === session.id || this.isUndoBusy()) {
      throw new HammerCodeError("任务、审批或撤销运行时不能切换模型或权限", "SESSION_BUSY", true);
    }
    this.resolveModel(settings.modelTier, settings.modelRef);
    session.modelTier = settings.modelTier;
    session.modelRef = settings.modelRef ?? `builtin:${settings.modelTier}`;
    session.permissionMode = settings.permissionMode;
    session.updatedAt = systemClock.now().toISOString();
    await this.store.save(session);
    this.upsertSummary(session);
    this.upsertWorkspace(session);
    this.emit({ type: "session_snapshot", session });
  }

  async startTask(input: unknown): Promise<{ sessionId: string }> {
    const request = startTaskSchema.parse(input);
    if (!this.workspaceRoot) {
      throw new HammerCodeError("请先选择工作区", "WORKSPACE_REQUIRED", true);
    }
    if (this.isBusy()) throw new HammerCodeError("已有任务或撤销正在运行", "SESSION_BUSY", true);
    const selected = this.resolveModel(request.modelTier, request.modelRef);
    const modelConfig = selected.config;

    const boundary = await WorkspaceBoundary.create(this.workspaceRoot);
    const approvals = new PendingApprovalGateway();
    const tools = new LocalToolExecutor(boundary, uuidGenerator);
    const model = new OpenAICompatibleChatClient({
      provider: modelConfig.provider,
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.apiBaseUrl,
      model: modelConfig.model,
      thinking: modelConfig.thinking,
      reasoningEffort: modelConfig.reasoningEffort,
      maxOutputTokens: modelConfig.maxOutputTokens,
      requestTimeoutMs: modelConfig.requestTimeoutMs,
    });
    const startNavigationRevision = this.navigationRevision;
    const runner = new AgentRunner(
      {
        model,
        tools,
        approvals,
        clock: systemClock,
        ids: uuidGenerator,
        onSessionChange: async (session) => {
          const pendingTitle = this.pendingTitles.get(session.id);
          if (pendingTitle) {
            session.title = pendingTitle;
            this.pendingTitles.delete(session.id);
          }
          this.runningSessionId ??= session.id;
          const selected =
            this.currentSession?.id === session.id ||
            (this.navigationRevision === startNavigationRevision &&
              this.workspaceRoot === session.workspaceRoot);
          if (selected) this.currentSession = session;
          this.upsertSummary(session);
          this.upsertWorkspace(session, selected);
          await this.store.save(session, { activate: selected });
          this.emit(selected
            ? { type: "session_snapshot", session }
            : { type: "session_updated", session });
        },
      },
      {
        maxRounds: this.config.maxAgentRounds,
        maxToolCalls: this.config.maxToolCalls,
        maxRunTimeMs: this.config.maxRunTimeMs,
        maxModelRetries: this.config.maxModelRetries,
        retryBaseDelayMs: this.config.retryBaseDelayMs,
        retryMaxDelayMs: this.config.retryMaxDelayMs,
        maxOutputTokens: modelConfig.maxOutputTokens,
        autoCompactRatio: this.config.autoCompactRatio,
        contextTokenBudget: this.config.contextTokenBudget,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
      },
    );
    this.runner = runner;
    this.approvals = approvals;
    const settings: SessionSettings = {
      modelTier: request.modelTier,
      modelRef: selected.modelRef,
      permissionMode: request.permissionMode,
    };
    const run = this.currentSession
      ? runner.resume(this.currentSession, request.task, settings)
      : runner.start(request.task, boundary.root, settings);
    const snapshot = runner.snapshot;
    if (!snapshot) throw new HammerCodeError("无法创建会话", "SESSION_CREATE_FAILED");
    this.currentSession = snapshot;
    this.runningSessionId = snapshot.id;
    this.upsertSummary(snapshot);
    this.upsertWorkspace(snapshot);
    this.emit({ type: "session_snapshot", session: snapshot });
    void run
      .catch((error: unknown) => {
        this.emit({ type: "notification", level: "error", message: toErrorMessage(error) });
      })
      .finally(() => {
        if (this.runningSessionId === snapshot.id) this.runningSessionId = null;
        if (this.runner === runner) this.runner = null;
        if (this.approvals === approvals) this.approvals = null;
        void this.generateAndPersistTitle(snapshot.id);
      });
    return { sessionId: snapshot.id };
  }

  async testModelConnection(input: unknown) {
    const parsed: ModelConnectionInput = modelConnectionSchema.parse(input);
    return this.modelCredentials.test(parsed, this.config.models[parsed.tier]);
  }

  async saveModelConnection(input: unknown) {
    const parsed: ModelConnectionInput = modelConnectionSchema.parse(input);
    const result = await this.modelCredentials.save(parsed, this.config.models[parsed.tier]);
    this.emit({
      type: "config_updated",
      config: this.publicConfig(),
    });
    return result;
  }

  async compressContext() {
    const session = this.currentSession;
    if (!session) throw new HammerCodeError("当前没有可压缩的聊天", "NO_SESSION", true);
    if (this.isBusy() || !["completed", "cancelled", "failed"].includes(session.status)) {
      throw new HammerCodeError("只能在当前任务结束后压缩上下文", "SESSION_BUSY", true);
    }
    const selected = this.resolveModel(session.modelTier, session.modelRef);
    const abort = new AbortController();
    this.contextCompactionAbort = abort;
    try {
      const result = await this.compactContextWithRetry(
        this.createModelClient(selected.config, {
          maxOutputTokens: Math.min(8_192, selected.config.maxOutputTokens),
          requestTimeoutMs: Math.max(60_000, selected.config.requestTimeoutMs),
        }),
        session,
        abort.signal,
      );
      if (this.currentSession?.id !== session.id) {
        throw new HammerCodeError("压缩期间当前聊天已经变化，未写入新记忆", "CONTEXT_COMPACTION_STALE", true);
      }
      session.contextMemory = result.memory;
      const activeTurn = session.turns.find((turn) => turn.id === session.activeTurnId);
      if (activeTurn?.metrics) {
        activeTurn.metrics.modelRequests += result.attempts;
        activeTurn.metrics.retryCount += result.attempts - 1;
        activeTurn.metrics.promptTokens += result.promptTokens;
        activeTurn.metrics.completionTokens += result.completionTokens;
        activeTurn.metrics.tokenUsageEstimated ||= result.usageEstimated;
        activeTurn.metrics.contextCompactions += 1;
        activeTurn.metrics.currentContextTokens = estimateTokens(
          systemPromptWithContextMemory(DEFAULT_SYSTEM_PROMPT, result.memory),
        );
      }
      session.updatedAt = result.memory.updatedAt;
      await this.store.save(session);
      this.upsertSummary(session);
      this.upsertWorkspace(session);
      this.emit({ type: "session_snapshot", session });
      return result.memory;
    } catch (error) {
      if (isAbortError(error) || abort.signal.aborted) {
        throw new HammerCodeError("上下文压缩已停止，旧记忆保持不变", "CONTEXT_COMPACTION_CANCELLED", true);
      }
      throw error;
    } finally {
      if (this.contextCompactionAbort === abort) this.contextCompactionAbort = null;
    }
  }

  openSideChat(): EphemeralSideChatState {
    const source = this.currentSession;
    if (!source) throw new HammerCodeError("请先打开一条主聊天", "NO_SESSION", true);
    if (this.sideChat?.snapshot.sourceSessionId === source.id) return this.sideChat.snapshot;
    this.destroySideChat();
    const selected = this.resolveModel(source.modelTier, source.modelRef);
    const modelConfig = selected.config;
    const model = this.createModelClient(modelConfig);
    let sideChat: EphemeralSideChat;
    sideChat = new EphemeralSideChat({
      model,
      modelTier: source.modelTier,
      modelRef: selected.modelRef,
      source,
      clock: systemClock,
      ids: uuidGenerator,
      onChange: (state) => {
        if (this.sideChat === sideChat) this.emit({ type: "side_chat_snapshot", sideChat: state });
      },
    });
    this.sideChat = sideChat;
    this.emit({ type: "side_chat_snapshot", sideChat: sideChat.snapshot });
    return sideChat.snapshot;
  }

  sendSideChat(idInput: unknown, contentInput: unknown): void {
    const sideChat = this.requireSideChat(idInput);
    const content = sideChatContentSchema.parse(contentInput);
    void sideChat.send(content).catch((error: unknown) => {
      this.emit({ type: "notification", level: "error", message: toErrorMessage(error) });
    });
  }

  cancelSideChat(idInput: unknown): void {
    this.requireSideChat(idInput).cancel();
  }

  closeSideChat(idInput: unknown): void {
    this.requireSideChat(idInput);
    this.destroySideChat();
  }

  async searchWorkspaceEntries(input: unknown) {
    const query = workspaceQuerySchema.parse(input);
    if (!this.workspaceRoot) return [];
    const boundary = await WorkspaceBoundary.create(this.workspaceRoot);
    return searchWorkspace(boundary, query);
  }

  cancelTask(detail = "任务已由用户取消"): void {
    this.runner?.cancel(detail);
    this.approvals?.cancel();
    this.undoAbort?.abort(new DOMException("用户取消撤销", "AbortError"));
    this.contextCompactionAbort?.abort(new DOMException("用户停止上下文压缩", "AbortError"));
  }

  resolveApproval(idInput: unknown, approved: unknown): void {
    const id = approvalIdSchema.parse(idInput);
    if (typeof approved !== "boolean") {
      throw new HammerCodeError("审批结果必须为布尔值", "INVALID_APPROVAL", true);
    }
    this.approvals?.resolve(id, approved);
  }

  async requestUndo(idInput: unknown): Promise<void> {
    const changeId = changeIdSchema.parse(idInput);
    const session = this.currentSession;
    if (!session) throw new HammerCodeError("当前没有聊天", "NO_SESSION", true);
    if (this.isBusy()) throw new HammerCodeError("已有任务或撤销正在运行", "SESSION_BUSY", true);
    if (!["completed", "cancelled", "failed"].includes(session.status)) {
      throw new HammerCodeError("只能在当前轮次结束后撤销文件修改", "SESSION_NOT_TERMINAL", true);
    }
    const boundary = await WorkspaceBoundary.create(session.workspaceRoot);
    const { change, prepared } = await prepareFileUndo(
      session,
      changeId,
      boundary,
      uuidGenerator,
      systemClock.now(),
    );

    const request = prepared.approvalRequest;
    if (!request) throw new HammerCodeError("撤销缺少审批信息", "UNDO_PREPARE_FAILED");
    request.title = "撤销文件修改";
    request.description = `将 ${change.path} 恢复到本次修改之前`;
    request.operation = "undo";
    request.turnId = session.activeTurnId;
    const approvals = new PendingApprovalGateway();
    const abort = new AbortController();
    session.pendingApproval = request;
    session.pendingUndo = {
      id: uuidGenerator.next("undo"),
      changeId: change.id,
      approvalId: request.id,
      status: "awaiting_approval",
      createdAt: systemClock.now().toISOString(),
    };
    session.updatedAt = systemClock.now().toISOString();
    this.approvals = approvals;
    this.undoAbort = abort;
    await this.store.save(session);
    this.emit({ type: "session_snapshot", session });
    void this.performUndo(prepared, approvals, abort).catch((error: unknown) => {
      this.emit({ type: "notification", level: "error", message: toErrorMessage(error) });
    });
  }

  async clearSession(): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("请先取消当前任务或撤销", "SESSION_BUSY", true);
    this.destroySideChat();
    this.currentSession = null;
    this.runner = null;
    this.approvals = null;
    await this.store.clear();
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  private upsertSummary(session: AgentSession): void {
    if (session.workspaceRoot !== this.workspaceRoot) return;
    const summary = toSummary(session);
    this.sessions = [summary, ...this.sessions.filter((item) => item.id !== summary.id)].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private upsertWorkspace(session: AgentSession, activate = this.currentSession?.id === session.id): void {
    const existing = this.workspaces.find((workspace) => workspace.root === session.workspaceRoot);
    const sessions = session.workspaceRoot === this.workspaceRoot
      ? this.sessions
      : [
          toSummary(session),
          ...(existing?.sessions.filter((item) => item.id !== session.id) ?? []),
        ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const summary: WorkspaceSummary = {
      root: session.workspaceRoot,
      name: path.basename(session.workspaceRoot) || session.workspaceRoot,
      sessionCount: sessions.length,
      sessions,
      activeSessionId: activate ? session.id : existing?.activeSessionId ?? null,
      updatedAt: session.updatedAt,
    };
    if (!existing) {
      this.workspaces = [...this.workspaces, summary];
      return;
    }
    this.workspaces = this.workspaces.map((workspace) =>
      workspace.root === session.workspaceRoot ? summary : workspace,
    );
  }

  private isRunning(): boolean {
    return this.runningSessionId !== null;
  }

  private isUndoBusy(): boolean {
    return this.undoAbort !== null || Boolean(this.currentSession?.pendingUndo);
  }

  private isBusy(): boolean {
    return this.isRunning() || this.isUndoBusy() || this.contextCompactionAbort !== null;
  }

  shutdown(): void {
    this.destroySideChat(false);
    this.cancelTask("应用关闭，正在运行的任务已安全取消；重新打开后不会重放工具调用。");
  }

  private requireSideChat(idInput: unknown): EphemeralSideChat {
    const id = sideChatIdSchema.parse(idInput);
    if (!this.sideChat || this.sideChat.snapshot.id !== id) {
      throw new HammerCodeError("侧边聊天已关闭或不存在", "SIDE_CHAT_NOT_FOUND", true);
    }
    return this.sideChat;
  }

  private destroySideChat(emit = true): void {
    if (!this.sideChat) return;
    this.sideChat.close();
    this.sideChat = null;
    if (emit) this.emit({ type: "side_chat_closed" });
  }

  private createModelClient(
    modelConfig: RuntimeConfig["models"]["fast"],
    overrides: { thinking?: "enabled" | "disabled"; maxOutputTokens?: number; requestTimeoutMs?: number } = {},
  ): OpenAICompatibleChatClient {
    return new OpenAICompatibleChatClient({
      provider: modelConfig.provider,
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.apiBaseUrl,
      model: modelConfig.model,
      thinking: overrides.thinking ?? modelConfig.thinking,
      reasoningEffort: modelConfig.reasoningEffort,
      maxOutputTokens: overrides.maxOutputTokens ?? modelConfig.maxOutputTokens,
      requestTimeoutMs: overrides.requestTimeoutMs ?? modelConfig.requestTimeoutMs,
    });
  }

  private async compactContextWithRetry(
    model: OpenAICompatibleChatClient,
    session: AgentSession,
    signal: AbortSignal,
  ): Promise<ModelContextCompactionResult & { attempts: number }> {
    let attempts = 0;
    while (true) {
      attempts += 1;
      try {
        const result = await compactContextWithModel(
          model,
          session,
          systemClock.now().toISOString(),
          "explicit",
          signal,
        );
        return {
          ...result,
          attempts,
          promptTokens: result.promptTokens + result.estimatedPromptTokens * (attempts - 1),
          usageEstimated: result.usageEstimated || attempts > 1,
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const retryable = error instanceof HammerCodeError && [
          "MODEL_RATE_LIMITED",
          "MODEL_SERVER_ERROR",
          "MODEL_RESOURCE_EXHAUSTED",
        ].includes(error.code);
        if (!retryable || attempts > this.config.maxModelRetries) throw error;
        const exponential = this.config.retryBaseDelayMs * 2 ** (attempts - 1);
        const delayMs = Math.min(this.config.retryMaxDelayMs, error.retryAfterMs ?? exponential);
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }

  private async generateAndPersistTitle(sessionId: string): Promise<void> {
    if (this.titleRequests.has(sessionId)) return;
    this.titleRequests.add(sessionId);
    try {
      const session = await this.store.loadSession(sessionId, { preserveActive: true });
      if (!session || session.title) return;
      const fast = this.resolvedRuntimeConfig().models.fast;
      const finalAnswer = [...session.messages].reverse().find(
        (message) => message.role === "assistant" && Boolean(message.content) && !message.toolCalls?.length,
      );
      let title = fallbackChatTitle(session.task);
      if (fast.apiKey) {
        try {
          title = await generateChatTitle(
            this.createModelClient(fast, {
              thinking: "disabled",
              maxOutputTokens: Math.min(256, fast.maxOutputTokens),
              requestTimeoutMs: Math.min(15_000, fast.requestTimeoutMs),
            }),
            session.task,
            finalAnswer?.role === "assistant" ? finalAnswer.content : "",
            new AbortController().signal,
          );
        } catch {
          // Title generation never changes the outcome of the main task.
        }
      }
      if (this.runningSessionId === sessionId) {
        this.pendingTitles.set(sessionId, title);
        return;
      }
      const latest = await this.store.loadSession(sessionId, { preserveActive: true });
      if (!latest || latest.title) return;
      latest.title = title;
      await this.store.save(latest, { activate: this.currentSession?.id === latest.id });
      if (this.currentSession?.id === latest.id) this.currentSession = latest;
      this.upsertSummary(latest);
      this.upsertWorkspace(latest, this.currentSession?.id === latest.id);
      this.emit(this.currentSession?.id === latest.id
        ? { type: "session_snapshot", session: latest }
        : { type: "session_updated", session: latest });
    } finally {
      this.titleRequests.delete(sessionId);
    }
  }

  private async performUndo(
    prepared: Awaited<ReturnType<LocalToolExecutor["prepare"]>>,
    approvals: PendingApprovalGateway,
    abort: AbortController,
  ): Promise<void> {
    const session = this.currentSession;
    if (!session?.pendingUndo || !session.pendingApproval) return;
    try {
      const approved = await approvals.request(session.pendingApproval, abort.signal);
      if (!approved) {
        session.pendingApproval = undefined;
        session.pendingUndo = undefined;
        session.updatedAt = systemClock.now().toISOString();
        await this.store.save(session);
        this.emit({ type: "session_snapshot", session });
        this.emit({ type: "notification", level: "info", message: "已取消撤销，没有修改文件。" });
        return;
      }
      session.pendingUndo.status = "executing";
      session.pendingApproval = undefined;
      session.updatedAt = systemClock.now().toISOString();
      await this.store.save(session);
      this.emit({ type: "session_snapshot", session });

      const result = await prepared.execute({
        signal: abort.signal,
        approvals,
        now: () => systemClock.now(),
      });
      if (!result.ok) {
        throw new HammerCodeError(result.summary, result.errorCode ?? "UNDO_FAILED", true);
      }
      const change = session.fileChanges.find((item) => item.id === session.pendingUndo?.changeId);
      if (!change) throw new HammerCodeError("找不到待撤销的文件修改", "CHANGE_NOT_FOUND");
      change.status = "reverted";
      change.revertedAt = systemClock.now().toISOString();
      session.pendingUndo = undefined;
      session.updatedAt = systemClock.now().toISOString();
      this.upsertSummary(session);
      this.upsertWorkspace(session);
      await this.store.save(session);
      this.emit({ type: "session_snapshot", session });
      this.emit({ type: "notification", level: "info", message: `已安全撤销 ${change.path}` });
    } catch (error) {
      if (session.pendingUndo) {
        session.pendingApproval = undefined;
        session.pendingUndo = undefined;
        session.updatedAt = systemClock.now().toISOString();
        await this.store.save(session);
        this.emit({ type: "session_snapshot", session });
      }
      throw error;
    } finally {
      this.approvals = null;
      this.undoAbort = null;
    }
  }

  private async reconcileInterruptedUndo(): Promise<void> {
    const session = this.currentSession;
    if (!session?.pendingUndo) return;
    try {
      const boundary = await WorkspaceBoundary.create(session.workspaceRoot);
      const outcome = await reconcilePendingUndo(
        session,
        boundary,
        systemClock.now().toISOString(),
      );
      if (outcome !== "none") {
        this.upsertSummary(session);
        this.upsertWorkspace(session);
        await this.store.save(session);
      }
    } catch {
      session.pendingApproval = undefined;
      session.pendingUndo = undefined;
      session.updatedAt = systemClock.now().toISOString();
      await this.store.save(session);
    }
  }

  private async refreshNavigation(): Promise<void> {
    const state = await this.store.loadState({
      liveSessionIds: this.runningSessionId ? [this.runningSessionId] : [],
    });
    this.currentSession = state.activeSession;
    this.sessions = state.sessions;
    this.workspaces = state.workspaces;
    this.workspaceRoot = state.workspaceRoot;
  }

  private emitWorkspaceChanged(): void {
    this.emit({
      type: "workspace_changed",
      workspaceRoot: this.workspaceRoot,
      workspaces: this.workspaces,
      sessions: this.sessions,
      session: this.currentSession,
    });
  }

  private emit(event: RendererEvent): void {
    if (!this.window.isDestroyed()) this.window.webContents.send("hammercode:event", event);
  }

  private publicConfig() {
    const resolved = this.resolvedRuntimeConfig();
    return toPublicConfig(resolved, Object.fromEntries(MODEL_TIERS.map((tier) => {
      const credential = this.modelCredentials.resolve(tier, this.config.models[tier]);
      return [tier, {
        status: credential.status,
        message: credential.error,
        lastCheckedAt: credential.lastCheckedAt,
      }];
    })));
  }

  private resolvedRuntimeConfig(): RuntimeConfig {
    return {
      ...this.config,
      models: Object.fromEntries(MODEL_TIERS.map((tier) => {
        const credential = this.modelCredentials.resolve(tier, this.config.models[tier]);
        return [tier, {
          ...this.config.models[tier],
          apiKey: credential.apiKey,
          apiBaseUrl: credential.apiBaseUrl,
        }];
      })) as RuntimeConfig["models"],
    };
  }

  private resolveModel(modelTier: SessionSettings["modelTier"], requestedRef?: string): {
    modelRef: ModelRef;
    config: RuntimeConfig["models"]["fast"];
  } {
    if (requestedRef && requestedRef !== "builtin:fast" && requestedRef !== "builtin:strong") {
      throw new HammerCodeError("模型只允许选择 Fast 或 Strong", "INVALID_MODEL_REF", true);
    }
    const modelRef: ModelRef = requestedRef === "builtin:strong"
      ? "builtin:strong"
      : requestedRef === "builtin:fast"
        ? "builtin:fast"
        : modelTier === "strong" ? "builtin:strong" : "builtin:fast";
    if (modelRef === "builtin:fast" || modelRef === "builtin:strong") {
      const selectedTier = modelRef === "builtin:fast" ? "fast" : "strong";
      if (selectedTier !== modelTier) {
        throw new HammerCodeError("模型引用与 Fast/Strong 档位不一致", "INVALID_MODEL_REF", true);
      }
      const config = this.resolvedRuntimeConfig().models[selectedTier];
      if (!config.apiKey) {
        const variable = selectedTier === "fast" ? "DEEPSEEK_API_KEY" : "GLM_API_KEY";
        throw new HammerCodeError(
          `${selectedTier === "fast" ? "Fast" : "Strong"} 模型未配置 ${variable}`,
          "API_KEY_REQUIRED",
          true,
        );
      }
      return { modelRef, config };
    }
    throw new HammerCodeError("模型只允许选择 Fast 或 Strong", "INVALID_MODEL_REF", true);
  }
}

export function safeIpcError(error: unknown): Error {
  return new Error(redactSecrets(toErrorMessage(error)));
}
