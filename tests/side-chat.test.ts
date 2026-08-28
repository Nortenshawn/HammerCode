import { describe, expect, it } from "vitest";
import { EphemeralSideChat, buildSideChatSnapshot } from "../src/core/side-chat";
import type { ModelClient } from "../src/core/types";
import type { AgentSession } from "../src/shared/contracts";

const at = "2026-08-29T00:00:00.000Z";

function source(): AgentSession {
  return {
    id: "session_main",
    workspaceRoot: "/tmp/workspace",
    status: "requesting",
    task: "修复布局",
    title: "自适应三栏布局",
    modelTier: "fast",
    modelRef: "builtin:fast",
    permissionMode: "ask",
    turns: [{ id: "turn_1", userMessageId: "user_1", status: "requesting", modelTier: "fast", permissionMode: "ask", createdAt: at, updatedAt: at }],
    activeTurnId: "turn_1",
    messages: [{ id: "user_1", turnId: "turn_1", role: "user", content: "修复布局", createdAt: at }],
    toolTraces: [],
    fileChanges: [],
    transitions: [],
    streamingText: "正在检查网格",
    streamingReasoning: "需要保存比例",
    createdAt: at,
    updatedAt: at,
  };
}

describe("ephemeral BTW", () => {
  it("freezes a bounded one-way source snapshot", () => {
    const session = source();
    const snapshot = buildSideChatSnapshot(session);
    session.task = "后来改变的目标";
    expect(snapshot).toContain("修复布局");
    expect(snapshot).toContain("正在检查网格");
    expect(snapshot).not.toContain("后来改变的目标");
    expect(snapshot.length).toBeLessThanOrEqual(60_000);
  });

  it("supports independent multi-turn text chat without exposing tools", async () => {
    const toolCounts: number[] = [];
    const model: ModelClient = {
      async *stream(request) {
        toolCounts.push(request.tools.length);
        yield { reasoningContent: "只读分析" };
        yield { content: `回答 ${toolCounts.length}`, finishReason: "stop" };
      },
    };
    let sequence = 0;
    const side = new EphemeralSideChat({
      model,
      modelTier: "fast",
      modelRef: "builtin:fast",
      source: source(),
      clock: { now: () => new Date(at) },
      ids: { next: (prefix) => `${prefix}_${++sequence}` },
    });
    await side.send("第一问");
    await side.send("第二问");
    expect(toolCounts).toEqual([0, 0]);
    expect(side.snapshot.status).toBe("completed");
    expect(side.snapshot.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant",
    ]);
    expect(source().messages).toHaveLength(1);
  });

  it("blocks unexpected model tool calls", async () => {
    const model: ModelClient = {
      async *stream() {
        yield { toolCallDeltas: [{ index: 0, id: "call_1", name: "write_file" }] };
      },
    };
    const side = new EphemeralSideChat({
      model,
      modelTier: "fast",
      modelRef: "builtin:fast",
      source: source(),
      clock: { now: () => new Date(at) },
      ids: { next: (prefix) => `${prefix}_1` },
    });
    await side.send("修改文件");
    expect(side.snapshot).toMatchObject({ status: "failed", error: expect.stringContaining("只读边界阻断") });
  });

  it("cancels its own model request without affecting the source", async () => {
    const model: ModelClient = {
      async *stream(request) {
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
        yield { content: "unreachable" };
      },
    };
    const main = source();
    const side = new EphemeralSideChat({
      model,
      modelTier: "fast",
      modelRef: "builtin:fast",
      source: main,
      clock: { now: () => new Date(at) },
      ids: { next: (prefix) => `${prefix}_cancel` },
    });
    const run = side.send("等待回答");
    await Promise.resolve();
    side.cancel();
    await run;
    expect(side.snapshot.status).toBe("cancelled");
    expect(main.status).toBe("requesting");
    expect(main.messages).toHaveLength(1);
  });
});
