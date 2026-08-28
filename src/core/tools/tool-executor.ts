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
import { hashText, MAX_REVERSIBLE_FILE_BYTES, readWorkspaceTextState } from "../file-state";
import { parsePlanUpdate, planUpdateSchema } from "../plan";
import { WorkspaceBoundary } from "../security/path-boundary";
import { classifyCommand } from "../security/command-policy";
import { runCommand, runProcess } from "./command-runner";
import { TOOL_DEFINITIONS } from "./tool-definitions";

const MAX_ARGUMENT_BYTES = 2_000_000;
const MAX_WRITE_BYTES = MAX_REVERSIBLE_FILE_BYTES;
const MAX_READ_BYTES = 200_000;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "release", "coverage"]);

const schemas = {
  update_plan: planUpdateSchema,
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
  read_pdf: z.object({
    path: z.string(),
    start_page: z.number().int().min(1).max(10_000).default(1),
    end_page: z.number().int().min(1).max(10_000).optional(),
  }).strict(),
  search_text: z
    .object({
      query: z.string().min(1).max(10_000),
      path: z.string().default("."),
      max_results: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  git_status: z.object({ cwd: z.string().default(".") }).strict(),
  git_diff: z.object({ cwd: z.string().default("."), staged: z.boolean().default(false) }).strict(),
  write_file: z
    .object({
      path: z.string(),
      content: z
        .string()
        .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_WRITE_BYTES, {
          message: "写入内容超过大小限制",
        })
        .refine((value) => !value.includes("\0"), {
          message: "二进制内容不支持安全写入与撤销",
        }),
    })
    .strict(),
  edit_file: z
    .object({
      path: z.string(),
      old_text: z.string().min(1).max(MAX_WRITE_BYTES),
      new_text: z
        .string()
        .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_WRITE_BYTES, {
          message: "替换内容超过大小限制",
        })
        .refine((value) => !value.includes("\0"), {
          message: "二进制内容不支持安全修改与撤销",
        }),
      replace_all: z.boolean().default(false),
    })
    .strict(),
  delete_file: z.object({ path: z.string() }).strict(),
  run_python: z.object({
    path: z.string(),
    args: z.array(z.string().max(4_096).refine((value) => !value.includes("\0"), "参数包含无效字符")).max(50).default([]),
    cwd: z.string().default("."),
    timeout_ms: z.number().int().min(1000).max(120_000).default(60_000),
  }).strict(),
  run_command: z
    .object({
      command: z.string(),
      cwd: z.string().default("."),
      timeout_ms: z.number().int().min(1000).max(120_000).default(60_000),
    })
    .strict(),
};

