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
    const toolRound: ModelStreamChunk[] = [
      {
        toolCallDeltas: [{ index: 0, id: "call", name: "unknown", arguments: "{}" }],
        finishReason: "tool_calls",
      },
    ];
    const runner = new AgentRunner(
      {
        model: new ScriptedModel([toolRound, toolRound]),
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
});
