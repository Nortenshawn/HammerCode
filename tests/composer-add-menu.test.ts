import { describe, expect, it } from "vitest";
import type { PublicSkill, WorkspaceEntry } from "../src/shared/contracts";
import {
  buildComposerAddMenu,
  COMPOSER_ADD_SECTION_ORDER,
  COMPOSER_ADD_WORKSPACE_LIMIT,
} from "../src/renderer/src/composer-add-menu";

function skill(id: string, overrides: Partial<PublicSkill> = {}): PublicSkill {
  return {
    key: `builtin:${id}`,
    id,
    name: id,
    version: "1.0.0",
    description: `${id} description`,
    when: `${id} description`,
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
    ...overrides,
  };
}

describe("composer add menu", () => {
  it("keeps the slash, workspace and Skill sections in a stable order", () => {
    expect(COMPOSER_ADD_SECTION_ORDER).toEqual(["commands", "workspace", "skills"]);
    expect(buildComposerAddMenu([], []).sectionOrder).toEqual(["commands", "workspace", "skills"]);
  });

  it("limits file previews and only exposes usable Skills", () => {
    const entries: WorkspaceEntry[] = Array.from({ length: 9 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      name: `file-${index}.ts`,
      kind: "file",
    }));
    const menu = buildComposerAddMenu(entries, [
      skill("ready"),
      skill("disabled", { enabled: false }),
      skill("untrusted", { trusted: false }),
      skill("invalid", { valid: false }),
    ]);

    expect(menu.workspaceEntries).toHaveLength(COMPOSER_ADD_WORKSPACE_LIMIT);
    expect(menu.workspaceEntries.at(-1)?.path).toBe("src/file-4.ts");
    expect(menu.skills.map((item) => item.id)).toEqual(["ready"]);
  });
});
