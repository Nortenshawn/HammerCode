import { z } from "zod";
import { SUBAGENT_MODES, SUBAGENT_ROLES } from "../shared/contracts";
import type { ModelToolDefinition, SubagentSpawnInput } from "./types";
import { HammerCodeError } from "./types";

const spawnSchema = z.object({
  tasks: z.array(z.object({
    role: z.enum(SUBAGENT_ROLES),
    mode: z.enum(SUBAGENT_MODES).default("read_only"),
    task: z.string().trim().min(1).max(20_000),
  }).strict()).min(1).max(3),
}).strict();

export const SUBAGENT_TOOL_DEFINITION: ModelToolDefinition = {
  type: "function",
  function: {
    name: "spawn_subagents",
    description: "并发启动 1–3 个隔离子 Agent 调查复杂任务。子 Agent 不能递归创建 Agent、不能运行通用命令、不能直接修改文件或远端状态；patch_proposal 仅生成不落盘的候选 diff。主 Agent 只接收带来源的结构化结论。",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: SUBAGENT_ROLES },
              mode: { type: "string", enum: SUBAGENT_MODES },
              task: { type: "string", description: "边界明确、可独立完成的调查或补丁提案任务" },
            },
            required: ["role", "task"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
};

export function parseSubagentSpawn(input: string): SubagentSpawnInput[] {
  let raw: unknown;
  try {
    raw = JSON.parse(input || "{}");
  } catch {
    throw new HammerCodeError("子 Agent 参数不是有效 JSON", "INVALID_SUBAGENT_ARGUMENTS", true);
  }
  const parsed = spawnSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HammerCodeError(
      `子 Agent 参数校验失败：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
      "INVALID_SUBAGENT_ARGUMENTS",
      true,
    );
  }
  return parsed.data.tasks;
}
