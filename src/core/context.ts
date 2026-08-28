import type { AgentSession, ConversationMessage, ToolMessage } from "../shared/contracts";
import type { ModelMessage } from "./types";
import { HammerCodeError } from "./types";

const SUMMARY_LIMIT = 12_000;
const FACTS_LIMIT = 6_000;

export interface ContextFacts {
  originalTask: string;
  recentConstraints: string[];
  appliedChanges: string[];
  verificationResults: string[];
  unresolvedErrors: string[];
  currentPlan: string[];
}

export function estimateTokens(value: string): number {
  if (!value) return 0;
  const ascii = (value.match(/[\x00-\x7F]/g) ?? []).length;
  const nonAscii = value.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(JSON.stringify(message)) + 12,
    0,
  );
}

function toModelMessage(message: ConversationMessage): ModelMessage {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  return {
    role: "assistant",
    content: message.content || null,
    reasoning_content: message.reasoningContent,
    tool_calls: message.toolCalls?.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

function summarizeRemoved(messages: ConversationMessage[]): string {
  const lines = [
    "以下内容是 HammerCode 对较早历史的本地压缩摘要，不代表新增事实：",
  ];
  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`- 用户消息：${message.content.slice(0, 1_000)}`);
    } else if (message.role === "assistant") {
      if (message.content) lines.push(`- 助手结论：${message.content.slice(0, 800)}`);
      for (const call of message.toolCalls ?? []) {
        lines.push(`- 已提出工具调用 ${call.name}（id: ${call.id}）`);
      }
    } else {
      lines.push(
        `- 工具 ${message.toolName}（id: ${message.toolCallId}）结果：${message.content.slice(0, 1_000)}`,
      );
    }
    if (lines.join("\n").length >= SUMMARY_LIMIT) break;
  }
  return lines.join("\n").slice(0, SUMMARY_LIMIT);
}

export function buildContextFacts(session: AgentSession): ContextFacts {
  const userMessages = session.messages.filter((message) => message.role === "user");
  const latestVerificationMessages = session.messages
    .filter(
      (message): message is ToolMessage =>
        message.role === "tool" &&
        ["run_command", "git_status", "git_diff"].includes(message.toolName),
    )
    .slice(-8)
    .map((message) => {
      try {
        const parsed = JSON.parse(message.content) as { summary?: unknown; output?: unknown; ok?: unknown };
        const output = typeof parsed.output === "string" ? ` · ${parsed.output.slice(0, 400)}` : "";
        return `${message.toolName}: ${parsed.ok === true ? "成功" : "未成功"} · ${String(parsed.summary ?? "无摘要")}${output}`;
      } catch {
        return `${message.toolName}: ${message.content.slice(0, 300)}`;
      }
    });
  const activeTurn = session.turns.find((turn) => turn.id === session.activeTurnId);
  const planTurn = activeTurn?.plan
    ? activeTurn
    : [...session.turns].reverse().find((turn) => turn.plan);
  return {
    originalTask: session.task.slice(0, 2_000),
    recentConstraints: userMessages.slice(-3).map((message) => message.content.slice(0, 1_000)),
    appliedChanges: session.fileChanges
      .filter((change) => change.status === "applied")
      .slice(-20)
      .map((change) => `${change.kind} ${change.path}（after hash: ${change.afterHash ?? "deleted"}）`),
    verificationResults: latestVerificationMessages,
    unresolvedErrors: session.turns
      .filter((turn) => turn.error)
      .slice(-5)
      .map((turn) => `${turn.terminationReason ?? "error"}: ${turn.error!.slice(0, 500)}`),
    currentPlan: planTurn?.plan?.steps.map((step) => `[${step.status}] ${step.title}`) ?? [],
  };
}

function renderFacts(facts: ContextFacts | undefined): string {
  if (!facts) return "";
  const lines = [
    "以下是从持久化会话状态提取的优先事实，只用于防止历史压缩丢失关键约束：",
    `- 原始任务：${facts.originalTask}`,
  ];
  for (const item of facts.recentConstraints) lines.push(`- 近期用户约束：${item}`);
  for (const item of facts.appliedChanges) lines.push(`- 已落盘变更：${item}`);
  for (const item of facts.verificationResults) lines.push(`- 工具/验证记录：${item}`);
  for (const item of facts.unresolvedErrors) lines.push(`- 历史失败：${item}`);
  for (const item of facts.currentPlan) lines.push(`- 当前计划：${item}`);
  return lines.join("\n").slice(0, FACTS_LIMIT);
}

function groupProtocolMessages(messages: ConversationMessage[]): ConversationMessage[][] {
  const groups: ConversationMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.toolCalls?.length) {
      const ids = new Set(message.toolCalls.map((call) => call.id));
      const group: ConversationMessage[] = [message];
      while (index + 1 < messages.length) {
        const next = messages[index + 1];
        if (next.role !== "tool" || !ids.has(next.toolCallId)) break;
        group.push(next);
        index += 1;
      }
      groups.push(group);
    } else {
      groups.push([message]);
    }
  }
  return groups;
}

export interface ContextBuildResult {
  messages: ModelMessage[];
  estimatedTokens: number;
  compacted: boolean;
}

export function buildModelContext(
  systemPrompt: string,
  history: ConversationMessage[],
  tokenBudget: number,
  facts?: ContextFacts,
): ContextBuildResult {
  const system: ModelMessage = { role: "system", content: systemPrompt };
  const full = [system, ...history.map(toModelMessage)];
  const fullEstimate = estimateMessageTokens(full);
  if (fullEstimate <= tokenBudget) {
    return { messages: full, estimatedTokens: fullEstimate, compacted: false };
  }

  const firstUserIndex = history.findIndex((message) => message.role === "user");
  const firstUser = firstUserIndex >= 0 ? history[firstUserIndex] : undefined;
  const candidates = history.filter((message) => message !== firstUser);
  const groups = groupProtocolMessages(candidates);
  let keptGroupStart = groups.length;
  let keptGroups: ConversationMessage[][] = [];
  const reserve = Math.max(1_000, Math.floor(tokenBudget * 0.7));

  while (keptGroupStart > 0) {
    const candidate = groups[keptGroupStart - 1];
    const next = [candidate, ...keptGroups];
    if (estimateMessageTokens(next.flat().map(toModelMessage)) > reserve) break;
    keptGroups = next;
    keptGroupStart -= 1;
  }

  const kept = [...(firstUser ? [firstUser] : []), ...keptGroups.flat()];
  const removed = groups.slice(0, keptGroupStart).flat();
  const priorityFacts = renderFacts(facts);
  let summaryText = [priorityFacts, summarizeRemoved(removed)].filter(Boolean).join("\n\n");
  let summary: ModelMessage = { role: "system", content: summaryText };
  let compacted = [system, summary, ...kept.map(toModelMessage)];
  let estimate = estimateMessageTokens(compacted);
  while (estimate > tokenBudget && summaryText.length > 240) {
    summaryText = `${summaryText.slice(0, Math.floor(summaryText.length * 0.7))}\n…（摘要已按上下文预算截断）`;
    summary = { role: "system", content: summaryText };
    compacted = [system, summary, ...kept.map(toModelMessage)];
    estimate = estimateMessageTokens(compacted);
  }
  if (estimate > tokenBudget) {
    throw new HammerCodeError(
      `上下文在压缩后仍超过预算（约 ${estimate}/${tokenBudget} tokens）`,
      "CONTEXT_OVERFLOW",
    );
  }
  return { messages: compacted, estimatedTokens: estimate, compacted: true };
}
