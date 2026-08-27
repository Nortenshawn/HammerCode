import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type { ApprovalRequest, ToolCall, ToolResult } from "../../shared/contracts";
import type { IdGenerator, PreparedToolCall, ToolExecutorPort } from "../types";
import { HammerCodeError } from "../types";
import { WorkspaceBoundary } from "../security/path-boundary";
import { assertCommandAllowed } from "../security/command-policy";
import { runCommand } from "./command-runner";
import { TOOL_DEFINITIONS } from "./tool-definitions";

const MAX_ARGUMENT_BYTES = 2_000_000;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_READ_BYTES = 200_000;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "release", "coverage"]);

const schemas = {
  list_files: z
    .object({
      path: z.string().default("."),
      recursive: z.boolean().default(false),
      max_entries: z.number().int().min(1).max(1000).default(300),
    })
    .strict(),
  read_file: z
    .object({
      path: z.string(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(MAX_READ_BYTES).default(MAX_READ_BYTES),
    })
    .strict(),
  search_text: z
    .object({
      query: z.string().min(1).max(10_000),
      path: z.string().default("."),
      max_results: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  write_file: z
    .object({ path: z.string(), content: z.string().max(MAX_WRITE_BYTES) })
    .strict(),
  delete_file: z.object({ path: z.string() }).strict(),
  run_command: z
    .object({
      command: z.string(),
      cwd: z.string().default("."),
      timeout_ms: z.number().int().min(1000).max(120_000).default(60_000),
    })
    .strict(),
};

type ToolName = keyof typeof schemas;

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseArguments<T extends ToolName>(name: T, input: string): z.output<(typeof schemas)[T]> {
  if (Buffer.byteLength(input) > MAX_ARGUMENT_BYTES) {
    throw new HammerCodeError("工具参数超过大小限制", "TOOL_ARGUMENTS_TOO_LARGE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input || "{}");
  } catch {
    throw new HammerCodeError("工具参数不是有效 JSON", "INVALID_TOOL_ARGUMENTS", true);
  }
  const parsed = schemas[name].safeParse(raw);
  if (!parsed.success) {
    throw new HammerCodeError(
      `工具参数校验失败：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
      "INVALID_TOOL_ARGUMENTS",
      true,
    );
  }
  return parsed.data as z.output<(typeof schemas)[T]>;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new HammerCodeError("目标不是普通文件", "NOT_A_FILE", true);
    if (info.size > MAX_WRITE_BYTES) {
      throw new HammerCodeError("现有文件过大，拒绝完整替换", "FILE_TOO_LARGE", true);
    }
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function approval(
  ids: IdGenerator,
  call: ToolCall,
  title: string,
  description: string,
  details: string,
  risk: ApprovalRequest["risk"],
  now: Date,
): ApprovalRequest {
  return {
    id: ids.next("approval"),
    toolCallId: call.id,
    toolName: call.name,
    title,
    description,
    details: details.slice(0, 200_000),
    risk,
    createdAt: now.toISOString(),
  };
}

export interface ToolExecutorConfig {
  maxCommandOutputBytes: number;
}

export class LocalToolExecutor implements ToolExecutorPort {
  readonly definitions = TOOL_DEFINITIONS;

  constructor(
    private readonly boundary: WorkspaceBoundary,
    private readonly ids: IdGenerator,
    private readonly config: ToolExecutorConfig = { maxCommandOutputBytes: 120_000 },
  ) {}

  async prepare(call: ToolCall, now: Date): Promise<PreparedToolCall> {
    if (!(call.name in schemas)) {
      throw new HammerCodeError(`未知工具：${call.name}`, "UNKNOWN_TOOL", true);
    }
    switch (call.name as ToolName) {
      case "list_files":
        return this.prepareList(call);
      case "read_file":
        return this.prepareRead(call);
      case "search_text":
        return this.prepareSearch(call);
      case "write_file":
        return this.prepareWrite(call, now);
      case "delete_file":
        return this.prepareDelete(call, now);
      case "run_command":
        return this.prepareCommand(call, now);
    }
  }

  private async prepareList(call: ToolCall): Promise<PreparedToolCall> {
    const args = parseArguments("list_files", call.arguments);
    const root = await this.boundary.resolveExisting(args.path);
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) throw new HammerCodeError("list_files 目标不是目录", "NOT_A_DIRECTORY", true);
    return {
      call,
      summary: `列出 ${args.path}`,
      target: args.path,
      requiresApproval: false,
      execute: async () => {
        const entries: string[] = [];
        const walk = async (directory: string): Promise<void> => {
          const children = await readdir(directory, { withFileTypes: true });
          children.sort((a, b) => a.name.localeCompare(b.name));
          for (const child of children) {
            if (entries.length >= args.max_entries) return;
            if (IGNORED_DIRECTORIES.has(child.name)) continue;
            const absolute = path.join(directory, child.name);
            const relative = this.boundary.relative(absolute);
            entries.push(`${relative}${child.isDirectory() ? "/" : ""}`);
            if (args.recursive && child.isDirectory() && !child.isSymbolicLink()) await walk(absolute);
          }
        };
        await walk(root);
        return {
          ok: true,
          summary: `列出 ${entries.length} 个条目`,
          output: entries.join("\n") || "（空目录）",
          truncated: entries.length >= args.max_entries,
          metadata: { count: entries.length, path: args.path },
        };
      },
    };
  }

  private async prepareRead(call: ToolCall): Promise<PreparedToolCall> {
    const args = parseArguments("read_file", call.arguments);
    const target = await this.boundary.resolveExisting(args.path);
    const info = await stat(target);
    if (!info.isFile()) throw new HammerCodeError("read_file 目标不是文件", "NOT_A_FILE", true);
    return {
      call,
      summary: `读取 ${args.path}`,
      target: args.path,
      requiresApproval: false,
      execute: async () => {
        const file = await open(target, "r");
        try {
          const size = Math.min(args.limit, Math.max(0, info.size - args.offset));
          const buffer = Buffer.alloc(size);
          const { bytesRead } = await file.read(buffer, 0, size, args.offset);
          return {
            ok: true,
            summary: `读取 ${bytesRead} 字节`,
            output: buffer.subarray(0, bytesRead).toString("utf8"),
            truncated: args.offset + bytesRead < info.size,
            metadata: { path: args.path, offset: args.offset, bytesRead, totalBytes: info.size },
          };
        } finally {
          await file.close();
        }
      },
    };
  }

  private async prepareSearch(call: ToolCall): Promise<PreparedToolCall> {
    const args = parseArguments("search_text", call.arguments);
    const target = await this.boundary.resolveExisting(args.path);
    return {
      call,
      summary: `搜索“${args.query.slice(0, 60)}”`,
      target: args.path,
      requiresApproval: false,
      execute: async () => {
        const matches: string[] = [];
        let scanned = 0;
        const visit = async (candidate: string): Promise<void> => {
          if (matches.length >= args.max_results || scanned >= 5_000) return;
          const info = await lstat(candidate);
          if (info.isSymbolicLink()) return;
          if (info.isDirectory()) {
            const children = await readdir(candidate, { withFileTypes: true });
            for (const child of children) {
              if (IGNORED_DIRECTORIES.has(child.name)) continue;
              await visit(path.join(candidate, child.name));
              if (matches.length >= args.max_results) return;
            }
            return;
          }
          if (!info.isFile() || info.size > 1_000_000) return;
          scanned += 1;
          const content = await readFile(candidate, "utf8").catch(() => null);
          if (content === null || content.includes("\0")) return;
          content.split(/\r?\n/).forEach((line, index) => {
            if (matches.length < args.max_results && line.includes(args.query)) {
              matches.push(`${this.boundary.relative(candidate)}:${index + 1}:${line.slice(0, 500)}`);
            }
          });
        };
        await visit(target);
        return {
          ok: true,
          summary: `找到 ${matches.length} 处匹配`,
          output: matches.join("\n") || "未找到匹配",
          truncated: matches.length >= args.max_results || scanned >= 5_000,
          metadata: { matches: matches.length, filesScanned: scanned },
        };
      },
    };
  }

  private async prepareWrite(call: ToolCall, now: Date): Promise<PreparedToolCall> {
    const args = parseArguments("write_file", call.arguments);
    const target = await this.boundary.resolveForWrite(args.path);
    const previous = await readOptionalText(target);
    const previousHash = previous === null ? null : hash(previous);
    const patch = createTwoFilesPatch(
      previous === null ? "/dev/null" : `a/${args.path}`,
      `b/${args.path}`,
      previous ?? "",
      args.content,
      "写入前",
      "写入后",
      { context: 4 },
    );
    const request = approval(
      this.ids,
      call,
      previous === null ? "创建文件" : "修改文件",
      `${previous === null ? "创建" : "完整替换"} ${args.path}`,
      patch,
      "write",
      now,
    );
    return {
      call,
      summary: request.description,
      target: args.path,
      requiresApproval: true,
      approvalRequest: request,
      execute: async () => {
        const checkedTarget = await this.boundary.resolveForWrite(args.path);
        const current = await readOptionalText(checkedTarget);
        const currentHash = current === null ? null : hash(current);
        if (currentHash !== previousHash) {
          return {
            ok: false,
            summary: "文件在审批期间发生变化，未写入",
            output: "请重新读取文件并生成新的修改。",
            errorCode: "STALE_WRITE",
          };
        }
        await mkdir(path.dirname(checkedTarget), { recursive: true });
        await this.boundary.resolveForWrite(args.path);
        const temp = path.join(
          path.dirname(checkedTarget),
          `.${path.basename(checkedTarget)}.hammercode-${process.pid}-${Date.now()}`,
        );
        const handle = await open(temp, "wx", 0o600);
        try {
          await handle.writeFile(args.content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temp, checkedTarget);
        } catch (error) {
          await rm(temp, { force: true });
          throw error;
        }
        return {
          ok: true,
          summary: `${previous === null ? "已创建" : "已修改"} ${args.path}`,
          output: patch.slice(0, 120_000),
          truncated: patch.length > 120_000,
          metadata: { path: args.path, bytesWritten: Buffer.byteLength(args.content) },
        };
      },
    };
  }

  private async prepareDelete(call: ToolCall, now: Date): Promise<PreparedToolCall> {
    const args = parseArguments("delete_file", call.arguments);
    const target = await this.boundary.resolveExisting(args.path);
    const info = await lstat(target);
    if (!info.isFile()) {
      throw new HammerCodeError("只允许删除单个普通文件", "DELETE_NON_FILE_BLOCKED");
    }
    const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    const request = approval(
      this.ids,
      call,
      "删除文件",
      `永久删除工作区文件 ${args.path}`,
      `目标：${args.path}\n大小：${info.size} 字节\n此操作不可由 HammerCode 自动恢复。`,
      "delete",
      now,
    );
    return {
      call,
      summary: request.description,
      target: args.path,
      requiresApproval: true,
      approvalRequest: request,
      execute: async () => {
        const checked = await this.boundary.resolveExisting(args.path);
        const current = await lstat(checked);
        const currentFingerprint = `${current.dev}:${current.ino}:${current.size}:${current.mtimeMs}`;
        if (currentFingerprint !== fingerprint) {
          return {
            ok: false,
            summary: "文件在审批期间发生变化，未删除",
            output: "请重新确认删除目标。",
            errorCode: "STALE_DELETE",
          };
        }
        await rm(checked);
        return {
          ok: true,
          summary: `已删除 ${args.path}`,
          output: `deleted: ${args.path}`,
          metadata: { path: args.path, bytesRemoved: info.size },
        };
      },
    };
  }

  private async prepareCommand(call: ToolCall, now: Date): Promise<PreparedToolCall> {
    const args = parseArguments("run_command", call.arguments);
    assertCommandAllowed(args.command);
    const cwd = await this.boundary.resolveExisting(args.cwd);
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new HammerCodeError("命令 cwd 不是目录", "NOT_A_DIRECTORY", true);
    const relativeCwd = this.boundary.relative(cwd);
    const request = approval(
      this.ids,
      call,
      "运行命令",
      `在 ${relativeCwd} 执行命令`,
      `cwd: ${cwd}\ncommand: ${args.command}\ntimeout: ${args.timeout_ms}ms`,
      "command",
      now,
    );
    return {
      call,
      summary: request.description,
      target: relativeCwd,
      requiresApproval: true,
      approvalRequest: request,
      execute: async (context) =>
        runCommand({
          command: args.command,
          cwd,
          timeoutMs: args.timeout_ms,
          maxOutputBytes: this.config.maxCommandOutputBytes,
          signal: context.signal,
        }),
    };
  }
}
