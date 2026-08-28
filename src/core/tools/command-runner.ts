import { spawn } from "node:child_process";
import type { ToolResult } from "../../shared/contracts";

export interface CommandRunOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

export interface ProcessRunOptions extends Omit<CommandRunOptions, "command"> {
  executable: string;
  args: string[];
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process may already have exited.
  }
}

export function runCommand(options: CommandRunOptions): Promise<ToolResult> {
  return runProcess({
    executable: "/bin/zsh",
    args: ["-lc", options.command],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    signal: options.signal,
  });
}

export function runProcess(options: ProcessRunOptions): Promise<ToolResult> {
  if (options.signal.aborted) {
    return Promise.resolve({
      ok: false,
      summary: "命令已取消",
      output: "",
      errorCode: "COMMAND_CANCELLED",
      metadata: { cwd: options.cwd, durationMs: 0 },
    });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const remaining = options.maxOutputBytes - stdout.length - stderr.length;
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    child.stdout?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stderr = append(stderr, chunk);
    });

    const terminate = (reason: "timeout" | "cancel"): void => {
      if (settled) return;
      timedOut ||= reason === "timeout";
      cancelled ||= reason === "cancel";
      killProcessGroup(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 1_000);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const onAbort = () => terminate("cancel");
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({
        ok: false,
        summary: "命令进程启动失败",
        output: error.message,
        errorCode: "COMMAND_SPAWN_FAILED",
        metadata: { cwd: options.cwd, durationMs: Date.now() - started },
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal.removeEventListener("abort", onAbort);
      const output = [
        stdout.length ? `stdout:\n${stdout.toString("utf8")}` : "",
        stderr.length ? `stderr:\n${stderr.toString("utf8")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const ok = exitCode === 0 && !timedOut && !cancelled;
      resolve({
        ok,
        summary: cancelled
          ? "命令已取消"
          : timedOut
            ? "命令执行超时"
            : ok
              ? "命令执行成功"
              : `命令以非零状态退出（${exitCode ?? signal ?? "unknown"}）`,
        output,
        errorCode: cancelled
          ? "COMMAND_CANCELLED"
          : timedOut
            ? "COMMAND_TIMEOUT"
            : ok
              ? undefined
              : "COMMAND_NON_ZERO_EXIT",
        truncated,
        metadata: {
          cwd: options.cwd,
          exitCode: exitCode ?? -1,
          signal: signal ?? "",
          timedOut,
          durationMs: Date.now() - started,
        },
      });
    });
  });
}
