import type { AgentSession, FileChange } from "../shared/contracts";
import { readWorkspaceTextState } from "./file-state";
import { WorkspaceBoundary } from "./security/path-boundary";
import { LocalToolExecutor } from "./tools/tool-executor";
import type { IdGenerator, PreparedToolCall } from "./types";
import { HammerCodeError } from "./types";

export interface PreparedUndo {
  change: FileChange;
  prepared: PreparedToolCall;
}

export async function prepareFileUndo(
  session: AgentSession,
  changeId: string,
  boundary: WorkspaceBoundary,
  ids: IdGenerator,
  now: Date,
): Promise<PreparedUndo> {
  const change = session.fileChanges.find((item) => item.id === changeId);
  if (!change || change.status !== "applied") {
    throw new HammerCodeError("该文件修改已不可撤销", "CHANGE_NOT_UNDOABLE", true);
  }
  const latestForPath = [...session.fileChanges]
    .reverse()
    .find((item) => item.path === change.path && item.status === "applied");
  if (latestForPath?.id !== change.id) {
    throw new HammerCodeError("必须先撤销该文件更新的修改", "UNDO_ORDER_CONFLICT", true);
  }
  const current = await readWorkspaceTextState(boundary, change.path);
  if (current.hash !== change.afterHash) {
    throw new HammerCodeError("文件在修改后又发生了变化，拒绝覆盖", "UNDO_STALE", true);
  }

  const tools = new LocalToolExecutor(boundary, ids);
  const call = change.beforeContent === null
    ? { id: ids.next("undo_call"), name: "delete_file", arguments: JSON.stringify({ path: change.path }) }
    : { id: ids.next("undo_call"), name: "write_file", arguments: JSON.stringify({ path: change.path, content: change.beforeContent }) };
  const prepared = await tools.prepare(call, now);
  if (!prepared.approvalRequest || !prepared.fileMutation) {
    throw new HammerCodeError("无法生成撤销审批", "UNDO_PREPARE_FAILED");
  }
  if (prepared.fileMutation.beforeHash !== change.afterHash || prepared.fileMutation.afterHash !== change.beforeHash) {
    throw new HammerCodeError("撤销前文件状态校验失败", "UNDO_STALE", true);
  }
  prepared.approvalRequest.title = "撤销文件修改";
  prepared.approvalRequest.description = `将 ${change.path} 恢复到本次修改之前`;
  prepared.approvalRequest.operation = "undo";
  prepared.approvalRequest.turnId = session.activeTurnId;
  return { change, prepared };
}
