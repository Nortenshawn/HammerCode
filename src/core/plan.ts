import { z } from "zod";
import type { AgentTurn, PlanCheckpoint, PlanStep, TurnPlan } from "../shared/contracts";
import type { IdGenerator } from "./types";
import { HammerCodeError } from "./types";

export const planUpdateSchema = z
  .object({
    explanation: z.string().max(2_000).optional(),
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
            title: z.string().trim().min(1).max(240),
            status: z.enum(["pending", "in_progress", "completed"]),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    let active = 0;
    for (const step of value.steps) {
      if (ids.has(step.id)) {
        context.addIssue({ code: "custom", message: `计划步骤 id 重复：${step.id}` });
      }
      ids.add(step.id);
      if (step.status === "in_progress") active += 1;
    }
    if (active > 1) {
      context.addIssue({ code: "custom", message: "同时最多只能有一个进行中的计划步骤" });
    }
  });

export type PlanUpdateInput = z.infer<typeof planUpdateSchema>;

export function isComplexTask(input: string): boolean {
  const normalized = input.trim();
  if (normalized.length >= 80) return true;
  if (normalized.split(/\r?\n/).filter(Boolean).length >= 3) return true;
  return /(完整实现|开发|重构|迁移|修复|调试|多个文件|测试|构建|发布|部署|新增.+(?:并|和|、)|先.+再)/i.test(
    normalized,
  );
}

export function parsePlanUpdate(argumentsJson: string): PlanUpdateInput {
  let raw: unknown;
  try {
    raw = JSON.parse(argumentsJson || "{}");
  } catch {
    throw new HammerCodeError("计划参数不是有效 JSON", "INVALID_PLAN", true);
  }
  const parsed = planUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HammerCodeError(
      `计划校验失败：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
      "INVALID_PLAN",
      true,
    );
  }
  return parsed.data;
}

function cloneSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((step) => ({ ...step }));
}

export function applyPlanUpdate(
  turn: AgentTurn,
  input: PlanUpdateInput,
  ids: IdGenerator,
  now: string,
): { plan: TurnPlan; checkpoint: PlanCheckpoint } {
  const previous = turn.plan;
  if (previous) {
    const nextById = new Map(input.steps.map((step) => [step.id, step]));
    for (const step of previous.steps) {
      if (step.status === "completed" && nextById.get(step.id)?.status !== "completed") {
        throw new HammerCodeError(
          `已完成的计划步骤不能回退或删除：${step.title}`,
          "PLAN_STATUS_REGRESSION",
          true,
        );
      }
    }
  }
  const revision = (previous?.revision ?? 0) + 1;
  const steps = cloneSteps(input.steps);
  const plan: TurnPlan = {
    revision,
    explanation: input.explanation,
    steps,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  const checkpoint: PlanCheckpoint = {
    id: ids.next("checkpoint"),
    revision,
    explanation: input.explanation,
    steps: cloneSteps(steps),
    round: turn.metrics?.roundsUsed ?? 0,
    toolCalls: turn.metrics?.toolCalls ?? 0,
    createdAt: now,
  };
  turn.plan = plan;
  turn.planCheckpoints = [...(turn.planCheckpoints ?? []), checkpoint];
  return { plan, checkpoint };
}

export function requiresPlanBeforeTool(toolName: string): boolean {
  return ["write_file", "edit_file", "delete_file", "run_command", "run_python"].includes(toolName);
}
