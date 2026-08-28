export type ComposerCommandId = "side_chat" | "models" | "compress";

export interface ComposerCommandDefinition {
  id: ComposerCommandId;
  label: string;
  keywords: string[];
}

export const COMPOSER_COMMANDS: readonly ComposerCommandDefinition[] = [
  { id: "side_chat", label: "侧边聊天", keywords: ["btw", "临时聊天"] },
  { id: "models", label: "模型", keywords: ["api", "fast", "strong"] },
  { id: "compress", label: "压缩上下文", keywords: ["压缩", "上下文", "记忆"] },
];

export function filterComposerCommands(query: string): readonly ComposerCommandDefinition[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return COMPOSER_COMMANDS;
  return COMPOSER_COMMANDS.filter((command) =>
    [command.label, ...command.keywords]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized),
  );
}
