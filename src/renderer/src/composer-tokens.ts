export interface ComposerToken {
  kind: "slash" | "mention" | "skill";
  query: string;
  start: number;
  end: number;
}

export function detectComposerToken(value: string, cursor: number): ComposerToken | null {
  if (cursor < 0) return null;
  const prefix = value.slice(0, cursor);
  const match = /(^|\s)(\/[^\s\/@$]*|@[^\s@$]*|\$[^\s$\/@]*)$/.exec(prefix);
  if (!match) return null;
  const token = match[2];
  return {
    kind: token.startsWith("/") ? "slash" : token.startsWith("@") ? "mention" : "skill",
    query: token.slice(1),
    start: match.index + match[1].length,
    end: cursor,
  };
}

export function replaceComposerToken(value: string, token: ComposerToken, replacement: string): string {
  return `${value.slice(0, token.start)}${replacement}${value.slice(token.end)}`;
}

export function formatWorkspaceMention(path: string): string {
  return /\s/.test(path) ? `@"${path.replaceAll('"', '\\"')}"` : `@${path}`;
}
