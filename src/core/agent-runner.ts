import type {
  AgentSession,
  AgentTurn,
  AssistantMessage,
  FileChange,
  TerminationReason,
  ToolMessage,
  ToolResult,
  ToolTrace,
} from "../shared/contracts";
import { buildModelContext } from "./context";
import { StreamAssembler } from "./model/stream-assembler";
import { closeUnresolvedToolCalls } from "./session-recovery";
import { transitionState } from "./state-machine";
import type { AgentDependencies, AgentRunOptions } from "./types";
import { HammerCodeError } from "./types";
import { cloneValue, isAbortError, toErrorMessage } from "./utils";

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

export class AgentRunner {
  private session: AgentSession | null = null;
  private runAbort: AbortController | null = null;
  private running = false;

  constructor(
    private readonly dependencies: AgentDependencies,
    private readonly options: AgentRunOptions,
  ) {}

  get snapshot(): AgentSession | null {
    return this.session ? cloneValue(this.session) : null;
  }

  async start(task: string, workspaceRoot: string): Promise<AgentSession> {
    this.assertCanRun(task);
    const now = this.dependencies.clock.now().toISOString();
    const turnId = this.dependencies.ids.next("turn");
    const userMessageId = this.dependencies.ids.next("message");
    const turn: AgentTurn = {
      id: turnId,
      userMessageId,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.session = {
      id: this.dependencies.ids.next("session"),
      workspaceRoot,
      status: "idle",
      task: task.trim(),
      turns: [turn],
      activeTurnId: turnId,
      messages: [
        {
          id: userMessageId,
          turnId,
          role: "user",
          content: task.trim(),
          createdAt: now,
        },
      ],
      toolTraces: [],
      fileChanges: [],
      transitions: [],
      streamingText: "",
      streamingReasoning: "",
      createdAt: now,
      updatedAt: now,
    };
    return this.runPreparedTurn("用户提交任务");
  }

  async resume(previous: AgentSession, input: string): Promise<AgentSession> {
    this.assertCanRun(input);
    if (!TERMINAL_STATUSES.has(previous.status)) {
      throw new HammerCodeError("只有已结束的聊天才能继续", "SESSION_NOT_TERMINAL", true);
    }
    if (previous.pendingUndo) {
      throw new HammerCodeError("文件撤销仍在处理中", "UNDO_BUSY", true);
    }

    this.session = cloneValue(previous);
    const now = this.dependencies.clock.now().toISOString();
    closeUnresolvedToolCalls(
      this.session,
      now,
      () => this.dependencies.ids.next("message"),
    );
    const turnId = this.dependencies.ids.next("turn");
    const userMessageId = this.dependencies.ids.next("message");
    this.session.turns.push({
      id: turnId,
      userMessageId,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    });
    this.session.activeTurnId = turnId;
    this.session.messages.push({
      id: userMessageId,
      turnId,
      role: "user",
      content: input.trim(),
      createdAt: now,
    });
    this.session.streamingText = "";
    this.session.streamingReasoning = "";
    this.session.pendingApproval = undefined;
    this.session.terminationReason = undefined;
    this.session.error = undefined;
    return this.runPreparedTurn("用户继续对话");
  }

  cancel(): void {
    this.runAbort?.abort(new DOMException("用户取消任务", "AbortError"));
  }

  private assertCanRun(input: string): void {
    if (this.running) throw new HammerCodeError("已有任务正在运行", "SESSION_BUSY", true);
    if (!input.trim()) throw new HammerCodeError("任务描述不能为空", "EMPTY_TASK", true);
  }

  private async runPreparedTurn(startReason: string): Promise<AgentSession> {
    this.running = true;
    const abort = new AbortController();
    this.runAbort = abort;
    try {
      await this.moveTo("requesting", startReason);
      await this.runLoop(abort.signal);
    } catch (error) {
      const now = this.dependencies.clock.now().toISOString();
      closeUnresolvedToolCalls(
        this.requireSession(),
        now,
        () => this.dependencies.ids.next("message"),
      );
      if (isAbortError(error) || abort.signal.aborted) {
        await this.terminate("cancelled", "任务已由用户取消");
      } else {
        const reason: TerminationReason =
          error instanceof HammerCodeError && error.code === "CONTEXT_OVERFLOW"
            ? "context_overflow"
            : error instanceof HammerCodeError &&
                ["INVALID_TOOL_CALL", "MODEL_INVALID_CHUNK", "MODEL_INVALID_JSON"].includes(error.code)
              ? "invalid_model_output"
              : "model_error";
        await this.terminate(reason, toErrorMessage(error));
      }
    } finally {
      this.running = false;
      this.runAbort = null;
    }
    return this.requireSession();
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    for (let round = 1; round <= this.options.maxRounds; round += 1) {
      if (signal.aborted) throw signal.reason;
      await this.prepareRequest(round);
      const context = buildModelContext(
        this.options.systemPrompt,
        this.requireSession().messages,
        this.options.contextTokenBudget,
      );
      const assembler = new StreamAssembler();

      for await (const chunk of this.dependencies.model.stream({
        messages: context.messages,
        tools: this.dependencies.tools.definitions,
        signal,
      })) {
        assembler.push(chunk);
        if (chunk.content) this.requireSession().streamingText += chunk.content;
        if (chunk.reasoningContent) this.requireSession().streamingReasoning += chunk.reasoningContent;
        if (chunk.content || chunk.reasoningContent) await this.publish();
      }

      const response = assembler.result();
      this.assertFreshToolCallIds(response.toolCalls.map((call) => call.id));
      const assistant: AssistantMessage = {
        id: this.dependencies.ids.next("message"),
        turnId: this.currentTurn().id,
        role: "assistant",
        content: response.content,
        reasoningContent: response.reasoningContent || undefined,
        toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
        createdAt: this.dependencies.clock.now().toISOString(),
      };
      this.requireSession().messages.push(assistant);
      this.requireSession().streamingText = "";
      this.requireSession().streamingReasoning = "";
      await this.publish();

      if (response.finishReason === "length") {
        throw new HammerCodeError("模型输出达到长度上限，任务未安全完成", "MODEL_LENGTH_LIMIT", true);
      }
      if (response.finishReason === "content_filter") {
        throw new HammerCodeError("模型输出被内容策略截断", "MODEL_CONTENT_FILTER", true);
      }
      if (response.finishReason === "insufficient_system_resource") {
        throw new HammerCodeError("模型服务资源不足，请稍后重试", "MODEL_RESOURCE_EXHAUSTED", true);
      }
      if (response.toolCalls.length > 0) {
        for (const call of response.toolCalls) await this.executeTool(call, signal);
        continue;
      }
      if (response.finishReason === "stop") {
        await this.terminate("completed", "模型正常完成任务");
        return;
      }
      throw new HammerCodeError("模型没有给出有效的终止原因", "INVALID_MODEL_FINISH");
    }

    await this.terminate(
      "round_limit",
      `已达到安全轮次上限（${this.options.maxRounds}），任务停止且不会继续调用模型。`,
    );
  }

  private assertFreshToolCallIds(callIds: string[]): void {
    if (callIds.length === 0) return;
    const existing = new Set<string>();
    for (const message of this.requireSession().messages) {
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) existing.add(call.id);
    }
    const current = new Set<string>();
    for (const id of callIds) {
      if (!id || existing.has(id) || current.has(id)) {
        throw new HammerCodeError("模型返回了重复或空的 tool call id", "INVALID_TOOL_CALL", true);
      }
      current.add(id);
    }
  }

