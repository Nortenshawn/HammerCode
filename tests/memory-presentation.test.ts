import { describe, expect, it } from "vitest";
import type { ArchivedWorkspaceSummary, ProjectMemoryRecord, WorkspaceSummary } from "../src/shared/contracts";
import {
  cleanMemorySourceLabel,
  memoryDescription,
  memorySourceTitle,
  memoryTitle,
} from "../src/renderer/src/memory-presentation";

function record(overrides: Partial<ProjectMemoryRecord> = {}): ProjectMemoryRecord {
  return {
    id: "memory_1",
    workspaceRoot: "/tmp/project",
    kind: "fact",
    subject: "file:src/app.ts",
    statement: `modify src/app.ts；当前内容哈希 ${"a".repeat(64)}`,
    confidence: "tool_verified",
    source: {
      type: "tool",
      sessionId: "session_abc",
      turnId: "turn_def",
      toolName: "edit_file",
      label: "工具 edit_file · session_abc/turn_def",
    },
    invalidation: { type: "none" },
    status: "active",
    conflictWith: [],
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("project memory presentation", () => {
  it("turns file records into readable text without exposing hashes or internal ids", () => {
    const item = record();
    expect(memoryTitle(item)).toBe("修改文件 · src/app.ts");
    expect(memoryDescription(item)).not.toContain("当前内容哈希");
    expect(cleanMemorySourceLabel(item)).toBe("工具 edit_file");
  });

  it("references the source chat title across active and archived collections", () => {
    const active: WorkspaceSummary[] = [];
    const archived: ArchivedWorkspaceSummary[] = [{
      root: "/tmp/project",
      name: "project",
      sessionCount: 1,
      sessions: [{
        id: "session_abc",
        workspaceRoot: "/tmp/project",
        title: "修复登录状态",
        status: "completed",
        turnCount: 2,
        changedFileCount: 1,
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:10:00.000Z",
      }],
      updatedAt: "2026-08-30T00:10:00.000Z",
    }];
    const source = memorySourceTitle(record(), active, archived);
    expect(source).toBe("工具 edit_file · 修复登录状态");
    expect(source).not.toContain("session_abc");
    expect(source).not.toContain("turn_def");
  });

  it("uses concise verification titles", () => {
    expect(memoryTitle(record({
      kind: "verification",
      subject: "verification:run_python:1234",
      source: { type: "tool", toolName: "run_python", label: "工具 run_python" },
      statement: "Python 测试通过",
    }))).toBe("Python 验证结果");
  });

  it("derives a readable title when a model subject is a technical slug", () => {
    expect(memoryTitle(record({
      kind: "decision",
      subject: "phase9-counter-contract",
      statement: "PHASE9_MEMORY_MARKER：Phase 9 counter 契约值必须为 42。后续说明",
      confidence: "model_inference",
      source: { type: "model", label: "模型推断" },
    }))).toBe("项目决定 · Phase 9 counter 契约值必须为 42");
  });
});
