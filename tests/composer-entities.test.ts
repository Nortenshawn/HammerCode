import { describe, expect, it } from "vitest";
import { appendComposerEntity, serializeComposerTask, skillComposerEntity, workspaceComposerEntity } from "../src/renderer/src/composer-entities";

describe("composer entities", () => {
  it("keeps workspace and Skill references as atomic entities while serializing model-compatible markers", () => {
    const file = workspaceComposerEntity({ path: "docs/design notes.md", name: "design notes.md", kind: "file" });
    const skill = skillComposerEntity({
      key: "builtin:pdf-review",
      id: "pdf-review",
      name: "PDF review",
      version: "1.0.0",
      description: "Review PDF files",
      when: "Review PDF files",
      license: "MIT",
      compatibility: "HammerCode",
      compatibilityStatus: "compatible",
      compatibilityIssues: [],
      source: "builtin",
      scope: "application",
      enabled: true,
      trusted: true,
      valid: true,
      issues: [],
      trustInvalidated: false,
      packageFingerprint: "a".repeat(64),
      capabilities: { tools: [], scripts: [] },
    });
    const entities = appendComposerEntity(appendComposerEntity([], file), skill);
    expect(appendComposerEntity(entities, file)).toBe(entities);
    expect(serializeComposerTask("请分析", entities)).toBe('@"docs/design notes.md" $pdf-review\n\n请分析');
  });

  it("supports entity-only turns", () => {
    const folder = workspaceComposerEntity({ path: "src", name: "src", kind: "directory" });
    expect(serializeComposerTask("  ", [folder])).toBe("@src");
  });
});
