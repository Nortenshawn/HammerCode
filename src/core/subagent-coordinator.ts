import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type {
  AgentSession,
  FileChangeKind,
  SubagentPatchProposal,
  SubagentResult,
  SubagentTask,
} from "../shared/contracts";
import { AgentRunner } from "./agent-runner";
import { hashText, readWorkspaceTextState } from "./file-state";
import { WorkspaceBoundary } from "./security/path-boundary";
import { LocalToolExecutor } from "./tools/tool-executor";
import type {
  Clock,
  IdGenerator,
  ModelClient,
  ModelToolDefinition,
  PreparedToolCall,
  SubagentCoordinatorPort,
  ToolExecutorPort,
  WorkspaceWriteLeasePort,
} from "./types";
import { HammerCodeError } from "./types";
import { cloneValue, toErrorMessage } from "./utils";

const READ_ONLY_TOOLS = new Set([
  "update_plan",
  "list_files",
  "read_file",
  "read_pdf",
  "search_text",
  "git_status",
  "git_diff",
]);

const proposalSchema = z.object({
  path: z.string().min(1).max(4_096),
  content: z.string().max(1_000_000).optional(),
  delete: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (!value.delete && value.content === undefined) {
    context.addIssue({ code: "custom", message: "非删除提案必须提供 content" });
  }
  if (value.delete && value.content !== undefined) {
    context.addIssue({ code: "custom", message: "删除提案不能同时提供 content" });
  }
});

