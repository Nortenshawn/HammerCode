import { describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/core/agent-runner";
import { PendingApprovalGateway } from "../src/main/approval-gateway";
import {
  MainAgentRunRegistry,
  type MainAgentRun,
} from "../src/main/main-agent-run-registry";
import type { AgentSession, ApprovalRequest } from "../src/shared/contracts";

const at = "2026-08-31T00:00:00.000Z";

function session(id: string, workspaceRoot: string): AgentSession {
  return {
    id,
    workspaceRoot,
    status: "requesting",
    task: id,
    modelTier: "fast",
    modelRef: "builtin:fast",
    permissionMode: "ask",
    turns: [{
      id: `${id}_turn`,
      userMessageId: `${id}_user`,
      status: "requesting",
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
      createdAt: at,
      updatedAt: at,
    }],
    activeTurnId: `${id}_turn`,
    messages: [{ id: `${id}_user`, turnId: `${id}_turn`, role: "user", content: id, createdAt: at }],
    toolTraces: [],
    fileChanges: [],
    transitions: [],
    streamingText: "",
    streamingReasoning: "",
    createdAt: at,
    updatedAt: at,
  };
}

function run(id: string, workspaceRoot: string) {
  const cancel = vi.fn();
  const approvals = new PendingApprovalGateway();
  const value: MainAgentRun = {
    sessionId: id,
    workspaceRoot,
    runner: { cancel } as unknown as AgentRunner,
    approvals,
    abortController: new AbortController(),
    execution: {
      modelTier: "fast",
      modelRef: "builtin:fast",
      modelName: "deepseek-v4-flash",
      permissionMode: "ask",
      budget: {
        maxRounds: 20,
        maxToolCalls: 100,
        maxRunTimeMs: 1_800_000,
        maxModelRetries: 2,
        maxOutputTokens: 32_768,
        contextTokenBudget: 120_000,
      },
    },
    currentSession: session(id, workspaceRoot),
  };
  return { value, cancel, approvals };
}

function approval(id: string): ApprovalRequest {
  return {
    id,
    toolCallId: `${id}_call`,
    toolName: "write_file",
    title: "写入文件",
    description: "写入测试文件",
    details: "diff",
    risk: "write",
    createdAt: at,
  };
}

describe("main agent run registry", () => {
  it("reserves different workspaces while atomically blocking the same workspace and fourth task", () => {
    const registry = new MainAgentRunRegistry(3);
    const first = registry.reserve("/workspace/a");
    expect(() => registry.reserve("/workspace/a")).toThrowError(expect.objectContaining({ code: "WORKSPACE_MAIN_AGENT_BUSY" }));
    const second = registry.reserve("/workspace/b");
    const third = registry.reserve("/workspace/c");
    expect(registry.occupiedCount).toBe(3);
    expect(() => registry.reserve("/workspace/d")).toThrowError(expect.objectContaining({ code: "MAIN_AGENT_CONCURRENCY_LIMIT" }));

    registry.releaseReservation(second);
    expect(registry.reserve("/workspace/d")).toMatchObject({ workspaceRoot: "/workspace/d" });
    registry.releaseReservation(first);
    registry.releaseReservation(third);
  });

  it("rebinds path aliases to one canonical workspace without opening a race", () => {
    const registry = new MainAgentRunRegistry(3);
    const firstAlias = registry.reserve("/alias/a");
    const secondAlias = registry.reserve("/alias/b");
    expect(registry.canonicalizeReservation(firstAlias, "/canonical/project"))
      .toMatchObject({ workspaceRoot: "/canonical/project" });
    expect(() => registry.canonicalizeReservation(secondAlias, "/canonical/project"))
      .toThrowError(expect.objectContaining({ code: "WORKSPACE_MAIN_AGENT_BUSY" }));
    expect(registry.occupiedCount).toBe(1);
  });

  it("keeps cancellation isolated to the addressed session", () => {
    const registry = new MainAgentRunRegistry(3);
    const first = run("session_a", "/workspace/a");
    const second = run("session_b", "/workspace/b");
    registry.attach(registry.reserve(first.value.workspaceRoot), first.value);
    registry.attach(registry.reserve(second.value.workspaceRoot), second.value);

    registry.cancel("session_a", "stop A");
    expect(first.cancel).toHaveBeenCalledWith("stop A");
    expect(first.value.abortController.signal.aborted).toBe(true);
    expect(second.cancel).not.toHaveBeenCalled();
    expect(second.value.abortController.signal.aborted).toBe(false);
    expect(registry.has("session_b")).toBe(true);
  });

  it("routes simultaneous approval and rejection by both session and approval id", async () => {
    const registry = new MainAgentRunRegistry(3);
    const first = run("session_a", "/workspace/a");
    const second = run("session_b", "/workspace/b");
    registry.attach(registry.reserve(first.value.workspaceRoot), first.value);
    registry.attach(registry.reserve(second.value.workspaceRoot), second.value);
    const firstRequest = approval("approval_a");
    const secondRequest = approval("approval_b");
    first.value.currentSession.pendingApproval = firstRequest;
    second.value.currentSession.pendingApproval = secondRequest;
    const firstResult = first.approvals.request(firstRequest, new AbortController().signal);
    const secondResult = second.approvals.request(secondRequest, new AbortController().signal);

    expect(() => registry.resolveApproval("session_a", "approval_b", true))
      .toThrowError(expect.objectContaining({ code: "APPROVAL_SESSION_MISMATCH" }));
    registry.resolveApproval("session_a", "approval_a", true);
    registry.resolveApproval("session_b", "approval_b", false);
    await expect(firstResult).resolves.toBe(true);
    await expect(secondResult).resolves.toBe(false);
  });

  it("updates and releases only the matching session and workspace", () => {
    const registry = new MainAgentRunRegistry(2);
    const first = run("session_a", "/workspace/a");
    const second = run("session_b", "/workspace/b");
    registry.attach(registry.reserve(first.value.workspaceRoot), first.value);
    registry.attach(registry.reserve(second.value.workspaceRoot), second.value);
    const updated = session("session_a", "/workspace/a");
    updated.streamingText = "partial A";
    registry.updateSession(updated);

    expect(registry.get("session_a")?.currentSession.streamingText).toBe("partial A");
    registry.finish("session_a");
    expect(registry.isWorkspaceOccupied("/workspace/a")).toBe(false);
    expect(registry.workspaceSessionId("/workspace/b")).toBe("session_b");
  });
});
