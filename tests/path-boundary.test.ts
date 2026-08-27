import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceBoundary } from "../src/core/security/path-boundary";

describe("workspace boundary", () => {
  let sandbox = "";
  let workspace = "";
  let outside = "";

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "hammercode-boundary-"));
    workspace = path.join(sandbox, "workspace");
    outside = path.join(sandbox, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(workspace, "inside.txt"), "safe");
    await writeFile(path.join(outside, "secret.txt"), "secret");
  });

  afterEach(async () => rm(sandbox, { recursive: true, force: true }));

  it("allows existing and new paths inside the workspace", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    await expect(boundary.resolveExisting("inside.txt")).resolves.toBe(path.join(boundary.root, "inside.txt"));
    await expect(boundary.resolveForWrite("new/deep/file.ts")).resolves.toBe(path.join(boundary.root, "new/deep/file.ts"));
  });

  it("blocks traversal and absolute paths", async () => {
    const boundary = await WorkspaceBoundary.create(workspace);
    await expect(boundary.resolveExisting("../outside/secret.txt")).rejects.toMatchObject({ code: "PATH_TRAVERSAL_BLOCKED" });
    await expect(boundary.resolveExisting(path.join(outside, "secret.txt"))).rejects.toMatchObject({ code: "ABSOLUTE_PATH_BLOCKED" });
  });

  it("blocks symlink escapes for reads and nonexistent write descendants", async () => {
    await symlink(outside, path.join(workspace, "escape"));
    const boundary = await WorkspaceBoundary.create(workspace);
    await expect(boundary.resolveExisting("escape/secret.txt")).rejects.toMatchObject({ code: "SYMLINK_ESCAPE_BLOCKED" });
    await expect(boundary.resolveForWrite("escape/new/file.ts")).rejects.toMatchObject({ code: "SYMLINK_ESCAPE_BLOCKED" });
  });
});