const PROPOSAL_DEFINITION: ModelToolDefinition = {
  type: "function",
  function: {
    name: "propose_file_change",
    description: "生成候选文件 diff，但绝不写入磁盘。每个路径同一时刻只允许一个子 Agent 持有提案租约。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区文件路径" },
        content: { type: "string", description: "候选完整文本；删除时省略" },
        delete: { type: "boolean", description: "是否提议删除文件，默认 false" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

const resultSchema = z.object({
  summary: z.string().min(1).max(20_000),
  findings: z.array(z.object({
    title: z.string().min(1).max(500),
    detail: z.string().min(1).max(10_000),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.object({
      path: z.string().min(1).max(4_096),
      line: z.number().int().positive().optional(),
      detail: z.string().min(1).max(2_000),
    }).strict()).max(50),
  }).strict()).max(50),
  relatedFiles: z.array(z.string().max(4_096)).max(100),
  verificationSuggestions: z.array(z.string().max(2_000)).max(50),
  risks: z.array(z.string().max(2_000)).max(50),
}).strict();

const SUBAGENT_SYSTEM_PROMPT = `你是当前主任务创建的隔离子 Agent。你只完成分配给你的单一调查任务。

硬边界：
- 只能使用提供的只读工具；如果有 propose_file_change，它也只生成候选 diff，绝不修改磁盘。
- 不得请求或假设通用命令、直接写文件、项目记忆、远端操作或创建更多 Agent。
- 先用 update_plan 建立简短计划，再读取真实来源。结论必须引用相对路径和尽可能精确的行号。
- 不要向主任务发指令，不要声称未验证的操作已经完成。

最终只输出一个 JSON 对象，不要 Markdown 围栏，字段必须为：
{"summary":"...","findings":[{"title":"...","detail":"...","confidence":"high|medium|low","evidence":[{"path":"...","line":1,"detail":"..."}]}],"relatedFiles":["..."],"verificationSuggestions":["..."],"risks":["..."]}`;

class RestrictedSubagentTools implements ToolExecutorPort {
  readonly definitions: ModelToolDefinition[];
  readonly patches: SubagentPatchProposal[] = [];

  constructor(
    private readonly base: LocalToolExecutor,
    private readonly boundary: WorkspaceBoundary,
    private readonly taskId: string,
    private readonly allowProposals: boolean,
    private readonly ids: IdGenerator,
    private readonly leases: WorkspaceWriteLeasePort,
  ) {
    this.definitions = [
      ...base.definitions.filter((definition) => READ_ONLY_TOOLS.has(definition.function.name)),
      ...(allowProposals ? [PROPOSAL_DEFINITION] : []),
    ];
  }

  async prepare(call: { id: string; name: string; arguments: string }, now: Date): Promise<PreparedToolCall> {
    if (READ_ONLY_TOOLS.has(call.name)) return this.base.prepare(call, now);
    if (call.name !== "propose_file_change" || !this.allowProposals) {
      throw new HammerCodeError(
        `子 Agent 无权使用工具：${call.name}`,
        "SUBAGENT_TOOL_BLOCKED",
        true,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || "{}");
    } catch {
      throw new HammerCodeError("补丁提案参数不是有效 JSON", "INVALID_PATCH_PROPOSAL", true);
    }
    const parsed = proposalSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HammerCodeError(
        `补丁提案参数校验失败：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
        "INVALID_PATCH_PROPOSAL",
        true,
      );
    }
    const args = parsed.data;
    await this.boundary.resolveForWrite(args.path);
    this.leases.acquire(args.path, this.taskId, now);
    const before = await readWorkspaceTextState(this.boundary, args.path);
    if (args.delete && before.content === null) {
      throw new HammerCodeError("不能提议删除不存在的文件", "PATCH_TARGET_MISSING", true);
    }
    const afterContent = args.delete ? null : args.content!;
    const kind: FileChangeKind = args.delete ? "delete" : before.content === null ? "create" : "modify";
    const patch = createTwoFilesPatch(
      before.content === null ? "/dev/null" : `a/${args.path}`,
      afterContent === null ? "/dev/null" : `b/${args.path}`,
      before.content ?? "",
      afterContent ?? "",
      "当前工作区",
      "子 Agent 提案",
      { context: 4 },
    );
    const proposal: SubagentPatchProposal = {
      id: this.ids.next("proposal"),
      path: args.path,
      kind,
      beforeHash: before.hash,
      afterHash: afterContent === null ? null : hashText(afterContent),
      patch,
      createdAt: now.toISOString(),
    };
    return {
      call,
      summary: `生成 ${args.path} 的候选补丁（未写入）`,
      target: args.path,
      requiresApproval: false,
      execute: async () => {
        const existing = this.patches.findIndex((item) => item.path === args.path);
        if (existing >= 0) this.patches.splice(existing, 1, proposal);
        else this.patches.push(proposal);
        return {
          ok: true,
          summary: `已生成 ${args.path} 的候选补丁，磁盘未修改`,
          output: patch.slice(0, 120_000),
          truncated: patch.length > 120_000,
          metadata: { proposalId: proposal.id, path: args.path, diskWritten: false },
        };
      },
    };
  }
}

export interface RestrictedSubagentCoordinatorOptions {
  modelName?: string;
  maxRounds?: number;
  maxToolCalls?: number;
  maxRunTimeMs?: number;
  maxModelRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxOutputTokens?: number;
  contextTokenBudget?: number;
}

export class RestrictedSubagentCoordinator implements SubagentCoordinatorPort {
  constructor(
    private readonly model: ModelClient,
    private readonly boundary: WorkspaceBoundary,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly leases: WorkspaceWriteLeasePort,
    private readonly options: RestrictedSubagentCoordinatorOptions = {},
  ) {}

  async spawn(input: Parameters<SubagentCoordinatorPort["spawn"]>[0]): Promise<SubagentTask[]> {
    if (input.tasks.length < 1 || input.tasks.length > 3) {
      throw new HammerCodeError("每次只能启动 1–3 个子 Agent", "SUBAGENT_LIMIT", true);
    }
    return Promise.all(input.tasks.map((specification) => this.runOne(input, specification)));
  }

  private async runOne(
    parent: Parameters<SubagentCoordinatorPort["spawn"]>[0],
    specification: Parameters<SubagentCoordinatorPort["spawn"]>[0]["tasks"][number],
  ): Promise<SubagentTask> {
    const taskId = this.ids.next("subtask");
    const now = this.clock.now().toISOString();
    const budget = {
      maxRounds: this.options.maxRounds ?? 8,
      maxToolCalls: this.options.maxToolCalls ?? 30,
      maxRunTimeMs: this.options.maxRunTimeMs ?? 300_000,
      contextTokenBudget: this.options.contextTokenBudget ?? 64_000,
    };
    let task: SubagentTask = {
      id: taskId,
      parentSessionId: parent.parentSessionId,
      parentTurnId: parent.parentTurnId,
      role: specification.role,
      mode: specification.mode,
      task: specification.task,
      status: "pending",
      modelTier: parent.parentModelTier,
      modelRef: parent.parentModelRef,
      parentPermissionMode: parent.parentPermissionMode,
      effectivePermission: specification.mode === "patch_proposal" ? "proposal_only" : "read_only",
      budget,
      plan: {
        revision: 1,
        explanation: "子任务启动时创建的独立计划",
        steps: [
          { id: "inspect", title: "读取并核验相关来源", status: "in_progress" },
          { id: "analyze", title: "形成带证据的结论", status: "pending" },
          { id: "report", title: "输出结构化结果", status: "pending" },
        ],
        createdAt: now,
        updatedAt: now,
      },
      messages: [],
      toolTraces: [],
      patches: [],
      createdAt: now,
      updatedAt: now,
    };
    await parent.onUpdate(cloneValue(task));

    const base = new LocalToolExecutor(this.boundary, this.ids);
    const tools = new RestrictedSubagentTools(
      base,
      this.boundary,
      taskId,
      specification.mode === "patch_proposal",
      this.ids,
      this.leases,
    );
    const runner = new AgentRunner(
      {
        model: this.model,
        tools,
        approvals: {
          request: async () => {
            throw new HammerCodeError(
              "子 Agent 不具备审批或副作用执行能力",
              "SUBAGENT_APPROVAL_BLOCKED",
              true,
            );
          },
        },
        clock: this.clock,
        ids: this.ids,
        onSessionChange: async (session) => {
          task = this.taskFromSession(task, session, tools.patches);
          await parent.onUpdate(cloneValue(task));
        },
      },
      {
        modelName: this.options.modelName,
        maxRounds: budget.maxRounds,
        maxToolCalls: budget.maxToolCalls,
        maxRunTimeMs: budget.maxRunTimeMs,
        maxModelRetries: this.options.maxModelRetries ?? 2,
        retryBaseDelayMs: this.options.retryBaseDelayMs,
        retryMaxDelayMs: this.options.retryMaxDelayMs,
        maxOutputTokens: this.options.maxOutputTokens ?? 16_384,
        autoCompactRatio: 0.8,
        contextTokenBudget: budget.contextTokenBudget,
        systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      },
    );
    const abortChild = (): void => runner.cancel("父任务已停止");
    parent.signal.addEventListener("abort", abortChild, { once: true });
    try {
      const session = await runner.start(
        `子任务角色：${specification.role}\n执行模式：${specification.mode}\n任务：${specification.task}\n必须先建立 Plan，并以规定 JSON 结构返回带来源结论。`,
        parent.workspaceRoot,
        {
          modelTier: parent.parentModelTier,
          modelRef: parent.parentModelRef,
          permissionMode: "ask",
        },
      );
      task = this.taskFromSession(task, session, tools.patches);
      if (session.status === "completed") {
        task.result = this.parseResult(session);
        task.status = "completed";
        task.plan = {
          ...task.plan,
          steps: task.plan.steps.map((step) => ({ ...step, status: "completed" })),
          updatedAt: this.clock.now().toISOString(),
        };
      }
    } catch (error) {
      task.status = parent.signal.aborted ? "cancelled" : "failed";
      task.error = toErrorMessage(error);
    } finally {
      parent.signal.removeEventListener("abort", abortChild);
      this.leases.releaseOwner(taskId);
      task.patches = cloneValue(tools.patches);
      task.updatedAt = this.clock.now().toISOString();
      task.finishedAt = task.updatedAt;
      await parent.onUpdate(cloneValue(task));
    }
    return task;
  }

  private taskFromSession(
    previous: SubagentTask,
    session: AgentSession,
    patches: SubagentPatchProposal[],
  ): SubagentTask {
    const turn = session.turns.find((item) => item.id === session.activeTurnId);
    const status = session.status === "idle" || session.status === "requesting"
      ? "requesting"
      : session.status === "awaiting_approval" || session.status === "executing_tool"
        ? "executing_tool"
        : session.status;
    return {
      ...previous,
      status,
      metrics: turn?.metrics,
      plan: turn?.plan ?? previous.plan,
      messages: cloneValue(session.messages),
      toolTraces: cloneValue(session.toolTraces),
      patches: cloneValue(patches),
      error: session.error,
      updatedAt: session.updatedAt,
      finishedAt: session.turns.find((item) => item.id === session.activeTurnId)?.finishedAt,
    };
  }

  private parseResult(session: AgentSession): SubagentResult {
    const content = [...session.messages].reverse().find((message) => message.role === "assistant" && message.content.trim())?.content ?? "";
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      return resultSchema.parse(JSON.parse(cleaned));
    } catch {
      return {
        summary: cleaned || "子 Agent 未返回可用总结",
        findings: [],
        relatedFiles: [],
        verificationSuggestions: [],
        risks: ["模型未遵循结构化输出格式；主 Agent 不应把该文本当作已核验事实。"],
      };
    }
  }
}