  private async executeTool(
    call: { id: string; name: string; arguments: string },
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.requireSession();
    const turnId = this.currentTurn().id;
    const trace: ToolTrace = {
      turnId,
      call,
      status: "proposed",
      summary: `模型请求调用 ${call.name}`,
    };
    session.toolTraces.push(trace);
    await this.publish();

    let prepared;
    try {
      prepared = await this.dependencies.tools.prepare(call, this.dependencies.clock.now());
      trace.summary = prepared.summary;
      trace.target = prepared.target;
      if (prepared.approvalRequest) {
        prepared.approvalRequest.turnId = turnId;
        prepared.approvalRequest.operation = "agent_tool";
      }
      trace.approval = prepared.approvalRequest;
    } catch (error) {
      const result: ToolResult = {
        ok: false,
        summary: "工具调用在执行前被拒绝",
        output: toErrorMessage(error),
        errorCode: error instanceof HammerCodeError ? error.code : "TOOL_PREPARE_FAILED",
      };
      trace.status =
        error instanceof HammerCodeError &&
        ["HIGH_RISK_COMMAND_BLOCKED", "PATH_TRAVERSAL_BLOCKED", "ABSOLUTE_PATH_BLOCKED", "SYMLINK_ESCAPE_BLOCKED"].includes(error.code)
          ? "blocked"
          : "failed";
      trace.result = result;
      trace.finishedAt = this.dependencies.clock.now().toISOString();
      this.appendToolMessage(call, result);
      await this.publish();
      return;
    }

    if (prepared.requiresApproval) {
      if (!prepared.approvalRequest) {
        throw new HammerCodeError("工具缺少审批信息", "INVALID_APPROVAL_REQUEST");
      }
      trace.status = "awaiting_approval";
      session.pendingApproval = prepared.approvalRequest;
      await this.moveTo("awaiting_approval", `等待审批 ${call.name}`);
      const approved = await this.dependencies.approvals.request(prepared.approvalRequest, signal);
      session.pendingApproval = undefined;
      if (!approved) {
        const result: ToolResult = {
          ok: false,
          summary: "用户拒绝了工具调用",
          output: "该操作未经批准，没有产生副作用。",
          errorCode: "APPROVAL_REJECTED",
        };
        trace.status = "rejected";
        trace.result = result;
        trace.finishedAt = this.dependencies.clock.now().toISOString();
        this.appendToolMessage(call, result);
        await this.moveTo("requesting", `用户拒绝 ${call.name}`);
        return;
      }
      trace.status = "approved";
      await this.publish();
    }

    trace.status = "running";
    trace.startedAt = this.dependencies.clock.now().toISOString();
    await this.moveTo("executing_tool", `执行 ${call.name}`);
    const started = this.dependencies.clock.now().getTime();
    let result: ToolResult;
    try {
      result = await prepared.execute({
        signal,
        approvals: this.dependencies.approvals,
        now: () => this.dependencies.clock.now(),
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      result = {
        ok: false,
        summary: "工具执行失败",
        output: toErrorMessage(error),
        errorCode: error instanceof HammerCodeError ? error.code : "TOOL_EXECUTION_FAILED",
      };
    }
    const finished = this.dependencies.clock.now();
    trace.status = result.ok ? "succeeded" : result.errorCode === "COMMAND_CANCELLED" ? "cancelled" : "failed";
    trace.result = result;
    trace.finishedAt = finished.toISOString();
    trace.durationMs = Math.max(0, finished.getTime() - started);
    if (result.ok && prepared.fileMutation) {
      const change: FileChange = {
        id: this.dependencies.ids.next("change"),
        turnId,
        toolCallId: call.id,
        ...prepared.fileMutation,
        status: "applied",
        appliedAt: finished.toISOString(),
      };
      session.fileChanges.push(change);
      trace.fileChangeId = change.id;
    }
    this.appendToolMessage(call, result);
    await this.moveTo("requesting", `${call.name} ${result.ok ? "执行完成" : "执行失败"}`);
  }

  private appendToolMessage(call: { id: string; name: string }, result: ToolResult): void {
    const message: ToolMessage = {
      id: this.dependencies.ids.next("message"),
      turnId: this.currentTurn().id,
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: JSON.stringify(result),
      createdAt: this.dependencies.clock.now().toISOString(),
    };
    this.requireSession().messages.push(message);
  }

  private async prepareRequest(round: number): Promise<void> {
    const session = this.requireSession();
    session.streamingText = "";
    session.streamingReasoning = "";
    if (session.status !== "requesting") await this.moveTo("requesting", `开始第 ${round} 轮模型请求`);
    else await this.publish();
  }

  private async moveTo(next: AgentSession["status"], reason: string): Promise<void> {
    const session = this.requireSession();
    const turn = this.currentTurn();
    const transition = transitionState(session.status, next, reason, this.dependencies.clock, turn.id);
    session.status = next;
    turn.status = next;
    session.transitions.push(transition);
    await this.publish();
  }

  private async terminate(reason: TerminationReason, detail: string): Promise<void> {
    const session = this.requireSession();
    if (TERMINAL_STATUSES.has(session.status)) return;
    const turn = this.currentTurn();
    session.terminationReason = reason;
    turn.terminationReason = reason;
    if (reason !== "completed" && reason !== "cancelled") {
      session.error = detail;
      turn.error = detail;
    }
    const target = reason === "completed" ? "completed" : reason === "cancelled" ? "cancelled" : "failed";
    await this.moveTo(target, detail);
    const finishedAt = this.dependencies.clock.now().toISOString();
    turn.finishedAt = finishedAt;
    turn.updatedAt = finishedAt;
    await this.publish();
  }

  private async publish(): Promise<void> {
    const session = this.requireSession();
    const now = this.dependencies.clock.now().toISOString();
    session.updatedAt = now;
    this.currentTurn().updatedAt = now;
    await this.dependencies.onSessionChange?.(cloneValue(session));
  }

  private currentTurn(): AgentTurn {
    const session = this.requireSession();
    const turn = session.turns.find((item) => item.id === session.activeTurnId);
    if (!turn) throw new HammerCodeError("找不到当前对话轮次", "NO_ACTIVE_TURN");
    return turn;
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new HammerCodeError("会话尚未创建", "NO_SESSION");
    return this.session;
  }
}
