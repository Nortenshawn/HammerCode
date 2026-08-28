import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceBoundary } from "../src/core/security/path-boundary";
import { searchWorkspace } from "../src/main/workspace-search";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("workspace mention search", () => {
  it("finds only real files and folders inside the bound workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "hammercode-mentions-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "hammercode-mentions-outside-"));
    directories.push(workspace, outside);
    await mkdir(path.join(workspace, "src", "components"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules", "hidden"), { recursive: true });
    await writeFile(path.join(workspace, "src", "components", "Panel.tsx"), "export {};\n");
    await writeFile(path.join(workspace, "node_modules", "hidden", "Panel.tsx"), "hidden\n");
    await writeFile(path.join(outside, "outside.ts"), "outside\n");
    await symlink(outside, path.join(workspace, "escaped"));

    const entries = await searchWorkspace(await WorkspaceBoundary.create(workspace), "panel");
    expect(entries).toEqual([
      { path: "src/components/Panel.tsx", name: "Panel.tsx", kind: "file" },
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/node_modules|escaped|outside/);
  });
});
