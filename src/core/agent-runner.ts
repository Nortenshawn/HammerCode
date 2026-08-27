import type {
  AgentSession,
  AssistantMessage,
  TerminationReason,
  ToolMessage,
  ToolResult,
  ToolTrace,
} from "../shared/contracts";
import { buildModelContext } from "./context";
import { StreamAssembler } from "./model/stream-assembler";
import { transitionState } from "./state-machine";
import type { AgentDependencies, AgentRunOptions } from "./types";
import { HammerCodeError } from "./types";
import { cloneValue, isAbortError, toErrorMessage } from "./utils";

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
    if (this.running) {
      throw new HammerCodeError("已有任务正在运行", "SESSION_BUSY", true);
    }
    if (!task.trim()) {
      throw new HammerCodeError("任务描述不能为空", "EMPTY_TASK", true);
    }

    this.running = true;
    this.runAbort = new AbortController();
    const now = this.dependencies.clock.now().toISOString();
    this.session = {
      id: this.dependencies.ids.next("session"),
      workspaceRoot,
      status: "idle",
      task: task.trim(),
      messages: [
        {
          id: this.dependencies.ids.next("message"),
          role: "user",
          content: task.trim(),
          createdAt: now,
        },
      ],
      toolTraces: [],
      transitions: [],
      streamingText: "",
      streamingReasoning: "",
      createdAt: now,
      updatedAt: now,
    };
    await this.moveTo("requesting", "用户提交任务");

    try {
      await this.runLoop(this.runAbort.signal);
    } catch (error) {
      if (isAbortError(error) || this.runAbort.signal.aborted) {
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

  cancel(): void {
    this.runAbort?.abort(new DOMException("用户取消任务", "AbortError"));
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
        if (chunk.reasoningContent) {
          this.requireSession().streamingReasoning += chunk.reasoningContent;
        }
        if (chunk.content || chunk.reasoningContent) await this.publish();
      }

      const response = assembler.result();
      const assistant: AssistantMessage = {
        id: this.dependencies.ids.next("message"),
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

  private async executeTool(
    call: { id: string; name: string; arguments: string },
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.requireSession();
    let trace: ToolTrace = {
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
        [
          "HIGH_RISK_COMMAND_BLOCKED",
          "PATH_TRAVERSAL_BLOCKED",
          "ABSOLUTE_PATH_BLOCKED",
          "SYMLINK_ESCAPE_BLOCKED",
        ].includes(error.code)
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
      const approved = await this.dependencies.approvals.request(
        prepared.approvalRequest,
        signal,
      );
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
    trace = session.toolTraces.find((item) => item.call.id === call.id) ?? trace;
    trace.status = result.ok ? "succeeded" : result.errorCode === "COMMAND_CANCELLED" ? "cancelled" : "failed";
    trace.result = result;
    trace.finishedAt = finished.toISOString();
    trace.durationMs = Math.max(0, finished.getTime() - started);
    this.appendToolMessage(call, result);
    await this.moveTo("requesting", `${call.name} ${result.ok ? "执行完成" : "执行失败"}`);
  }

  private appendToolMessage(
    call: { id: string; name: string },
    result: ToolResult,
  ): void {
    const message: ToolMessage = {
      id: this.dependencies.ids.next("message"),
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
    if (session.status !== "requesting") {
      await this.moveTo("requesting", `开始第 ${round} 轮模型请求`);
    } else {
      await this.publish();
    }
  }

  private async moveTo(
    next: AgentSession["status"],
    reason: string,
  ): Promise<void> {
    const session = this.requireSession();
    const transition = transitionState(
      session.status,
      next,
      reason,
      this.dependencies.clock,
    );
    session.status = next;
    session.transitions.push(transition);
    await this.publish();
  }

  private async terminate(reason: TerminationReason, detail: string): Promise<void> {
    const session = this.requireSession();
    if (["completed", "cancelled", "failed"].includes(session.status)) return;
    session.terminationReason = reason;
    if (reason !== "completed" && reason !== "cancelled") session.error = detail;
    const target = reason === "completed" ? "completed" : reason === "cancelled" ? "cancelled" : "failed";
    await this.moveTo(target, detail);
  }

  private async publish(): Promise<void> {
    const session = this.requireSession();
    session.updatedAt = this.dependencies.clock.now().toISOString();
    await this.dependencies.onSessionChange?.(cloneValue(session));
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new HammerCodeError("会话尚未创建", "NO_SESSION");
    return this.session;
  }
}
