import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("runs a workspace Python file without shell interpolation after permission approval", async () => {
    await writeFile(
      path.join(workspace, "inspect.py"),
      "import sys\nprint('arg=' + sys.argv[1])\n",
    );
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);
    const prepared = await executor.prepare(
      {
        id: "python_1",
        name: "run_python",
        arguments: JSON.stringify({ path: "inspect.py", args: ["value;touch not-created"] }),
      },
      new Date(),
    );

    expect(prepared).toMatchObject({ requiresApproval: true, approvalPolicy: "permission_mode" });
    const result = await prepared.execute({
      signal: new AbortController().signal,
      approvals: { request: async () => true },
      now: () => new Date(),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("arg=value;touch not-created");
    await expect(readFile(path.join(workspace, "not-created"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects PDF misuse and path-like Python arguments before execution", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);
    await expect(executor.prepare(
      { id: "pdf_wrong", name: "read_pdf", arguments: '{"path":"a.txt"}' },
      new Date(),
    )).rejects.toMatchObject({ code: "NOT_A_PDF" });
    await writeFile(path.join(workspace, "inspect.py"), "print('safe')\n");
    await expect(executor.prepare(
      { id: "python_escape", name: "run_python", arguments: '{"path":"inspect.py","args":["../outside"]}' },
      new Date(),
    )).rejects.toMatchObject({ code: "PYTHON_ARGUMENT_PATH_BLOCKED" });
  });

  it("extracts PDF text through the bounded local parser process", async () => {
    const fakeParser = path.join(workspace, "fake-pdftotext");
    await writeFile(fakeParser, "#!/bin/sh\nprintf '第一页内容\\n第二页内容\\n'\n");
    await chmod(fakeParser, 0o700);
    await writeFile(path.join(workspace, "brief.pdf"), "%PDF-1.4\n% test fixture\n");
    const previousParser = process.env.HAMMERCODE_PDFTOTEXT_PATH;
    process.env.HAMMERCODE_PDFTOTEXT_PATH = fakeParser;
    try {
      const boundary = await WorkspaceBoundary.create(workspace);
      const executor = new LocalToolExecutor(boundary, ids);
      const prepared = await executor.prepare(
        { id: "pdf_1", name: "read_pdf", arguments: '{"path":"brief.pdf","start_page":1,"end_page":2}' },
        new Date(),
      );
      expect(prepared.requiresApproval).toBe(false);
      const result = await prepared.execute({
        signal: new AbortController().signal,
        approvals: { request: async () => true },
        now: () => new Date(),
      });
      expect(result).toMatchObject({ ok: true, metadata: { path: "brief.pdf", startPage: 1, endPage: 2 } });
      expect(result.output).toContain("第一页内容");
    } finally {
      if (previousParser === undefined) delete process.env.HAMMERCODE_PDFTOTEXT_PATH;
      else process.env.HAMMERCODE_PDFTOTEXT_PATH = previousParser;
    }
  });

  it("provides dedicated approval-free Git status and diff tools", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);
    const status = await executor.prepare(
      { id: "git_status_1", name: "git_status", arguments: "{}" },
      new Date(),
    );
    const diff = await executor.prepare(
      { id: "git_diff_1", name: "git_diff", arguments: '{"staged":true}' },
      new Date(),
    );
    expect(status).toMatchObject({ requiresApproval: false, target: "." });
    expect(diff).toMatchObject({ requiresApproval: false, target: "." });
  });

  it("separates auto verification, ordinary and always-approved commands", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);
    const automatic = await executor.prepare(
      { id: "cmd_test", name: "run_command", arguments: '{"command":"npm test"}' },
      new Date(),
    );
    const ordinary = await executor.prepare(
      { id: "cmd_build", name: "run_command", arguments: '{"command":"npm run build"}' },
      new Date(),
    );
    const remote = await executor.prepare(
      { id: "cmd_push", name: "run_command", arguments: '{"command":"git push origin main"}' },
      new Date(),
    );
    expect(automatic.requiresApproval).toBe(false);
    expect(ordinary).toMatchObject({ requiresApproval: true, approvalPolicy: "permission_mode" });
    expect(remote).toMatchObject({ requiresApproval: true, approvalPolicy: "always" });
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

  it("edits one exact text region without rewriting through the model", async () => {
    await writeFile(path.join(workspace, "a.txt"), "alpha\nbeta\ngamma\n");
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);
    const prepared = await executor.prepare(
      {
        id: "edit_1",
        name: "edit_file",
        arguments: JSON.stringify({ path: "a.txt", old_text: "beta", new_text: "BETA" }),
      },
      new Date(),
    );

    expect(prepared.requiresApproval).toBe(true);
    expect(prepared.approvalRequest?.details).toContain("-beta");
    expect(prepared.approvalRequest?.details).toContain("+BETA");
    expect(prepared.fileMutation).toMatchObject({
      path: "a.txt",
      kind: "modify",
      beforeContent: "alpha\nbeta\ngamma\n",
      afterContent: "alpha\nBETA\ngamma\n",
    });
    const result = await prepared.execute({
      signal: new AbortController().signal,
      approvals: { request: async () => true },
      now: () => new Date(),
    });
    expect(result).toMatchObject({ ok: true, metadata: { replacements: 1 } });
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("rejects ambiguous exact edits unless replace_all is explicit", async () => {
    await writeFile(path.join(workspace, "a.txt"), "same\nsame\n");
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);

    await expect(executor.prepare(
      {
        id: "edit_ambiguous",
        name: "edit_file",
        arguments: JSON.stringify({ path: "a.txt", old_text: "same", new_text: "changed" }),
      },
      new Date(),
    )).rejects.toMatchObject({ code: "EDIT_TEXT_AMBIGUOUS" });
  });

  it("rejects binary writes because they cannot be safely reviewed or undone", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);

    await expect(
      executor.prepare(
        {
          id: "write_binary",
          name: "write_file",
          arguments: JSON.stringify({ path: "binary.dat", content: "prefix\0suffix" }),
        },
        new Date(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_ARGUMENTS" });
  });

  it("records reversible state for an approved text deletion", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    const executor = new LocalToolExecutor(boundary, ids);
    const prepared = await executor.prepare(
      { id: "delete_1", name: "delete_file", arguments: '{"path":"a.txt"}' },
      new Date(),
    );

    expect(prepared.fileMutation).toMatchObject({
      path: "a.txt",
      kind: "delete",
      beforeContent: "before\n",
      afterContent: null,
    });
    expect(prepared.approvalRequest?.details).toContain("-before");
  });
});
