import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  ToolExecutorPort,
} from "../src/core/types";

class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly scripts: ModelStreamChunk[][]) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) throw new Error("unexpected model request");
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
    expect(result.toolTraces[0]).toMatchObject({ status: "succeeded" });
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
    runner.cancel();
    const result = await run;
    expect(result.status).toBe("cancelled");
    expect(result.terminationReason).toBe("cancelled");
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
  });
});
