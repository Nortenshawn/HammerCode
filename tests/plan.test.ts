import { describe, expect, it } from "vitest";
import { applyPlanUpdate, isComplexTask, parsePlanUpdate } from "../src/core/plan";
import type { AgentTurn } from "../src/shared/contracts";

const at = "2026-08-28T00:00:00.000Z";

function turn(): AgentTurn {
  return {
    id: "turn_1",
    userMessageId: "message_1",
    status: "requesting",
    modelTier: "fast",
    modelRef: "builtin:fast",
    permissionMode: "ask",
    createdAt: at,
    updatedAt: at,
  };
}

describe("persistent turn plans", () => {
  it("detects multi-step work and creates versioned checkpoints", () => {
    expect(isComplexTask("请完整实现设置页、重试机制和相应的自动测试，然后运行构建验证。" )).toBe(true);
    const target = turn();
    const input = parsePlanUpdate(JSON.stringify({
      explanation: "先建立主链路",
      steps: [
        { id: "implement", title: "实现功能", status: "in_progress" },
        { id: "verify", title: "运行验证", status: "pending" },
      ],
    }));
    applyPlanUpdate(target, input, { next: () => "checkpoint_1" }, at);
    expect(target.plan).toMatchObject({ revision: 1, explanation: "先建立主链路" });
    expect(target.planCheckpoints).toEqual([expect.objectContaining({ id: "checkpoint_1", revision: 1 })]);
  });

  it("does not allow completed work to regress in a later checkpoint", () => {
    const target = turn();
    applyPlanUpdate(target, {
      steps: [{ id: "done", title: "已完成", status: "completed" }],
    }, { next: () => "checkpoint_1" }, at);
    expect(() => applyPlanUpdate(target, {
      steps: [{ id: "done", title: "已完成", status: "pending" }],
    }, { next: () => "checkpoint_2" }, at)).toThrow();
  });
});
