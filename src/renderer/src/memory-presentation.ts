import type {
  ArchivedWorkspaceSummary,
  ProjectMemoryRecord,
  WorkspaceSummary,
} from "../../shared/contracts";

export function cleanMemorySourceLabel(record: ProjectMemoryRecord): string {
  const cleaned = record.source.label
    .replace(/\s*·\s*session[_-][a-z0-9-]+(?:\/turn[_-][a-z0-9-]+)?/gi, "")
    .replace(/\s*·\s*(?:tool|subtask)[_-][a-z0-9-]+/gi, "")
    .trim();
  if (cleaned) return cleaned;
  if (record.source.type === "tool") return `工具 ${record.source.toolName ?? "调用"}`;
  if (record.source.type === "user") return "用户确认";
  if (record.source.type === "subagent") return "子任务结果";
  return "模型推断";
}

export function memoryTitle(record: ProjectMemoryRecord): string {
  if (record.subject.startsWith("file:")) {
    const target = record.subject.slice("file:".length);
    const action = record.statement.startsWith("create ")
      ? "创建文件"
      : record.statement.startsWith("delete ")
        ? "删除文件"
        : "修改文件";
    return `${action} · ${target}`;
  }
  if (record.subject.startsWith("verification:")) {
    return record.source.toolName === "run_python" ? "Python 验证结果" : "命令验证结果";
  }
  const readable = record.subject.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^[\x00-\x7f ]+$/.test(readable) && /[\u3400-\u9fff]/.test(record.statement)) {
    const statementTitle = record.statement
      .split(/[。；\n]/, 1)[0]
      .replace(/^[A-Z0-9_]{3,}\s*[：:] ?\s*/, "")
      .trim();
    if (statementTitle) {
      const kind = record.kind === "decision" ? "项目决定" : record.kind === "constraint" ? "项目约束" : "项目事实";
      return `${kind} · ${statementTitle.slice(0, 34)}${statementTitle.length > 34 ? "…" : ""}`;
    }
  }
  return readable || (record.kind === "decision"
    ? "项目决定"
    : record.kind === "constraint"
      ? "项目约束"
      : "项目事实");
}

export function memoryDescription(record: ProjectMemoryRecord): string {
  if (record.subject.startsWith("file:")) {
    return "文件状态已经由本地工具核验；内容变化后，这条记忆会自动失效。";
  }
  const normalized = record.statement.replace(/\s+/g, " ").trim();
  return `${normalized.slice(0, 360)}${normalized.length > 360 ? "…" : ""}`;
}

export function memorySourceTitle(
  record: ProjectMemoryRecord,
  workspaces: WorkspaceSummary[],
  archivedWorkspaces: ArchivedWorkspaceSummary[],
): string {
  const sessionId = record.source.sessionId;
  const session = sessionId
    ? [...workspaces, ...archivedWorkspaces]
      .flatMap((workspace) => workspace.sessions)
      .find((item) => item.id === sessionId)
    : undefined;
  return session
    ? `${cleanMemorySourceLabel(record)} · ${session.title}`
    : cleanMemorySourceLabel(record);
}
