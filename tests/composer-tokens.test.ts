import { describe, expect, it } from "vitest";
import {
  detectComposerToken,
  formatWorkspaceMention,
  replaceComposerToken,
} from "../src/renderer/src/composer-tokens";

describe("composer command and mention tokens", () => {
  it("detects slash commands only at the start or after whitespace", () => {
    expect(detectComposerToken("/模", 2)).toMatchObject({ kind: "slash", query: "模", start: 0 });
    expect(detectComposerToken("先看看\n/压缩", 7)).toMatchObject({ kind: "slash", query: "压缩", start: 4 });
    expect(detectComposerToken("https://example.com", 8)).toBeNull();
    expect(detectComposerToken("路径/a", 3)).toBeNull();
  });

  it("detects and replaces workspace mentions without damaging surrounding text", () => {
    const value = "请读取 @src/comp 后继续";
    const token = detectComposerToken(value, "请读取 @src/comp".length);
    expect(token).toMatchObject({ kind: "mention", query: "src/comp" });
    expect(replaceComposerToken(value, token!, "@src/components/ ")).toBe("请读取 @src/components/  后继续");
    expect(formatWorkspaceMention("docs/design notes.md")).toBe('@"docs/design notes.md"');
    expect(formatWorkspaceMention("src/main.ts")).toBe("@src/main.ts");
  });

  it("honors an explicitly dismissed palette cursor", () => {
    expect(detectComposerToken("/模型", -1)).toBeNull();
  });

  it("detects Skill mentions after whitespace", () => {
    expect(detectComposerToken("$pdf", 4)).toMatchObject({ kind: "skill", query: "pdf", start: 0 });
    expect(detectComposerToken("请分析 $test", 10)).toMatchObject({ kind: "skill", query: "test" });
    expect(detectComposerToken("price$usd", 9)).toBeNull();
  });
});