type ToolName = keyof typeof schemas;

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
      case "update_plan":
        return this.preparePlan(call);
      case "list_files":
        return this.prepareList(call);
      case "read_file":
        return this.prepareRead(call);
      case "read_pdf":
        return this.prepareReadPdf(call);
      case "search_text":
        return this.prepareSearch(call);
      case "git_status":
        return this.prepareGitStatus(call);
      case "git_diff":
        return this.prepareGitDiff(call);
      case "write_file":
        return this.prepareWrite(call, now);
      case "edit_file":
        return this.prepareEdit(call, now);
      case "delete_file":
        return this.prepareDelete(call, now);
      case "run_python":
        return this.preparePython(call, now);
      case "run_command":
        return this.prepareCommand(call, now);
    }
  }

  private preparePlan(call: ToolCall): PreparedToolCall {
    const args = parsePlanUpdate(call.arguments);
    return {
      call,
      summary: `更新计划（${args.steps.length} 个步骤）`,
      requiresApproval: false,
      execute: async () => ({
        ok: true,
        summary: `已记录计划检查点（${args.steps.length} 个步骤）`,
        output: JSON.stringify(args),
        metadata: { steps: args.steps.length },
      }),
    };
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

  private async prepareReadPdf(call: ToolCall): Promise<PreparedToolCall> {
    const args = parseArguments("read_pdf", call.arguments);
    const target = await this.boundary.resolveExisting(args.path);
    const info = await stat(target);
    if (!info.isFile() || path.extname(target).toLowerCase() !== ".pdf") {
      throw new HammerCodeError("read_pdf 目标必须是工作区内的 PDF 文件", "NOT_A_PDF", true);
    }
    const endPage = args.end_page ?? args.start_page + 99;
    if (endPage < args.start_page || endPage - args.start_page + 1 > 200) {
      throw new HammerCodeError("单次 PDF 读取页数必须在 1–200 页之间", "PDF_PAGE_LIMIT", true);
    }
    return {
      call,
      summary: `读取 PDF ${args.path}（第 ${args.start_page}–${endPage} 页）`,
      target: args.path,
      requiresApproval: false,
      execute: async (context) => {
        const candidates = [
          process.env.HAMMERCODE_PDFTOTEXT_PATH,
          "/opt/homebrew/bin/pdftotext",
          "/usr/local/bin/pdftotext",
          "pdftotext",
        ].filter((value): value is string => Boolean(value));
        for (const executable of candidates) {
          const result = await runProcess({
            executable,
            args: ["-f", String(args.start_page), "-l", String(endPage), "-layout", target, "-"],
            cwd: this.boundary.root,
            timeoutMs: 60_000,
            maxOutputBytes: this.config.maxCommandOutputBytes,
            signal: context.signal,
          });
          if (result.errorCode === "COMMAND_SPAWN_FAILED") continue;
          return {
            ...result,
            summary: result.ok ? `已提取 ${args.path} 的 PDF 文本` : `PDF 解析失败：${result.summary}`,
            errorCode: result.ok ? undefined : result.errorCode === "COMMAND_NON_ZERO_EXIT" ? "PDF_PARSE_FAILED" : result.errorCode,
            metadata: { ...result.metadata, path: args.path, startPage: args.start_page, endPage },
          };
        }
        return {
          ok: false,
          summary: "本机未安装 pdftotext",
          output: "请安装 Poppler，或通过 HAMMERCODE_PDFTOTEXT_PATH 指定可信的 pdftotext 可执行文件。",
          errorCode: "PDF_PARSER_UNAVAILABLE",
        };
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

  private async prepareGitStatus(call: ToolCall): Promise<PreparedToolCall> {
    const args = parseArguments("git_status", call.arguments);
    const cwd = await this.resolveCommandDirectory(args.cwd);
    return {
      call,
      summary: `读取 Git 状态（${this.boundary.relative(cwd)}）`,
      target: this.boundary.relative(cwd),
      requiresApproval: false,
      execute: async (context) =>
        runCommand({
          command: "git --no-pager -c color.ui=false status --short --branch",
          cwd,
          timeoutMs: 30_000,
          maxOutputBytes: this.config.maxCommandOutputBytes,
          signal: context.signal,
        }),
    };
  }

  private async prepareGitDiff(call: ToolCall): Promise<PreparedToolCall> {
    const args = parseArguments("git_diff", call.arguments);
    const cwd = await this.resolveCommandDirectory(args.cwd);
    return {
      call,
      summary: `读取${args.staged ? "已暂存" : "未暂存"} Git diff（${this.boundary.relative(cwd)}）`,
      target: this.boundary.relative(cwd),
      requiresApproval: false,
      execute: async (context) =>
        runCommand({
          command: `git --no-pager -c color.ui=false diff --no-ext-diff --unified=3${args.staged ? " --cached" : ""}`,
          cwd,
          timeoutMs: 30_000,
          maxOutputBytes: this.config.maxCommandOutputBytes,
          signal: context.signal,
        }),
    };
  }

  private async resolveCommandDirectory(relativePath: string): Promise<string> {
    const cwd = await this.boundary.resolveExisting(relativePath);
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new HammerCodeError("命令 cwd 不是目录", "NOT_A_DIRECTORY", true);
    return cwd;
  }

  private async prepareWrite(call: ToolCall, now: Date): Promise<PreparedToolCall> {
    const args = parseArguments("write_file", call.arguments);
    await this.boundary.resolveForWrite(args.path);
    const previousState = await readWorkspaceTextState(this.boundary, args.path);
    const previous = previousState.content;
    const previousHash = previousState.hash;
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
      fileMutation: {
        path: args.path,
        kind: previous === null ? "create" : "modify",
        beforeContent: previous,
        afterContent: args.content,
        beforeHash: previousHash,
        afterHash: hashText(args.content),
        patch,
      },
      execute: async () => {
        const current = await readWorkspaceTextState(this.boundary, args.path);
        if (current.hash !== previousHash) {
          return {
            ok: false,
            summary: "文件在审批期间发生变化，未写入",
            output: "请重新读取文件并生成新的修改。",
            errorCode: "STALE_WRITE",
          };
        }
        await this.writeTextAtomically(args.path, args.content);
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

  private async prepareEdit(call: ToolCall, now: Date): Promise<PreparedToolCall> {
    const args = parseArguments("edit_file", call.arguments);
    await this.boundary.resolveForWrite(args.path);
    const previousState = await readWorkspaceTextState(this.boundary, args.path);
    if (previousState.content === null || previousState.hash === null) {
      throw new HammerCodeError("精确修改要求目标文件已经存在", "PATH_NOT_FOUND", true);
    }
    const occurrences = previousState.content.split(args.old_text).length - 1;
    if (occurrences === 0) {
      throw new HammerCodeError("待替换文本与当前文件不匹配，请重新读取文件", "EDIT_TEXT_NOT_FOUND", true);
    }
    if (occurrences > 1 && !args.replace_all) {
      throw new HammerCodeError(
        `待替换文本出现 ${occurrences} 次；请提供更精确的 old_text 或显式启用 replace_all`,
        "EDIT_TEXT_AMBIGUOUS",
        true,
      );
    }
    const nextContent = args.replace_all
      ? previousState.content.split(args.old_text).join(args.new_text)
      : `${previousState.content.slice(0, previousState.content.indexOf(args.old_text))}${args.new_text}${previousState.content.slice(previousState.content.indexOf(args.old_text) + args.old_text.length)}`;
    if (Buffer.byteLength(nextContent, "utf8") > MAX_WRITE_BYTES) {
      throw new HammerCodeError("修改后的文件超过大小限制", "FILE_TOO_LARGE", true);
    }
    if (nextContent === previousState.content) {
      throw new HammerCodeError("精确修改没有产生内容变化", "NO_CHANGES", true);
    }
    const patch = createTwoFilesPatch(
      `a/${args.path}`,
      `b/${args.path}`,
      previousState.content,
      nextContent,
      "修改前",
      "修改后",
      { context: 4 },
    );
    const request = approval(
      this.ids,
      call,
      "精确修改文件",
      `${args.replace_all ? `替换 ${occurrences} 处` : "替换 1 处"} ${args.path}`,
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
      fileMutation: {
        path: args.path,
        kind: "modify",
        beforeContent: previousState.content,
        afterContent: nextContent,
        beforeHash: previousState.hash,
        afterHash: hashText(nextContent),
        patch,
      },
      execute: async () => {
        const current = await readWorkspaceTextState(this.boundary, args.path);
        if (current.hash !== previousState.hash) {
          return {
            ok: false,
            summary: "文件在审批期间发生变化，未修改",
            output: "请重新读取文件并生成新的精确修改。",
            errorCode: "STALE_WRITE",
          };
        }
        await this.writeTextAtomically(args.path, nextContent);
        return {
          ok: true,
          summary: `已精确修改 ${args.path}`,
          output: patch.slice(0, 120_000),
          truncated: patch.length > 120_000,
          metadata: {
            path: args.path,
            replacements: args.replace_all ? occurrences : 1,
            bytesWritten: Buffer.byteLength(nextContent),
          },
        };
      },
    };
  }

  private async writeTextAtomically(relativePath: string, content: string): Promise<void> {
    const checkedTarget = await this.boundary.resolveForWrite(relativePath);
    await mkdir(path.dirname(checkedTarget), { recursive: true });
    await this.boundary.resolveForWrite(relativePath);
    const temp = path.join(
      path.dirname(checkedTarget),
      `.${path.basename(checkedTarget)}.hammercode-${process.pid}-${Date.now()}`,
    );
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
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
  }

  private async prepareDelete(call: ToolCall, now: Date): Promise<PreparedToolCall> {
    const args = parseArguments("delete_file", call.arguments);
    const target = await this.boundary.resolveExisting(args.path);
    const info = await lstat(target);
    if (!info.isFile()) {
      throw new HammerCodeError("只允许删除单个普通文件", "DELETE_NON_FILE_BLOCKED");
    }
    const previous = await readWorkspaceTextState(this.boundary, args.path);
    if (previous.content === null || previous.hash === null) {
      throw new HammerCodeError("删除目标不存在", "PATH_NOT_FOUND", true);
    }
    const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    const patch = createTwoFilesPatch(
      `a/${args.path}`,
      "/dev/null",
      previous.content,
      "",
      "删除前",
      "删除后",
      { context: 4 },
    );
    const request = approval(
      this.ids,
      call,
      "删除文件",
      `永久删除工作区文件 ${args.path}`,
      patch,
      "delete",
      now,
    );
    return {
      call,
      summary: request.description,
      target: args.path,
      requiresApproval: true,
      approvalRequest: request,
      fileMutation: {
        path: args.path,
        kind: "delete",
        beforeContent: previous.content,
        afterContent: null,
        beforeHash: previous.hash,
        afterHash: null,
        patch,
      },
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
    const classification = classifyCommand(args.command);
    const cwd = await this.resolveCommandDirectory(args.cwd);
    const relativeCwd = this.boundary.relative(cwd);
    if (classification.policy === "auto") {
      return {
        call,
        summary: `自动执行本地验证：${args.command.slice(0, 120)}`,
        target: relativeCwd,
        requiresApproval: false,
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
    const request = approval(
      this.ids,
      call,
      "运行命令",
      `在 ${relativeCwd} 执行命令`,
      `cwd: ${cwd}\ncommand: ${args.command}\ntimeout: ${args.timeout_ms}ms\npolicy: ${classification.reason}`,
      "command",
      now,
    );
    return {
      call,
      summary: request.description,
      target: relativeCwd,
      requiresApproval: true,
      approvalPolicy: classification.policy === "always" ? "always" : "permission_mode",
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

  private async preparePython(call: ToolCall, now: Date): Promise<PreparedToolCall> {
    const args = parseArguments("run_python", call.arguments);
    if (args.args.some((value) => path.isAbsolute(value) || /(^|[\\/])\.\.([\\/]|$)|^~|\$\{?HOME\}?/i.test(value))) {
      throw new HammerCodeError("Python 参数不得引用工作区外路径", "PYTHON_ARGUMENT_PATH_BLOCKED", true);
    }
    const target = await this.boundary.resolveExisting(args.path);
    const info = await stat(target);
    if (!info.isFile() || path.extname(target).toLowerCase() !== ".py") {
      throw new HammerCodeError("run_python 目标必须是工作区内的 .py 文件", "NOT_A_PYTHON_SCRIPT", true);
    }
    const cwd = await this.resolveCommandDirectory(args.cwd);
    const relativeCwd = this.boundary.relative(cwd);
    const request = approval(
      this.ids,
      call,
      "运行 Python 脚本",
      `在 ${relativeCwd} 运行 ${args.path}`,
      `cwd: ${cwd}\nscript: ${target}\nargs: ${JSON.stringify(args.args)}\ntimeout: ${args.timeout_ms}ms`,
      "command",
      now,
    );
    return {
      call,
      summary: request.description,
      target: args.path,
      requiresApproval: true,
      approvalPolicy: "permission_mode",
      approvalRequest: request,
      execute: async (context) => {
        const candidates = [
          process.env.HAMMERCODE_PYTHON_PATH,
          "/opt/homebrew/bin/python3",
          "/usr/local/bin/python3",
          "/usr/bin/python3",
          "python3",
        ].filter((value): value is string => Boolean(value));
        for (const executable of candidates) {
          const result = await runProcess({
            executable,
            args: [target, ...args.args],
            cwd,
            timeoutMs: args.timeout_ms,
            maxOutputBytes: this.config.maxCommandOutputBytes,
            signal: context.signal,
          });
          if (result.errorCode === "COMMAND_SPAWN_FAILED") continue;
          return {
            ...result,
            summary: result.ok ? `Python 脚本执行成功：${args.path}` : result.summary,
            metadata: { ...result.metadata, script: args.path },
          };
        }
        return {
          ok: false,
          summary: "本机未找到 python3",
          output: "请安装 Python 3，或通过 HAMMERCODE_PYTHON_PATH 指定可信的解释器。",
          errorCode: "PYTHON_UNAVAILABLE",
        };
      },
    };
  }
}
