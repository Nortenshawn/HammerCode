import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashText } from "../src/core/file-state";
import type { Clock, IdGenerator } from "../src/core/types";
import { ProjectMemoryStore } from "../src/main/project-memory-store";

const temporaryDirectories: string[] = [];

function fixtures() {
  let id = 0;
  let tick = 0;
  const ids: IdGenerator = { next: (prefix) => `${prefix}_${id++}` };
  const clock: Clock = { now: () => new Date(Date.parse("2026-08-29T00:00:00.000Z") + tick++ * 1_000) };
  return { ids, clock };
}

async function workspace(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `hammercode-memory-${name}-`));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project memory store", () => {
  it("persists records per normalized workspace without leaking across projects", async () => {
    const first = await workspace("first");
    const second = await workspace("second");
    const storage = await workspace("storage");
    const { ids, clock } = fixtures();
    const store = new ProjectMemoryStore(storage, clock, ids);
    await store.rememberUser({
      workspaceRoot: first,
      kind: "constraint",
      subject: "runtime",
      statement: "只支持 Apple Silicon",
      source: { type: "user", label: "用户确认", sessionId: "session_1", turnId: "turn_1" },
    });

    expect((await store.snapshot(first)).records).toHaveLength(1);
    expect((await store.snapshot(second)).records).toHaveLength(0);
    const restored = new ProjectMemoryStore(storage, clock, ids);
    expect((await restored.snapshot(first)).records[0]).toMatchObject({
      confidence: "user_confirmed",
      subject: "runtime",
    });
    const files = await readdir(storage);
    expect(files).toHaveLength(1);
    expect((await stat(path.join(storage, files.find((file) => file.endsWith(".json"))!))).mode & 0o777).toBe(0o600);
  });

  it("marks incompatible inference as conflicts and resolves them after deletion", async () => {
    const root = await workspace("conflict");
    const storage = await workspace("conflict-store");
    const { ids, clock } = fixtures();
    const store = new ProjectMemoryStore(storage, clock, ids);
    const first = await store.rememberInference({
      workspaceRoot: root,
      kind: "decision",
      subject: "package-manager",
      statement: "使用 npm",
      invalidation: { type: "none" },
      source: { sessionId: "s1", turnId: "t1", toolCallId: "c1" },
    });
    const second = await store.rememberInference({
      workspaceRoot: root,
      kind: "decision",
      subject: "package-manager",
      statement: "使用 pnpm",
      invalidation: { type: "none" },
      source: { sessionId: "s2", turnId: "t2", toolCallId: "c2" },
    });

    expect((await store.snapshot(root)).records.map((record) => record.status)).toEqual(["conflicted", "conflicted"]);
    const afterDelete = await store.delete(root, second.id);
    expect(afterDelete.records).toHaveLength(1);
    expect(afterDelete.records[0]).toMatchObject({ id: first.id, status: "active", conflictWith: [] });
  });

  it("invalidates file facts by hash and verification facts after a workspace revision", async () => {
    const root = await workspace("invalidation");
    const storage = await workspace("invalidation-store");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/app.ts"), "export const value = 1;\n");
    const { ids, clock } = fixtures();
    const store = new ProjectMemoryStore(storage, clock, ids);
    const content = await readFile(path.join(root, "src/app.ts"), "utf8");
    await store.recordToolFact({
      workspaceRoot: root,
      sessionId: "s1",
      turnId: "t1",
      call: { id: "write_1", name: "write_file", arguments: "{}" },
      result: { ok: true, summary: "已修改 src/app.ts", output: "" },
      fileChange: {
        id: "change_1",
        turnId: "t1",
        toolCallId: "write_1",
        path: "src/app.ts",
        kind: "modify",
        beforeContent: null,
        afterContent: content,
        beforeHash: null,
        afterHash: hashText(content),
        patch: "patch",
        status: "applied",
        appliedAt: "2026-08-29T00:00:00.000Z",
      },
    });
    await store.recordToolFact({
      workspaceRoot: root,
      sessionId: "s1",
      turnId: "t1",
      call: { id: "test_1", name: "run_command", arguments: '{"command":"npm test"}' },
      result: { ok: true, summary: "测试通过", output: "12 tests passed" },
    });
    expect((await store.snapshot(root)).records.filter((record) => record.status === "active")).toHaveLength(2);

    await writeFile(path.join(root, "src/app.ts"), "export const value = 2;\n");
    const afterExternalEdit = await store.snapshot(root);
    expect(afterExternalEdit.records.find((record) => record.kind === "fact")?.status).toBe("invalidated");

    await writeFile(path.join(root, "src/other.ts"), "export {};\n");
    const other = await readFile(path.join(root, "src/other.ts"), "utf8");
    await store.recordToolFact({
      workspaceRoot: root,
      sessionId: "s1",
      turnId: "t2",
      call: { id: "write_2", name: "write_file", arguments: "{}" },
      result: { ok: true, summary: "已创建 src/other.ts", output: "" },
      fileChange: {
        id: "change_2", turnId: "t2", toolCallId: "write_2", path: "src/other.ts", kind: "create",
        beforeContent: null, afterContent: other, beforeHash: null, afterHash: hashText(other), patch: "patch",
        status: "applied", appliedAt: "2026-08-29T00:00:00.000Z",
      },
    });
    expect((await store.snapshot(root)).records.find((record) => record.kind === "verification")?.status).toBe("invalidated");
  });

  it("enforces retrieval record and character budgets while preserving source labels", async () => {
    const root = await workspace("budget");
    const storage = await workspace("budget-store");
    const { ids, clock } = fixtures();
    const store = new ProjectMemoryStore(storage, clock, ids);
    for (let index = 0; index < 8; index += 1) {
      await store.rememberUser({
        workspaceRoot: root,
        kind: "fact",
        subject: `测试事实 ${index}`,
        statement: `测试结果 ${index} ${"x".repeat(120)}`,
        source: { type: "user", label: `用户来源 ${index}` },
      });
    }
    const recall = await store.retrieve(root, "测试", { maxRecords: 2, maxCharacters: 700 });
    expect(recall.records).toHaveLength(2);
    expect(recall.characterCount).toBeLessThanOrEqual(700);
    expect(recall.rendered).toContain("来源：用户来源");
    expect(recall.truncated).toBe(true);
  });

  it("serializes concurrent writes within one workspace without losing records", async () => {
    const root = await workspace("concurrent");
    const storage = await workspace("concurrent-store");
    const { ids, clock } = fixtures();
    const store = new ProjectMemoryStore(storage, clock, ids);
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.rememberUser({
      workspaceRoot: root,
      kind: "fact",
      subject: `concurrent-${index}`,
      statement: `value-${index}`,
      source: { type: "user", label: `user-${index}` },
    })));
    const snapshot = await store.snapshot(root);
    expect(snapshot.records).toHaveLength(12);
    expect(new Set(snapshot.records.map((record) => record.subject)).size).toBe(12);
  });
});
