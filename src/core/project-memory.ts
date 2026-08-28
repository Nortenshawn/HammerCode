import { z } from "zod";
import type { ProjectMemoryRecall } from "../shared/contracts";
import type { ModelToolDefinition } from "./types";
import { HammerCodeError } from "./types";

export const PROJECT_MEMORY_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_project_memory",
      description: "检索当前工作区跨聊天共享的项目记忆。只返回带来源和可信度的相关记录；冲突或失效信息不会被伪装成确定事实。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 1000 },
          max_records: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_project",
      description: "把对后续聊天长期有用的事实、决策或约束写入当前项目记忆。该内容会明确标记为模型推断；验证结果只能由真实工具自动写入，不要用此工具伪造。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["fact", "decision", "constraint"] },
          subject: { type: "string", minLength: 1, maxLength: 240 },
          statement: { type: "string", minLength: 1, maxLength: 4000 },
          expires_at: { type: "string", description: "可选 ISO 8601 失效时间" },
        },
        required: ["kind", "subject", "statement"],
        additionalProperties: false,
      },
    },
  },
];

const searchSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  max_records: z.number().int().min(1).max(20).default(12),
}).strict();

const rememberSchema = z.object({
  kind: z.enum(["fact", "decision", "constraint"]),
  subject: z.string().trim().min(1).max(240),
  statement: z.string().trim().min(1).max(4_000),
  expires_at: z.string().datetime({ offset: true }).optional(),
}).strict();

function parseJson(argumentsText: string): unknown {
  if (Buffer.byteLength(argumentsText, "utf8") > 20_000) {
    throw new HammerCodeError("项目记忆工具参数超过大小限制", "MEMORY_ARGUMENTS_TOO_LARGE", true);
  }
  try {
    return JSON.parse(argumentsText || "{}");
  } catch {
    throw new HammerCodeError("项目记忆工具参数不是有效 JSON", "INVALID_MEMORY_ARGUMENTS", true);
  }
}

export function parseProjectMemorySearch(argumentsText: string): z.output<typeof searchSchema> {
  const parsed = searchSchema.safeParse(parseJson(argumentsText));
  if (!parsed.success) {
    throw new HammerCodeError("项目记忆检索参数无效", "INVALID_MEMORY_ARGUMENTS", true);
  }
  return parsed.data;
}

export function parseProjectMemoryWrite(argumentsText: string): z.output<typeof rememberSchema> {
  const parsed = rememberSchema.safeParse(parseJson(argumentsText));
  if (!parsed.success) {
    throw new HammerCodeError("项目记忆写入参数无效", "INVALID_MEMORY_ARGUMENTS", true);
  }
  return parsed.data;
}

export function projectMemoryToolOutput(recall: ProjectMemoryRecall): string {
  return recall.rendered || "没有匹配的活动项目记忆";
}
