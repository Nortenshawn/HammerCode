import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../src/core/agent-runner";
import { WorkspaceBoundary } from "../src/core/security/path-boundary";
import { LocalToolExecutor } from "../src/core/tools/tool-executor";
import type {
  ApprovalGateway,
  Clock,
  IdGenerator,
  ModelClient,
  ModelRequest,
  ModelStreamChunk,
  ProjectMemoryPort,
  SubagentCoordinatorPort,
  ToolExecutorPort,
} from "../src/core/types";
import { HammerCodeError } from "../src/core/types";

class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly scripts: Array<ModelStreamChunk[] | Error>) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) throw new Error("unexpected model request");
    if (script instanceof Error) throw script;
    for (const chunk of script) yield chunk;
  }
}

function fixtures() {
  let id = 0;
  let tick = 0;
  const ids: IdGenerator = { next: (prefix) => `${prefix}_${id++}` };
  const clock: Clock = {
    now: () => new Date(Date.parse("2026-08-27T00:00:00.000Z") + tick++),
  };
  return { ids, clock };
}

const approve: ApprovalGateway = { request: async () => true };
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("agent runner", () => {
  it("completes an end-to-end read tool loop with a mocked model", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-e2e-"));
    workspaces.push(workspace);
    await writeFile(path.join(workspace, "README.md"), "hello agent\n");
    const boundary = await WorkspaceBoundary.create(workspace);
    const { ids, clock } = fixtures();
    const tools = new LocalToolExecutor(boundary, ids);
    const model = new ScriptedModel([
      [
        { reasoningContent: "先读取" },
        {
          toolCallDeltas: [
            { index: 0, id: "call_read", name: "read_file", arguments: '{"path":"README.md"}' },
          ],
          finishReason: "tool_calls",
        },
      ],
      [{ content: "读取完成，内容正常。", finishReason: "stop" }],
    ]);
    const snapshots: string[] = [];
    const runner = new AgentRunner(
      {
        model,
        tools,
        approvals: approve,
        ids,
        clock,
        onSessionChange: (session) => {
          snapshots.push(session.status);
        },
      },
      { maxRounds: 4, contextTokenBudget: 10_000, systemPrompt: "system" },
    );

    const result = await runner.start("检查 README", workspace);
    expect(result.status).toBe("completed");
    expect(result.terminationReason).toBe("completed");
    expect(result.toolTraces[0]).toMatchObject({ status: "succeeded", authorization: "not_required" });
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("hello agent"))).toBe(true);
    expect(model.requests).toHaveLength(2);
    expect(snapshots).toContain("executing_tool");
  });

  it("treats rejected approval as recoverable and records no write", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-reject-"));
    workspaces.push(workspace);
    const boundary = await WorkspaceBoundary.create(workspace);
    const { ids, clock } = fixtures();
    const model = new ScriptedModel([
      [
        {
          toolCallDeltas: [
            { index: 0, id: "call_write", name: "write_file", arguments: '{"path":"new.txt","content":"nope"}' },
          ],
          finishReason: "tool_calls",
        },
      ],
      [{ content: "用户拒绝后已停止写入。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      {
        model,
        tools: new LocalToolExecutor(boundary, ids),
        approvals: { request: async () => false },
        ids,
        clock,
      },
      { maxRounds: 3, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("尝试写文件", workspace);
    expect(result.status).toBe("completed");
    expect(result.toolTraces[0].status).toBe("rejected");
    expect(result.toolTraces[0].authorization).toBe("user_rejected");
    expect(result.messages.some((message) => message.role === "tool" && message.content.includes("APPROVAL_REJECTED"))).toBe(true);
  });

  it("stops at the configured round limit", async () => {
    const { ids, clock } = fixtures();
    const unknownTools: ToolExecutorPort = {
      definitions: [],
      prepare: async () => {
        throw new Error("unknown");
      },
    };
    const toolRound = (id: string): ModelStreamChunk[] => [
      {
        toolCallDeltas: [{ index: 0, id, name: "unknown", arguments: "{}" }],
        finishReason: "tool_calls",
      },
    ];
    const runner = new AgentRunner(
      {
        model: new ScriptedModel([toolRound("call_1"), toolRound("call_2")]),
        tools: unknownTools,
        approvals: approve,
        ids,
        clock,
      },
      { maxRounds: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("loop", "/tmp");
    expect(result.status).toBe("failed");
    expect(result.terminationReason).toBe("round_limit");
  });

  it("cancels an in-flight model request", async () => {
    const { ids, clock } = fixtures();
    const waitingModel: ModelClient = {
      async *stream(request) {
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancel", "AbortError")),
            { once: true },
          );
        });
        yield { finishReason: "stop" };
      },
    };
    const runner = new AgentRunner(
      {
        model: waitingModel,
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
      },
      { maxRounds: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const run = runner.start("cancel me", "/tmp");
    await Promise.resolve();
    runner.cancel("应用关闭，任务已安全取消");
    const result = await run;
    expect(result.status).toBe("cancelled");
    expect(result.terminationReason).toBe("cancelled");
    expect(result.error).toBe("应用关闭，任务已安全取消");
  });

  it("continues the same chat after completion without replaying historical work", async () => {
    const { ids, clock } = fixtures();
    const model = new ScriptedModel([
      [{ content: "第一轮完成。", finishReason: "stop" }],
      [{ content: "已根据补充要求继续。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      {
        model,
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
      },
      { maxRounds: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );

    const first = await runner.start("先分析问题", "/tmp");
    const second = await runner.resume(first, "补充：保持接口不变");
    expect(second.id).toBe(first.id);
    expect(second.turns).toHaveLength(2);
    expect(second.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: "第一轮完成。" }),
        expect.objectContaining({ role: "user", content: "补充：保持接口不变" }),
      ]),
    );
  });

  it("can recover from a failed turn by starting a fresh turn in the same chat", async () => {
    const { ids, clock } = fixtures();
    let requestCount = 0;
    const model: ModelClient = {
      async *stream(): AsyncIterable<ModelStreamChunk> {
        requestCount += 1;
        if (requestCount === 1) throw new Error("temporary model failure");
        yield { content: "重试后已完成。", finishReason: "stop" };
      },
    };
    const runner = new AgentRunner(
      {
        model,
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
      },
      { maxRounds: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );

    const failed = await runner.start("执行任务", "/tmp");
    expect(failed).toMatchObject({ status: "failed", terminationReason: "model_error" });
    const recovered = await runner.resume(failed, "刚才失败了，请重试");
    expect(recovered).toMatchObject({ id: failed.id, status: "completed" });
    expect(recovered.turns).toHaveLength(2);
    expect(recovered.turns[0]).toMatchObject({ status: "failed", terminationReason: "model_error" });
    expect(recovered.turns[1]).toMatchObject({ status: "completed", terminationReason: "completed" });
  });

  it("closes an interrupted tool call before continuing and never executes it again", async () => {
    const { ids, clock } = fixtures();
    let executions = 0;
    const tools: ToolExecutorPort = {
      definitions: [],
      prepare: async (call, now) => ({
        call,
        summary: "等待写入审批",
        requiresApproval: true,
        approvalRequest: {
          id: "approval_wait",
          toolCallId: call.id,
          toolName: call.name,
          title: "写入",
          description: "写入文件",
          details: "diff",
          risk: "write",
          createdAt: now.toISOString(),
        },
        execute: async () => {
          executions += 1;
          return { ok: true, summary: "done", output: "done" };
        },
      }),
    };
    const approvals: ApprovalGateway = {
      request: (_request, signal) => new Promise<boolean>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("cancel", "AbortError")), { once: true });
      }),
    };
    const model = new ScriptedModel([
      [{ toolCallDeltas: [{ index: 0, id: "call_wait", name: "write_file", arguments: "{}" }], finishReason: "tool_calls" }],
      [{ content: "已按新要求继续，未重放写入。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      { model, tools, approvals, ids, clock },
      { maxRounds: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );

    const running = runner.start("准备写入", "/tmp");
    await new Promise((resolve) => setTimeout(resolve, 0));
    runner.cancel();
    const cancelled = await running;
    expect(cancelled.status).toBe("cancelled");
    expect(executions).toBe(0);
    expect(cancelled.messages.filter((message) => message.role === "tool" && message.toolCallId === "call_wait")).toHaveLength(1);

    const continued = await runner.resume(cancelled, "不要写了，只总结");
    expect(continued.status).toBe("completed");
    expect(executions).toBe(0);
    expect(continued.messages.filter((message) => message.role === "tool" && message.toolCallId === "call_wait")).toHaveLength(1);
    expect(JSON.stringify(model.requests[1].messages)).toContain("TOOL_CALL_INTERRUPTED");
  });

  it("records an approved file mutation for review", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-change-"));
    workspaces.push(workspace);
    await writeFile(path.join(workspace, "a.txt"), "before\n");
    const boundary = await WorkspaceBoundary.create(workspace);
    const { ids, clock } = fixtures();
    const model = new ScriptedModel([
      [{ toolCallDeltas: [{ index: 0, id: "call_change", name: "write_file", arguments: '{"path":"a.txt","content":"after\\n"}' }], finishReason: "tool_calls" }],
      [{ content: "修改完成。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      { model, tools: new LocalToolExecutor(boundary, ids), approvals: approve, ids, clock },
      { maxRounds: 3, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("修改 a.txt", workspace);
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges[0]).toMatchObject({
      path: "a.txt",
      kind: "modify",
      beforeContent: "before\n",
      afterContent: "after\n",
      status: "applied",
    });
    expect(result.toolTraces[0].fileChangeId).toBe(result.fileChanges[0].id);
    expect(result.toolTraces[0].authorization).toBe("user_approved");
  });

  it("auto-approves ordinary workspace writes in full access mode", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-full-access-"));
    workspaces.push(workspace);
    const boundary = await WorkspaceBoundary.create(workspace);
    const { ids, clock } = fixtures();
    let approvalRequests = 0;
    const model = new ScriptedModel([
      [{ toolCallDeltas: [{ index: 0, id: "call_auto", name: "write_file", arguments: JSON.stringify({ path: "auto.txt", content: "approved by mode\n" }) }], finishReason: "tool_calls" }],
      [{ content: "自动写入完成。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      {
        model,
        tools: new LocalToolExecutor(boundary, ids),
        approvals: { request: async () => { approvalRequests += 1; return false; } },
        ids,
        clock,
      },
      { maxRounds: 3, contextTokenBudget: 10_000, systemPrompt: "system" },
    );

    const result = await runner.start(
      "创建 auto.txt",
      workspace,
      { modelTier: "fast", permissionMode: "full_access" },
    );
    expect(approvalRequests).toBe(0);
    expect(result.toolTraces[0]).toMatchObject({
      status: "succeeded",
      authorization: "full_access",
    });
    const toolMessage = result.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call_auto",
    );
    expect(JSON.parse(toolMessage?.content ?? "{}")).toMatchObject({
      metadata: { authorization: "full_access", approvalPolicy: "permission_mode" },
    });
    expect(await readFile(path.join(workspace, "auto.txt"), "utf8")).toBe("approved by mode\n");
  });

  it("keeps hard path blocking active in full access mode", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-full-block-"));
    workspaces.push(workspace);
    const boundary = await WorkspaceBoundary.create(workspace);
    const { ids, clock } = fixtures();
    const model = new ScriptedModel([
      [{ toolCallDeltas: [{ index: 0, id: "call_escape", name: "read_file", arguments: '{"path":"../outside.txt"}' }], finishReason: "tool_calls" }],
      [{ content: "越界访问已被阻断。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      {
        model,
        tools: new LocalToolExecutor(boundary, ids),
        approvals: { request: async () => { throw new Error("blocked calls must not request approval"); } },
        ids,
        clock,
      },
      { maxRounds: 3, contextTokenBudget: 10_000, systemPrompt: "system" },
    );

    const result = await runner.start(
      "尝试越界",
      workspace,
      { modelTier: "strong", permissionMode: "full_access" },
    );
    expect(result.toolTraces[0]).toMatchObject({
      status: "blocked",
      authorization: "safety_blocked",
      result: { errorCode: "PATH_TRAVERSAL_BLOCKED" },
    });
  });

  it("freezes model and permission settings on each turn", async () => {
    const { ids, clock } = fixtures();
    const runner = new AgentRunner(
      {
        model: new ScriptedModel([
          [{ content: "fast", finishReason: "stop" }],
          [{ content: "strong", finishReason: "stop" }],
        ]),
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
      },
      { maxRounds: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const first = await runner.start("第一轮", "/tmp", { modelTier: "fast", permissionMode: "ask" });
    const second = await runner.resume(first, "第二轮", { modelTier: "strong", permissionMode: "full_access" });
    expect(second.turns).toEqual([
      expect.objectContaining({ modelTier: "fast", permissionMode: "ask" }),
      expect.objectContaining({ modelTier: "strong", permissionMode: "full_access" }),
    ]);
    expect(second).toMatchObject({ modelTier: "strong", permissionMode: "full_access" });
  });

  it("persists an explicit plan and checkpoint before a complex task mutates files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-plan-"));
    workspaces.push(workspace);
    const boundary = await WorkspaceBoundary.create(workspace);
    const { ids, clock } = fixtures();
    const planArguments = JSON.stringify({
      explanation: "先实现，再验证",
      steps: [
        { id: "implement", title: "实现文件", status: "in_progress" },
        { id: "verify", title: "验证结果", status: "pending" },
      ],
    });
    const model = new ScriptedModel([
      [{ toolCallDeltas: [{ index: 0, id: "call_plan", name: "update_plan", arguments: planArguments }], finishReason: "tool_calls" }],
      [{ toolCallDeltas: [{ index: 0, id: "call_write_plan", name: "write_file", arguments: '{"path":"planned.txt","content":"done\\n"}' }], finishReason: "tool_calls" }],
      [{ content: "已按计划完成。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      { model, tools: new LocalToolExecutor(boundary, ids), approvals: approve, ids, clock },
      { maxRounds: 4, maxToolCalls: 10, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("请完整实现一个文件，然后运行测试并确认结果。", workspace);
    expect(result.status).toBe("completed");
    expect(result.turns[0].plan).toMatchObject({ revision: 1, explanation: "先实现，再验证" });
    expect(result.turns[0].planCheckpoints).toHaveLength(1);
    expect(result.turns[0].metrics).toMatchObject({ roundsUsed: 3, toolCalls: 2 });
    expect(await readFile(path.join(workspace, "planned.txt"), "utf8")).toBe("done\n");
  });

  it("returns PLAN_REQUIRED instead of executing an unplanned complex side effect", async () => {
    const { ids, clock } = fixtures();
    let executions = 0;
    const tools: ToolExecutorPort = {
      definitions: [],
      prepare: async (call) => ({
        call,
        summary: "write",
        requiresApproval: false,
        execute: async () => {
          executions += 1;
          return { ok: true, summary: "written", output: "written" };
        },
      }),
    };
    const runner = new AgentRunner(
      {
        model: new ScriptedModel([
          [{ toolCallDeltas: [{ index: 0, id: "call_unplanned", name: "write_file", arguments: "{}" }], finishReason: "tool_calls" }],
          [{ content: "收到计划要求，先停止。", finishReason: "stop" }],
        ]),
        tools,
        approvals: approve,
        ids,
        clock,
      },
      { maxRounds: 3, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("完整实现多个文件、运行测试并汇总所有结果。", "/tmp");
    expect(executions).toBe(0);
    expect(result.toolTraces[0]).toMatchObject({
      status: "failed",
      result: { errorCode: "PLAN_REQUIRED" },
    });
  });

  it("retries 429 with bounded backoff and records retry metrics", async () => {
    const { ids, clock } = fixtures();
    let requests = 0;
    const model: ModelClient = {
      async *stream() {
        requests += 1;
        if (requests === 1) {
          throw new HammerCodeError("rate limited", "MODEL_RATE_LIMITED", true, 250);
        }
        yield { content: "重试成功。", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 3 } };
      },
    };
    const waits: number[] = [];
    const runner = new AgentRunner(
      {
        model,
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
        wait: async (milliseconds) => { waits.push(milliseconds); },
      },
      { maxRounds: 2, maxModelRetries: 2, retryBaseDelayMs: 100, retryMaxDelayMs: 1_000, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("retry", "/tmp");
    expect(result.status).toBe("completed");
    expect(waits).toEqual([250]);
    expect(result.turns[0]).toMatchObject({
      retryEvents: [{ reason: "rate_limited", delayMs: 250 }],
      metrics: { modelRequests: 2, retryCount: 1, promptTokens: expect.any(Number), completionTokens: 3 },
    });
  });

  it("distinguishes output exhaustion and request timeout from generic model failures", async () => {
    const firstFixtures = fixtures();
    const outputRunner = new AgentRunner(
      {
        model: new ScriptedModel([[{ content: "partial", finishReason: "length" }]]),
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ...firstFixtures,
      },
      { maxRounds: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const output = await outputRunner.start("output", "/tmp");
    expect(output.terminationReason).toBe("output_limit");

    const secondFixtures = fixtures();
    const timeoutRunner = new AgentRunner(
      {
        model: { async *stream() { throw new HammerCodeError("timeout", "MODEL_REQUEST_TIMEOUT", true); } },
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ...secondFixtures,
      },
      { maxRounds: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const timeout = await timeoutRunner.start("timeout", "/tmp");
    expect(timeout.terminationReason).toBe("request_timeout");
  });

  it("terminates independently at tool-count and runtime budgets", async () => {
    const toolFixtures = fixtures();
    let executions = 0;
    const toolRunner = new AgentRunner(
      {
        model: new ScriptedModel([[
          {
            toolCallDeltas: [
              { index: 0, id: "call_budget_1", name: "read_file", arguments: "{}" },
              { index: 1, id: "call_budget_2", name: "read_file", arguments: "{}" },
            ],
            finishReason: "tool_calls",
          },
        ]]),
        tools: {
          definitions: [],
          prepare: async (call) => ({
            call,
            summary: "bounded tool",
            requiresApproval: false,
            execute: async () => {
              executions += 1;
              return { ok: true, summary: "done", output: "done" };
            },
          }),
        },
        approvals: approve,
        ...toolFixtures,
      },
      { maxRounds: 2, maxToolCalls: 1, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const toolLimited = await toolRunner.start("budget", "/tmp");
    expect(toolLimited.terminationReason).toBe("tool_limit");
    expect(executions).toBe(1);

    const timeFixtures = fixtures();
    const timeRunner = new AgentRunner(
      {
        model: {
          async *stream(request) {
            await new Promise<void>((_resolve, reject) => request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            ));
          },
        },
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ...timeFixtures,
      },
      { maxRounds: 2, maxRunTimeMs: 5, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const timeLimited = await timeRunner.start("time budget", "/tmp");
    expect(timeLimited.terminationReason).toBe("time_limit");
  });

  it("bounds resource-exhaustion retries and records the final reason", async () => {
    const { ids, clock } = fixtures();
    let attempts = 0;
    const runner = new AgentRunner(
      {
        model: {
          async *stream() {
            attempts += 1;
            yield { finishReason: "insufficient_system_resource" };
          },
        },
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
        wait: async () => {},
      },
      { maxRounds: 2, maxModelRetries: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("resource", "/tmp");
    expect(attempts).toBe(3);
    expect(result.terminationReason).toBe("resource_exhausted");
    expect(result.turns[0].retryEvents).toHaveLength(2);
  });

  it("keeps remote commands in approval even under full access", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-remote-approval-"));
    workspaces.push(workspace);
    const boundary = await WorkspaceBoundary.create(workspace);
    const { ids, clock } = fixtures();
    let approvals = 0;
    const runner = new AgentRunner(
      {
        model: new ScriptedModel([
          [{ toolCallDeltas: [{ index: 0, id: "call_push", name: "run_command", arguments: '{"command":"git push origin main"}' }], finishReason: "tool_calls" }],
          [{ content: "远端操作被拒绝，没有执行。", finishReason: "stop" }],
        ]),
        tools: new LocalToolExecutor(boundary, ids),
        approvals: { request: async () => { approvals += 1; return false; } },
        ids,
        clock,
      },
      { maxRounds: 3, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("push", workspace, { modelTier: "fast", permissionMode: "full_access" });
    expect(approvals).toBe(1);
    expect(result.toolTraces[0]).toMatchObject({
      approvalPolicy: "always",
      authorization: "user_rejected",
      status: "rejected",
    });
  });

  it("continues safely after a model failure that follows a completed tool without replaying it", async () => {
    const { ids, clock } = fixtures();
    let requests = 0;
    let executions = 0;
    const model: ModelClient = {
      async *stream() {
        requests += 1;
        if (requests === 1) {
          yield { toolCallDeltas: [{ index: 0, id: "call_once", name: "write_file", arguments: "{}" }], finishReason: "tool_calls" };
          return;
        }
        if (requests === 2) throw new HammerCodeError("server failed", "MODEL_SERVER_ERROR", true);
        yield { content: "已从同一聊天安全继续。", finishReason: "stop" };
      },
    };
    const tools: ToolExecutorPort = {
      definitions: [],
      prepare: async (call) => ({
        call,
        summary: "single side effect",
        requiresApproval: false,
        execute: async () => {
          executions += 1;
          return { ok: true, summary: "done", output: "done" };
        },
      }),
    };
    const runner = new AgentRunner(
      { model, tools, approvals: approve, ids, clock, wait: async () => {} },
      { maxRounds: 3, maxModelRetries: 0, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const failed = await runner.start("写一次", "/tmp");
    expect(failed).toMatchObject({ status: "failed", terminationReason: "server_error" });
    expect(executions).toBe(1);
    const resumed = await runner.resume(failed, "不要重复写入，只继续总结");
    expect(resumed.status).toBe("completed");
    expect(executions).toBe(1);
    expect(resumed.messages.filter((message) => message.role === "tool" && message.toolCallId === "call_once")).toHaveLength(1);
  });

  it("automatically creates chat-local memory before a new turn crosses the context threshold", async () => {
    const { ids, clock } = fixtures();
    const oldConclusion = `第一轮长结论：${"x".repeat(7_000)}`;
    const model = new ScriptedModel([
      [{ content: oldConclusion, finishReason: "stop" }],
      new HammerCodeError("temporary", "MODEL_SERVER_ERROR", true),
      [{ content: "原始目标必须保留；第一轮已完成。", finishReason: "stop" }],
      [{ content: "已依据压缩记忆继续。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      {
        model,
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
        wait: async () => {},
      },
      {
        maxRounds: 2,
        contextTokenBudget: 3_000,
        autoCompactRatio: 0.5,
        systemPrompt: "system",
      },
    );

    const first = await runner.start("必须保留原始目标", "/tmp");
    const resumed = await runner.resume(first, "继续下一阶段");
    expect(resumed.contextMemory).toMatchObject({
      mode: "automatic",
      compactionCount: 1,
      throughMessageId: first.messages.at(-1)?.id,
    });
    expect(resumed.messages).toHaveLength(first.messages.length + 2);
    expect(resumed.turns.at(-1)?.metrics?.contextCompactions).toBe(1);
    expect(model.requests[1].tools).toEqual([]);
    expect(model.requests[2].tools).toEqual([]);
    expect(JSON.stringify(model.requests[2].messages)).toContain("必须保留原始目标");
    expect(model.requests[3].messages[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(model.requests[3].messages[0])).toContain("原始目标必须保留");
    expect(model.requests[3].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "继续下一阶段" }),
    ]));
    expect(model.requests[3].messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: oldConclusion }),
    ]));
    expect(resumed.turns.at(-1)?.metrics).toMatchObject({ modelRequests: 3, retryCount: 1 });
  });

  it("injects bounded source-bearing project memory and labels model writes as inference", async () => {
    const { ids, clock } = fixtures();
    const writes: Array<{ kind: string; subject: string; statement: string }> = [];
    const memory: ProjectMemoryPort = {
      settings: async () => ({
        enabled: true,
        useMemories: true,
        generateMemories: true,
        maxRecallRecords: 6,
        maxRecallCharacters: 3_000,
      }),
      retrieve: async () => ({
        records: [],
        rendered: "[decision] package-manager: 使用 npm（置信：user_confirmed；来源：用户确认）",
        truncated: false,
        characterCount: 78,
      }),
      rememberInference: async (input) => {
        writes.push(input);
        return {
          id: "memory_1",
          workspaceRoot: "/tmp",
          kind: input.kind,
          subject: input.subject,
          statement: input.statement,
          confidence: "model_inference",
          source: { type: "model", label: "模型推断" },
          invalidation: { type: "none" },
          status: "active",
          conflictWith: [],
          createdAt: "2026-08-29T00:00:00.000Z",
          updatedAt: "2026-08-29T00:00:00.000Z",
        };
      },
      recordToolFact: async () => null,
    };
    const model = new ScriptedModel([
      [
        { toolCallDeltas: [{ index: 0, id: "remember_1", name: "remember_project", arguments: '{"kind":"decision","subject":"test-runner","statement":"使用 Vitest"}' }], finishReason: "tool_calls" },
      ],
      [{ content: "已记录。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      {
        model,
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
        projectMemory: memory,
      },
      { maxRounds: 3, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("记录测试框架决定", "/tmp");
    expect(result.status).toBe("completed");
    expect(model.requests[0].messages[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(model.requests[0].messages[0])).toContain("来源：用户确认");
    expect(model.requests[0].tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining([
      "search_project_memory", "remember_project",
    ]));
    expect(writes).toEqual([expect.objectContaining({ kind: "decision", subject: "test-runner", statement: "使用 Vitest" })]);
    expect(result.toolTraces.find((trace) => trace.call.name === "remember_project")?.result?.metadata).toMatchObject({
      confidence: "model_inference",
    });
  });

  it("snapshots disabled project memory per turn without injecting tools or context", async () => {
    const { ids, clock } = fixtures();
    const retrieve = vi.fn();
    const recordToolFact = vi.fn();
    const memory: ProjectMemoryPort = {
      settings: async () => ({
        enabled: false,
        useMemories: true,
        generateMemories: true,
        maxRecallRecords: 6,
        maxRecallCharacters: 3_000,
      }),
      retrieve,
      rememberInference: vi.fn(),
      recordToolFact,
    };
    const model = new ScriptedModel([[{ content: "完成。", finishReason: "stop" }]]);
    const runner = new AgentRunner(
      {
        model,
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
        projectMemory: memory,
      },
      { maxRounds: 2, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("不要使用跨聊天记忆", "/tmp");
    expect(retrieve).not.toHaveBeenCalled();
    expect(recordToolFact).not.toHaveBeenCalled();
    expect(model.requests[0].tools).toEqual([]);
    expect(model.requests[0].messages[0]).toEqual({ role: "system", content: "system" });
    expect(result.turns[0].projectMemorySettings).toMatchObject({ enabled: false });
    expect(result.turns[0].metrics).toMatchObject({
      projectMemoryRecords: 0,
      projectMemoryCharacters: 0,
      projectMemoryTokens: 0,
    });
  });

  it("enforces a cumulative maximum of three subagents in one parent turn", async () => {
    const { ids, clock } = fixtures();
    let spawnCalls = 0;
    const coordinator: SubagentCoordinatorPort = {
      spawn: async (input) => {
        spawnCalls += 1;
        return Promise.all(input.tasks.map(async (specification, index) => {
          const now = clock.now().toISOString();
          const task = {
            id: `subtask_${spawnCalls}_${index}`,
            parentSessionId: input.parentSessionId,
            parentTurnId: input.parentTurnId,
            role: specification.role,
            mode: specification.mode,
            task: specification.task,
            status: "completed" as const,
            modelTier: input.parentModelTier,
            modelRef: input.parentModelRef,
            parentPermissionMode: input.parentPermissionMode,
            effectivePermission: specification.mode === "patch_proposal" ? "proposal_only" as const : "read_only" as const,
            budget: { maxRounds: 8, maxToolCalls: 30, maxRunTimeMs: 300_000, contextTokenBudget: 64_000 },
            plan: {
              revision: 1,
              steps: [{ id: "done", title: "done", status: "completed" as const }],
              createdAt: now,
              updatedAt: now,
            },
            messages: [],
            toolTraces: [],
            patches: [],
            result: { summary: "done", findings: [], relatedFiles: [], verificationSuggestions: [], risks: [] },
            createdAt: now,
            updatedAt: now,
            finishedAt: now,
          };
          await input.onUpdate(task);
          return task;
        }));
      },
    };
    const twoTasks = {
      tasks: [
        { role: "analysis", mode: "read_only", task: "A" },
        { role: "test_localization", mode: "read_only", task: "B" },
      ],
    };
    const model = new ScriptedModel([
      [{ toolCallDeltas: [{ index: 0, id: "spawn_first", name: "spawn_subagents", arguments: JSON.stringify(twoTasks) }], finishReason: "tool_calls" }],
      [{ toolCallDeltas: [{ index: 0, id: "spawn_second", name: "spawn_subagents", arguments: JSON.stringify(twoTasks) }], finishReason: "tool_calls" }],
      [{ content: "已遵守累计上限。", finishReason: "stop" }],
    ]);
    const runner = new AgentRunner(
      {
        model,
        tools: { definitions: [], prepare: async () => { throw new Error("unused"); } },
        approvals: approve,
        ids,
        clock,
        subagents: coordinator,
      },
      { maxRounds: 4, maxToolCalls: 10, contextTokenBudget: 10_000, systemPrompt: "system" },
    );
    const result = await runner.start("并行完成四个独立调查，但必须遵守系统上限。", "/tmp");
    expect(result.status).toBe("completed");
    expect(result.subtasks).toHaveLength(2);
    expect(spawnCalls).toBe(1);
    expect(result.toolTraces.find((trace) => trace.call.id === "spawn_second")?.result).toMatchObject({
      ok: false,
      errorCode: "SUBAGENT_LIMIT",
    });
  });
});
