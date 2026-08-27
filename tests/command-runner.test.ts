import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/core/tools/command-runner";

describe("command runner", () => {
  it("does not spawn when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCommand({
      command: "touch should-not-exist",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
      signal: controller.signal,
    });
    expect(result.errorCode).toBe("COMMAND_CANCELLED");
  });

  it("reports non-zero exit codes", async () => {
    const result = await runCommand({
      command: "echo problem >&2; exit 7",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("COMMAND_NON_ZERO_EXIT");
    expect(result.metadata?.exitCode).toBe(7);
    expect(result.output).toContain("problem");
  });

  it("truncates oversized output", async () => {
    const result = await runCommand({
      command: "printf '1234567890%.0s' {1..100}",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 50,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThan(100);
  });

  it("times out and terminates the process group", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-process-"));
    const pidFile = path.join(directory, "child.pid");
    const result = await runCommand({
      command: `sleep 10 & child_pid=$!; echo $child_pid > ${JSON.stringify(pidFile)}; wait`,
      cwd: process.cwd(),
      timeoutMs: 200,
      maxOutputBytes: 1_000,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("COMMAND_TIMEOUT");
    expect(result.metadata?.timedOut).toBe(true);
    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    await rm(directory, { recursive: true, force: true });
  });

  it("supports cancellation", async () => {
    const controller = new AbortController();
    const resultPromise = runCommand({
      command: "sleep 10",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await resultPromise;
    expect(result.errorCode).toBe("COMMAND_CANCELLED");
  });
});
