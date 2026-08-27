import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { HammerCodeError } from "../types";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class WorkspaceBoundary {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<WorkspaceBoundary> {
    if (!path.isAbsolute(root)) {
      throw new HammerCodeError("工作区根目录必须是绝对路径", "INVALID_WORKSPACE");
    }
    const resolved = await realpath(root);
    const info = await lstat(resolved);
    if (!info.isDirectory()) {
      throw new HammerCodeError("工作区根路径不是目录", "INVALID_WORKSPACE");
    }
    return new WorkspaceBoundary(resolved);
  }

  private validateInput(input: string): string {
    if (!input || input.includes("\0")) {
      throw new HammerCodeError("路径不能为空或包含 NUL", "INVALID_PATH");
    }
    if (path.isAbsolute(input)) {
      throw new HammerCodeError("工具路径必须相对工作区", "ABSOLUTE_PATH_BLOCKED");
    }
    const candidate = path.resolve(this.root, input);
    if (!isInside(this.root, candidate)) {
      throw new HammerCodeError("路径试图逃逸工作区", "PATH_TRAVERSAL_BLOCKED");
    }
    return candidate;
  }

  async resolveExisting(input: string): Promise<string> {
    const candidate = this.validateInput(input);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      throw new HammerCodeError(`目标不存在：${input}`, "PATH_NOT_FOUND", true);
    }
    if (!isInside(this.root, resolved)) {
      throw new HammerCodeError("符号链接指向工作区外", "SYMLINK_ESCAPE_BLOCKED");
    }
    return resolved;
  }

  async resolveForWrite(input: string): Promise<string> {
    const candidate = this.validateInput(input);
    let cursor = candidate;

    while (true) {
      try {
        const resolved = await realpath(cursor);
        if (!isInside(this.root, resolved)) {
          throw new HammerCodeError("目标父目录通过符号链接逃逸工作区", "SYMLINK_ESCAPE_BLOCKED");
        }
        break;
      } catch (error) {
        if (error instanceof HammerCodeError) throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          throw new HammerCodeError("无法验证目标父目录", "INVALID_PATH");
        }
        cursor = parent;
      }
    }
    return candidate;
  }

  relative(absolutePath: string): string {
    if (!isInside(this.root, absolutePath)) {
      throw new HammerCodeError("路径不属于当前工作区", "PATH_OUTSIDE_WORKSPACE");
    }
    return path.relative(this.root, absolutePath) || ".";
  }
}
