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
      messages: [{ id: "m1", role: "user", content: "edit", createdAt: at }],
      toolTraces: [],
      transitions: [{ from: "idle", to: "requesting", reason: "start", at }],
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
  });
});
