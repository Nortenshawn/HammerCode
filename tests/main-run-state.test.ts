import { describe, expect, it } from "vitest";
import { deriveMainRunUiState } from "../src/renderer/src/main-run-state";
import type { SessionSummary, WorkspaceSummary } from "../src/shared/contracts";

const at = "2026-08-31T00:00:00.000Z";

function summary(id: string, workspaceRoot: string, status: SessionSummary["status"]): SessionSummary {
  return {
    id,
    workspaceRoot,
    title: id,
    status,
    turnCount: 1,
    changedFileCount: 0,
    createdAt: at,
    updatedAt: at,
  };
}

function workspace(root: string, sessions: SessionSummary[]): WorkspaceSummary {
  return {
    root,
    name: root,
    pinned: false,
    memoryExport: { mode: "project" },
    sessionCount: sessions.length,
    sessions,
    activeSessionId: sessions[0]?.id ?? null,
    updatedAt: at,
  };
}

describe("main run UI state", () => {
  it("allows a second project while another workspace is running", () => {
    const state = deriveMainRunUiState([
      workspace("/a", [summary("a", "/a", "requesting")]),
      workspace("/b", []),
    ], "/b", null, 3);
    expect(state).toMatchObject({
      activeCount: 1,
      currentSessionRunning: false,
      workspaceHasRunningSession: false,
      anotherSessionInWorkspaceRunning: false,
      limitReached: false,
    });
  });

  it("locks only another chat in the same workspace and marks approval as active", () => {
    const state = deriveMainRunUiState([
      workspace("/a", [
        summary("waiting", "/a", "awaiting_approval"),
        summary("terminal", "/a", "completed"),
      ]),
    ], "/a", "terminal", 3);
    expect(state).toMatchObject({
      activeCount: 1,
      currentSessionRunning: false,
      workspaceHasRunningSession: true,
      anotherSessionInWorkspaceRunning: true,
    });
  });

  it("reaches the shared configured limit without treating terminal chats as active", () => {
    const state = deriveMainRunUiState([
      workspace("/a", [summary("a", "/a", "requesting")]),
      workspace("/b", [summary("b", "/b", "executing_tool")]),
      workspace("/c", [summary("c", "/c", "awaiting_approval")]),
      workspace("/d", [summary("done", "/d", "completed")]),
    ], "/d", "done", 3);
    expect(state.activeCount).toBe(3);
    expect(state.limitReached).toBe(true);
    expect(state.currentSessionRunning).toBe(false);
  });
});
