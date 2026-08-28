import type {
  AgentSession,
  AgentTurn,
  AssistantMessage,
  FileChange,
  ModelTier,
  PermissionMode,
  ModelRef,
  TerminationReason,
  ToolMessage,
  ToolResult,
  ToolTrace,
} from "../shared/contracts";
import { compactContextWithModel } from "./context-compactor";
import {
  buildContextFacts,
  buildModelContext,
  estimateTokens,
  historyAfterContextMemory,
  systemPromptWithContextMemory,
} from "./context";
import { StreamAssembler } from "./model/stream-assembler";
import { closeUnresolvedToolCalls } from "./session-recovery";
import { applyPlanUpdate, isComplexTask, parsePlanUpdate, requiresPlanBeforeTool } from "./plan";
import { transitionState } from "./state-machine";
import type { AgentDependencies, AgentRunOptions } from "./types";
import { HammerCodeError } from "./types";
import { cloneValue, isAbortError, toErrorMessage } from "./utils";

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

export interface TurnExecutionSettings {
  modelTier: ModelTier;
  modelRef?: ModelRef;
  permissionMode: PermissionMode;
}

const DEFAULT_TURN_SETTINGS: TurnExecutionSettings = {
  modelTier: "fast",
  permissionMode: "ask",
};

export class AgentRunner {
  private session: AgentSession | null = null;
  private runAbort: AbortController | null = null;
  private running = false;
  private cancellationDetail = "任务已由用户取消";
  private runDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAutoCompactionSource: AgentSession | null = null;

  constructor(
    private readonly dependencies: AgentDependencies,
    private readonly options: AgentRunOptions,
  ) {}

  get snapshot(): AgentSession | null {
    return this.session ? cloneValue(this.session) : null;
  }

