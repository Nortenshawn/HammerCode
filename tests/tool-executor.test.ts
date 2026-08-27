import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceBoundary } from "../src/core/security/path-boundary";
import { LocalToolExecutor } from "../src/core/tools/tool-executor";
import type { IdGenerator } from "../src/core/types";

describe("local tool executor", () => {
  let workspace = "";
  let counter = 0;
  const ids: IdGenerator = { next: (prefix) => `${prefix}_${counter++}` };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-tools-"));
    await writeFile(path.join(workspace, "a.txt"), "before\n");
  });
  afterEach(async () => rm(workspace, { recursive: true, force: true }));

  it("runs read-only tools without approval", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);
    const prepared = await executor.prepare(
      { id: "read_1", name: "read_file", arguments: '{"path":"a.txt"}' },
      new Date(),
    );
    expect(prepared.requiresApproval).toBe(false);
    const result = await prepared.execute({
      signal: new AbortController().signal,
      approvals: { request: async () => true },
      now: () => new Date(),
    });
    expect(result.output).toBe("before\n");
  });

  it("previews a diff and only mutates when executed after approval", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);
    const prepared = await executor.prepare(
      { id: "write_1", name: "write_file", arguments: '{"path":"a.txt","content":"after\\n"}' },
      new Date(),
    );
    expect(prepared.requiresApproval).toBe(true);
    expect(prepared.approvalRequest?.details).toContain("-before");
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("before\n");
    const result = await prepared.execute({
      signal: new AbortController().signal,
      approvals: { request: async () => true },
      now: () => new Date(),
    });
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("after\n");
  });

  it("detects a stale file after approval preview", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);
    const prepared = await executor.prepare(
      { id: "write_2", name: "write_file", arguments: '{"path":"a.txt","content":"agent\\n"}' },
      new Date(),
    );
    await writeFile(path.join(workspace, "a.txt"), "user edit\n");
    const result = await prepared.execute({
      signal: new AbortController().signal,
      approvals: { request: async () => true },
      now: () => new Date(),
    });
    expect(result.errorCode).toBe("STALE_WRITE");
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("user edit\n");
  });
});
