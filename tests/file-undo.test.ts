import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashText, reconcilePendingUndo } from "../src/core/file-state";
import { prepareFileUndo } from "../src/core/file-undo";
import { WorkspaceBoundary } from "../src/core/security/path-boundary";
import type { AgentSession, FileChange } from "../src/shared/contracts";
import type { IdGenerator } from "../src/core/types";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

function sessionWithChanges(workspaceRoot: string, changes: FileChange[]): AgentSession {
  const at = "2026-08-28T00:00:00.000Z";
  return {
    id: "session_undo",
    workspaceRoot,
    status: "completed",
    task: "edit",
    turns: [{ id: "turn_1", userMessageId: "user_1", status: "completed", terminationReason: "completed", createdAt: at, updatedAt: at, finishedAt: at }],
    activeTurnId: "turn_1",
    messages: [
      { id: "user_1", turnId: "turn_1", role: "user", content: "edit", createdAt: at },
      { id: "assistant_1", turnId: "turn_1", role: "assistant", content: "done", createdAt: at },
    ],
    toolTraces: [],
    fileChanges: changes,
    transitions: [{ turnId: "turn_1", from: "requesting", to: "completed", reason: "done", at }],
    streamingText: "",
    streamingReasoning: "",
    terminationReason: "completed",
    createdAt: at,
    updatedAt: at,
  };
}

function change(id: string, before: string | null, after: string | null, appliedAt: string): FileChange {
  return {
    id,
    turnId: "turn_1",
    toolCallId: `call_${id}`,
    path: "a.txt",
    kind: before === null ? "create" : after === null ? "delete" : "modify",
    beforeContent: before,
    afterContent: after,
    beforeHash: before === null ? null : hashText(before),
    afterHash: after === null ? null : hashText(after),
    patch: "diff",
    status: "applied",
    appliedAt,
  };
}

describe("safe file undo", () => {
  it("previews and executes the inverse mutation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-undo-"));
    directories.push(workspace);
    await writeFile(path.join(workspace, "a.txt"), "after\n");
    const boundary = await WorkspaceBoundary.create(workspace);
    let counter = 0;
    const ids: IdGenerator = { next: (prefix) => `${prefix}_${counter++}` };
    const item = change("change_1", "before\n", "after\n", "2026-08-28T00:00:01.000Z");
    const session = sessionWithChanges(workspace, [item]);

    const undo = await prepareFileUndo(session, item.id, boundary, ids, new Date());
    expect(undo.prepared.approvalRequest).toMatchObject({ operation: "undo", title: "撤销文件修改" });
    expect(undo.prepared.approvalRequest?.details).toContain("-after");
    expect(undo.prepared.approvalRequest?.details).toContain("+before");
    const result = await undo.prepared.execute({
      signal: new AbortController().signal,
      approvals: { request: async () => true },
      now: () => new Date(),
    });
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("before\n");
  });

  it("rejects undo when the file changed after the recorded mutation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-undo-stale-"));
    directories.push(workspace);
    await writeFile(path.join(workspace, "a.txt"), "user changed\n");
    const boundary = await WorkspaceBoundary.create(workspace);
    const item = change("change_1", "before\n", "after\n", "2026-08-28T00:00:01.000Z");
    const session = sessionWithChanges(workspace, [item]);
    await expect(
      prepareFileUndo(session, item.id, boundary, { next: (prefix) => `${prefix}_1` }, new Date()),
    ).rejects.toMatchObject({ code: "UNDO_STALE" });
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("user changed\n");
  });

  it("requires reverse chronological undo for the same file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-undo-order-"));
    directories.push(workspace);
    await writeFile(path.join(workspace, "a.txt"), "three\n");
    const boundary = await WorkspaceBoundary.create(workspace);
    const first = change("change_1", "one\n", "two\n", "2026-08-28T00:00:01.000Z");
    const second = change("change_2", "two\n", "three\n", "2026-08-28T00:00:02.000Z");
    const session = sessionWithChanges(workspace, [first, second]);
    await expect(
      prepareFileUndo(session, first.id, boundary, { next: (prefix) => `${prefix}_1` }, new Date()),
    ).rejects.toMatchObject({ code: "UNDO_ORDER_CONFLICT" });
  });

  it("reconciles a crash after the inverse write without replaying it", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-undo-recover-"));
    directories.push(workspace);
    await writeFile(path.join(workspace, "a.txt"), "before\n");
    const boundary = await WorkspaceBoundary.create(workspace);
    const item = change("change_1", "before\n", "after\n", "2026-08-28T00:00:01.000Z");
    const session = sessionWithChanges(workspace, [item]);
    session.pendingUndo = { id: "undo_1", changeId: item.id, approvalId: "approval_1", status: "executing", createdAt: "2026-08-28T00:00:02.000Z" };

    const outcome = await reconcilePendingUndo(session, boundary, "2026-08-28T00:00:03.000Z");
    expect(outcome).toBe("reverted");
    expect(item.status).toBe("reverted");
    expect(session.pendingUndo).toBeUndefined();
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("before\n");
  });
});
