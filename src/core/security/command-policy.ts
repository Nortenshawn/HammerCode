import { HammerCodeError } from "../types";

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[;&|]\s*)sudo(?:\s|$)/i, reason: "禁止提权命令" },
  { pattern: /(^|[;&|]\s*)(?:su|doas)(?:\s|$)/i, reason: "禁止切换或提升用户权限" },
  {
    pattern: /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(?:\/|~|\$HOME)(?:\s|$)/i,
    reason: "禁止删除系统、用户目录或工作区根级内容",
  },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: "禁止系统电源操作" },
  { pattern: /\b(?:diskutil\s+erase\w*|mkfs(?:\.|\s)|fdisk\s)/i, reason: "禁止磁盘破坏操作" },
  { pattern: /\b(?:launchctl\s+(?:load|bootstrap)|systemctl\s+(?:enable|start))\b/i, reason: "禁止安装持久化系统服务" },
  { pattern: /\bchmod\s+(?:-R\s+)?777\s+(?:\/|~)/i, reason: "禁止放宽系统或用户目录权限" },
];

export function assertCommandAllowed(command: string): void {
  if (!command.trim()) {
    throw new HammerCodeError("命令不能为空", "INVALID_COMMAND", true);
  }
  if (command.length > 16_000 || command.includes("\0")) {
    throw new HammerCodeError("命令长度或内容无效", "INVALID_COMMAND");
  }
  for (const rule of BLOCKED_PATTERNS) {
    if (rule.pattern.test(command)) {
      throw new HammerCodeError(rule.reason, "HIGH_RISK_COMMAND_BLOCKED");
    }
  }
}
