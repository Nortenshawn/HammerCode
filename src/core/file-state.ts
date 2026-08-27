import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { AgentSession, FileChange } from "../shared/contracts";
import { WorkspaceBoundary } from "./security/path-boundary";
import { HammerCodeError } from "./types";

export const MAX_REVERSIBLE_FILE_BYTES = 1_000_000;

export function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readWorkspaceTextState(
  boundary: WorkspaceBoundary,
  relativePath: string,
): Promise<{ content: string | null; hash: string | null }> {
  const target = await boundary.resolveForWrite(relativePath);
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new HammerCodeError("目标不是普通文件", "NOT_A_FILE", true);
    if (info.size > MAX_REVERSIBLE_FILE_BYTES) {
      throw new HammerCodeError("文件超过可安全撤销的大小限制", "FILE_TOO_LARGE", true);
    }
    const buffer = await readFile(target);
    if (buffer.includes(0)) {
      throw new HammerCodeError("二进制文件暂不支持安全撤销", "BINARY_FILE_UNDO_UNSUPPORTED", true);
    }
    const content = buffer.toString("utf8");
    return { content, hash: hashText(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: null, hash: null };
    throw error;
  }
}

export async function reconcilePendingUndo(
  session: AgentSession,
  boundary: WorkspaceBoundary,
  now: string,
): Promise<"none" | "cancelled" | "reverted" | "not_applied" | "stale"> {
  const pending = session.pendingUndo;
  if (!pending) return "none";
  const change = session.fileChanges.find((item) => item.id === pending.changeId);
  session.pendingApproval = undefined;
  session.pendingUndo = undefined;
  if (!change || change.status === "reverted") return "cancelled";
  if (pending.status === "awaiting_approval") return "cancelled";

  const current = await readWorkspaceTextState(boundary, change.path);
  if (current.hash === change.beforeHash) {
    change.status = "reverted";
    change.revertedAt = now;
    return "reverted";
  }
  if (current.hash === change.afterHash) return "not_applied";
  return "stale";
}
