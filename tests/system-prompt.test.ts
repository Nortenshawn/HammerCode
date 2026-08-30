import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT, PRODUCT_IDENTITY_PROMPT } from "../src/core/system-prompt";

describe("default response style", () => {
  it("defines a non-personified HammerCode product identity", () => {
    expect(PRODUCT_IDENTITY_PROMPT).toContain("你是 HammerCode，一个本地编程智能体");
    expect(PRODUCT_IDENTITY_PROMPT).toContain("模型只是在本轮提供推理的引擎");
    expect(PRODUCT_IDENTITY_PROMPT).toContain("不具有人类意识或情感");
    expect(DEFAULT_SYSTEM_PROMPT.split("<product_identity>")).toHaveLength(2);
  });

  it("prefers natural paragraphs and reserves lists for real structure", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("最终回答默认使用简洁、连贯的自然段");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("短回答不要机械拆成“一、二、三”");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("短总结通常不需要标题");
  });
});
