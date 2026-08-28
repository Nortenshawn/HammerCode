import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readWorkspaceTextState } from "../core/file-state";
import { WorkspaceBoundary } from "../core/security/path-boundary";
import type { Clock, IdGenerator, ProjectMemoryPort } from "../core/types";
import { HammerCodeError } from "../core/types";
import type {
  ProjectMemoryConfidence,
  ProjectMemoryInvalidation,
  ProjectMemoryKind,
  ProjectMemoryRecall,
  ProjectMemoryRecord,
  ProjectMemorySnapshot,
  ProjectMemorySource,
} from "../shared/contracts";

const memorySourceSchema = z.object({
  type: z.enum(["tool", "user", "model", "subagent"]),
  sessionId: z.string().max(200).optional(),
  turnId: z.string().max(200).optional(),
  toolCallId: z.string().max(200).optional(),
  toolName: z.string().max(100).optional(),
  subtaskId: z.string().max(200).optional(),
  label: z.string().max(500),
}).strict();

const invalidationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("file_hash"), path: z.string().max(4_096), expectedHash: z.string().max(200) }).strict(),
  z.object({ type: z.literal("workspace_revision"), revision: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("expires_at"), expiresAt: z.string().datetime({ offset: true }) }).strict(),
]);

const memoryRecordSchema = z.object({
  id: z.string().min(1).max(200),
  workspaceRoot: z.string().min(1).max(4_096),
  kind: z.enum(["fact", "decision", "constraint", "verification"]),
  subject: z.string().min(1).max(240),
  statement: z.string().min(1).max(6_000),
  confidence: z.enum(["tool_verified", "user_confirmed", "model_inference"]),
  source: memorySourceSchema,
  invalidation: invalidationSchema,
  status: z.enum(["active", "conflicted", "invalidated", "deleted"]),
  conflictWith: z.array(z.string().max(200)).max(100),
  invalidatedReason: z.string().max(1_000).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const memoryFileSchema = z.object({
  version: z.literal(1),
  workspaceRoot: z.string().min(1).max(4_096),
  revision: z.number().int().nonnegative(),
  records: z.array(memoryRecordSchema).max(10_000),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

type MemoryFile = z.infer<typeof memoryFileSchema>;

function scopeName(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex");
}

function normalizeStatement(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function queryTerms(query: string): string[] {
  const normalized = query.toLocaleLowerCase();
  const words = normalized.match(/[a-z0-9_./:-]{2,}|[\u3400-\u9fff]{2,}/g) ?? [];
  const chinese = [...normalized.matchAll(/[\u3400-\u9fff]+/g)].flatMap((match) => {
    const value = match[0];
    return Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2));
  });
  return [...new Set([...words, ...chinese])].slice(0, 80);
}

function renderRecord(record: ProjectMemoryRecord): string {
  const conflict = record.status === "conflicted" ? " · 冲突" : "";
  return `- [${record.kind} · ${record.confidence}${conflict}] ${record.subject}: ${record.statement}（来源：${record.source.label}；${record.updatedAt}）`;
}

export class ProjectMemoryStore implements ProjectMemoryPort {
  private readonly workspaceQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly onChange?: (snapshot: ProjectMemorySnapshot) => void | Promise<void>,
  ) {}

  async snapshot(workspaceRoot: string): Promise<ProjectMemorySnapshot> {
    return this.withWorkspaceLock(workspaceRoot, async () => {
      const state = await this.load(workspaceRoot);
      const changed = await this.refreshInvalidations(state);
      if (changed) await this.save(state);
      return this.toSnapshot(state);
    });
  }

  async retrieve(
    workspaceRoot: string,
    query: string,
    options: { maxRecords?: number; maxCharacters?: number } = {},
  ): Promise<ProjectMemoryRecall> {
    const snapshot = await this.snapshot(workspaceRoot);
    const maxRecords = Math.max(1, Math.min(20, options.maxRecords ?? 12));
    const maxCharacters = Math.max(500, Math.min(20_000, options.maxCharacters ?? 6_000));
    const terms = queryTerms(query);
    const confidenceScore: Record<ProjectMemoryConfidence, number> = {
      tool_verified: 30,
      user_confirmed: 20,
      model_inference: 5,
    };
    const ranked = snapshot.records
      .filter((record) => record.status === "active" || record.status === "conflicted")
      .map((record) => {
        const haystack = `${record.subject}\n${record.statement}\n${record.source.label}`.toLocaleLowerCase();
        const relevance = terms.reduce((score, term) => score + (haystack.includes(term) ? 8 : 0), 0);
        return { record, score: confidenceScore[record.confidence] + relevance + (record.status === "conflicted" ? -4 : 0) };
      })
      .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt));
    const relevant = ranked.filter((item) => terms.length === 0 || item.score > confidenceScore[item.record.confidence]);
    const candidates = relevant.length > 0 ? relevant : ranked.slice(0, Math.min(4, maxRecords));

    const selected: ProjectMemoryRecord[] = [];
    let rendered = "";
    let truncated = false;
    for (const { record } of candidates) {
      if (selected.length >= maxRecords) { truncated = true; break; }
      const line = renderRecord(record);
      if (rendered.length + line.length + 1 > maxCharacters) { truncated = true; break; }
      selected.push(record);
      rendered += `${rendered ? "\n" : ""}${line}`;
    }
    return { records: selected, rendered, truncated, characterCount: rendered.length };
  }

  async rememberInference(input: Parameters<ProjectMemoryPort["rememberInference"]>[0]): Promise<ProjectMemoryRecord> {
    const invalidation: ProjectMemoryInvalidation = input.invalidation?.type === "expires_at"
      ? { type: "expires_at", expiresAt: input.invalidation.expiresAt }
      : input.invalidation?.type === "file_hash"
        ? input.invalidation
        : { type: "none" };
    return this.addRecord(input.workspaceRoot, {
      kind: input.kind,
      subject: input.subject,
      statement: input.statement,
      confidence: "model_inference",
      source: {
        type: "model",
        sessionId: input.source.sessionId,
        turnId: input.source.turnId,
        toolCallId: input.source.toolCallId,
        toolName: "remember_project",
        label: `模型推断 · ${input.source.sessionId}/${input.source.turnId}`,
      },
      invalidation,
    });
  }

  async recordToolFact(input: Parameters<ProjectMemoryPort["recordToolFact"]>[0]): Promise<ProjectMemoryRecord | null> {
    if (!input.result.ok) return null;
    return this.withWorkspaceLock(input.workspaceRoot, async () => {
      const source: ProjectMemorySource = {
        type: "tool",
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.call.id,
        toolName: input.call.name,
        label: `工具 ${input.call.name} · ${input.sessionId}/${input.turnId}`,
      };
      if (input.fileChange) {
        const state = await this.load(input.workspaceRoot);
        state.revision += 1;
        const now = this.clock.now().toISOString();
        for (const record of state.records) {
          if (
            record.status !== "deleted" &&
            record.kind === "verification" &&
            record.invalidation.type === "workspace_revision" &&
            record.invalidation.revision < state.revision
          ) {
            record.status = "invalidated";
            record.invalidatedReason = `工作区已发生后续文件修改（revision ${state.revision}）`;
            record.updatedAt = now;
          }
          if (
            record.status !== "deleted" &&
            record.subject === `file:${input.fileChange.path}` &&
            (record.status === "active" || record.status === "conflicted")
          ) {
            record.status = "invalidated";
            record.invalidatedReason = "已被新的文件工具事实替代";
            record.updatedAt = now;
          }
        }
        const record = this.createRecord(state, {
          kind: "fact",
          subject: `file:${input.fileChange.path}`,
          statement: `${input.fileChange.kind} ${input.fileChange.path}；当前内容哈希 ${input.fileChange.afterHash ?? "deleted"}`,
          confidence: "tool_verified",
          source,
          invalidation: {
            type: "file_hash",
            path: input.fileChange.path,
            expectedHash: input.fileChange.afterHash ?? "deleted",
          },
        });
        state.records.push(record);
        this.recomputeConflicts(state);
        await this.save(state);
        return record;
      }
      if (!["run_command", "run_python"].includes(input.call.name)) return null;
      const fingerprint = createHash("sha256").update(input.call.arguments).digest("hex").slice(0, 16);
      const state = await this.load(input.workspaceRoot);
      const subject = `verification:${input.call.name}:${fingerprint}`;
      const now = this.clock.now().toISOString();
      for (const existing of state.records) {
        if (
          existing.subject === subject &&
          existing.confidence === "tool_verified" &&
          (existing.status === "active" || existing.status === "conflicted")
        ) {
          existing.status = "invalidated";
          existing.invalidatedReason = "已被同一验证工具的更新结果替代";
          existing.updatedAt = now;
          existing.conflictWith = [];
        }
      }
      const statement = `${input.result.summary}${input.result.output ? `；${input.result.output.slice(0, 1_200)}` : ""}`;
      const record = this.createRecord(state, {
        kind: "verification",
        subject,
        statement,
        confidence: "tool_verified",
        source,
        invalidation: { type: "workspace_revision", revision: state.revision },
      });
      state.records.push(record);
      this.recomputeConflicts(state);
      await this.save(state);
      return record;
    });
  }

  async rememberUser(input: {
    workspaceRoot: string;
    kind: ProjectMemoryKind;
    subject: string;
    statement: string;
    source: ProjectMemorySource;
    invalidation?: ProjectMemoryInvalidation;
  }): Promise<ProjectMemoryRecord> {
    return this.addRecord(input.workspaceRoot, {
      ...input,
      confidence: "user_confirmed",
      invalidation: input.invalidation ?? { type: "none" },
    });
  }

  async delete(workspaceRoot: string, memoryId: string): Promise<ProjectMemorySnapshot> {
    return this.withWorkspaceLock(workspaceRoot, async () => {
      const state = await this.load(workspaceRoot);
      const record = state.records.find((item) => item.id === memoryId && item.workspaceRoot === workspaceRoot);
      if (!record || record.status === "deleted") {
        throw new HammerCodeError("找不到这条项目记忆", "PROJECT_MEMORY_NOT_FOUND", true);
      }
      const now = this.clock.now().toISOString();
      record.status = "deleted";
      record.deletedAt = now;
      record.updatedAt = now;
      record.conflictWith = [];
      this.recomputeConflicts(state);
      await this.save(state);
      return this.toSnapshot(state);
    });
  }

  private async addRecord(
    workspaceRoot: string,
    input: {
      kind: ProjectMemoryKind;
      subject: string;
      statement: string;
      confidence: ProjectMemoryConfidence;
      source: ProjectMemorySource;
      invalidation: ProjectMemoryInvalidation;
    },
  ): Promise<ProjectMemoryRecord> {
    return this.withWorkspaceLock(workspaceRoot, async () => {
      const state = await this.load(workspaceRoot);
      const record = this.createRecord(state, input);
      state.records.push(record);
      this.recomputeConflicts(state);
      await this.save(state);
      return record;
    });
  }

  private createRecord(
    state: MemoryFile,
    input: {
      kind: ProjectMemoryKind;
      subject: string;
      statement: string;
      confidence: ProjectMemoryConfidence;
      source: ProjectMemorySource;
      invalidation: ProjectMemoryInvalidation;
    },
  ): ProjectMemoryRecord {
    const now = this.clock.now().toISOString();
    return {
      id: this.ids.next("memory"),
      workspaceRoot: state.workspaceRoot,
      kind: input.kind,
      subject: input.subject.trim().slice(0, 240),
      statement: input.statement.trim().slice(0, 6_000),
      confidence: input.confidence,
      source: input.source,
      invalidation: input.invalidation,
      status: "active",
      conflictWith: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private recomputeConflicts(state: MemoryFile): void {
    const candidates = state.records.filter((record) => record.status === "active" || record.status === "conflicted");
    for (const record of candidates) {
      record.status = "active";
      record.conflictWith = [];
    }
    const groups = new Map<string, ProjectMemoryRecord[]>();
    for (const record of candidates) {
      const key = `${record.kind}\u0000${record.subject.trim().toLocaleLowerCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    for (const records of groups.values()) {
      if (new Set(records.map((record) => normalizeStatement(record.statement))).size <= 1) continue;
      for (const record of records) {
        record.status = "conflicted";
        record.conflictWith = records.filter((item) => item.id !== record.id).map((item) => item.id);
      }
    }
  }

  private async refreshInvalidations(state: MemoryFile): Promise<boolean> {
    let changed = false;
    let boundary: WorkspaceBoundary | null = null;
    for (const record of state.records) {
      if (record.status !== "active" && record.status !== "conflicted") continue;
      let reason: string | null = null;
      if (record.invalidation.type === "expires_at" && Date.parse(record.invalidation.expiresAt) <= this.clock.now().getTime()) {
        reason = `已到失效时间 ${record.invalidation.expiresAt}`;
      }
      if (record.invalidation.type === "workspace_revision" && record.invalidation.revision < state.revision) {
        reason = `工作区修订已从 ${record.invalidation.revision} 变为 ${state.revision}`;
      }
      if (record.invalidation.type === "file_hash") {
        boundary ??= await WorkspaceBoundary.create(state.workspaceRoot);
        const current = await readWorkspaceTextState(boundary, record.invalidation.path).catch(() => ({ hash: null }));
        const currentHash = current.hash ?? "deleted";
        if (currentHash !== record.invalidation.expectedHash) reason = `文件 ${record.invalidation.path} 的内容哈希已经变化`;
      }
      if (reason) {
        record.status = "invalidated";
        record.invalidatedReason = reason;
        record.updatedAt = this.clock.now().toISOString();
        record.conflictWith = [];
        changed = true;
      }
    }
    if (changed) this.recomputeConflicts(state);
    return changed;
  }

  private async load(workspaceRoot: string): Promise<MemoryFile> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${scopeName(workspaceRoot)}.json`);
    try {
      const parsed = memoryFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.workspaceRoot !== workspaceRoot) {
        throw new HammerCodeError("项目记忆工作区标识不匹配", "PROJECT_MEMORY_SCOPE_MISMATCH");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const now = this.clock.now().toISOString();
      return { version: 1, workspaceRoot, revision: 0, records: [], createdAt: now, updatedAt: now };
    }
  }

  private async save(state: MemoryFile): Promise<void> {
    state.updatedAt = this.clock.now().toISOString();
    const checked = memoryFileSchema.parse(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, `${scopeName(state.workspaceRoot)}.json`);
    const temporary = `${target}.${process.pid}.${this.ids.next("tmp")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    await this.onChange?.(this.toSnapshot(checked));
  }

  private async withWorkspaceLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceQueues.get(workspaceRoot) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    this.workspaceQueues.set(workspaceRoot, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.workspaceQueues.get(workspaceRoot) === current) this.workspaceQueues.delete(workspaceRoot);
    }
  }

  private toSnapshot(state: MemoryFile): ProjectMemorySnapshot {
    return {
      workspaceRoot: state.workspaceRoot,
      revision: state.revision,
      records: state.records.filter((record) => record.status !== "deleted"),
      updatedAt: state.updatedAt,
    };
  }
}
