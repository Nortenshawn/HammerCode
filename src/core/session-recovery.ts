import type { AgentSession, ToolMessage, ToolResult } from "../shared/contracts";

function uniqueRecoveryMessageId(session: AgentSession, callId: string): string {
  const existing = new Set(session.messages.map((message) => message.id));
  const base = `recovery_${callId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);
  let candidate = base;
  let suffix = 1;
  while (existing.has(candidate)) candidate = `${base}_${suffix++}`;
  return candidate;
}

export function closeUnresolvedToolCalls(
  session: AgentSession,
  now: string,
  nextMessageId?: () => string,
): number {
  const resolved = new Set(
    session.messages
      .filter((message): message is ToolMessage => message.role === "tool")
      .map((message) => message.toolCallId),
  );
  const additions = new Map<string, ToolMessage[]>();

  for (const message of session.messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (resolved.has(call.id)) continue;
      const result: ToolResult = {
        ok: false,
        summary: "先前工具调用已中断",
        output: "该工具调用没有完整结果，HammerCode 已将其封口且不会自动重放。",
        errorCode: "TOOL_CALL_INTERRUPTED",
      };
      const toolMessage: ToolMessage = {
        id: nextMessageId?.() ?? uniqueRecoveryMessageId(session, call.id),
        turnId: message.turnId,
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify(result),
        createdAt: now,
      };
      const list = additions.get(message.id) ?? [];
      list.push(toolMessage);
      additions.set(message.id, list);
      resolved.add(call.id);

      const trace = session.toolTraces.find((item) => item.call.id === call.id);
      if (trace && !trace.result) {
        trace.status = "cancelled";
        trace.result = result;
        trace.finishedAt = now;
      }
    }
  }

  if (additions.size === 0) return 0;
  session.messages = session.messages.flatMap((message) => [message, ...(additions.get(message.id) ?? [])]);
  return [...additions.values()].reduce((total, messages) => total + messages.length, 0);
}
