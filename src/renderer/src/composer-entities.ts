import type { PublicSkill, WorkspaceEntry } from "../../shared/contracts";
import { formatWorkspaceMention } from "./composer-tokens";

export type ComposerEntity =
  | {
      key: string;
      kind: "file" | "directory";
      label: string;
      detail: string;
      value: string;
      serialized: string;
    }
  | {
      key: string;
      kind: "skill";
      label: string;
      detail: string;
      value: string;
      serialized: string;
    };

export function workspaceComposerEntity(entry: WorkspaceEntry): ComposerEntity {
  return {
    key: `workspace:${entry.path}`,
    kind: entry.kind,
    label: entry.name,
    detail: entry.path,
    value: entry.path,
    serialized: formatWorkspaceMention(entry.path),
  };
}

export function skillComposerEntity(skill: PublicSkill): ComposerEntity {
  return {
    key: `skill:${skill.key}`,
    kind: "skill",
    label: skill.id,
    detail: skill.description,
    value: skill.key,
    serialized: `$${skill.id}`,
  };
}

export function appendComposerEntity(items: ComposerEntity[], entity: ComposerEntity): ComposerEntity[] {
  return items.some((item) => item.key === entity.key) ? items : [...items, entity];
}

export function serializeComposerTask(text: string, entities: ComposerEntity[]): string {
  const references = entities.map((entity) => entity.serialized).join(" ");
  const body = text.trim();
  if (!references) return body;
  return body ? `${references}\n\n${body}` : references;
}
