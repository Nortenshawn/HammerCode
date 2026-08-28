import { describe, expect, it } from "vitest";
import { fallbackChatTitle, generateChatTitle, sanitizeChatTitle } from "../src/core/chat-title";
import type { ModelClient } from "../src/core/types";

describe("chat title generation", () => {
  it("removes markdown, labels and emoji while keeping one compact line", () => {
    expect(sanitizeChatTitle("## 标题：修复侧栏拖动问题 🚀\n第二行")).toBe("修复侧栏拖动问题");
    expect(fallbackChatTitle("实现一个特别特别特别特别特别特别特别特别长的任务名称\n详情").length).toBeLessThanOrEqual(28);
  });

  it("uses a text-only model request with no tools", async () => {
    let toolCount = -1;
    const model: ModelClient = {
      async *stream(request) {
        toolCount = request.tools.length;
        yield { content: "修复 BTW 布局 ✨", finishReason: "stop" };
      },
    };
    await expect(generateChatTitle(model, "task", "done", new AbortController().signal))
      .resolves.toBe("修复 BTW 布局");
    expect(toolCount).toBe(0);
  });
});
