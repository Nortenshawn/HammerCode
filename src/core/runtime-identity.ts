import type { ModelTier, PermissionMode } from "../shared/contracts";
import { PRODUCT_IDENTITY_PROMPT } from "./system-prompt";

export interface RuntimeIdentityContext {
  modelTier?: ModelTier;
  modelName?: string;
  permissionMode?: PermissionMode;
  workspaceRoot?: string;
  workspaceAccess?: "bound" | "none";
  round?: number;
  maxRounds?: number;
  toolCallsUsed?: number;
  maxToolCalls?: number;
  elapsedRunTimeMs?: number;
  maxRunTimeMs?: number;
  maxOutputTokensPerRequest?: number;
  contextTokenBudget?: number;
  toolNames?: readonly string[];
}

function safeInline(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function knownInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value! >= 0;
}

function engineLine(context: RuntimeIdentityContext): string {
  const tier = context.modelTier === "fast"
    ? "Fast"
    : context.modelTier === "strong"
      ? "Strong"
      : "未知档位";
  const model = safeInline(context.modelName, 160) ?? "未知模型名（本轮未提供，不得猜测）";
  return `本轮引擎：${tier} · ${model}。对外身份始终是 HammerCode，模型仅负责本轮推理。`;
}

function permissionLine(mode: PermissionMode | undefined): string {
  if (mode === "ask") {
    return "权限：请求批准。只读和明确安全的工具可直接执行；写入、删除与一般命令需要批准，硬安全边界始终不可绕过。";
  }
  if (mode === "full_access") {
    return "权限：完全访问。工作区内普通操作可自动执行；远端状态修改仍需批准，硬安全边界始终不可绕过。";
  }
  return "权限：未知（本轮未提供，不得猜测操作会否自动执行）。";
}

function workspaceLine(context: RuntimeIdentityContext): string {
  const root = safeInline(context.workspaceRoot, 2_000);
  if (!root) return "绑定工作区：未知（本轮未提供，不得猜测或声称能访问任何路径）。";
  if (context.workspaceAccess === "none") {
    return `关联工作区：${root}。本次请求没有文件访问能力，不能读取工作区内外文件。`;
  }
  if (context.workspaceAccess !== "bound") {
    return `绑定工作区：${root}；访问能力未知（本轮未提供，不得猜测）。`;
  }
  return `绑定工作区：${root}。只能访问该工作区，工作区外文件不可用。`;
}

function roundBudget(context: RuntimeIdentityContext): string {
  if (!knownInteger(context.round) || !knownInteger(context.maxRounds) || context.round < 1 || context.maxRounds < 1) {
    return "轮次未知";
  }
  return `轮次 ${context.round}/${context.maxRounds}（本次之后最多 ${Math.max(0, context.maxRounds - context.round)} 轮）`;
}

function toolBudget(context: RuntimeIdentityContext): string {
  if (!knownInteger(context.toolCallsUsed) || !knownInteger(context.maxToolCalls) || context.maxToolCalls < 1) {
    return "工具次数未知";
  }
  return `工具 ${context.toolCallsUsed}/${context.maxToolCalls}（剩余 ${Math.max(0, context.maxToolCalls - context.toolCallsUsed)} 次）`;
}

function timeBudget(context: RuntimeIdentityContext): string {
  if (!knownInteger(context.elapsedRunTimeMs) || !knownInteger(context.maxRunTimeMs) || context.maxRunTimeMs < 1) {
    return "运行时间未知";
  }
  const elapsedSeconds = Math.floor(context.elapsedRunTimeMs / 1_000);
  const maxSeconds = Math.ceil(context.maxRunTimeMs / 1_000);
  const remainingSeconds = Math.max(0, Math.ceil((context.maxRunTimeMs - context.elapsedRunTimeMs) / 1_000));
  return `时间 ${elapsedSeconds}/${maxSeconds} 秒（剩余至多 ${remainingSeconds} 秒）`;
}

function tokenBudgets(context: RuntimeIdentityContext): string {
  const output = knownInteger(context.maxOutputTokensPerRequest) && context.maxOutputTokensPerRequest > 0
    ? String(context.maxOutputTokensPerRequest)
    : "未知";
  const contextBudget = knownInteger(context.contextTokenBudget) && context.contextTokenBudget > 0
    ? String(context.contextTokenBudget)
    : "未知";
  return `单次输出上限 ${output} tokens；上下文预算 ${contextBudget} tokens`;
}

function toolLine(toolNames: readonly string[] | undefined): string {
  if (!toolNames) return "实际工具：未知（本次请求未提供能力清单，不得猜测）。";
  const names = [...new Set(toolNames.map((name) => safeInline(name, 100)).filter((name): name is string => Boolean(name)))];
  return names.length > 0
    ? `实际工具：${names.join("、")}。只能使用这份清单中的工具。`
    : "实际工具：无。本次请求没有提供可调用工具。";
}

export function renderRuntimeIdentityContext(context: RuntimeIdentityContext): string {
  return [
    "<runtime_context>",
    engineLine(context),
    permissionLine(context.permissionMode),
    workspaceLine(context),
    `预算：${roundBudget(context)}；${toolBudget(context)}；${timeBudget(context)}；${tokenBudgets(context)}。`,
    toolLine(context.toolNames),
    "事实优先级：当前用户要求高于项目记忆和 Skill；真实磁盘与本轮工具结果高于历史摘要。不得声称看到未提供的凭据、环境变量或运行状态。",
    "</runtime_context>",
  ].join("\n");
}

export function systemPromptWithRuntimeIdentity(
  basePrompt: string,
  context: RuntimeIdentityContext,
): string {
  return [
    basePrompt.includes("<product_identity>") ? "" : PRODUCT_IDENTITY_PROMPT,
    basePrompt,
    renderRuntimeIdentityContext(context),
  ].filter(Boolean).join("\n\n");
}
