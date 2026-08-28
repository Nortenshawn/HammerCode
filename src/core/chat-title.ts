import type { ModelClient } from "./types";
import { HammerCodeError } from "./types";
import { sanitizeChatTitle } from "../shared/chat-title";

export { fallbackChatTitle, sanitizeChatTitle } from "../shared/chat-title";

export async function generateChatTitle(
  model: ModelClient,
  task: string,
  finalAnswer: string,
  signal: AbortSignal,
): Promise<string> {
  const prompt = [
    "请为下面这条编程聊天生成一个简洁中文小标题。",
    "要求：只输出标题；不使用 Emoji、引号、Markdown、状态词或轮次信息；不超过 24 个汉字。",
    "用户任务：",
    task.slice(0, 4_000),
    finalAnswer ? `最终结果：\n${finalAnswer.slice(0, 3_000)}` : "",
  ].filter(Boolean).join("\n\n");
  let content = "";
  for await (const chunk of model.stream({
    messages: [
      { role: "system", content: "你只负责生成准确、克制、无 Emoji 的聊天列表标题。" },
      { role: "user", content: prompt },
    ],
    tools: [],
    signal,
  })) {
    if (chunk.toolCallDeltas?.length) {
      throw new HammerCodeError("标题模型返回了意外工具调用", "TITLE_TOOL_CALL");
    }
    if (chunk.content) content += chunk.content;
    if (chunk.finishReason === "content_filter") {
      throw new HammerCodeError("标题生成被内容策略终止", "TITLE_CONTENT_FILTER", true);
    }
    if (chunk.finishReason === "insufficient_system_resource") {
      throw new HammerCodeError("标题生成暂时资源不足", "TITLE_RESOURCE_EXHAUSTED", true);
    }
  }
  const title = sanitizeChatTitle(content);
  if (!title) throw new HammerCodeError("标题模型没有返回可用文本", "TITLE_EMPTY", true);
  return title;
}