  async start(
    task: string,
    workspaceRoot: string,
    settings: TurnExecutionSettings = DEFAULT_TURN_SETTINGS,
  ): Promise<AgentSession> {
    this.assertCanRun(task);
    this.pendingAutoCompactionSource = null;
    const now = this.dependencies.clock.now().toISOString();
    const turnId = this.dependencies.ids.next("turn");
    const userMessageId = this.dependencies.ids.next("message");
    const turn: AgentTurn = {
      id: turnId,
      userMessageId,
      status: "idle",
      modelTier: settings.modelTier,
      modelRef: settings.modelRef ?? `builtin:${settings.modelTier}`,
      permissionMode: settings.permissionMode,
      planRequired: isComplexTask(task),
      planCheckpoints: [],
      retryEvents: [],
      metrics: this.initialMetrics(false),
      createdAt: now,
      updatedAt: now,
    };
    this.session = {
      id: this.dependencies.ids.next("session"),
      workspaceRoot,
      status: "idle",
      task: task.trim(),
      modelTier: settings.modelTier,
      modelRef: settings.modelRef ?? `builtin:${settings.modelTier}`,
      permissionMode: settings.permissionMode,
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

  async resume(
    previous: AgentSession,
    input: string,
    settings: TurnExecutionSettings = DEFAULT_TURN_SETTINGS,
  ): Promise<AgentSession> {
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
    this.pendingAutoCompactionSource = this.shouldAutoCompact(this.session)
      ? cloneValue(this.session)
      : null;
    const turnId = this.dependencies.ids.next("turn");
    const userMessageId = this.dependencies.ids.next("message");
    this.session.turns.push({
      id: turnId,
      userMessageId,
      status: "idle",
      modelTier: settings.modelTier,
      modelRef: settings.modelRef ?? `builtin:${settings.modelTier}`,
      permissionMode: settings.permissionMode,
      planRequired: isComplexTask(input),
      planCheckpoints: [],
      retryEvents: [],
      metrics: this.initialMetrics(false),
      createdAt: now,
      updatedAt: now,
    });
    this.session.activeTurnId = turnId;
    this.session.modelTier = settings.modelTier;
    this.session.modelRef = settings.modelRef ?? `builtin:${settings.modelTier}`;
    this.session.permissionMode = settings.permissionMode;
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

  cancel(detail = "任务已由用户取消"): void {
    this.cancellationDetail = detail;
    this.runAbort?.abort(new DOMException(detail, "AbortError"));
  }

  private assertCanRun(input: string): void {
    if (this.running) throw new HammerCodeError("已有任务正在运行", "SESSION_BUSY", true);
    if (!input.trim()) throw new HammerCodeError("任务描述不能为空", "EMPTY_TASK", true);
  }

  private async runPreparedTurn(startReason: string): Promise<AgentSession> {
    this.running = true;
    this.cancellationDetail = "任务已由用户取消";
    const abort = new AbortController();
    this.runAbort = abort;
    const maxRunTimeMs = this.maxRunTimeMs();
    this.runDeadlineTimer = setTimeout(
      () => abort.abort(new HammerCodeError("任务达到运行时间上限", "RUN_TIME_LIMIT", true)),
      maxRunTimeMs,
    );
    try {
      await this.moveTo("requesting", startReason);
      await this.compactPendingContext(abort.signal);
      await this.runLoop(abort.signal);
    } catch (error) {
      const now = this.dependencies.clock.now().toISOString();
      closeUnresolvedToolCalls(
        this.requireSession(),
        now,
        () => this.dependencies.ids.next("message"),
      );
      const abortReason = abort.signal.reason;
      if (abortReason instanceof HammerCodeError && abortReason.code === "RUN_TIME_LIMIT") {
        await this.terminate(
          "time_limit",
          `已达到运行时间上限（${Math.round(maxRunTimeMs / 1_000)} 秒），任务已停止。`,
        );
      } else if (isAbortError(error) || abort.signal.aborted) {
        await this.terminate("cancelled", this.cancellationDetail);
      } else {
        const reason = this.terminationReasonFor(error);
        await this.terminate(reason, toErrorMessage(error));
      }
    } finally {
      if (this.runDeadlineTimer) clearTimeout(this.runDeadlineTimer);
      this.runDeadlineTimer = null;
      this.running = false;
      this.runAbort = null;
      this.pendingAutoCompactionSource = null;
    }
    return this.requireSession();
  }

  private async compactPendingContext(signal: AbortSignal): Promise<void> {
    const source = this.pendingAutoCompactionSource;
    if (!source) return;
    const session = this.requireSession();
    const turn = this.currentTurn();
    const metrics = turn.metrics!;
    session.streamingReasoning = "正在压缩上下文…";
    await this.publish();
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        metrics.modelRequests += 1;
        await this.publish();
        try {
          const result = await compactContextWithModel(
            this.dependencies.model,
            source,
            this.dependencies.clock.now().toISOString(),
            "automatic",
            signal,
          );
          session.contextMemory = result.memory;
          metrics.contextCompactions += 1;
          metrics.promptTokens += result.promptTokens;
          metrics.completionTokens += result.completionTokens;
          metrics.tokenUsageEstimated ||= result.usageEstimated;
          metrics.currentContextTokens = estimateTokens(
            `${systemPromptWithContextMemory(this.options.systemPrompt, result.memory)}\n${JSON.stringify(historyAfterContextMemory(session))}`,
          );
          break;
        } catch (error) {
          const retryReason = this.retryReasonFor(error);
          if (!retryReason || metrics.retryCount >= metrics.maxRetries || signal.aborted) throw error;
          metrics.retryCount += 1;
          const requestedDelay = error instanceof HammerCodeError ? error.retryAfterMs : undefined;
          const exponential = this.retryBaseDelayMs() * 2 ** (metrics.retryCount - 1);
          const delayMs = Math.min(this.retryMaxDelayMs(), requestedDelay ?? exponential);
          turn.retryEvents = [
            ...(turn.retryEvents ?? []),
            {
              attempt: metrics.retryCount,
              reason: retryReason,
              delayMs,
              createdAt: this.dependencies.clock.now().toISOString(),
            },
          ];
          metrics.promptTokens += estimateTokens(JSON.stringify(source.messages));
          metrics.tokenUsageEstimated = true;
          await this.publish();
          await this.wait(delayMs, signal);
        }
      }
    } finally {
      session.streamingReasoning = "";
      this.pendingAutoCompactionSource = null;
    }
    await this.publish();
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    for (let round = 1; round <= this.options.maxRounds; round += 1) {
      if (signal.aborted) throw signal.reason;
      await this.prepareRequest(round);
      const session = this.requireSession();
      const context = buildModelContext(
        systemPromptWithContextMemory(this.options.systemPrompt, session.contextMemory),
        historyAfterContextMemory(session),
        this.options.contextTokenBudget,
        buildContextFacts(session),
      );
      const metrics = this.currentTurn().metrics!;
      metrics.roundsUsed = round;
      metrics.currentContextTokens = context.estimatedTokens;
      if (context.compacted) metrics.contextCompactions += 1;
      const response = await this.requestModelWithRetry(context.messages, context.estimatedTokens, signal);
      this.recordUsage(response, context.estimatedTokens);
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
        throw new HammerCodeError("模型服务资源不足，已用尽本轮退避重试", "MODEL_RESOURCE_EXHAUSTED", true);
      }
      if (response.toolCalls.length > 0) {
        for (const call of response.toolCalls) {
          if (metrics.toolCalls >= metrics.maxToolCalls) {
            throw new HammerCodeError("已达到工具调用次数上限", "TOOL_LIMIT", true);
          }
          metrics.toolCalls += 1;
          await this.executeTool(call, signal);
        }
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

  private async requestModelWithRetry(
    messages: Parameters<AgentDependencies["model"]["stream"]>[0]["messages"],
    estimatedPromptTokens: number,
    signal: AbortSignal,
  ): Promise<ReturnType<StreamAssembler["result"]>> {
    const turn = this.currentTurn();
    const metrics = turn.metrics!;
    while (true) {
      if (signal.aborted) throw signal.reason;
      this.requireSession().streamingText = "";
      this.requireSession().streamingReasoning = "";
      const assembler = new StreamAssembler();
      metrics.modelRequests += 1;
      try {
        for await (const chunk of this.dependencies.model.stream({
          messages,
          tools: this.dependencies.tools.definitions,
          signal,
        })) {
          assembler.push(chunk);
          if (chunk.content) this.requireSession().streamingText += chunk.content;
          if (chunk.reasoningContent) this.requireSession().streamingReasoning += chunk.reasoningContent;
          if (chunk.content || chunk.reasoningContent) await this.publish();
        }
        const response = assembler.result();
        if (response.finishReason === "insufficient_system_resource") {
          throw new HammerCodeError(
            "模型服务临时资源不足",
            "MODEL_RESOURCE_EXHAUSTED",
            true,
          );
        }
        return response;
      } catch (error) {
        const retryReason = this.retryReasonFor(error);
        if (!retryReason || metrics.retryCount >= metrics.maxRetries || signal.aborted) throw error;
        metrics.retryCount += 1;
        const requestedDelay = error instanceof HammerCodeError ? error.retryAfterMs : undefined;
        const exponential = this.retryBaseDelayMs() * 2 ** (metrics.retryCount - 1);
        const delayMs = Math.min(this.retryMaxDelayMs(), requestedDelay ?? exponential);
        turn.retryEvents = [
          ...(turn.retryEvents ?? []),
          {
            attempt: metrics.retryCount,
            reason: retryReason,
            delayMs,
            createdAt: this.dependencies.clock.now().toISOString(),
          },
        ];
        this.requireSession().streamingText = "";
        this.requireSession().streamingReasoning = "";
        metrics.promptTokens += estimatedPromptTokens;
        metrics.tokenUsageEstimated = true;
        await this.publish();
        await this.wait(delayMs, signal);
      }
    }
  }

  private recordUsage(
    response: ReturnType<StreamAssembler["result"]>,
    estimatedPromptTokens: number,
  ): void {
    const metrics = this.currentTurn().metrics!;
    if (response.usage?.promptTokens !== undefined) metrics.promptTokens += response.usage.promptTokens;
    else {
      metrics.promptTokens += estimatedPromptTokens;
      metrics.tokenUsageEstimated = true;
    }
    if (response.usage?.completionTokens !== undefined) {
      metrics.completionTokens += response.usage.completionTokens;
    } else {
      metrics.completionTokens += estimateTokens(
        `${response.reasoningContent}\n${response.content}\n${response.toolCalls.map((call) => call.arguments).join("\n")}`,
      );
      metrics.tokenUsageEstimated = true;
    }
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

    if (this.currentTurn().planRequired && !this.currentTurn().plan && requiresPlanBeforeTool(call.name)) {
      const result: ToolResult = {
        ok: false,
        summary: "复杂任务需要先建立显式计划",
        output: "请先调用 update_plan，记录可检查的步骤后再执行副作用工具。",
        errorCode: "PLAN_REQUIRED",
      };
      trace.status = "failed";
      trace.authorization = "not_required";
      trace.approvalPolicy = "none";
      trace.result = result;
      trace.finishedAt = this.dependencies.clock.now().toISOString();
      this.appendToolMessage(call, result);
      await this.publish();
      return;
    }

    let prepared;
    try {
      prepared = await this.dependencies.tools.prepare(call, this.dependencies.clock.now());
      trace.summary = prepared.summary;
      trace.target = prepared.target;
      trace.approvalPolicy = prepared.requiresApproval
        ? prepared.approvalPolicy ?? "permission_mode"
        : "none";
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
      if (trace.status === "blocked") trace.authorization = "safety_blocked";
      trace.result = result;
      trace.finishedAt = this.dependencies.clock.now().toISOString();
      this.appendToolMessage(call, result);
      await this.publish();
      return;
    }

    if (!prepared.requiresApproval) {
      trace.authorization = "not_required";
    } else if (
      this.currentTurn().permissionMode === "full_access" &&
      prepared.approvalPolicy !== "always"
    ) {
      trace.status = "approved";
      trace.authorization = "full_access";
      await this.publish();
    } else {
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
        trace.authorization = "user_rejected";
        trace.result = result;
        trace.finishedAt = this.dependencies.clock.now().toISOString();
        this.appendToolMessage(call, result);
        await this.moveTo("requesting", `用户拒绝 ${call.name}`);
        return;
      }
      trace.status = "approved";
      trace.authorization = "user_approved";
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
    if (result.ok && call.name === "update_plan") {
      try {
        applyPlanUpdate(
          this.currentTurn(),
          parsePlanUpdate(call.arguments),
          this.dependencies.ids,
          finished.toISOString(),
        );
      } catch (error) {
        result = {
          ok: false,
          summary: "计划检查点未更新",
          output: toErrorMessage(error),
          errorCode: error instanceof HammerCodeError ? error.code : "INVALID_PLAN",
        };
        trace.status = "failed";
        trace.result = result;
      }
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
    if (reason !== "completed") {
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

  private initialMetrics(autoCompacted: boolean) {
    return {
      roundsUsed: 0,
      maxRounds: this.options.maxRounds,
      modelRequests: 0,
      retryCount: 0,
      maxRetries: this.options.maxModelRetries ?? 2,
      toolCalls: 0,
      maxToolCalls: this.options.maxToolCalls ?? 100,
      promptTokens: 0,
      completionTokens: 0,
      tokenUsageEstimated: false,
      maxOutputTokensPerRequest: this.options.maxOutputTokens ?? 32_768,
      contextTokenBudget: this.options.contextTokenBudget,
      currentContextTokens: 0,
      contextCompactions: autoCompacted ? 1 : 0,
      maxRunTimeMs: this.maxRunTimeMs(),
    };
  }

  private shouldAutoCompact(session: AgentSession): boolean {
    const ratio = this.options.autoCompactRatio ?? 0.78;
    const estimated = estimateTokens(
      `${systemPromptWithContextMemory(this.options.systemPrompt, session.contextMemory)}\n${JSON.stringify(historyAfterContextMemory(session))}`,
    );
    return session.messages.length > 0 && estimated >= this.options.contextTokenBudget * ratio;
  }

  private maxRunTimeMs(): number {
    return this.options.maxRunTimeMs ?? 1_800_000;
  }

  private retryBaseDelayMs(): number {
    return this.options.retryBaseDelayMs ?? 1_000;
  }

  private retryMaxDelayMs(): number {
    return this.options.retryMaxDelayMs ?? 8_000;
  }

  private retryReasonFor(error: unknown): "rate_limited" | "server_error" | "resource_exhausted" | null {
    if (!(error instanceof HammerCodeError)) return null;
    if (error.code === "MODEL_RATE_LIMITED") return "rate_limited";
    if (error.code === "MODEL_SERVER_ERROR") return "server_error";
    if (error.code === "MODEL_RESOURCE_EXHAUSTED") return "resource_exhausted";
    return null;
  }

  private terminationReasonFor(error: unknown): TerminationReason {
    if (!(error instanceof HammerCodeError)) return "model_error";
    if (error.code === "CONTEXT_OVERFLOW") return "context_overflow";
    if (error.code === "MODEL_REQUEST_TIMEOUT") return "request_timeout";
    if (error.code === "MODEL_LENGTH_LIMIT") return "output_limit";
    if (error.code === "MODEL_RATE_LIMITED") return "rate_limited";
    if (error.code === "MODEL_SERVER_ERROR") return "server_error";
    if (error.code === "MODEL_RESOURCE_EXHAUSTED") return "resource_exhausted";
    if (error.code === "TOOL_LIMIT") return "tool_limit";
    if (error.code === "RUN_TIME_LIMIT") return "time_limit";
    if (["INVALID_TOOL_CALL", "MODEL_INVALID_CHUNK", "MODEL_INVALID_JSON"].includes(error.code)) {
      return "invalid_model_output";
    }
    return "model_error";
  }

  private wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (this.dependencies.wait) return this.dependencies.wait(milliseconds, signal);
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}
