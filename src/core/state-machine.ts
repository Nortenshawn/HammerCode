import type { SessionStatus, StateTransition } from "../shared/contracts";
import type { Clock } from "./types";
import { HammerCodeError } from "./types";

const ALLOWED_TRANSITIONS: Record<SessionStatus, ReadonlySet<SessionStatus>> = {
  idle: new Set(["requesting", "cancelled"]),
  requesting: new Set([
    "requesting",
    "awaiting_approval",
    "executing_tool",
    "completed",
    "cancelled",
    "failed",
  ]),
  awaiting_approval: new Set([
    "executing_tool",
    "requesting",
    "cancelled",
    "failed",
  ]),
  executing_tool: new Set(["requesting", "cancelled", "failed"]),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

export function transitionState(
  current: SessionStatus,
  next: SessionStatus,
  reason: string,
  clock: Clock,
): StateTransition {
  if (!ALLOWED_TRANSITIONS[current].has(next)) {
    throw new HammerCodeError(
      `非法状态转换：${current} -> ${next}`,
      "INVALID_STATE_TRANSITION",
    );
  }

  return { from: current, to: next, reason, at: clock.now().toISOString() };
}
