import { describe, expect, it } from "vitest";
import { transitionState } from "../src/core/state-machine";
import type { Clock } from "../src/core/types";

const clock: Clock = { now: () => new Date("2026-08-27T00:00:00.000Z") };

describe("state machine", () => {
  it("records an allowed transition", () => {
    expect(transitionState("requesting", "awaiting_approval", "write", clock)).toEqual({
      from: "requesting",
      to: "awaiting_approval",
      reason: "write",
      at: "2026-08-27T00:00:00.000Z",
    });
  });

  it("rejects terminal-state transitions", () => {
    expect(() => transitionState("completed", "requesting", "again", clock)).toThrow(
      "非法状态转换",
    );
  });
});
