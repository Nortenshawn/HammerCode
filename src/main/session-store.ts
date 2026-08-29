import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { closeUnresolvedToolCalls } from "../core/session-recovery";
import { fallbackChatTitle } from "../shared/chat-title";
import {
  MODEL_TIERS,
  PERMISSION_MODES,
  SESSION_STATUSES,
  SUBAGENT_MODES,
  SUBAGENT_ROLES,
  type AgentSession,
  type AgentTurn,
  type ModelRef,
  type ConversationMessage,
  type SessionSummary,
  type ToolAuthorization,
  type WorkspaceSummary,
} from "../shared/contracts";

const toolCallSchema = z.object({ id: z.string(), name: z.string(), arguments: z.string() });
const toolResultSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  output: z.string(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  errorCode: z.string().optional(),
  truncated: z.boolean().optional(),
});
const approvalSchema = z.object({
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  title: z.string(),
  description: z.string(),
  details: z.string(),
  risk: z.enum(["write", "delete", "command"]),
  turnId: z.string().optional(),
  operation: z.enum(["agent_tool", "undo"]).optional(),
  createdAt: z.string(),
});
const messageSchema = z.discriminatedUnion("role", [
  z.object({
    id: z.string(),
    turnId: z.string().optional(),
    role: z.literal("user"),
    content: z.string(),
    createdAt: z.string(),
  }),
  z.object({
    id: z.string(),
    turnId: z.string().optional(),
    role: z.literal("assistant"),
    content: z.string(),
    reasoningContent: z.string().optional(),
    toolCalls: z.array(toolCallSchema).optional(),
    createdAt: z.string(),
  }),
  z.object({
    id: z.string(),
    turnId: z.string().optional(),
    role: z.literal("tool"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.string(),
    createdAt: z.string(),
  }),
]);
const terminationSchema = z.enum([
  "completed",
  "round_limit",
  "tool_limit",
  "time_limit",
  "cancelled",
  "request_timeout",
  "output_limit",
  "rate_limited",
  "server_error",
  "resource_exhausted",
  "model_error",
  "tool_error",
  "invalid_model_output",
  "context_overflow",
  "interrupted",
]);
const planStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
const planSchema = z.object({
  revision: z.number().int().positive(),
  explanation: z.string().optional(),
  steps: z.array(planStepSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const planCheckpointSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  explanation: z.string().optional(),
  steps: z.array(planStepSchema),
  round: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  createdAt: z.string(),
});
const retryEventSchema = z.object({
  attempt: z.number().int().positive(),
  reason: z.enum(["rate_limited", "server_error", "resource_exhausted"]),
  delayMs: z.number().int().nonnegative(),
  createdAt: z.string(),
});
const metricsSchema = z.object({
  roundsUsed: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  modelRequests: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  maxToolCalls: z.number().int().positive(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  tokenUsageEstimated: z.boolean(),
  maxOutputTokensPerRequest: z.number().int().positive(),
  contextTokenBudget: z.number().int().positive(),
  currentContextTokens: z.number().int().nonnegative().optional(),
  contextCompactions: z.number().int().nonnegative(),
  projectMemoryRecords: z.number().int().nonnegative().default(0),
  projectMemoryCharacters: z.number().int().nonnegative().default(0),
  projectMemoryTokens: z.number().int().nonnegative().default(0),
  skillCount: z.number().int().nonnegative().default(0),
  skillCharacters: z.number().int().nonnegative().default(0),
  skillTokens: z.number().int().nonnegative().default(0),
  maxRunTimeMs: z.number().int().positive(),
});
const projectMemorySettingsSchema = z.object({
  enabled: z.boolean(),
  useMemories: z.boolean(),
  generateMemories: z.boolean(),
  maxRecallRecords: z.number().int().min(1).max(20),
  maxRecallCharacters: z.number().int().min(500).max(20_000),
});
const contextMemorySchema = z.object({
  version: z.literal(1),
  summary: z.string(),
  throughMessageId: z.string(),
  throughCreatedAt: z.string(),
  sourceMessageCount: z.number().int().nonnegative(),
  mode: z.enum(["automatic", "explicit"]).optional(),
  compactionCount: z.number().int().positive().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const skillResourceAuditSchema = z.object({
  path: z.string(),
  kind: z.enum(["entry", "reference", "script", "asset"]),
  characters: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  sha256: z.string(),
  readAt: z.string(),
});
const skillScriptAuditSchema = z.object({
  path: z.string(),
  toolCallId: z.string(),
  status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
  authorization: z.enum(["not_required", "user_approved", "user_rejected", "full_access", "safety_blocked"]).optional(),
  durationMs: z.number().nonnegative().optional(),
  finishedAt: z.string(),
});
const skillUseAuditSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  source: z.enum(["builtin", "user", "project"]),
  scope: z.enum(["application", "user", "project"]),
  trigger: z.enum(["explicit", "automatic"]),
  reason: z.string(),
  packageFingerprint: z.string(),
  entryPath: z.string(),
  instructionCharacters: z.number().int().nonnegative(),
  instructionTokens: z.number().int().nonnegative(),
  availableResources: z.array(z.string()).max(100),
  availableScripts: z.array(z.string()).max(20),
  resources: z.array(skillResourceAuditSchema).max(200),
  scripts: z.array(skillScriptAuditSchema).max(100),
});
const turnSchema = z.object({
  id: z.string(),
  userMessageId: z.string(),
  status: z.enum(SESSION_STATUSES),
  terminationReason: terminationSchema.optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  modelTier: z.enum(MODEL_TIERS).optional(),
  modelRef: z.string().min(1).max(1_000).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  planRequired: z.boolean().optional(),
  plan: planSchema.optional(),
  planCheckpoints: z.array(planCheckpointSchema).optional(),
  retryEvents: z.array(retryEventSchema).optional(),
  metrics: metricsSchema.optional(),
  projectMemorySettings: projectMemorySettingsSchema.optional(),
  skills: z.array(skillUseAuditSchema).max(2).optional(),
});
const fileChangeSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  toolCallId: z.string(),
  path: z.string(),
  kind: z.enum(["create", "modify", "delete"]),
  beforeContent: z.string().nullable(),
  afterContent: z.string().nullable(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  patch: z.string(),
  status: z.enum(["applied", "reverted"]),
  appliedAt: z.string(),
  revertedAt: z.string().optional(),
});
const pendingUndoSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  approvalId: z.string(),
  status: z.enum(["awaiting_approval", "executing"]),
  createdAt: z.string(),
});
const traceStatusSchema = z.enum([
  "proposed",
  "awaiting_approval",
  "approved",
  "rejected",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);
const authorizationSchema = z.enum([
  "not_required",
  "user_approved",
  "user_rejected",
  "full_access",
  "safety_blocked",
]);
const subagentEvidenceSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  detail: z.string(),
});
const subagentFindingSchema = z.object({
  title: z.string(),
  detail: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(subagentEvidenceSchema),
});
const subagentResultSchema = z.object({
  summary: z.string(),
  findings: z.array(subagentFindingSchema),
  relatedFiles: z.array(z.string()),
  verificationSuggestions: z.array(z.string()),
  risks: z.array(z.string()),
});
const subagentPatchSchema = z.object({
  id: z.string(),
  path: z.string(),
  kind: z.enum(["create", "modify", "delete"]),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  patch: z.string(),
  createdAt: z.string(),
});
const subagentBudgetSchema = z.object({
  maxRounds: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxRunTimeMs: z.number().int().positive(),
  contextTokenBudget: z.number().int().positive(),
});
const subagentSchema = z.object({
  id: z.string(),
  parentSessionId: z.string(),
  parentTurnId: z.string(),
  role: z.enum(SUBAGENT_ROLES),
  mode: z.enum(SUBAGENT_MODES),
  task: z.string(),
  status: z.enum(["pending", "requesting", "executing_tool", "completed", "cancelled", "failed"]),
  modelTier: z.enum(MODEL_TIERS),
  modelRef: z.string().regex(/^(?:builtin:(?:fast|strong)|connection:[0-9a-f-]{36})$/i),
  parentPermissionMode: z.enum(PERMISSION_MODES),
  effectivePermission: z.enum(["read_only", "proposal_only"]),
  budget: subagentBudgetSchema,
  metrics: metricsSchema.optional(),
  plan: planSchema,
  messages: z.array(messageSchema),
  toolTraces: z.array(z.object({
    turnId: z.string().optional(),
    call: toolCallSchema,
    status: traceStatusSchema,
    summary: z.string(),
    target: z.string().optional(),
    approval: approvalSchema.optional(),
    result: toolResultSchema.optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    durationMs: z.number().optional(),
    fileChangeId: z.string().optional(),
    authorization: authorizationSchema.optional(),
    approvalPolicy: z.enum(["none", "permission_mode", "always"]).optional(),
  })),
  patches: z.array(subagentPatchSchema),
  result: subagentResultSchema.optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
});
const sessionSchema = z.object({
  id: z.string(),
  workspaceRoot: z.string(),
  status: z.enum(SESSION_STATUSES),
  task: z.string(),
  title: z.string().max(120).optional(),
  modelTier: z.enum(MODEL_TIERS).optional(),
  modelRef: z.string().min(1).max(1_000).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  turns: z.array(turnSchema).optional(),
  activeTurnId: z.string().optional(),
  messages: z.array(messageSchema),
  toolTraces: z.array(
    z.object({
      turnId: z.string().optional(),
      call: toolCallSchema,
      status: traceStatusSchema,
      summary: z.string(),
      target: z.string().optional(),
      approval: approvalSchema.optional(),
      result: toolResultSchema.optional(),
      startedAt: z.string().optional(),
      finishedAt: z.string().optional(),
      durationMs: z.number().optional(),
      fileChangeId: z.string().optional(),
      authorization: authorizationSchema.optional(),
      approvalPolicy: z.enum(["none", "permission_mode", "always"]).optional(),
    }),
  ),
  fileChanges: z.array(fileChangeSchema).optional(),
  transitions: z.array(
    z.object({
      turnId: z.string().optional(),
      from: z.enum(SESSION_STATUSES),
      to: z.enum(SESSION_STATUSES),
      reason: z.string(),
      at: z.string(),
    }),
  ),
  streamingText: z.string(),
  streamingReasoning: z.string(),
  pendingApproval: approvalSchema.optional(),
  pendingUndo: pendingUndoSchema.optional(),
  contextMemory: contextMemorySchema.optional(),
  subtasks: z.array(subagentSchema).max(200).optional(),
  terminationReason: terminationSchema.optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const indexV1Schema = z.object({
  version: z.literal(1),
  workspaceRoot: z.string().nullable(),
  activeSessionId: z.string().nullable(),
  sessionIds: z.array(z.string()),
});
const workspaceIndexSchema = z.object({
  root: z.string(),
  activeSessionId: z.string().nullable(),
  sessionIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const indexV2Schema = z.object({
  version: z.literal(2),
  activeWorkspaceRoot: z.string().nullable(),
  workspaces: z.array(workspaceIndexSchema),
});

type ParsedSession = z.infer<typeof sessionSchema>;
type LegacyIndex = z.infer<typeof indexV1Schema>;
type SessionIndex = z.infer<typeof indexV2Schema>;
type WorkspaceIndex = z.infer<typeof workspaceIndexSchema>;

export interface SessionStoreState {
  activeSession: AgentSession | null;
  sessions: SessionSummary[];
  workspaces: WorkspaceSummary[];
  workspaceRoot: string | null;
}

const ACTIVE_STATUSES = new Set(["requesting", "awaiting_approval", "executing_tool"]);
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/;

function legacyTurnId(sessionId: string, index: number): string {
  return `turn_legacy_${sessionId}_${index}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
}

function builtinModelRef(tier: "fast" | "strong"): ModelRef {
  return tier === "fast" ? "builtin:fast" : "builtin:strong";
}

function normalizeModelRef(ref: string | undefined, tier: "fast" | "strong"): ModelRef {
  if (ref === builtinModelRef(tier)) return ref;
  if (/^connection:[0-9a-f-]{36}$/i.test(ref ?? "")) return ref as ModelRef;
  return builtinModelRef(tier);
}

function inferAuthorization(trace: ParsedSession["toolTraces"][number]): ToolAuthorization {
  if (trace.authorization) return trace.authorization;
  if (trace.status === "blocked") return "safety_blocked";
  if (trace.status === "rejected") return "user_rejected";
  if (trace.approval) return "user_approved";
  return "not_required";
}

function normalizeSessionShape(parsed: ParsedSession): AgentSession {
  const rawMessages = parsed.messages.map((message) => ({ ...message }));
  const defaultModelTier = parsed.modelTier ?? parsed.turns?.at(-1)?.modelTier ?? "fast";
  const defaultModelRef = normalizeModelRef(parsed.modelRef, defaultModelTier);
  const defaultPermissionMode =
    parsed.permissionMode ?? parsed.turns?.at(-1)?.permissionMode ?? "ask";
  let turns: AgentTurn[] =
    parsed.turns?.map((turn) => ({
      ...turn,
      modelTier: turn.modelTier ?? defaultModelTier,
      modelRef: normalizeModelRef(turn.modelRef, turn.modelTier ?? defaultModelTier),
      permissionMode: turn.permissionMode ?? "ask",
      planCheckpoints: turn.planCheckpoints ?? [],
      retryEvents: turn.retryEvents ?? [],
      metrics: turn.metrics ? {
        ...turn.metrics,
        currentContextTokens: turn.metrics.currentContextTokens ?? 0,
        skillCount: turn.metrics.skillCount ?? 0,
        skillCharacters: turn.metrics.skillCharacters ?? 0,
        skillTokens: turn.metrics.skillTokens ?? 0,
      } : undefined,
    })) ?? [];

  if (turns.length === 0) {
    const users = rawMessages.filter((message) => message.role === "user");
    if (users.length === 0) throw new Error("会话缺少用户消息");
    turns = users.map((message, index) => {
      const isLast = index === users.length - 1;
      return {
        id: message.turnId ?? legacyTurnId(parsed.id, index),
        userMessageId: message.id,
        status: isLast ? parsed.status : "completed",
        terminationReason: isLast ? parsed.terminationReason : "completed",
        error: isLast ? parsed.error : undefined,
        modelTier: defaultModelTier,
        modelRef: defaultModelRef,
        permissionMode: "ask",
        createdAt: message.createdAt,
        updatedAt: isLast ? parsed.updatedAt : users[index + 1]?.createdAt ?? parsed.updatedAt,
        finishedAt:
          isLast && ACTIVE_STATUSES.has(parsed.status)
            ? undefined
            : isLast
              ? parsed.updatedAt
              : users[index + 1]?.createdAt,
      };
    });
  }

  const turnByUserMessage = new Map(turns.map((turn) => [turn.userMessageId, turn]));
  let currentTurn = turns[0];
  const messages = rawMessages.map((message) => {
    if (message.role === "user") currentTurn = turnByUserMessage.get(message.id) ?? currentTurn;
    return { ...message, turnId: message.turnId ?? currentTurn.id } as ConversationMessage;
  });
  const assistantTurnByCall = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) assistantTurnByCall.set(call.id, message.turnId);
  }
  const activeTurnId =
    parsed.activeTurnId && turns.some((turn) => turn.id === parsed.activeTurnId)
      ? parsed.activeTurnId
      : turns.at(-1)!.id;

  return {
    id: parsed.id,
    workspaceRoot: parsed.workspaceRoot,
    status: parsed.status,
    task: parsed.task,
    title: parsed.title,
    modelTier: parsed.modelTier ?? turns.at(-1)?.modelTier ?? "fast",
    modelRef: normalizeModelRef(parsed.modelRef, parsed.modelTier ?? turns.at(-1)?.modelTier ?? defaultModelTier),
    permissionMode: parsed.permissionMode ?? defaultPermissionMode,
    turns,
    activeTurnId,
    messages,
    toolTraces: parsed.toolTraces.map((trace) => ({
      ...trace,
      turnId: trace.turnId ?? assistantTurnByCall.get(trace.call.id) ?? activeTurnId,
      authorization: inferAuthorization(trace),
    })),
    fileChanges: parsed.fileChanges?.map((change) => ({ ...change })) ?? [],
    transitions: parsed.transitions.map((transition) => ({
      ...transition,
      turnId: transition.turnId ?? activeTurnId,
    })),
    streamingText: parsed.streamingText,
    streamingReasoning: parsed.streamingReasoning,
    pendingApproval: parsed.pendingApproval,
    pendingUndo: parsed.pendingUndo,
    contextMemory: parsed.contextMemory ? {
      ...parsed.contextMemory,
      mode: parsed.contextMemory.mode ?? "explicit",
      compactionCount: parsed.contextMemory.compactionCount ?? 1,
    } : undefined,
    subtasks: parsed.subtasks?.map((task) => ({
      ...task,
      modelRef: normalizeModelRef(task.modelRef, task.modelTier),
      metrics: task.metrics ? {
        ...task.metrics,
        currentContextTokens: task.metrics.currentContextTokens ?? 0,
      } : undefined,
      messages: task.messages.map((message) => ({
        ...message,
        turnId: message.turnId ?? task.parentTurnId,
      })) as ConversationMessage[],
      toolTraces: task.toolTraces.map((trace) => ({
        ...trace,
        turnId: trace.turnId ?? task.parentTurnId,
      })),
    })),
    terminationReason: parsed.terminationReason,
    error: parsed.error,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

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

function workspaceName(root: string): string {
  return path.basename(root) || root;
}

function toWorkspaceSummary(
  workspace: WorkspaceIndex,
  sessions: SessionSummary[],
): WorkspaceSummary {
  return {
    root: workspace.root,
    name: workspaceName(workspace.root),
    sessionCount: sessions.length,
    sessions,
    activeSessionId: workspace.activeSessionId,
    updatedAt: workspace.updatedAt,
  };
}

function sortSummaries(items: SessionSummary[]): SessionSummary[] {
  return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export class SessionStore {
  private readonly dataDirectory: string;
  private readonly indexPath: string;
  private readonly sessionsDirectory: string;
  private readonly legacyPath: string;
  private writeCounter = 0;

  constructor(dataDirectory: string) {
    this.dataDirectory = dataDirectory;
    this.indexPath = path.join(dataDirectory, "session-index.json");
    this.sessionsDirectory = path.join(dataDirectory, "chats");
    this.legacyPath = path.join(dataDirectory, "active-session.json");
  }

  async loadState(options: { liveSessionIds?: readonly string[] } = {}): Promise<SessionStoreState> {
    const index = await this.readIndex();
    const liveSessionIds = new Set(options.liveSessionIds ?? []);
    const workspaceSummaries: WorkspaceSummary[] = [];
    let activeSession: AgentSession | null = null;
    let activeSessions: SessionSummary[] = [];
    for (const workspace of index.workspaces) {
      const sessions: AgentSession[] = [];
      const validIds: string[] = [];
      for (const id of workspace.sessionIds) {
        const session = await this.readSession(id, liveSessionIds.has(id));
        if (!session || session.workspaceRoot !== workspace.root) continue;
        validIds.push(id);
        sessions.push(session);
      }
      workspace.sessionIds = validIds;
      const summaries = sortSummaries(sessions.map(toSummary));
      const selected =
        sessions.find((session) => session.id === workspace.activeSessionId) ?? null;
      if (!selected) workspace.activeSessionId = null;
      workspaceSummaries.push(toWorkspaceSummary(workspace, summaries));
      if (workspace.root === index.activeWorkspaceRoot) {
        activeSession = selected;
        activeSessions = summaries;
      }
    }
    if (!index.workspaces.some((item) => item.root === index.activeWorkspaceRoot)) {
      index.activeWorkspaceRoot = null;
    }
    await this.writeIndex(index);
    return {
      activeSession,
      sessions: activeSessions,
      // Keep the explicit insertion order from the index. Selecting a project or
      // chat must not make the sidebar jump by moving that project to the top.
      workspaces: workspaceSummaries,
      workspaceRoot: index.activeWorkspaceRoot,
    };
  }

  async load(): Promise<AgentSession | null> {
    return (await this.loadState()).activeSession;
  }

  async loadSession(id: string, options: { preserveActive?: boolean } = {}): Promise<AgentSession | null> {
    this.assertSafeSessionId(id);
    return this.readSession(id, options.preserveActive === true);
  }

  async save(session: AgentSession, options: { activate?: boolean } = {}): Promise<void> {
    this.assertSafeSessionId(session.id);
    const parsed = sessionSchema.parse(session);
    const normalized = normalizeSessionShape(parsed);
    const index = await this.readIndex();
    const now = normalized.updatedAt;
    let workspace = index.workspaces.find((item) => item.root === normalized.workspaceRoot);
    if (!workspace) {
      workspace = {
        root: normalized.workspaceRoot,
        activeSessionId: null,
        sessionIds: [],
        createdAt: now,
        updatedAt: now,
      };
      index.workspaces.push(workspace);
    }
    await this.writeSession(normalized);
    workspace.sessionIds = [
      normalized.id,
      ...workspace.sessionIds.filter((id) => id !== normalized.id),
    ];
    workspace.updatedAt = now;
    if (options.activate !== false) {
      workspace.activeSessionId = normalized.id;
      index.activeWorkspaceRoot = workspace.root;
    }
    await this.writeIndex(index);
  }

  async setWorkspaceRoot(workspaceRoot: string): Promise<void> {
    const index = await this.readIndex();
    let workspace = index.workspaces.find((item) => item.root === workspaceRoot);
    if (!workspace) {
      const now = new Date().toISOString();
      workspace = {
        root: workspaceRoot,
        activeSessionId: null,
        sessionIds: [],
        createdAt: now,
        updatedAt: now,
      };
      index.workspaces.push(workspace);
    }
    index.activeWorkspaceRoot = workspace.root;
    workspace.updatedAt = new Date().toISOString();
    await this.writeIndex(index);
  }

  async selectWorkspace(workspaceRoot: string): Promise<void> {
    const index = await this.readIndex();
    const workspace = index.workspaces.find((item) => item.root === workspaceRoot);
    if (!workspace) throw new Error("找不到指定工作区");
    index.activeWorkspaceRoot = workspace.root;
    workspace.updatedAt = new Date().toISOString();
    await this.writeIndex(index);
  }

  async setActive(sessionId: string | null): Promise<void> {
    const index = await this.readIndex();
    const workspace = index.workspaces.find(
      (item) => item.root === index.activeWorkspaceRoot,
    );
    if (!workspace) throw new Error("当前没有工作区");
    if (sessionId !== null) {
      this.assertSafeSessionId(sessionId);
      if (!workspace.sessionIds.includes(sessionId)) throw new Error("找不到指定聊天");
    }
    workspace.activeSessionId = sessionId;
    workspace.updatedAt = new Date().toISOString();
    await this.writeIndex(index);
  }

  async clear(): Promise<void> {
    const index = await this.readIndex();
    const workspace = index.workspaces.find(
      (item) => item.root === index.activeWorkspaceRoot,
    );
    const activeSessionId = workspace?.activeSessionId;
    if (!workspace || !activeSessionId) return;
    await rm(this.sessionPath(activeSessionId), { force: true });
    workspace.sessionIds = workspace.sessionIds.filter((id) => id !== activeSessionId);
    workspace.activeSessionId = null;
    workspace.updatedAt = new Date().toISOString();
    await this.writeIndex(index);
  }

  private async readIndex(): Promise<SessionIndex> {
    const raw = await this.readText(this.indexPath);
    if (raw !== null) {
      try {
        const value = JSON.parse(raw) as unknown;
        const current = indexV2Schema.safeParse(value);
        if (current.success) return current.data;
        const legacy = indexV1Schema.safeParse(value);
        if (legacy.success) return this.migrateV1Index(legacy.data);
      } catch {
        // Invalid index data is ignored; chat files remain untouched for manual recovery.
      }
      return this.emptyIndex();
    }
    return this.migrateLegacySession();
  }

  private async migrateV1Index(legacy: LegacyIndex): Promise<SessionIndex> {
    const groups = new Map<string, AgentSession[]>();
    for (const id of legacy.sessionIds) {
      const session = await this.readSession(id);
      if (!session) continue;
      const group = groups.get(session.workspaceRoot) ?? [];
      group.push(session);
      groups.set(session.workspaceRoot, group);
    }
    if (groups.size === 0 && legacy.workspaceRoot) groups.set(legacy.workspaceRoot, []);
    const workspaces: WorkspaceIndex[] = [...groups.entries()].map(([root, sessions]) => {
      const createdAt =
        sessions.map((session) => session.createdAt).sort()[0] ?? new Date().toISOString();
      const updatedAt =
        sessions.map((session) => session.updatedAt).sort().at(-1) ?? createdAt;
      return {
        root,
        activeSessionId: sessions.some((session) => session.id === legacy.activeSessionId)
          ? legacy.activeSessionId
          : null,
        sessionIds: sessions
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map((session) => session.id),
        createdAt,
        updatedAt,
      };
    });
    const activeSession = workspaces.find((workspace) => workspace.activeSessionId);
    const activeWorkspaceRoot =
      activeSession?.root ??
      workspaces.find((workspace) => workspace.root === legacy.workspaceRoot)?.root ??
      workspaces[0]?.root ??
      null;
    const index: SessionIndex = { version: 2, activeWorkspaceRoot, workspaces };
    await this.writeIndex(index);
    return index;
  }

  private async migrateLegacySession(): Promise<SessionIndex> {
    const raw = await this.readText(this.legacyPath);
    if (raw === null) return this.emptyIndex();
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) return this.emptyIndex();
      const session = this.normalizeInterrupted(normalizeSessionShape(parsed.data));
      this.assertSafeSessionId(session.id);
      await this.writeSession(session);
      const index: SessionIndex = {
        version: 2,
        activeWorkspaceRoot: session.workspaceRoot,
        workspaces: [
          {
            root: session.workspaceRoot,
            activeSessionId: session.id,
            sessionIds: [session.id],
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          },
        ],
      };
      await this.writeIndex(index);
      await rm(this.legacyPath, { force: true });
      return index;
    } catch {
      return this.emptyIndex();
    }
  }

  private async readSession(id: string, preserveActive = false): Promise<AgentSession | null> {
    if (!SAFE_SESSION_ID.test(id)) return null;
    const raw = await this.readText(this.sessionPath(id));
    if (raw === null) return null;
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success || parsed.data.id !== id) return null;
      const session = normalizeSessionShape(parsed.data);
      if (ACTIVE_STATUSES.has(session.status) && !preserveActive) {
        const normalized = this.normalizeInterrupted(session);
        await this.writeSession(normalized);
        return normalized;
      }
      return session;
    } catch {
      return null;
    }
  }

  private normalizeInterrupted(session: AgentSession): AgentSession {
    if (!ACTIVE_STATUSES.has(session.status)) return session;
    const now = new Date().toISOString();
    closeUnresolvedToolCalls(session, now);
    const turn =
      session.turns.find((item) => item.id === session.activeTurnId) ?? session.turns.at(-1)!;
    session.transitions.push({
      turnId: turn.id,
      from: session.status,
      to: "failed",
      reason: "应用退出导致运行中任务中断；未确认的副作用不会自动重放。",
      at: now,
    });
    session.status = "failed";
    turn.status = "failed";
    turn.terminationReason = "interrupted";
    turn.error = "上次运行被中断。请检查已有结果后继续对话。";
    turn.updatedAt = now;
    turn.finishedAt = now;
    session.pendingApproval = undefined;
    session.streamingText = "";
    session.streamingReasoning = "";
    session.terminationReason = "interrupted";
    session.error = turn.error;
    session.updatedAt = now;
    return session;
  }

  private async writeSession(session: AgentSession): Promise<void> {
    await mkdir(this.sessionsDirectory, { recursive: true, mode: 0o700 });
    await this.writeJsonAtomically(this.sessionPath(session.id), session);
  }

  private async writeIndex(index: SessionIndex): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await this.writeJsonAtomically(this.indexPath, index);
  }

  private async writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    this.writeCounter += 1;
    const tempPath = `${filePath}.tmp-${process.pid}-${this.writeCounter}`;
    await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tempPath, filePath);
  }

  private async readText(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private sessionPath(id: string): string {
    this.assertSafeSessionId(id);
    return path.join(this.sessionsDirectory, `${id}.json`);
  }

  private assertSafeSessionId(id: string): void {
    if (!SAFE_SESSION_ID.test(id)) throw new Error("无效的会话标识");
  }

  private emptyIndex(): SessionIndex {
    return { version: 2, activeWorkspaceRoot: null, workspaces: [] };
  }
}
