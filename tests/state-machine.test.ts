import { describe, expect, it } from "vitest";
import { transitionState } from "../src/core/state-machine";
import type { Clock } from "../src/core/types";

const clock: Clock = { now: () => new Date("2026-08-27T00:00:00.000Z") };

describe("state machine", () => {
  it("records an allowed transition", () => {
    expect(transitionState("requesting", "awaiting_approval", "write", clock, "turn_1")).toEqual({
      turnId: "turn_1",
      from: "requesting",
      to: "awaiting_approval",
      reason: "write",
      at: "2026-08-27T00:00:00.000Z",
    });
  });

  it("allows an explicit new turn after a terminal state", () => {
    expect(transitionState("completed", "requesting", "继续对话", clock, "turn_2")).toMatchObject({
      turnId: "turn_2",
      from: "completed",
      to: "requesting",
    });
  });

  it("still rejects invalid transitions inside a terminal turn", () => {
    expect(() => transitionState("completed", "completed", "again", clock, "turn_2")).toThrow("非法状态转换");
  });
});
