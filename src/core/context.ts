import type { ConversationMessage } from "../shared/contracts";
import type { ModelMessage } from "./types";
import { HammerCodeError } from "./types";

const SUMMARY_LIMIT = 12_000;

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
  let summaryText = summarizeRemoved(removed);
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
