import path from "node:path";
import { chmod, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { app, dialog, type BrowserWindow } from "electron";
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
import { RestrictedSubagentCoordinator } from "../core/subagent-coordinator";
import { DEFAULT_SYSTEM_PROMPT } from "../core/system-prompt";
import { LocalToolExecutor } from "../core/tools/tool-executor";
import { HammerCodeError } from "../core/types";
import { isAbortError, redactSecrets, systemClock, toErrorMessage, uuidGenerator } from "../core/utils";
import { WorkspaceWriteLeaseManager } from "../core/write-leases";
import {
  MODEL_TIERS,
  PERMISSION_MODES,
  type AgentSession,
  type AppBootstrap,
  type ArchivedProjectSummary,
  type ArchivedWorkspaceSummary,
  type EphemeralSideChatState,
  type ModelConnectionProbeInput,
  type ModelConnectionSaveInput,
  type ModelRef,
  type ProjectMemorySnapshot,
  type ProjectMemoryExportPreference,
  type ProjectMemoryExportPreferenceResult,
  type ProjectMemorySettings,
  type ProjectMemoryTransferResult,
  type ReferencePreview,
  type RendererEvent,
  type SessionSettings,
  type SessionSummary,
  type SkillInventorySnapshot,
  type SkillSettings,
  type SkillTransferResult,
  type WorkspaceSummary,
} from "../shared/contracts";
import { PendingApprovalGateway } from "./approval-gateway";
import type { RuntimeConfig } from "./config";
import { toPublicConfig } from "./config";
import { connectionModelRef, ModelCredentialStore } from "./model-credential-store";
import { ProjectMemoryStore } from "./project-memory-store";
import { SessionStore } from "./session-store";
import { SkillStore } from "./skill-store";
import { searchWorkspace } from "./workspace-search";

const startTaskSchema = z
  .object({
    task: z.string().trim().min(1).max(100_000),
    modelTier: z.enum(MODEL_TIERS),
    modelRef: z.string().regex(/^(?:builtin:(?:fast|strong)|connection:[0-9a-f-]{36})$/i).optional(),
    permissionMode: z.enum(PERMISSION_MODES),
  })
  .strict();
const settingsSchema = startTaskSchema.omit({ task: true });
const approvalIdSchema = z.string().min(1).max(200);
const sessionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const changeIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const workspaceRootSchema = z.string().min(1).max(4096);
const workspaceQuerySchema = z.string().max(240);
const workspacePreviewPathSchema = z.string().min(1).max(4_096);
const modelConnectionProbeSchema = z.object({
  connectionId: z.union([z.enum(["builtin:fast", "builtin:strong"]), z.string().uuid()]).optional(),
  apiBaseUrl: z.string().trim().min(1).max(2_048),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
}).strict();
const modelConnectionSaveSchema = z.object({
  connectionId: z.union([z.enum(["builtin:fast", "builtin:strong"]), z.string().uuid()]).optional(),
  name: z.string().trim().min(1).max(60),
  tier: z.enum(MODEL_TIERS),
  model: z.string().trim().min(1).max(500),
  apiBaseUrl: z.string().trim().min(1).max(2_048),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
}).strict();
const modelConnectionIdSchema = z.union([z.enum(["builtin:fast", "builtin:strong"]), z.string().uuid()]);
const modelConnectionNameSchema = z.string().trim().min(1).max(60);
const sideChatIdSchema = z.string().regex(/^btw_[a-zA-Z0-9_-]{1,200}$/);
const sideChatContentSchema = z.string().trim().min(1).max(20_000);
const projectMemoryIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const projectDisplayNameSchema = z.string().trim().min(1).max(80);
const projectPinnedSchema = z.boolean();
const projectMemoryExportModeSchema = z.enum(["project", "custom"]);
const projectMemorySettingsSchema = z.object({
  enabled: z.boolean(),
  useMemories: z.boolean(),
  generateMemories: z.boolean(),
  maxRecallRecords: z.number().int().min(1).max(20),
  maxRecallCharacters: z.number().int().min(500).max(20_000),
}).strict();

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
  private archivedWorkspaces: ArchivedWorkspaceSummary[] = [];
  private archivedProjects: ArchivedProjectSummary[] = [];
  private currentSession: AgentSession | null = null;
  private currentProjectMemory: ProjectMemorySnapshot | null = null;
  private currentSkills: SkillInventorySnapshot = {
    workspaceRoot: null,
    settings: { modelActivationEnabled: true },
    skills: [],
    updatedAt: new Date(0).toISOString(),
  };
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
    private readonly projectMemory: ProjectMemoryStore,
    private readonly skills: SkillStore,
  ) {}

  async initialize(): Promise<void> {
    await this.modelCredentials.load(this.config.models);
    await this.skills.load();
    await this.refreshNavigation();
    await this.reconcileInterruptedUndo();
  }

  bootstrap(): AppBootstrap {
    return {
      session: this.currentSession,
      sessions: this.sessions,
      workspaces: this.workspaces,
      archivedWorkspaces: this.archivedWorkspaces,
      archivedProjects: this.archivedProjects,
      workspaceRoot: this.workspaceRoot,
      projectMemory: this.currentProjectMemory,
      skills: this.currentSkills,
      config: this.publicConfig(),
    };
  }

  async chooseWorkspace(): Promise<string | null> {
    if (this.isUndoBusy()) throw new HammerCodeError("撤销运行时不能切换工作区", "SESSION_BUSY", true);
    const result = await dialog.showOpenDialog(this.window, {
      title: "选择 HammerCode 工作区",
      defaultPath: this.workspaceRoot ?? app.getPath("documents"),
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
    if (!this.workspaces.some((workspace) => workspace.sessions.some((item) => item.id === id))) {
      throw new HammerCodeError("找不到这条活动聊天记录", "SESSION_NOT_FOUND", true);
    }
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

  async archiveSession(idInput: unknown): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能归档聊天", "SESSION_BUSY", true);
    const id = sessionIdSchema.parse(idInput);
    if (!this.workspaces.some((workspace) => workspace.sessions.some((item) => item.id === id))) {
      throw new HammerCodeError("找不到可归档的聊天", "SESSION_NOT_FOUND", true);
    }
    if (this.currentSession?.id === id) this.destroySideChat();
    this.navigationRevision += 1;
    await this.store.archiveSession(id);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async restoreSession(idInput: unknown): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能恢复聊天", "SESSION_BUSY", true);
    const id = sessionIdSchema.parse(idInput);
    if (!this.archivedWorkspaces.some((workspace) => workspace.sessions.some((item) => item.id === id))) {
      throw new HammerCodeError("找不到已归档聊天", "SESSION_NOT_FOUND", true);
    }
    this.navigationRevision += 1;
    await this.store.restoreSession(id);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async archiveWorkspaceChats(rootInput: unknown): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能批量归档", "SESSION_BUSY", true);
    const root = workspaceRootSchema.parse(rootInput);
    const workspace = this.workspaces.find((item) => item.root === root);
    if (!workspace) throw new HammerCodeError("找不到这个工作区", "WORKSPACE_NOT_FOUND", true);
    if (workspace.sessionCount === 0) return;
    if (this.currentSession?.workspaceRoot === root) this.destroySideChat();
    this.navigationRevision += 1;
    await this.store.archiveWorkspaceChats(root);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async restoreWorkspaceChats(rootInput: unknown): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能批量恢复", "SESSION_BUSY", true);
    const root = workspaceRootSchema.parse(rootInput);
    const workspace = this.archivedWorkspaces.find((item) => item.root === root);
    if (!workspace) throw new HammerCodeError("找不到已归档项目记录", "WORKSPACE_NOT_FOUND", true);
    if (workspace.sessionCount === 0) return;
    this.navigationRevision += 1;
    await this.store.restoreWorkspaceChats(root);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async setProjectPinned(rootInput: unknown, pinnedInput: unknown): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能调整项目", "SESSION_BUSY", true);
    const root = workspaceRootSchema.parse(rootInput);
    const pinned = projectPinnedSchema.parse(pinnedInput);
    if (!this.workspaces.some((item) => item.root === root)) {
      throw new HammerCodeError("找不到这个项目", "WORKSPACE_NOT_FOUND", true);
    }
    await this.store.setProjectPinned(root, pinned);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async renameProject(rootInput: unknown, nameInput: unknown): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能重命名项目", "SESSION_BUSY", true);
    const root = workspaceRootSchema.parse(rootInput);
    const name = projectDisplayNameSchema.parse(nameInput);
    if (![...this.workspaces, ...this.archivedProjects].some((item) => item.root === root)) {
      throw new HammerCodeError("找不到这个项目", "WORKSPACE_NOT_FOUND", true);
    }
    await this.store.renameProject(root, name);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async archiveProject(rootInput: unknown): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能归档项目", "SESSION_BUSY", true);
    const root = workspaceRootSchema.parse(rootInput);
    if (!this.workspaces.some((item) => item.root === root)) {
      throw new HammerCodeError("找不到这个项目", "WORKSPACE_NOT_FOUND", true);
    }
    await this.store.archiveProject(root);
    if (this.workspaceRoot === root) this.destroySideChat();
    this.navigationRevision += 1;
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async restoreProject(rootInput: unknown): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能恢复项目", "SESSION_BUSY", true);
    const root = workspaceRootSchema.parse(rootInput);
    if (!this.archivedProjects.some((item) => item.root === root)) {
      throw new HammerCodeError("找不到已归档项目", "WORKSPACE_NOT_FOUND", true);
    }
    await this.store.restoreProject(root);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
  }

  async removeProject(rootInput: unknown): Promise<void> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能移除项目", "SESSION_BUSY", true);
    const root = workspaceRootSchema.parse(rootInput);
    if (!this.workspaces.some((item) => item.root === root)) {
      throw new HammerCodeError("找不到这个项目", "WORKSPACE_NOT_FOUND", true);
    }
    await this.store.removeProject(root);
    if (this.workspaceRoot === root) this.destroySideChat();
    this.navigationRevision += 1;
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
    session.modelRef = (settings.modelRef ?? `builtin:${settings.modelTier}`) as ModelRef;
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
    const writeLeases = new WorkspaceWriteLeaseManager();
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
    const subagents = new RestrictedSubagentCoordinator(
      model,
      boundary,
      systemClock,
      uuidGenerator,
      writeLeases,
      {
        modelName: modelConfig.model,
        maxRounds: Math.min(8, this.config.maxAgentRounds),
        maxToolCalls: Math.min(30, this.config.maxToolCalls),
        maxRunTimeMs: Math.min(300_000, this.config.maxRunTimeMs),
        maxModelRetries: this.config.maxModelRetries,
        retryBaseDelayMs: this.config.retryBaseDelayMs,
        retryMaxDelayMs: this.config.retryMaxDelayMs,
        maxOutputTokens: Math.min(16_384, modelConfig.maxOutputTokens),
        contextTokenBudget: Math.min(64_000, this.config.contextTokenBudget),
      },
    );
    const startNavigationRevision = this.navigationRevision;
    const runner = new AgentRunner(
      {
        model,
        tools,
        approvals,
        clock: systemClock,
        ids: uuidGenerator,
        projectMemory: this.projectMemory,
        skills: this.skills,
        subagents,
        writeLeases,
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
        modelName: modelConfig.model,
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
    const parsed: ModelConnectionProbeInput = modelConnectionProbeSchema.parse(input);
    return this.modelCredentials.test(parsed, this.config.models);
  }

  async saveModelConnection(input: unknown) {
    const parsed: ModelConnectionSaveInput = modelConnectionSaveSchema.parse(input);
    const result = await this.modelCredentials.save(parsed, this.config.models);
    this.emit({
      type: "config_updated",
      config: this.publicConfig(),
    });
    return result;
  }

  async renameModelConnection(idInput: unknown, nameInput: unknown) {
    const id = modelConnectionIdSchema.parse(idInput);
    const name = modelConnectionNameSchema.parse(nameInput);
    const result = await this.modelCredentials.rename(id, name, this.config.models);
    this.emit({ type: "config_updated", config: this.publicConfig() });
    return result;
  }

  async deleteModelConnection(idInput: unknown): Promise<void> {
    const id = modelConnectionIdSchema.parse(idInput);
    if (this.runningSessionId || this.sideChat?.snapshot.status === "requesting") {
      throw new HammerCodeError("模型正在使用中，任务结束后才能删除连接", "MODEL_CONNECTION_BUSY", true);
    }
    const deletedRef = connectionModelRef(id);
    await this.modelCredentials.delete(id);
    if (this.currentSession?.modelRef === deletedRef) {
      this.currentSession.modelRef = `builtin:${this.currentSession.modelTier}`;
      this.currentSession.updatedAt = systemClock.now().toISOString();
      await this.store.save(this.currentSession);
      this.emit({ type: "session_snapshot", session: this.currentSession });
    }
    this.emit({ type: "config_updated", config: this.publicConfig() });
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
      modelName: modelConfig.model,
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

  async chooseWorkspaceEntry() {
    if (!this.workspaceRoot) throw new HammerCodeError("请先选择工作区", "WORKSPACE_REQUIRED", true);
    const boundary = await WorkspaceBoundary.create(this.workspaceRoot);
    const result = await dialog.showOpenDialog(this.window, {
      title: "选择当前工作区中的文件或文件夹",
      message: "只能添加当前工作区内的文件或文件夹引用。",
      defaultPath: boundary.root,
      properties: ["openFile", "openDirectory"],
      buttonLabel: "添加引用",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = await realpath(result.filePaths[0]);
    const relative = boundary.relative(selected);
    const info = await stat(selected);
    if (!info.isFile() && !info.isDirectory()) {
      throw new HammerCodeError("当前类型不能添加到聊天", "WORKSPACE_ENTRY_UNSUPPORTED", true);
    }
    return {
      path: relative,
      name: relative === "." ? path.basename(boundary.root) : path.basename(selected),
      kind: info.isDirectory() ? "directory" as const : "file" as const,
    };
  }

  async previewWorkspaceEntry(input: unknown): Promise<ReferencePreview> {
    const relativePath = workspacePreviewPathSchema.parse(input);
    if (!this.workspaceRoot) throw new HammerCodeError("请先选择工作区", "WORKSPACE_REQUIRED", true);
    const boundary = await WorkspaceBoundary.create(this.workspaceRoot);
    const absolute = await boundary.resolveExisting(relativePath);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      const children = (await readdir(absolute, { withFileTypes: true }))
        .filter((item) => !item.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
      const visible = children.slice(0, 240);
      return {
        key: `workspace:${relativePath}`,
        kind: "directory",
        title: path.basename(absolute),
        subtitle: relativePath,
        content: visible.map((item) => `${item.isDirectory() ? "目录" : "文件"}\t${item.name}`).join("\n") || "（空文件夹）",
        truncated: children.length > visible.length,
      };
    }
    if (!info.isFile()) throw new HammerCodeError("当前类型无法预览", "PREVIEW_UNSUPPORTED", true);
    const maxBytes = 96_000;
    const handle = await open(absolute, "r");
    let buffer: Buffer;
    try {
      const target = Buffer.alloc(Math.min(info.size, maxBytes + 1));
      const { bytesRead } = await handle.read(target, 0, target.length, 0);
      buffer = target.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const extension = path.extname(relativePath).toLowerCase();
    if (buffer.includes(0) || [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip"].includes(extension)) {
      return {
        key: `workspace:${relativePath}`,
        kind: "file",
        title: path.basename(relativePath),
        subtitle: relativePath,
        content: `这是${extension === ".pdf" ? " PDF" : "二进制"}文件，当前侧边预览不展开其原始内容。Agent 仍可通过正式工具读取。`,
        truncated: false,
      };
    }
    const content = buffer.toString("utf8");
    const language = extension.slice(1) || "text";
    return {
      key: `workspace:${relativePath}`,
      kind: "file",
      title: path.basename(relativePath),
      subtitle: relativePath,
      content: content.slice(0, maxBytes),
      truncated: info.size > maxBytes || content.length > maxBytes,
      language,
    };
  }

  async previewSkill(skillKey: unknown): Promise<ReferencePreview> {
    return this.skills.previewPackage(skillKey, this.workspaceRoot);
  }

  async listProjectMemory(rootInput: unknown): Promise<ProjectMemorySnapshot> {
    const root = this.knownProjectRoot(rootInput);
    const snapshot = await this.projectMemory.snapshot(root);
    if (root === this.workspaceRoot) this.currentProjectMemory = snapshot;
    return snapshot;
  }

  async updateProjectMemorySettings(rootInput: unknown, input: unknown): Promise<ProjectMemorySnapshot> {
    const root = this.knownProjectRoot(rootInput);
    const settings: ProjectMemorySettings = projectMemorySettingsSchema.parse(input);
    const snapshot = await this.projectMemory.updateSettings(root, settings);
    if (root === this.workspaceRoot) this.currentProjectMemory = snapshot;
    return snapshot;
  }

  async configureProjectMemoryExport(
    rootInput: unknown,
    modeInput: unknown,
  ): Promise<ProjectMemoryExportPreferenceResult> {
    if (this.isBusy()) throw new HammerCodeError("任务、审批或撤销运行时不能调整导出位置", "SESSION_BUSY", true);
    const root = this.knownProjectRoot(rootInput);
    const mode = projectMemoryExportModeSchema.parse(modeInput);
    const current = await this.store.projectMemoryExport(root);
    let preference: ProjectMemoryExportPreference;
    if (mode === "project") {
      preference = { mode: "project", customDirectory: current.customDirectory };
    } else {
      const defaultPath = await this.existingDirectory(current.customDirectory) ?? app.getPath("documents");
      const result = await dialog.showOpenDialog(this.window, {
        title: "选择项目记忆默认导出目录",
        defaultPath,
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "设为默认位置",
      });
      if (result.canceled || !result.filePaths[0]) {
        return { status: "cancelled", preference: current };
      }
      preference = { mode: "custom", customDirectory: result.filePaths[0] };
    }
    await this.store.updateProjectMemoryExport(root, preference);
    await this.refreshNavigation();
    this.emitWorkspaceChanged();
    return { status: "updated", preference };
  }

  async exportProjectMemory(rootInput: unknown): Promise<ProjectMemoryTransferResult> {
    const root = this.knownProjectRoot(rootInput);
    const project = [...this.workspaces, ...this.archivedProjects].find((item) => item.root === root)!;
    const snapshot = await this.projectMemory.snapshot(root);
    const safeName = project.name.replace(/[\\/:*?"<>|]/g, "-").trim() || path.basename(root) || "project";
    const preference = await this.store.projectMemoryExport(root);
    const preferredDirectory = preference.mode === "custom" ? preference.customDirectory : root;
    const defaultDirectory = await this.existingDirectory(preferredDirectory) ?? app.getPath("documents");
    const result = await dialog.showSaveDialog(this.window, {
      title: "导出项目记忆",
      defaultPath: path.join(defaultDirectory, `${safeName}-hammercode-memory.json`),
      buttonLabel: "确认导出",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { status: "cancelled" };
    const data = await this.projectMemory.exportData(root);
    const temporary = path.join(
      path.dirname(result.filePath),
      `.${path.basename(result.filePath)}.${process.pid}.${uuidGenerator.next("export")}.tmp`,
    );
    try {
      await writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, result.filePath);
      await chmod(result.filePath, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      status: "exported",
      fileName: path.basename(result.filePath),
      recordCount: snapshot.records.length,
    };
  }

  async importProjectMemory(rootInput: unknown): Promise<ProjectMemoryTransferResult> {
    const root = this.knownProjectRoot(rootInput);
    const result = await dialog.showOpenDialog(this.window, {
      title: "导入项目记忆",
      defaultPath: await this.existingDirectory(root) ?? app.getPath("documents"),
      properties: ["openFile"],
      buttonLabel: "导入到所选项目",
    });
    if (result.canceled || !result.filePaths[0]) return { status: "cancelled" };
    const filePath = result.filePaths[0];
    if ((await stat(filePath)).size > 2_000_000) {
      throw new HammerCodeError("项目记忆文件超过 2 MB 上限", "PROJECT_MEMORY_IMPORT_TOO_LARGE", true);
    }
    const imported = await this.projectMemory.importData(root, await readFile(filePath, "utf8"));
    if (root === this.workspaceRoot) this.currentProjectMemory = imported.snapshot;
    return {
      status: "imported",
      fileName: path.basename(filePath),
      imported: imported.imported,
      skipped: imported.skipped,
      conflicted: imported.conflicted,
    };
  }

  async deleteProjectMemory(rootInput: unknown, idInput: unknown): Promise<ProjectMemorySnapshot> {
    const root = this.knownProjectRoot(rootInput);
    const id = projectMemoryIdSchema.parse(idInput);
    const snapshot = await this.projectMemory.delete(root, id);
    if (root === this.workspaceRoot) this.currentProjectMemory = snapshot;
    return snapshot;
  }

  async updateSkillSettings(input: unknown): Promise<SkillInventorySnapshot> {
    const settings = input as SkillSettings;
    this.currentSkills = await this.skills.updateSettings(settings, this.workspaceRoot);
    return this.currentSkills;
  }

  async setSkillEnabled(
    skillKey: unknown,
    enabled: unknown,
    trustProject: unknown,
  ): Promise<SkillInventorySnapshot> {
    if (typeof enabled !== "boolean" || (trustProject !== undefined && typeof trustProject !== "boolean")) {
      throw new HammerCodeError("Skill 启用参数无效", "INVALID_SKILL_SETTINGS", true);
    }
    this.currentSkills = await this.skills.setEnabled(
      skillKey,
      enabled,
      trustProject === true,
      this.workspaceRoot,
    );
    return this.currentSkills;
  }

  async importSkill(): Promise<SkillTransferResult> {
    const result = await dialog.showOpenDialog(this.window, {
      title: "导入本地 Skill 文件夹",
      defaultPath: this.workspaceRoot ?? app.getPath("documents"),
      properties: ["openDirectory"],
      buttonLabel: "检查并导入",
    });
    if (result.canceled || !result.filePaths[0]) return { status: "cancelled" };
    const imported = await this.skills.importFolder(result.filePaths[0], this.workspaceRoot);
    this.currentSkills = await this.skills.inventory(this.workspaceRoot);
    return { status: "imported", skillId: imported.id, fileName: path.basename(result.filePaths[0]) };
  }

  async exportSkill(skillKey: unknown): Promise<SkillTransferResult> {
    const result = await dialog.showOpenDialog(this.window, {
      title: "选择 Skill 导出位置",
      defaultPath: this.workspaceRoot ?? app.getPath("documents"),
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "导出到这里",
    });
    if (result.canceled || !result.filePaths[0]) return { status: "cancelled" };
    const fileName = await this.skills.exportPackage(skillKey, this.workspaceRoot, result.filePaths[0]);
    return { status: "exported", fileName };
  }

  async uninstallSkill(skillKey: unknown): Promise<SkillInventorySnapshot> {
    if (this.runningSessionId) {
      throw new HammerCodeError("任务运行时不能卸载 Skill；禁用仍可安全影响下一轮", "SESSION_BUSY", true);
    }
    this.currentSkills = await this.skills.uninstall(skillKey, this.workspaceRoot);
    return this.currentSkills;
  }

  handleProjectMemoryChange(snapshot: ProjectMemorySnapshot): void {
    if (snapshot.workspaceRoot !== this.workspaceRoot) return;
    this.currentProjectMemory = snapshot;
    this.emit({ type: "project_memory_updated", memory: snapshot });
  }

  handleSkillChange(snapshot: SkillInventorySnapshot): void {
    if (snapshot.workspaceRoot !== this.workspaceRoot) return;
    this.currentSkills = snapshot;
    this.emit({ type: "skills_updated", skills: snapshot });
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
      name: existing?.name ?? (path.basename(session.workspaceRoot) || session.workspaceRoot),
      pinned: existing?.pinned ?? false,
      memoryExport: existing?.memoryExport ?? { mode: "project" },
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

  private knownProjectRoot(input: unknown): string {
    const root = workspaceRootSchema.parse(input);
    if (![...this.workspaces, ...this.archivedProjects].some((project) => project.root === root)) {
      throw new HammerCodeError("找不到这个项目", "WORKSPACE_NOT_FOUND", true);
    }
    return root;
  }

  private async existingDirectory(candidate: string | undefined): Promise<string | null> {
    if (!candidate) return null;
    try {
      return (await stat(candidate)).isDirectory() ? candidate : null;
    } catch {
      return null;
    }
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
    this.archivedWorkspaces = state.archivedWorkspaces;
    this.archivedProjects = state.archivedProjects;
    this.workspaceRoot = state.workspaceRoot;
    this.currentProjectMemory = this.workspaceRoot
      ? await this.projectMemory.snapshot(this.workspaceRoot)
      : null;
    this.currentSkills = await this.skills.inventory(this.workspaceRoot);
  }

  private emitWorkspaceChanged(): void {
    this.emit({
      type: "workspace_changed",
      workspaceRoot: this.workspaceRoot,
      workspaces: this.workspaces,
      archivedWorkspaces: this.archivedWorkspaces,
      archivedProjects: this.archivedProjects,
      sessions: this.sessions,
      session: this.currentSession,
    });
    this.emit({ type: "project_memory_updated", memory: this.currentProjectMemory });
    this.emit({ type: "skills_updated", skills: this.currentSkills });
  }

  private emit(event: RendererEvent): void {
    if (!this.window.isDestroyed()) this.window.webContents.send("hammercode:event", event);
  }

  private publicConfig() {
    const resolved = this.resolvedRuntimeConfig();
    return toPublicConfig(resolved, this.modelCredentials.listPublic(this.config.models));
  }

  private resolvedRuntimeConfig(): RuntimeConfig {
    return {
      ...this.config,
      models: Object.fromEntries(MODEL_TIERS.map((tier) => {
        const credential = this.modelCredentials.resolve(`builtin:${tier}`, this.config.models);
        if (!credential) throw new HammerCodeError("默认模型连接缺失", "DEFAULT_MODEL_CONNECTION_MISSING");
        return [tier, {
          ...this.config.models[tier],
          apiKey: credential.apiKey,
          apiBaseUrl: credential.apiBaseUrl,
          model: credential.model,
        }];
      })) as RuntimeConfig["models"],
    };
  }

  private resolveModel(modelTier: SessionSettings["modelTier"], requestedRef?: string): {
    modelRef: ModelRef;
    config: RuntimeConfig["models"]["fast"];
  } {
    const modelRef = (requestedRef ?? `builtin:${modelTier}`) as ModelRef;
    const credential = this.modelCredentials.resolve(modelRef, this.config.models);
    if (!credential) throw new HammerCodeError("找不到选中的模型连接", "INVALID_MODEL_REF", true);
    if (credential.tier !== modelTier) {
      throw new HammerCodeError("模型连接与运行档位不一致", "INVALID_MODEL_REF", true);
    }
    if (!credential.apiKey) {
      throw new HammerCodeError(`${credential.name} 尚未配置 API Key`, "API_KEY_REQUIRED", true);
    }
    return {
      modelRef,
      config: {
        ...this.config.models[credential.tier],
        apiKey: credential.apiKey,
        apiBaseUrl: credential.apiBaseUrl,
        model: credential.model,
      },
    };
  }
}

export function safeIpcError(error: unknown): Error {
  return new Error(redactSecrets(toErrorMessage(error)));
}
