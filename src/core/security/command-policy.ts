import { HammerCodeError } from "../types";

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/i, reason: "禁止提权命令" },
  { pattern: /\b(?:su|doas)\b/i, reason: "禁止切换或提升用户权限" },
  {
    pattern: /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(?:\/|~|\$HOME)(?:\s|$)/i,
    reason: "禁止删除系统、用户目录或工作区根级内容",
  },
  {
    pattern: /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(?:\.|\.\/|\*|\.\/\*)(?:\s|$)/i,
    reason: "禁止递归擦除整个工作区",
  },
  { pattern: /(^|[\s='"(])\.\.(?:\/|\\|[\s'";|&)]|$)/, reason: "命令不得通过上级目录访问工作区外" },
  { pattern: /(?:\$\{?HOME\}?|(^|[\s='"(])~(?:\/|[\s'";|&)]|$))/i, reason: "命令不得访问用户主目录" },
  { pattern: /(^|[\s='"(])\/(?!dev\/null(?:[\s'";|&)]|$))/, reason: "命令不得使用工作区外绝对路径" },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: "禁止系统电源操作" },
  { pattern: /\b(?:diskutil\s+erase\w*|mkfs(?:\.|\s)|fdisk\s)/i, reason: "禁止磁盘破坏操作" },
  { pattern: /\b(?:launchctl\s+(?:load|bootstrap)|systemctl\s+(?:enable|start))\b/i, reason: "禁止安装持久化系统服务" },
  { pattern: /\bchmod\s+(?:-R\s+)?777\s+(?:\/|~)/i, reason: "禁止放宽系统或用户目录权限" },
];

const ALWAYS_APPROVAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[;&|]\s*)git\s+(?:push|pull|fetch|clone|remote\s+(?:add|set-url|remove)|tag\s+-d)\b/i, reason: "Git 远端或共享状态操作" },
  { pattern: /(^|[;&|]\s*)(?:gh|glab)\s+(?:pr|repo|release|issue|api|workflow)\b/i, reason: "代码托管平台远端操作" },
  { pattern: /(^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:publish|login|logout|owner|access|deprecate|dist-tag)\b/i, reason: "包仓库发布或账户操作" },
  { pattern: /(^|[;&|]\s*)(?:twine\s+upload|cargo\s+publish|gem\s+push|docker\s+push)\b/i, reason: "发布或上传制品" },
  { pattern: /(^|[;&|]\s*)(?:curl|wget|scp|sftp|ssh|rsync)\b/i, reason: "网络传输或远程执行" },
  { pattern: /(^|[;&|]\s*)(?:vercel|netlify|firebase|flyctl|wrangler|kubectl|helm|terraform|pulumi)\b/i, reason: "部署或远端基础设施操作" },
  { pattern: /(^|[;&|]\s*)(?:aws|gcloud|az|doctl|heroku)\b/i, reason: "云端状态操作" },
  { pattern: /(^|[;&|]\s*)git\s+(?:reset\s+--hard|clean\s+-|rebase|checkout\s+--|restore\s+--source)\b/i, reason: "可能丢弃本地 Git 状态" },
  { pattern: /(^|[;&|]\s*)rm\s+-[^\s]*[rf][^\s]*\b/i, reason: "递归或强制删除工作区内容" },
];

export type CommandApprovalPolicy = "auto" | "permission_mode" | "always";

export interface CommandClassification {
  policy: CommandApprovalPolicy;
  reason: string;
}

function isSimpleCommand(command: string): boolean {
  return /^[a-zA-Z0-9_@./:+,=-]+(?:[ \t]+[a-zA-Z0-9_@./:+,=-]+)*$/.test(command.trim());
}

function splitPlainCommandSequence(command: string): string[] | null {
  if (!/(?:&&|\|\||;|\r?\n)/.test(command)) return null;
  const commands = command.split(/(?:&&|\|\||;|\r?\n)/).map((item) => item.trim());
  if (commands.some((item) => !item || !isSimpleCommand(item))) return null;
  return commands;
}

function isAutoCommand(command: string): boolean {
  if (!isSimpleCommand(command)) return false;
  const tokens = command.trim().split(/\s+/);
  const [first, second, third] = tokens;
  if (["pytest", "swift"].includes(first) && (first !== "swift" || second === "test")) return true;
  if (["python", "python3"].includes(first) && second === "-m" && third === "pytest") return true;
  if (first === "go" && second === "test") return true;
  if (first === "cargo" && second === "test") return true;
  if (first === "dotnet" && second === "test") return true;
  if (["mvn", "mvnw", "gradle", "gradlew"].includes(first) && tokens.some((token) => /^(?:test|check)$/.test(token))) return true;
  if (first === "node" && ["--test", "--check"].includes(second)) return true;
  if ((first === "tsc" || (first === "npx" && second === "tsc")) && tokens.includes("--noEmit")) return true;
  if (["npm", "pnpm", "yarn", "bun"].includes(first)) {
    if (second === "test" || second === "typecheck") return true;
    if (second === "run" && third && /^(?:test(?::[\w-]+)?|typecheck)$/.test(third)) return true;
  }
  if (first === "git" && ["status", "diff"].includes(second) && !tokens.includes("--no-index")) return true;
  return false;
}

function hasRemoteOrReleaseIntent(command: string): boolean {
  if (!isSimpleCommand(command)) return false;
  const tokens = command.trim().split(/\s+/);
  if (["env", "command", "xargs", "bash", "sh", "zsh", "fish", "nohup", "nice", "time", "timeout"].includes(tokens[0])) return true;
  const gitIndex = tokens.indexOf("git");
  if (gitIndex >= 0 && tokens.slice(gitIndex + 1).some((token) => /^(?:push|pull|fetch|clone)$/.test(token))) return true;
  const remoteExecutables = new Set([
    "gh", "glab", "curl", "wget", "scp", "sftp", "ssh", "rsync",
    "vercel", "netlify", "firebase", "flyctl", "wrangler", "kubectl", "helm", "terraform", "pulumi",
    "aws", "gcloud", "az", "doctl", "heroku",
  ]);
  if (tokens.some((token) => remoteExecutables.has(token))) return true;
  return tokens.some((token) => /(?:^|[-_:])(?:deploy|publish|release|upload)(?:$|[-_:])/i.test(token));
}

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

export function classifyCommand(command: string): CommandClassification {
  assertCommandAllowed(command);
  for (const rule of ALWAYS_APPROVAL_PATTERNS) {
    if (rule.pattern.test(command)) return { policy: "always", reason: rule.reason };
  }
  if (isSimpleCommand(command)) {
    if (hasRemoteOrReleaseIntent(command)) {
      return { policy: "always", reason: "命令包含远端、发布意图或可隐藏实际子命令的包装器" };
    }
    if (isAutoCommand(command)) {
      return { policy: "auto", reason: "受限的本地验证或只读 Git 命令" };
    }
    return { policy: "permission_mode", reason: "普通工作区命令" };
  }

  const sequence = splitPlainCommandSequence(command);
  if (sequence) {
    for (const item of sequence) {
      for (const rule of ALWAYS_APPROVAL_PATTERNS) {
        if (rule.pattern.test(item)) return { policy: "always", reason: rule.reason };
      }
      if (hasRemoteOrReleaseIntent(item)) {
        return { policy: "always", reason: "本地命令序列包含远端、发布意图或可隐藏实际子命令的包装器" };
      }
    }
    return { policy: "permission_mode", reason: "已逐段校验的普通本地命令序列" };
  }

  return { policy: "always", reason: "Shell 包装器或复杂语法无法静态证明为纯本地操作" };
}
