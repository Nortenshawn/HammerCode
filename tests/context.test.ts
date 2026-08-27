import { describe, expect, it } from "vitest";
import { buildModelContext, estimateMessageTokens } from "../src/core/context";
import type { ConversationMessage } from "../src/shared/contracts";

const at = "2026-08-27T00:00:00.000Z";

describe("context management", () => {
  it("keeps full history under budget", () => {
    const history: ConversationMessage[] = [{ id: "u1", role: "user", content: "fix it", createdAt: at }];
    const result = buildModelContext("system", history, 10_000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(2);
  });

  it("compresses old history while retaining the original task and recent state", () => {
    const history: ConversationMessage[] = [
      { id: "u1", role: "user", content: "关键任务：修复登录", createdAt: at },
      ...Array.from({ length: 20 }, (_, index): ConversationMessage => ({
        id: `a${index}`,
        role: "assistant",
        content: `旧分析 ${index} ${"x".repeat(600)}`,
        createdAt: at,
      })),
      { id: "u2", role: "user", content: "保留最新约束：不改接口", createdAt: at },
    ];
    const result = buildModelContext("system", history, 2_000);
    expect(result.compacted).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("关键任务：修复登录");
    expect(JSON.stringify(result.messages)).toContain("保留最新约束：不改接口");
    expect(estimateMessageTokens(result.messages)).toBeLessThanOrEqual(2_000);
  });

  it("keeps assistant tool calls and their results as an atomic protocol group", () => {
    const history: ConversationMessage[] = [
      { id: "u1", role: "user", content: "inspect", createdAt: at },
      { id: "old", role: "assistant", content: "x".repeat(10_000), createdAt: at },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }],
        createdAt: at,
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "call_1",
        toolName: "read_file",
        content: '{"ok":true,"output":"content"}',
        createdAt: at,
      },
    ];
    const result = buildModelContext("system", history, 1_500);
    const toolIndex = result.messages.findIndex((message) => message.role === "tool");
    expect(toolIndex).toBeGreaterThan(0);
    expect(result.messages[toolIndex - 1]).toMatchObject({ role: "assistant" });
    expect(result.messages[toolIndex - 1]).toHaveProperty("tool_calls.0.id", "call_1");
  });
});
