import { describe, expect, it } from "vitest";
import {
  buildContextFacts,
  buildModelContext,
  createContextMemory,
  estimateMessageTokens,
  historyAfterContextMemory,
  systemPromptWithContextMemory,
} from "../src/core/context";
import type { AgentSession, ConversationMessage } from "../src/shared/contracts";

const at = "2026-08-27T00:00:00.000Z";

describe("context management", () => {
  it("keeps full history under budget", () => {
    const history: ConversationMessage[] = [{ id: "u1", turnId: "turn_1", role: "user", content: "fix it", createdAt: at }];
    const result = buildModelContext("system", history, 10_000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(2);
  });

  it("compresses old history while retaining the original task and recent state", () => {
    const history: ConversationMessage[] = [
      { id: "u1", turnId: "turn_1", role: "user", content: "关键任务：修复登录", createdAt: at },
      ...Array.from({ length: 20 }, (_, index): ConversationMessage => ({
        id: `a${index}`,
        turnId: "turn_1",
        role: "assistant",
        content: `旧分析 ${index} ${"x".repeat(600)}`,
        createdAt: at,
      })),
      { id: "u2", turnId: "turn_2", role: "user", content: "保留最新约束：不改接口", createdAt: at },
    ];
    const result = buildModelContext("system", history, 2_000);
    expect(result.compacted).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("关键任务：修复登录");
    expect(JSON.stringify(result.messages)).toContain("保留最新约束：不改接口");
    expect(estimateMessageTokens(result.messages)).toBeLessThanOrEqual(2_000);
  });

  it("keeps assistant tool calls and their results as an atomic protocol group", () => {
    const history: ConversationMessage[] = [
      { id: "u1", turnId: "turn_1", role: "user", content: "inspect", createdAt: at },
      { id: "old", turnId: "turn_1", role: "assistant", content: "x".repeat(10_000), createdAt: at },
      {
        id: "a1",
        turnId: "turn_1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }],
        createdAt: at,
      },
      {
        id: "t1",
        turnId: "turn_1",
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

  it("retains persisted constraints, changes, verification and plan facts after deep compaction", () => {
    const history: ConversationMessage[] = [
      { id: "u1", turnId: "turn_1", role: "user", content: "原始长任务", createdAt: at },
      ...Array.from({ length: 40 }, (_, index): ConversationMessage => ({
        id: `old_${index}`,
        turnId: "turn_1",
        role: "assistant",
        content: `可丢弃旧推理 ${index} ${"z".repeat(800)}`,
        createdAt: at,
      })),
      { id: "u2", turnId: "turn_2", role: "user", content: "最新输入", createdAt: at },
    ];
    const result = buildModelContext("system", history, 3_000, {
      originalTask: "必须完成 Phase 6",
      recentConstraints: ["不能修改公开接口"],
      appliedChanges: ["modify src/main.ts（after hash: abc123）"],
      verificationResults: ["npm test: 成功 · 72 tests passed"],
      unresolvedErrors: ["server_error: 上次服务端失败"],
      currentPlan: ["[in_progress] 完成长上下文测试"],
      skillsUsed: ["pdf-review@1.0.0（显式）· 用户显式指定 $pdf-review"],
    });
    const serialized = JSON.stringify(result.messages);
    expect(result.compacted).toBe(true);
    expect(serialized).toContain("必须完成 Phase 6");
    expect(serialized).toContain("不能修改公开接口");
    expect(serialized).toContain("abc123");
    expect(serialized).toContain("72 tests passed");
    expect(serialized).toContain("完成长上下文测试");
    expect(serialized).toContain("pdf-review@1.0.0");
    expect(estimateMessageTokens(result.messages)).toBeLessThanOrEqual(3_000);
  });

  it("carries the latest failed turn plan and verification into a new turn's facts", () => {
    const session = {
      task: "修复长任务",
      activeTurnId: "turn_2",
      turns: [
        {
          id: "turn_1",
          error: "临时服务端失败",
          terminationReason: "server_error",
          plan: {
            revision: 2,
            steps: [{ id: "verify", title: "完成回归验证", status: "in_progress" }],
            createdAt: at,
            updatedAt: at,
          },
        },
        { id: "turn_2" },
      ],
      messages: [
        { id: "u1", turnId: "turn_1", role: "user", content: "修复长任务", createdAt: at },
        {
          id: "t1",
          turnId: "turn_1",
          role: "tool",
          toolCallId: "call_1",
          toolName: "run_command",
          content: JSON.stringify({ ok: true, summary: "测试通过", output: "103 tests passed" }),
          createdAt: at,
        },
        { id: "u2", turnId: "turn_2", role: "user", content: "继续完成，不要重放", createdAt: at },
      ],
      fileChanges: [],
    } as unknown as AgentSession;

    const facts = buildContextFacts(session);
    expect(facts.currentPlan).toContain("[in_progress] 完成回归验证");
    expect(facts.verificationResults.join("\n")).toContain("103 tests passed");
    expect(facts.unresolvedErrors.join("\n")).toContain("临时服务端失败");
  });

  it("creates persistent single-chat memory without deleting audit history", () => {
    const messages: ConversationMessage[] = [
      { id: "u1", turnId: "turn_1", role: "user", content: "实现功能", createdAt: at },
      { id: "a1", turnId: "turn_1", role: "assistant", content: "已完成第一阶段", createdAt: at },
    ];
    const session = {
      task: "实现功能",
      activeTurnId: "turn_1",
      turns: [{ id: "turn_1" }],
      messages,
      fileChanges: [],
    } as unknown as AgentSession;
    const memory = createContextMemory(session, at, "explicit");
    session.contextMemory = memory;
    expect(session.messages).toHaveLength(2);
    expect(historyAfterContextMemory(session)).toEqual([]);
    session.messages.push({ id: "u2", turnId: "turn_2", role: "user", content: "继续", createdAt: at });
    expect(historyAfterContextMemory(session).map((message) => message.id)).toEqual(["u2"]);
    expect(systemPromptWithContextMemory("system", memory)).toContain("已完成第一阶段");
    expect(memory).toMatchObject({ mode: "explicit", compactionCount: 1, sourceMessageCount: 2 });
  });
});
