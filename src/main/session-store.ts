import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { closeUnresolvedToolCalls } from "../core/session-recovery";
import {
  SESSION_STATUSES,
  type AgentSession,
  type AgentTurn,
  type ConversationMessage,
  type SessionSummary,
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
  z.object({ id: z.string(), turnId: z.string().optional(), role: z.literal("user"), content: z.string(), createdAt: z.string() }),
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
const turnSchema = z.object({
  id: z.string(),
  userMessageId: z.string(),
  status: z.enum(SESSION_STATUSES),
  terminationReason: z.enum(["completed", "round_limit", "cancelled", "model_error", "tool_error", "invalid_model_output", "context_overflow", "interrupted"]).optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
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
const sessionSchema = z.object({
  id: z.string(),
  workspaceRoot: z.string(),
  status: z.enum(SESSION_STATUSES),
  task: z.string(),
  turns: z.array(turnSchema).optional(),
  activeTurnId: z.string().optional(),
  messages: z.array(messageSchema),
  toolTraces: z.array(
    z.object({
      turnId: z.string().optional(),
      call: toolCallSchema,
      status: z.enum(["proposed", "awaiting_approval", "approved", "rejected", "running", "succeeded", "failed", "blocked", "cancelled"]),
      summary: z.string(),
      target: z.string().optional(),
      approval: approvalSchema.optional(),
      result: toolResultSchema.optional(),
      startedAt: z.string().optional(),
      finishedAt: z.string().optional(),
      durationMs: z.number().optional(),
      fileChangeId: z.string().optional(),
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
  terminationReason: z.enum(["completed", "round_limit", "cancelled", "model_error", "tool_error", "invalid_model_output", "context_overflow", "interrupted"]).optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const indexSchema = z.object({
  version: z.literal(1),
  workspaceRoot: z.string().nullable(),
  activeSessionId: z.string().nullable(),
  sessionIds: z.array(z.string()),
});

type ParsedSession = z.infer<typeof sessionSchema>;
type SessionIndex = z.infer<typeof indexSchema>;

export interface SessionStoreState {
  activeSession: AgentSession | null;
  sessions: SessionSummary[];
  workspaceRoot: string | null;
}

const ACTIVE_STATUSES = new Set(["requesting", "awaiting_approval", "executing_tool"]);
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/;

function legacyTurnId(sessionId: string, index: number): string {
  return `turn_legacy_${sessionId}_${index}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
}

function normalizeSessionShape(parsed: ParsedSession): AgentSession {
  const rawMessages = parsed.messages.map((message) => ({ ...message }));
  let turns: AgentTurn[] = parsed.turns?.map((turn) => ({ ...turn })) ?? [];

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
        createdAt: message.createdAt,
        updatedAt: isLast ? parsed.updatedAt : users[index + 1]?.createdAt ?? parsed.updatedAt,
        finishedAt: isLast && ACTIVE_STATUSES.has(parsed.status) ? undefined : isLast ? parsed.updatedAt : users[index + 1]?.createdAt,
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
    turns,
    activeTurnId,
    messages,
    toolTraces: parsed.toolTraces.map((trace) => ({
      ...trace,
      turnId: trace.turnId ?? assistantTurnByCall.get(trace.call.id) ?? activeTurnId,
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
    title: session.task.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || "未命名对话",
    status: session.status,
    turnCount: session.turns.length,
    changedFileCount: new Set(session.fileChanges.filter((change) => change.status === "applied").map((change) => change.path)).size,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
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

  async loadState(): Promise<SessionStoreState> {
    const index = await this.readIndex();
    const sessions: AgentSession[] = [];
    const validIds: string[] = [];
    for (const id of index.sessionIds) {
      const session = await this.readSession(id);
      if (!session) continue;
      validIds.push(id);
      sessions.push(session);
    }

    const activeSession = sessions.find((session) => session.id === index.activeSessionId) ?? null;
    if (!activeSession && index.activeSessionId) index.activeSessionId = null;
    if (validIds.length !== index.sessionIds.length) index.sessionIds = validIds;
    const workspaceRoot = index.workspaceRoot ?? activeSession?.workspaceRoot ?? null;
    if (workspaceRoot !== index.workspaceRoot) index.workspaceRoot = workspaceRoot;
    await this.writeIndex(index);
    return { activeSession, sessions: sortSummaries(sessions.map(toSummary)), workspaceRoot };
  }

  async load(): Promise<AgentSession | null> {
    return (await this.loadState()).activeSession;
  }

  async loadSession(id: string): Promise<AgentSession | null> {
    this.assertSafeSessionId(id);
    return this.readSession(id);
  }

  async save(session: AgentSession): Promise<void> {
    this.assertSafeSessionId(session.id);
    const parsed = sessionSchema.parse(session);
    const normalized = normalizeSessionShape(parsed);
    const index = await this.readIndex();
    if (index.workspaceRoot && index.workspaceRoot !== normalized.workspaceRoot) throw new Error("会话工作区与当前单工作区不一致");
    await this.writeSession(normalized);
    index.workspaceRoot = normalized.workspaceRoot;
    index.activeSessionId = normalized.id;
    index.sessionIds = [normalized.id, ...index.sessionIds.filter((id) => id !== normalized.id)];
    await this.writeIndex(index);
  }

  async setWorkspaceRoot(workspaceRoot: string): Promise<void> {
    const index = await this.readIndex();
    if (index.workspaceRoot && index.workspaceRoot !== workspaceRoot && index.sessionIds.length > 0) throw new Error("已有聊天时不能切换到其他工作区");
    index.workspaceRoot = workspaceRoot;
    await this.writeIndex(index);
  }

  async setActive(sessionId: string | null): Promise<void> {
    const index = await this.readIndex();
    if (sessionId !== null) {
      this.assertSafeSessionId(sessionId);
      if (!index.sessionIds.includes(sessionId)) throw new Error("找不到指定聊天");
    }
    index.activeSessionId = sessionId;
    await this.writeIndex(index);
  }

  async clear(): Promise<void> {
    const index = await this.readIndex();
    const activeSessionId = index.activeSessionId;
    if (!activeSessionId) return;
    await rm(this.sessionPath(activeSessionId), { force: true });
    index.sessionIds = index.sessionIds.filter((id) => id !== activeSessionId);
    index.activeSessionId = null;
    await this.writeIndex(index);
  }

  private async readIndex(): Promise<SessionIndex> {
    const raw = await this.readText(this.indexPath);
    if (raw !== null) {
      try {
        const parsed = indexSchema.safeParse(JSON.parse(raw) as unknown);
        if (parsed.success) return parsed.data;
      } catch {
        // Invalid index data is ignored; chat files remain untouched for manual recovery.
      }
      return this.emptyIndex();
    }
    return this.migrateLegacy();
  }

  private async migrateLegacy(): Promise<SessionIndex> {
    const raw = await this.readText(this.legacyPath);
    if (raw === null) return this.emptyIndex();
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) return this.emptyIndex();
      const session = this.normalizeInterrupted(normalizeSessionShape(parsed.data));
      this.assertSafeSessionId(session.id);
      await this.writeSession(session);
      const index: SessionIndex = { version: 1, workspaceRoot: session.workspaceRoot, activeSessionId: session.id, sessionIds: [session.id] };
      await this.writeIndex(index);
      await rm(this.legacyPath, { force: true });
      return index;
    } catch {
      return this.emptyIndex();
    }
  }

  private async readSession(id: string): Promise<AgentSession | null> {
    if (!SAFE_SESSION_ID.test(id)) return null;
    const raw = await this.readText(this.sessionPath(id));
    if (raw === null) return null;
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success || parsed.data.id !== id) return null;
      const session = normalizeSessionShape(parsed.data);
      if (ACTIVE_STATUSES.has(session.status)) {
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
    const turn = session.turns.find((item) => item.id === session.activeTurnId) ?? session.turns.at(-1)!;
    session.transitions.push({ turnId: turn.id, from: session.status, to: "failed", reason: "应用退出导致运行中任务中断；未确认的副作用不会自动重放。", at: now });
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
    return { version: 1, workspaceRoot: null, activeSessionId: null, sessionIds: [] };
  }
}
