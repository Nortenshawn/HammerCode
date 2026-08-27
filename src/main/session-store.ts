import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  SESSION_STATUSES,
  type AgentSession,
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
  createdAt: z.string(),
});
const messageSchema = z.discriminatedUnion("role", [
  z.object({ id: z.string(), role: z.literal("user"), content: z.string(), createdAt: z.string() }),
  z.object({
    id: z.string(),
    role: z.literal("assistant"),
    content: z.string(),
    reasoningContent: z.string().optional(),
    toolCalls: z.array(toolCallSchema).optional(),
    createdAt: z.string(),
  }),
  z.object({
    id: z.string(),
    role: z.literal("tool"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.string(),
    createdAt: z.string(),
  }),
]);
const sessionSchema = z.object({
  id: z.string(),
  workspaceRoot: z.string(),
  status: z.enum(SESSION_STATUSES),
  task: z.string(),
  messages: z.array(messageSchema),
  toolTraces: z.array(
    z.object({
      call: toolCallSchema,
      status: z.enum([
        "proposed",
        "awaiting_approval",
        "approved",
        "rejected",
        "running",
        "succeeded",
        "failed",
        "blocked",
        "cancelled",
      ]),
      summary: z.string(),
      target: z.string().optional(),
      approval: approvalSchema.optional(),
      result: toolResultSchema.optional(),
      startedAt: z.string().optional(),
      finishedAt: z.string().optional(),
      durationMs: z.number().optional(),
    }),
  ),
  transitions: z.array(
    z.object({
      from: z.enum(SESSION_STATUSES),
      to: z.enum(SESSION_STATUSES),
      reason: z.string(),
      at: z.string(),
    }),
  ),
  streamingText: z.string(),
  streamingReasoning: z.string(),
  pendingApproval: approvalSchema.optional(),
  terminationReason: z
    .enum([
      "completed",
      "round_limit",
      "cancelled",
      "model_error",
      "tool_error",
      "invalid_model_output",
      "context_overflow",
      "interrupted",
    ])
    .optional(),
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

type SessionIndex = z.infer<typeof indexSchema>;

export interface SessionStoreState {
  activeSession: AgentSession | null;
  sessions: SessionSummary[];
  workspaceRoot: string | null;
}

const ACTIVE_STATUSES = new Set(["requesting", "awaiting_approval", "executing_tool"]);
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/;

function toSummary(session: AgentSession): SessionSummary {
  return {
    id: session.id,
    workspaceRoot: session.workspaceRoot,
    title: session.task.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || "未命名对话",
    status: session.status,
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

    const activeSession =
      sessions.find((session) => session.id === index.activeSessionId) ?? null;
    if (!activeSession && index.activeSessionId) index.activeSessionId = null;
    if (validIds.length !== index.sessionIds.length) index.sessionIds = validIds;

    const workspaceRoot = index.workspaceRoot ?? activeSession?.workspaceRoot ?? null;
    if (workspaceRoot !== index.workspaceRoot) index.workspaceRoot = workspaceRoot;
    await this.writeIndex(index);

    return {
      activeSession,
      sessions: sortSummaries(sessions.map(toSummary)),
      workspaceRoot,
    };
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
    const parsed = sessionSchema.parse(session) as AgentSession;
    const index = await this.readIndex();
    if (index.workspaceRoot && index.workspaceRoot !== parsed.workspaceRoot) {
      throw new Error("会话工作区与当前单工作区不一致");
    }
    await this.writeSession(parsed);
    index.workspaceRoot = parsed.workspaceRoot;
    index.activeSessionId = parsed.id;
    index.sessionIds = [parsed.id, ...index.sessionIds.filter((id) => id !== parsed.id)];
    await this.writeIndex(index);
  }

  async setWorkspaceRoot(workspaceRoot: string): Promise<void> {
    const index = await this.readIndex();
    if (index.workspaceRoot && index.workspaceRoot !== workspaceRoot && index.sessionIds.length > 0) {
      throw new Error("已有聊天时不能切换到其他工作区");
    }
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
        // A malformed index is ignored. Individual chat files remain untouched.
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
      const session = parsed.data as AgentSession;
      this.assertSafeSessionId(session.id);
      const normalized = this.normalizeInterrupted(session);
      await this.writeSession(normalized);
      const index: SessionIndex = {
        version: 1,
        workspaceRoot: normalized.workspaceRoot,
        activeSessionId: normalized.id,
        sessionIds: [normalized.id],
      };
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
      const session = parsed.data as AgentSession;
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
    session.transitions.push({
      from: session.status,
      to: "failed",
      reason: "应用退出导致运行中任务中断；未确认的副作用不会自动重放。",
      at: now,
    });
    session.status = "failed";
    session.pendingApproval = undefined;
    session.streamingText = "";
    session.streamingReasoning = "";
    session.terminationReason = "interrupted";
    session.error = "上次运行被中断。请检查已有结果后重新提交任务。";
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
