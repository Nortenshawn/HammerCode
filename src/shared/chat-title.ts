const TITLE_LIMIT = 28;

export function sanitizeChatTitle(value: string): string {
  const firstLine = value
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/, 1)[0] ?? "";
  const cleaned = firstLine
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/^\s*[#>*`'\"“”‘’\-–—]+|[#>*`'\"“”‘’\-–—]+\s*$/g, "")
    .replace(/^\s*(?:标题|title)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, TITLE_LIMIT).join("").trim();
}

export function fallbackChatTitle(value: string): string {
  return sanitizeChatTitle(value) || "未命名对话";
}
