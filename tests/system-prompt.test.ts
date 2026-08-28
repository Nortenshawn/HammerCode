import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../src/core/system-prompt";

describe("default response style", () => {
  it("prefers natural paragraphs and reserves lists for real structure", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("最终回答默认使用简洁、连贯的自然段");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("短回答不要机械拆成“一、二、三”");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("短总结通常不需要标题");
  });
});
