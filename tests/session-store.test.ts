import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/main/session-store";
import type { AgentSession } from "../src/shared/contracts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

function createSession(id: string, task: string, updatedAt: string): AgentSession {
  const turnId = `${id}_turn`;
  const userMessageId = `${id}_user`;
  return {
    id,
    workspaceRoot: "/tmp/workspace",
    status: "completed",
    task,
    turns: [{ id: turnId, userMessageId, status: "completed", terminationReason: "completed", createdAt: updatedAt, updatedAt, finishedAt: updatedAt }],
    activeTurnId: turnId,
    messages: [
      { id: userMessageId, turnId, role: "user", content: task, createdAt: updatedAt },
      { id: `${id}_assistant`, turnId, role: "assistant", content: "done", createdAt: updatedAt },
    ],
    toolTraces: [],
    fileChanges: [],
    transitions: [{ turnId, from: "requesting", to: "completed", reason: "done", at: updatedAt }],
    streamingText: "",
    streamingReasoning: "",
    terminationReason: "completed",
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("session persistence", () => {
  it("ignores malformed persistence instead of crashing startup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "active-session.json"), "{broken", "utf8");
    await expect(store.load()).resolves.toBeNull();
  });

  it("marks interrupted side-effect states as failed without replaying approval", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const at = "2026-08-27T00:00:00.000Z";
    const approval = {
      id: "approval_1",
      toolCallId: "call_1",
      toolName: "write_file",
      title: "修改文件",
      description: "修改 a.txt",
      details: "diff",
      risk: "write" as const,
      createdAt: at,
    };
    const session: AgentSession = {
      id: "session_1",
      workspaceRoot: "/tmp/workspace",
      status: "awaiting_approval",
      task: "edit",
      turns: [{ id: "turn_1", userMessageId: "m1", status: "awaiting_approval", createdAt: at, updatedAt: at }],
      activeTurnId: "turn_1",
      messages: [
        { id: "m1", turnId: "turn_1", role: "user", content: "edit", createdAt: at },
        { id: "m2", turnId: "turn_1", role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' }], createdAt: at },
      ],
      toolTraces: [{ turnId: "turn_1", call: { id: "call_1", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' }, status: "awaiting_approval", summary: "修改 a.txt", approval }],
      fileChanges: [],
      transitions: [{ turnId: "turn_1", from: "idle", to: "requesting", reason: "start", at }],
      streamingText: "partial",
      streamingReasoning: "thinking",
      pendingApproval: approval,
      createdAt: at,
      updatedAt: at,
    };
    await store.save(session);
    const restored = await store.load();
    expect(restored).toMatchObject({
      status: "failed",
      terminationReason: "interrupted",
      pendingApproval: undefined,
      streamingText: "",
      streamingReasoning: "",
    });
    expect(restored?.transitions.at(-1)).toMatchObject({
      from: "awaiting_approval",
      to: "failed",
    });
    expect(restored?.messages.filter((message) => message.role === "tool" && message.toolCallId === "call_1")).toHaveLength(1);
    expect(restored?.toolTraces[0]).toMatchObject({ status: "cancelled", result: { errorCode: "TOOL_CALL_INTERRUPTED" } });

    const restoredAgain = await store.load();
    expect(restoredAgain?.messages.filter((message) => message.role === "tool" && message.toolCallId === "call_1")).toHaveLength(1);
  });

  it("keeps independent chats and restores the selected chat", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const first = createSession("session_first", "检查项目结构", "2026-08-27T01:00:00.000Z");
    const second = createSession("session_second", "修复类型错误", "2026-08-27T02:00:00.000Z");

    await store.save(first);
    await store.save(second);
    let state = await store.loadState();
    expect(state.sessions.map((item) => item.id)).toEqual(["session_second", "session_first"]);
    expect(state.activeSession?.id).toBe("session_second");
    expect(state.workspaceRoot).toBe("/tmp/workspace");

    await store.setActive("session_first");
    state = await store.loadState();
    expect(state.activeSession?.task).toBe("检查项目结构");
    expect(state.sessions).toHaveLength(2);
  });

  it("migrates the legacy active-session file without losing the chat", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const legacy = createSession("session_legacy", "保留旧聊天", "2026-08-27T03:00:00.000Z");
    const raw = JSON.parse(JSON.stringify(legacy)) as {
      turns?: unknown;
      activeTurnId?: unknown;
      fileChanges?: unknown;
      messages: Array<{ turnId?: string }>;
      toolTraces: Array<{ turnId?: string }>;
      transitions: Array<{ turnId?: string }>;
    };
    delete raw.turns;
    delete raw.activeTurnId;
    delete raw.fileChanges;
    raw.messages.forEach((message) => delete message.turnId);
    raw.toolTraces.forEach((trace) => delete trace.turnId);
    raw.transitions.forEach((transition) => delete transition.turnId);
    await writeFile(path.join(directory, "active-session.json"), JSON.stringify(raw), "utf8");

    const state = await new SessionStore(directory).loadState();
    expect(state.activeSession).toMatchObject({ id: "session_legacy", task: "保留旧聊天" });
    expect(state.activeSession?.turns).toHaveLength(1);
    expect(state.activeSession?.messages.every((message) => Boolean(message.turnId))).toBe(true);
    expect(state.sessions).toEqual([
      expect.objectContaining({ id: "session_legacy", title: "保留旧聊天" }),
    ]);
  });
});
