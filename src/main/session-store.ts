import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SESSION_STATUSES, type AgentSession } from "../shared/contracts";

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

export class SessionStore {
  private readonly filePath: string;

  constructor(dataDirectory: string) {
    this.filePath = path.join(dataDirectory, "active-session.json");
  }

  async load(): Promise<AgentSession | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success) return null;
    const session = parsed.data as AgentSession;
    if (["requesting", "awaiting_approval", "executing_tool"].includes(session.status)) {
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
      await this.save(session);
    }
    return session;
  }

  async save(session: AgentSession): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(tempPath, JSON.stringify(session, null, 2), { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
