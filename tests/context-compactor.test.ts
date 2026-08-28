import { describe, expect, it } from "vitest";
import { compactContextWithModel } from "../src/core/context-compactor";
import type { ModelClient, ModelRequest, ModelStreamChunk } from "../src/core/types";
import type { AgentSession } from "../src/shared/contracts";

const at = "2026-08-29T00:00:00.000Z";

function session(): AgentSession {
  return {
    id: "session_1",
    workspaceRoot: "/tmp/workspace",
    status: "completed",
    task: "修复登录并保留公开接口",
    modelTier: "fast",
    modelRef: "builtin:fast",
    permissionMode: "ask",
    turns: [{
      id: "turn_1",
      userMessageId: "message_1",
      status: "completed",
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
      planRequired: false,
      planCheckpoints: [],
      retryEvents: [],
      createdAt: at,
      updatedAt: at,
    }],
    activeTurnId: "turn_1",
    messages: [
      { id: "message_1", turnId: "turn_1", role: "user", content: "不要修改公开接口", createdAt: at },
      { id: "message_2", turnId: "turn_1", role: "assistant", content: "已修复登录校验", createdAt: at },
    ],
    toolTraces: [],
    fileChanges: [],
    transitions: [],
    streamingText: "",
    streamingReasoning: "",
    createdAt: at,
    updatedAt: at,
  };
}

class RecordingModel implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(private readonly chunks: ModelStreamChunk[]) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request);
    for (const chunk of this.chunks) yield chunk;
  }
}

describe("model context compactor", () => {
  it("creates semantic memory with deterministic fact anchors and no tools", async () => {
    const model = new RecordingModel([
      { content: "登录校验已修复，后续必须保持公开接口不变。", finishReason: "stop", usage: { promptTokens: 120, completionTokens: 18 } },
    ]);
    const source = session();
    const result = await compactContextWithModel(model, source, at, "explicit", new AbortController().signal);

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].tools).toEqual([]);
    expect(result.memory).toMatchObject({
      mode: "explicit",
      throughMessageId: "message_2",
      sourceMessageCount: 2,
      compactionCount: 1,
    });
    expect(result.memory.summary).toContain("登录校验已修复");
    expect(result.memory.summary).toContain("不要修改公开接口");
    expect(result).toMatchObject({ promptTokens: 120, completionTokens: 18, usageEstimated: false });
    expect(source.contextMemory).toBeUndefined();
  });

  it("rejects exhausted output without mutating existing memory", async () => {
    const model = new RecordingModel([{ content: "不完整摘要", finishReason: "length" }]);
    const source = session();
    source.contextMemory = {
      version: 1,
      summary: "旧记忆",
      throughMessageId: "message_1",
      throughCreatedAt: at,
      sourceMessageCount: 1,
      mode: "explicit",
      compactionCount: 1,
      createdAt: at,
      updatedAt: at,
    };

    await expect(compactContextWithModel(model, source, at, "explicit", new AbortController().signal))
      .rejects.toMatchObject({ code: "CONTEXT_COMPACTION_LENGTH" });
    expect(source.contextMemory.summary).toBe("旧记忆");
  });

  it("propagates cancellation without creating memory", async () => {
    const source = session();
    const model: ModelClient = {
      stream: async function* (request) {
        await new Promise<void>((resolve, reject) => {
          if (request.signal.aborted) reject(request.signal.reason);
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
        yield { content: "不应到达", finishReason: "stop" };
      },
    };
    const abort = new AbortController();
    const run = compactContextWithModel(model, source, at, "explicit", abort.signal);
    abort.abort(new DOMException("stop", "AbortError"));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(source.contextMemory).toBeUndefined();
  });

  it("blocks tool calls proposed during compression", async () => {
    const model = new RecordingModel([{
      toolCallDeltas: [{ index: 0, id: "call_1", name: "read_file", arguments: "{}" }],
      finishReason: "tool_calls",
    }]);
    await expect(compactContextWithModel(model, session(), at, "automatic", new AbortController().signal))
      .rejects.toMatchObject({ code: "CONTEXT_COMPACTION_TOOL_CALL" });
  });
});
