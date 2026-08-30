import type { PublicSkill, WorkspaceEntry } from "../../shared/contracts";
import { COMPOSER_COMMANDS } from "./composer-commands";

export const COMPOSER_ADD_SECTION_ORDER = ["commands", "workspace", "skills"] as const;
export const COMPOSER_ADD_WORKSPACE_LIMIT = 5;

export function buildComposerAddMenu(
  entries: WorkspaceEntry[],
  skills: PublicSkill[],
) {
  return {
    sectionOrder: COMPOSER_ADD_SECTION_ORDER,
    commands: COMPOSER_COMMANDS,
    workspaceEntries: entries.slice(0, COMPOSER_ADD_WORKSPACE_LIMIT),
    skills: skills.filter((skill) => skill.valid && skill.enabled && skill.trusted),
  };
}
