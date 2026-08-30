import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { estimateTokens } from "../core/context";
import { WorkspaceBoundary } from "../core/security/path-boundary";
import { runProcess } from "../core/tools/command-runner";
import type {
  ApprovalRequest,
  PublicSkill,
  ReferencePreview,
  SkillInventorySnapshot,
  SkillResourceKind,
  SkillSettings,
  SkillSource,
  SkillUseAudit,
  ToolCall,
  ToolResult,
} from "../shared/contracts";
import type {
  Clock,
  IdGenerator,
  ModelToolDefinition,
  PreparedToolCall,
  SkillCatalogCandidate,
  SkillPort,
  SkillSelection,
} from "../core/types";
import { HammerCodeError } from "../core/types";

const MAX_INDEX_BYTES = 32_000;
const MAX_ENTRY_CHARACTERS = 12_000;
const MAX_RESOURCE_CHARACTERS = 16_000;
const MAX_SCRIPT_CHARACTERS = 32_000;
const MAX_PACKAGE_BYTES = 2_000_000;
const MAX_PACKAGE_FILES = 80;
const MAX_SKILLS_PER_EXPLICIT_TURN = 2;
const MAX_COMBINED_ENTRY_CHARACTERS = 24_000;
const MAX_CATALOG_CHARACTERS = 8_000;
const SAFE_SCRIPT_IMPORTS = new Set([
  "argparse",
  "collections",
  "csv",
  "datetime",
  "decimal",
  "functools",
  "hashlib",
  "itertools",
  "json",
  "math",
  "re",
  "statistics",
  "string",
  "sys",
  "textwrap",
  "typing",
]);

const skillIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const frontmatterSchema = z.object({
  name: skillIdSchema,
  description: z.string().trim().min(1).max(1_024),
  license: z.string().max(200).optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  "allowed-tools": z.union([
    z.string().max(1_000),
    z.array(z.string().min(1).max(120)).max(32),
  ]).optional(),
}).passthrough();

const skillStateSchema = z.object({
  enabled: z.boolean(),
  trusted: z.boolean(),
  trustedFingerprint: z.string().length(64).optional(),
  trustInvalidatedAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
}).strict();
const settingsFileSchema = z.object({
  version: z.literal(2),
  modelActivationEnabled: z.boolean(),
  states: z.record(z.string(), skillStateSchema),
}).strict();
const legacySettingsFileSchema = z.object({
  version: z.literal(1),
  autoMatchEnabled: z.boolean(),
  states: z.record(z.string(), z.object({
    enabled: z.boolean(),
    trusted: z.boolean(),
    lastUsedAt: z.string().optional(),
  }).strict()),
}).strict();

const skillSettingsSchema = z.object({ modelActivationEnabled: z.boolean() }).strict();
const openAiMetadataSchema = z.object({
  interface: z.object({
    display_name: z.string().max(120).optional(),
    short_description: z.string().max(500).optional(),
  }).passthrough().optional(),
  policy: z.object({
    allow_implicit_invocation: z.boolean().optional(),
  }).passthrough().optional(),
  dependencies: z.object({
    tools: z.array(z.unknown()).max(32).optional(),
  }).passthrough().optional(),
}).passthrough();
const skillKeySchema = z.string().min(1).max(300);
const activateSkillSchema = z.object({ skill_id: skillIdSchema }).strict();
const readResourceSchema = z.object({
  skill_id: skillIdSchema,
  path: z.string().min(1).max(240),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(MAX_RESOURCE_CHARACTERS).default(MAX_RESOURCE_CHARACTERS),
}).strict();
const runScriptSchema = z.object({
  skill_id: skillIdSchema,
  path: z.string().min(1).max(240),
  args: z.array(z.string().max(2_000)).max(30).default([]),
  cwd: z.string().max(240).default("."),
  timeout_ms: z.number().int().min(1_000).max(120_000).default(60_000),
}).strict();

const ACTIVATE_SKILL_DEFINITION: ModelToolDefinition = {
  type: "function",
  function: {
    name: "activate_skill",
    description: "仅在当前 turn 的有界 Skill 目录中有明确匹配时，激活一个 Skill 并加载完整 SKILL.md。每轮最多由模型选择一个；不要为弱相关任务调用。Skill 不会获得额外权限。",
    parameters: {
      type: "object",
      properties: { skill_id: { type: "string" } },
      required: ["skill_id"],
      additionalProperties: false,
    },
  },
};

const ACTIVE_SKILL_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_skill_resource",
      description: "按需读取本轮已启用 Skill 包内的 reference、script 或文本 asset。只能读取当前 turn 固化的 Skill 和相对包路径。",
      parameters: {
        type: "object",
        properties: {
          skill_id: { type: "string" },
          path: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: MAX_RESOURCE_CHARACTERS },
        },
        required: ["skill_id", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_skill_script",
      description: "运行本轮标准 Skill 的 scripts/ 中已发现并固化的纯文本 Python 辅助脚本。allowed-tools 只作声明、不授权；脚本在无凭据、无网络、不可写且不能读取工作区的受限环境中执行，并继续受本轮审批模式、超时、输出上限和取消控制。",
      parameters: {
        type: "object",
        properties: {
          skill_id: { type: "string" },
          path: { type: "string" },
          args: { type: "array", maxItems: 30, items: { type: "string", maxLength: 2000 } },
          cwd: { type: "string", description: "只用于工具审计的工作区相对 cwd，默认 ." },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
        },
        required: ["skill_id", "path"],
        additionalProperties: false,
      },
    },
  },
];

interface SkillState {
  enabled: boolean;
  trusted: boolean;
  trustedFingerprint?: string;
  trustInvalidatedAt?: string;
  lastUsedAt?: string;
}

interface SkillFile {
  relativePath: string;
  size: number;
  modifiedAt: number;
  sha256: string;
  kind: SkillResourceKind;
}

interface InternalSkill {
  key: string;
  root: string;
  source: SkillSource;
  scope: PublicSkill["scope"];
  manifest: NormalizedSkillManifest;
  files: SkillFile[];
  fingerprint: string;
  issues: string[];
  compatibilityIssues: string[];
  enabled: boolean;
  trusted: boolean;
  trustInvalidated: boolean;
  lastUsedAt?: string;
}

interface NormalizedSkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  when: string;
  license: string;
  entry: "SKILL.md";
  compatibility: string;
  allowImplicitInvocation: boolean;
  triggers: { explicit: string[] };
  capabilities: { tools: string[]; scripts: string[]; runnableScripts: string[] };
}

interface PersistedSettings {
  version: 2;
  modelActivationEnabled: boolean;
  states: Record<string, SkillState>;
}

function defaultSettings(): PersistedSettings {
  return { version: 2, modelActivationEnabled: true, states: {} };
}

function scopeFor(source: SkillSource): PublicSkill["scope"] {
  if (source === "builtin") return "application";
  return source;
}

function projectToken(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function stateKey(source: SkillSource, id: string, workspaceRoot?: string): string {
  return source === "project"
    ? `project:${projectToken(workspaceRoot ?? "")}:${id}`
    : `${source}:${id}`;
}

function packageFingerprint(files: SkillFile[]): string {
  const stable = files
    .map((file) => `${file.relativePath}\0${file.sha256}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(stable).digest("hex");
}

function allowedTools(value: z.infer<typeof frontmatterSchema>["allowed-tools"]): string[] {
  if (!value) return [];
  return Array.isArray(value)
    ? [...new Set(value)]
    : [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

async function readSkillIndex(entryPath: string): Promise<{ text: string; frontmatter: z.infer<typeof frontmatterSchema> }> {
  const handle = await open(entryPath, "r");
  try {
    const buffer = Buffer.alloc(MAX_INDEX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
      throw new HammerCodeError("SKILL.md 缺少标准 YAML frontmatter", "SKILL_MANIFEST_INVALID", true);
    }
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new HammerCodeError("SKILL.md frontmatter 未闭合", "SKILL_MANIFEST_INVALID", true);
    let raw: unknown;
    try {
      raw = parseYaml(match[1]);
    } catch {
      throw new HammerCodeError("SKILL.md frontmatter 不是有效 YAML", "SKILL_MANIFEST_INVALID", true);
    }
    const parsed = frontmatterSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HammerCodeError(
        `SKILL.md frontmatter 校验失败：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
        "SKILL_MANIFEST_INVALID",
        true,
      );
    }
    return { text: match[0], frontmatter: parsed.data };
  } finally {
    await handle.close();
  }
}

async function readOptionalOpenAiMetadata(root: string): Promise<z.infer<typeof openAiMetadataSchema>> {
  const agentsPath = path.join(root, "agents");
  let agentsInfo;
  try {
    agentsInfo = await lstat(agentsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!agentsInfo.isDirectory() || agentsInfo.isSymbolicLink()) {
    throw new HammerCodeError("agents/ 必须是 Skill 包内的普通目录", "SKILL_SYMLINK_BLOCKED");
  }
  const agentsReal = await realpath(agentsPath);
  if (!agentsReal.startsWith(`${root}${path.sep}`)) {
    throw new HammerCodeError("agents/ 越出 Skill 包目录", "SKILL_PATH_BLOCKED");
  }
  const metadataPath = path.join(root, "agents", "openai.yaml");
  let info;
  try {
    info = await lstat(metadataPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INDEX_BYTES) {
    throw new HammerCodeError("agents/openai.yaml 无效、过大或是符号链接", "SKILL_MANIFEST_INVALID", true);
  }
  const metadataReal = await realpath(metadataPath);
  if (!metadataReal.startsWith(`${root}${path.sep}`)) {
    throw new HammerCodeError("agents/openai.yaml 越出 Skill 包目录", "SKILL_PATH_BLOCKED");
  }
  let raw: unknown;
  try {
    raw = parseYaml(await readFile(metadataReal, "utf8"));
  } catch {
    throw new HammerCodeError("agents/openai.yaml 不是有效 YAML", "SKILL_MANIFEST_INVALID", true);
  }
  const parsed = openAiMetadataSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new HammerCodeError(
      `agents/openai.yaml 校验失败：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
      "SKILL_MANIFEST_INVALID",
      true,
    );
  }
  return parsed.data;
}

function parseJson<T>(schema: z.ZodType<T>, value: string, label: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new HammerCodeError(`${label} 不是有效 JSON`, "SKILL_MANIFEST_INVALID", true);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HammerCodeError(
      `${label} 校验失败：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
      "SKILL_MANIFEST_INVALID",
      true,
    );
  }
  return parsed.data;
}

function assertSafeRelative(value: string, expectedPrefix?: string): string {
  if (value.includes("\0") || path.isAbsolute(value) || value.includes("\\")) {
    throw new HammerCodeError("Skill 资源路径必须是安全的相对路径", "SKILL_PATH_BLOCKED");
  }
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new HammerCodeError("Skill 资源路径越界", "SKILL_PATH_BLOCKED");
  }
  if (expectedPrefix && !normalized.startsWith(`${expectedPrefix}/`)) {
    throw new HammerCodeError(`Skill 资源必须位于 ${expectedPrefix}/`, "SKILL_PATH_BLOCKED");
  }
  return normalized;
}

function assertInstructionSafe(content: string): void {
  const forbidden: Array<[RegExp, string]> = [
    [/(?:读取|打开|打印|输出|复制|read|open|print|copy).{0,40}(?:\.env|api[ _-]?key|credential|凭据|密钥)/is, "Skill 试图诱导访问凭据"],
    [/(?:忽略|覆盖|绕过|ignore|override|bypass).{0,40}(?:system|系统|AGENTS\.md|用户|user|安全|security)/is, "Skill 试图覆盖高优先级指令"],
    [/(?:^|[\s`'"(])\.\.(?:\/|\\)/m, "Skill 包含越界路径指令"],
    [/(?:^|[\s`'"(])\/(?:Users|etc|private|var|System|Library)\//m, "Skill 包含工作区外绝对路径指令"],
  ];
  for (const [pattern, message] of forbidden) {
    if (pattern.test(content)) throw new HammerCodeError(message, "SKILL_INSTRUCTION_BLOCKED");
  }
}

function assertScriptSafe(content: string): void {
  assertInstructionSafe(content);
  const forbidden: Array<[RegExp, string]> = [
    [/\b(?:sudo|doas|shutdown|reboot|halt|poweroff|diskutil|mkfs|fdisk)\b/i, "脚本包含提权或系统破坏能力"],
    [/\b(?:subprocess|socket|requests|urllib|http\.client|ftplib|paramiko)\b/i, "脚本不能创建子进程或访问网络"],
    [/\b(?:eval|exec|compile|__import__)\s*\(/i, "脚本不能动态执行代码或导入模块"],
    [/\b(?:os\.|pathlib|shutil|tempfile|open\s*\()/i, "脚本不能直接访问文件系统"],
    [/\b(?:git\s+push|curl|wget|ssh|scp|rsync|publish|deploy|upload)\b/i, "脚本包含远端或发布行为"],
    [/(?:\.env|api[ _-]?key|authorization|credential|secret|token)/i, "脚本不能访问凭据或环境秘密"],
  ];
  for (const [pattern, message] of forbidden) {
    if (pattern.test(content)) throw new HammerCodeError(message, "SKILL_SCRIPT_BLOCKED");
  }
  const unsupported = unsupportedScriptImports(content);
  if (unsupported.length > 0) {
    throw new HammerCodeError(`脚本依赖未允许的模块：${unsupported.join("、")}`, "SKILL_SCRIPT_DEPENDENCY_BLOCKED");
  }
}

function unsupportedScriptImports(content: string): string[] {
  const unsupported = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const fromMatch = line.match(/^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+/);
    const importMatch = line.match(/^\s*import\s+(.+)$/);
    const modules = fromMatch
      ? [fromMatch[1].split(".")[0]]
      : importMatch
        ? importMatch[1].split(",").map((item) => item.trim().split(/\s+as\s+/i)[0].split(".")[0])
        : [];
    for (const moduleName of modules) {
      if (!SAFE_SCRIPT_IMPORTS.has(moduleName)) {
        unsupported.add(moduleName);
      }
    }
  }
  return [...unsupported].sort();
}

function parseArguments<T>(schema: z.ZodType<T>, input: string): T {
  if (Buffer.byteLength(input, "utf8") > 200_000) {
    throw new HammerCodeError("Skill 工具参数超过大小限制", "TOOL_ARGUMENTS_TOO_LARGE");
  }
  return parseJson(schema, input || "{}", "Skill 工具参数");
}

function shellProfileLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface SkillStoreOptions {
  builtinRoot: string;
  userRoot: string;
  settingsFile: string;
  trashRoot: string;
}

export class SkillStore implements SkillPort {
  private settings: PersistedSettings = defaultSettings();

  constructor(
    private readonly options: SkillStoreOptions,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly onChange?: (snapshot: SkillInventorySnapshot) => void | Promise<void>,
  ) {}

  async load(): Promise<void> {
    await mkdir(this.options.userRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(this.options.settingsFile), { recursive: true, mode: 0o700 });
    await mkdir(this.options.trashRoot, { recursive: true, mode: 0o700 });
    try {
      const value = await readFile(this.options.settingsFile, "utf8");
      let raw: unknown;
      try {
        raw = JSON.parse(value);
      } catch {
        throw new HammerCodeError("Skill 设置不是有效 JSON", "SKILL_MANIFEST_INVALID", true);
      }
      const current = settingsFileSchema.safeParse(raw);
      if (current.success) {
        this.settings = current.data;
      } else {
        const legacy = legacySettingsFileSchema.safeParse(raw);
        if (!legacy.success) throw new HammerCodeError("Skill 设置结构无效", "SKILL_MANIFEST_INVALID", true);
        this.settings = {
          version: 2,
          modelActivationEnabled: legacy.data.autoMatchEnabled,
          states: legacy.data.states,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.settings = defaultSettings();
      }
    }
    await this.saveSettings();
  }

  async inventory(workspaceRoot: string | null): Promise<SkillInventorySnapshot> {
    const skills = await this.discover(workspaceRoot);
    return {
      workspaceRoot,
      settings: { modelActivationEnabled: this.settings.modelActivationEnabled },
      skills: skills.map((skill) => this.toPublic(skill)),
      updatedAt: this.clock.now().toISOString(),
    };
  }

  async previewPackage(skillKeyInput: unknown, workspaceRoot: string | null): Promise<ReferencePreview> {
    const skillKey = skillKeySchema.parse(skillKeyInput);
    const skill = (await this.discover(workspaceRoot)).find((item) => item.key === skillKey);
    if (!skill || skill.issues.length > 0) {
      throw new HammerCodeError("找不到可预览的有效 Skill", "SKILL_NOT_FOUND", true);
    }
    const entry = await this.readVerifiedBuffer(skill, skill.manifest.entry, "entry");
    if (entry.buffer.includes(0)) throw new HammerCodeError("SKILL.md 不是文本文件", "SKILL_BINARY_BLOCKED", true);
    const content = entry.buffer.toString("utf8");
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trimStart();
    const limit = 80_000;
    return {
      key: `skill:${skill.key}`,
      kind: "skill",
      title: skill.manifest.name,
      subtitle: `${skill.source === "builtin" ? "内置" : skill.source === "user" ? "用户" : "当前项目"} · ${skill.manifest.id}@${skill.manifest.version}`,
      content: body.slice(0, limit),
      truncated: body.length > limit,
      language: "markdown",
    };
  }

  async updateSettings(input: unknown, workspaceRoot: string | null): Promise<SkillInventorySnapshot> {
    const settings = skillSettingsSchema.parse(input);
    this.settings.modelActivationEnabled = settings.modelActivationEnabled;
    await this.saveSettings();
    return this.notify(workspaceRoot);
  }

  async setEnabled(
    keyInput: unknown,
    enabled: boolean,
    trustProject: boolean,
    workspaceRoot: string | null,
  ): Promise<SkillInventorySnapshot> {
    const key = skillKeySchema.parse(keyInput);
    const skill = (await this.discover(workspaceRoot)).find((item) => item.key === key);
    if (!skill) throw new HammerCodeError("找不到这个 Skill", "SKILL_NOT_FOUND", true);
    if (skill.issues.length > 0) {
      throw new HammerCodeError(`Skill 校验未通过：${skill.issues.join("；")}`, "SKILL_INVALID", true);
    }
    if (enabled && skill.source === "project" && !skill.trusted) {
      if (!trustProject) {
        throw new HammerCodeError("项目 Skill 首次启用前需要明确确认来源和能力范围", "SKILL_TRUST_REQUIRED", true);
      }
      await this.validatePackageContents(skill);
    }
    const current = this.settings.states[skill.key] ?? this.defaultState(skill.source);
    this.settings.states[skill.key] = {
      ...current,
      enabled,
      trusted: current.trusted || skill.source !== "project" || trustProject,
      trustedFingerprint: skill.source === "project" && enabled && trustProject
        ? skill.fingerprint
        : current.trustedFingerprint,
      trustInvalidatedAt: skill.source === "project" && enabled && trustProject
        ? undefined
        : current.trustInvalidatedAt,
    };
    await this.saveSettings();
    return this.notify(workspaceRoot);
  }

  async importFolder(sourceRoot: string, workspaceRoot: string | null): Promise<PublicSkill> {
    const inspected = await this.inspectPackage(sourceRoot, "user", undefined);
    if (inspected.issues.length > 0) {
      throw new HammerCodeError(`Skill 导入校验失败：${inspected.issues.join("；")}`, "SKILL_IMPORT_INVALID", true);
    }
    await this.validatePackageContents(inspected);
    const existing = await this.discover(workspaceRoot);
    if (existing.some((item) => item.manifest.id === inspected.manifest.id)) {
      throw new HammerCodeError(`Skill ID 已存在：${inspected.manifest.id}`, "SKILL_DUPLICATE_ID", true);
    }
    const destination = path.join(this.options.userRoot, inspected.manifest.id);
    const staging = path.join(this.options.userRoot, `.import-${inspected.manifest.id}-${Date.now()}`);
    let imported: InternalSkill;
    try {
      await this.copyPackage(inspected.root, staging);
      imported = await this.inspectPackage(staging, "user", undefined, true);
      await this.validatePackageContents(imported);
      if (await lstat(destination).then(() => true).catch(() => false)) {
        throw new HammerCodeError("目标 Skill 目录已经存在", "SKILL_DUPLICATE_ID", true);
      }
      await rename(staging, destination);
      imported = await this.inspectPackage(destination, "user", undefined);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    this.settings.states[imported.key] = { enabled: true, trusted: true };
    await this.saveSettings();
    await this.notify(workspaceRoot);
    return this.toPublic(imported);
  }

  async exportPackage(skillKeyInput: unknown, workspaceRoot: string | null, destinationRoot: string): Promise<string> {
    const skillKey = skillKeySchema.parse(skillKeyInput);
    const skill = (await this.discover(workspaceRoot)).find((item) => item.key === skillKey);
    if (!skill || skill.issues.length > 0) {
      throw new HammerCodeError("找不到可导出的有效 Skill", "SKILL_NOT_FOUND", true);
    }
    await this.validatePackageContents(skill);
    const destinationBoundary = await realpath(destinationRoot);
    const destinationInfo = await stat(destinationBoundary);
    if (!destinationInfo.isDirectory()) throw new HammerCodeError("导出位置不是目录", "NOT_A_DIRECTORY", true);
    const destination = path.join(destinationBoundary, skill.manifest.id);
    if (await lstat(destination).then(() => true).catch(() => false)) {
      throw new HammerCodeError(
        `导出位置已存在同名目录：${skill.manifest.id}`,
        "SKILL_EXPORT_EXISTS",
        true,
      );
    }
    const staging = path.join(destinationBoundary, `.hammercode-skill-export-${skill.manifest.id}-${Date.now()}`);
    try {
      await this.copyPackage(skill.root, staging);
      await this.validatePackageContents(await this.inspectPackage(
        staging,
        skill.source,
        workspaceRoot ?? undefined,
        true,
      ));
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return path.basename(destination);
  }

  async uninstall(skillKeyInput: unknown, workspaceRoot: string | null): Promise<SkillInventorySnapshot> {
    const skillKey = skillKeySchema.parse(skillKeyInput);
    const skill = (await this.discover(workspaceRoot)).find((item) => item.key === skillKey);
    if (!skill) throw new HammerCodeError("找不到这个 Skill", "SKILL_NOT_FOUND", true);
    if (skill.source === "builtin") {
      throw new HammerCodeError("内置 Skill 不能卸载，可以将它禁用", "SKILL_BUILTIN_REMOVE_BLOCKED", true);
    }
    const destination = path.join(path.dirname(skill.root), `.removed-${skill.manifest.id}-${Date.now()}`);
    await rename(skill.root, destination);
    delete this.settings.states[skill.key];
    await this.saveSettings();
    return this.notify(workspaceRoot);
  }

  async select(workspaceRoot: string, task: string, now: Date): Promise<SkillSelection> {
    const skills = await this.discover(workspaceRoot);
    const usable = skills.filter((skill) => skill.enabled && skill.trusted && skill.issues.length === 0);
    const explicitIds = [...task.matchAll(/(?:^|\s)\$([a-z0-9][a-z0-9-]{0,63})(?=\s|$|[.,，。；;:：])/gi)]
      .map((match) => match[1].toLowerCase());
    const uniqueExplicit = [...new Set(explicitIds)];
    if (uniqueExplicit.length > MAX_SKILLS_PER_EXPLICIT_TURN) {
      throw new HammerCodeError(
        `单轮最多显式使用 ${MAX_SKILLS_PER_EXPLICIT_TURN} 个 Skill`,
        "SKILL_TURN_LIMIT",
        true,
      );
    }

    const selected: Array<{ skill: InternalSkill; trigger: "explicit"; reason: string }> = [];
    if (uniqueExplicit.length > 0) {
      selected.push(...uniqueExplicit.map((id) => {
        const skill = usable.find((item) => item.manifest.triggers.explicit.includes(id));
        if (!skill) {
          const known = skills.find((item) => item.manifest.triggers.explicit.includes(id));
          const suffix = known ? "已禁用、未信任或校验失败" : "不存在";
          throw new HammerCodeError(`显式指定的 Skill $${id} ${suffix}`, "SKILL_NOT_AVAILABLE", true);
        }
        return { skill, trigger: "explicit" as const, reason: `用户显式指定 $${id}` };
      }));
    }

    const usages: SkillUseAudit[] = [];
    const rendered: string[] = [];
    let combinedCharacters = 0;
    for (const item of selected) {
      const activated = await this.activateInternal(item.skill, item.trigger, item.reason, now);
      combinedCharacters += activated.usage.instructionCharacters;
      if (combinedCharacters > MAX_COMBINED_ENTRY_CHARACTERS) {
        throw new HammerCodeError("本轮 Skill 入口超过上下文硬预算", "SKILL_CONTEXT_BUDGET", true);
      }
      usages.push(activated.usage);
      rendered.push(activated.rendered);
      this.settings.states[item.skill.key] = {
        ...(this.settings.states[item.skill.key] ?? this.defaultState(item.skill.source)),
        lastUsedAt: now.toISOString(),
      };
    }
    if (usages.length > 0) {
      await this.saveSettings();
      await this.notify(workspaceRoot);
    }
    const candidates: SkillCatalogCandidate[] = uniqueExplicit.length === 0 && this.settings.modelActivationEnabled
      ? usable
          .filter((skill) => skill.manifest.allowImplicitInvocation)
          .map((skill) => ({
            id: skill.manifest.id,
            version: skill.manifest.version,
            source: skill.source,
            packageFingerprint: skill.fingerprint,
          }))
      : [];
    const catalogLines: string[] = [];
    let catalogCharacters = 0;
    for (const candidate of candidates) {
      const skill = usable.find((item) =>
        item.manifest.id === candidate.id &&
        item.source === candidate.source &&
        item.fingerprint === candidate.packageFingerprint,
      );
      if (!skill) continue;
      const line = JSON.stringify({
        id: skill.manifest.id,
        description: skill.manifest.description,
        version: skill.manifest.version,
        source: skill.source,
        compatibility: skill.compatibilityIssues.length > 0 ? "partial" : "compatible",
      });
      if (catalogCharacters + line.length + 1 > MAX_CATALOG_CHARACTERS) break;
      catalogLines.push(line);
      catalogCharacters += line.length + 1;
    }
    const visibleIds = new Set(catalogLines.map((line) => (JSON.parse(line) as { id: string }).id));
    const visibleCandidates = candidates.filter((candidate) => visibleIds.has(candidate.id));
    const catalog = catalogLines.join("\n");
    return {
      usages,
      rendered: rendered.join("\n\n"),
      catalog,
      catalogCharacters,
      catalogTokens: estimateTokens(catalog),
      candidates: visibleCandidates,
    };
  }

  definitions(usages: SkillUseAudit[], candidates: SkillCatalogCandidate[]): ModelToolDefinition[] {
    if (usages.length > 0) return ACTIVE_SKILL_TOOL_DEFINITIONS;
    return candidates.length > 0 ? [ACTIVATE_SKILL_DEFINITION] : [];
  }

  async prepare(
    call: ToolCall,
    usages: SkillUseAudit[],
    candidates: SkillCatalogCandidate[],
    workspaceRoot: string,
    now: Date,
  ): Promise<PreparedToolCall> {
    if (call.name === "activate_skill") {
      return this.prepareActivateSkill(call, usages, candidates, workspaceRoot, now);
    }
    if (call.name === "read_skill_resource") return this.prepareReadResource(call, usages, workspaceRoot);
    if (call.name === "run_skill_script") return this.prepareRunScript(call, usages, workspaceRoot, now);
    throw new HammerCodeError(`未知 Skill 工具：${call.name}`, "UNKNOWN_TOOL", true);
  }

  private async prepareActivateSkill(
    call: ToolCall,
    usages: SkillUseAudit[],
    candidates: SkillCatalogCandidate[],
    workspaceRoot: string,
    now: Date,
  ): Promise<PreparedToolCall> {
    const args = parseArguments(activateSkillSchema, call.arguments);
    if (usages.length > 0) {
      throw new HammerCodeError("当前 turn 已有激活的 Skill，模型不能再次隐式激活", "SKILL_TURN_LIMIT", true);
    }
    const candidate = candidates.find((item) => item.id === args.skill_id);
    if (!candidate) {
      throw new HammerCodeError("只能激活当前 turn 有界目录中的 Skill", "SKILL_NOT_AVAILABLE", true);
    }
    const skill = (await this.discover(workspaceRoot)).find((item) =>
      item.manifest.id === candidate.id &&
      item.source === candidate.source &&
      item.fingerprint === candidate.packageFingerprint &&
      item.enabled && item.trusted && item.issues.length === 0,
    );
    if (!skill) {
      throw new HammerCodeError("Skill 已变化或不再可用；本轮不会静默切换版本", "SKILL_VERSION_CHANGED", true);
    }
    const activated = await this.activateInternal(
      skill,
      "model",
      `模型根据有界名称与 description 目录选择 ${skill.manifest.id}`,
      now,
    );
    return {
      call,
      summary: `激活 Skill ${skill.manifest.id}`,
      target: skill.manifest.id,
      requiresApproval: false,
      execute: async () => {
        if (usages.length > 0) {
          return {
            ok: false,
            summary: "当前 turn 已激活其他 Skill",
            output: "模型隐式激活每轮最多一个，Skill 默认不会延续到下一轮。",
            errorCode: "SKILL_TURN_LIMIT",
          };
        }
        usages.push(activated.usage);
        this.settings.states[skill.key] = {
          ...(this.settings.states[skill.key] ?? this.defaultState(skill.source)),
          lastUsedAt: now.toISOString(),
        };
        await this.saveSettings();
        await this.notify(workspaceRoot);
        return {
          ok: true,
          summary: `已为当前 turn 激活 ${skill.manifest.id}`,
          output: activated.rendered,
          metadata: {
            skillActivated: true,
            skillId: activated.usage.id,
            skillVersion: activated.usage.version,
            skillInstructionCharacters: activated.usage.instructionCharacters,
            skillInstructionTokens: activated.usage.instructionTokens,
            skillEntrySha256: activated.usage.resources[0]?.sha256 ?? "",
          },
        };
      },
    };
  }

  private async activateInternal(
    skill: InternalSkill,
    trigger: "explicit" | "model",
    reason: string,
    now: Date,
  ): Promise<{ usage: SkillUseAudit; rendered: string }> {
    const entry = await this.readVerifiedText(skill, skill.manifest.entry, MAX_ENTRY_CHARACTERS, "entry");
    assertInstructionSafe(entry.content);
    const readAt = now.toISOString();
    const usage: SkillUseAudit = {
      id: skill.manifest.id,
      name: skill.manifest.name,
      version: skill.manifest.version,
      source: skill.source,
      scope: skill.scope,
      trigger,
      reason,
      packageFingerprint: skill.fingerprint,
      entryPath: skill.manifest.entry,
      instructionCharacters: entry.content.length,
      instructionTokens: estimateTokens(entry.content),
      availableResources: skill.files
        .filter((file) => ["reference", "script", "asset"].includes(file.kind))
        .map((file) => file.relativePath),
      availableScripts: [...skill.manifest.capabilities.runnableScripts],
      resources: [{
        path: skill.manifest.entry,
        kind: "entry",
        characters: entry.content.length,
        tokens: estimateTokens(entry.content),
        sha256: entry.sha256,
        readAt,
      }],
      scripts: [],
    };
    return {
      usage,
      rendered: [
        `<skill id="${usage.id}" version="${usage.version}" source="${usage.source}" trigger="${usage.trigger}">`,
        `使用原因：${usage.reason}`,
        "有效范围：仅当前 turn；下一轮必须重新显式指定或由模型重新选择。",
        `可按需读取的资源：${usage.availableResources.join("、") || "无"}`,
        `允许通过正式权限链运行的脚本：${usage.availableScripts.join("、") || "无"}`,
        entry.content,
        "</skill>",
      ].join("\n"),
    };
  }

  private async prepareReadResource(
    call: ToolCall,
    usages: SkillUseAudit[],
    workspaceRoot: string,
  ): Promise<PreparedToolCall> {
    const args = parseArguments(readResourceSchema, call.arguments);
    const { usage, skill } = await this.resolveTurnSkill(usages, args.skill_id, workspaceRoot);
    const resourcePath = assertSafeRelative(args.path);
    if (!usage.availableResources.includes(resourcePath) && resourcePath !== usage.entryPath) {
      throw new HammerCodeError("该资源不属于本轮已固化的 Skill", "SKILL_RESOURCE_NOT_AVAILABLE", true);
    }
    const file = skill.files.find((item) => item.relativePath === resourcePath);
    const kind = file?.kind;
    if (!kind) throw new HammerCodeError("Skill 资源不存在", "SKILL_RESOURCE_NOT_FOUND", true);
    const limit = kind === "script" ? Math.min(args.limit, MAX_SCRIPT_CHARACTERS) : args.limit;
    const resource = await this.readVerifiedText(skill, resourcePath, Math.max(args.offset + limit, limit), kind);
    assertInstructionSafe(resource.content);
    const sliced = resource.content.slice(args.offset, args.offset + limit);
    const truncated = args.offset + limit < resource.content.length;
    return {
      call,
      summary: `读取 Skill 资源 ${usage.id}/${resourcePath}`,
      target: `${usage.id}/${resourcePath}`,
      requiresApproval: false,
      execute: async () => ({
        ok: true,
        summary: `已读取 ${usage.name} 的 ${resourcePath}`,
        output: sliced,
        truncated,
        metadata: {
          skillId: usage.id,
          skillVersion: usage.version,
          skillResourcePath: resourcePath,
          skillResourceKind: kind,
          skillResourceCharacters: sliced.length,
          skillResourceTokens: estimateTokens(sliced),
          skillResourceSha256: createHash("sha256").update(sliced).digest("hex"),
        },
      }),
    };
  }

  private async prepareRunScript(
    call: ToolCall,
    usages: SkillUseAudit[],
    workspaceRoot: string,
    now: Date,
  ): Promise<PreparedToolCall> {
    const args = parseArguments(runScriptSchema, call.arguments);
    const { usage, skill } = await this.resolveTurnSkill(usages, args.skill_id, workspaceRoot);
    const scriptPath = assertSafeRelative(args.path, "scripts");
    if (!usage.availableScripts.includes(scriptPath)) {
      throw new HammerCodeError("脚本不在本轮已发现并固化的 scripts/ 清单中", "SKILL_SCRIPT_NOT_DECLARED", true);
    }
    if (path.extname(scriptPath).toLowerCase() !== ".py") {
      throw new HammerCodeError("首版只允许纯文本 Python Skill 脚本", "SKILL_SCRIPT_TYPE_BLOCKED", true);
    }
    for (const argument of args.args) {
      if (/\.env|api[ _-]?key|credential|secret|token|(?:^|[\\/])\.\.(?:[\\/]|$)|^[/~]|https?:\/\//i.test(argument)) {
        throw new HammerCodeError("Skill 脚本参数包含路径、网络或凭据风险", "SKILL_SCRIPT_ARGUMENT_BLOCKED");
      }
    }
    const script = await this.readVerifiedText(skill, scriptPath, MAX_SCRIPT_CHARACTERS, "script");
    assertScriptSafe(script.content);
    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const cwd = await boundary.resolveExisting(args.cwd);
    const cwdInfo = await stat(cwd);
    if (!cwdInfo.isDirectory()) throw new HammerCodeError("Skill 脚本 cwd 不是目录", "NOT_A_DIRECTORY", true);
    const approvalRequest: ApprovalRequest = {
      id: this.ids.next("approval"),
      toolCallId: call.id,
      toolName: call.name,
      title: "运行 Skill 脚本",
      description: `运行 ${usage.name} 的 ${scriptPath}`,
      details: [
        `Skill: ${usage.id}@${usage.version}`,
        `脚本: ${scriptPath}`,
        `参数: ${JSON.stringify(args.args)}`,
        `cwd: ${boundary.relative(cwd)}`,
        "隔离: 无 API 凭据、无网络、不可写、不可读取工作区",
      ].join("\n"),
      risk: "command",
      createdAt: now.toISOString(),
    };
    return {
      call,
      summary: approvalRequest.description,
      target: `${usage.id}/${scriptPath}`,
      requiresApproval: true,
      approvalPolicy: "permission_mode",
      approvalRequest,
      execute: async (context) => {
        if (process.platform !== "darwin") {
          return {
            ok: false,
            summary: "当前系统不支持受限 Skill 脚本运行",
            output: "首版 Skill 脚本隔离只面向 macOS。",
            errorCode: "SKILL_SCRIPT_PLATFORM_UNSUPPORTED",
          };
        }
        const packageRoot = shellProfileLiteral(skill.root);
        const userHome = shellProfileLiteral(homedir());
        const workspace = shellProfileLiteral(boundary.root);
        const profile = [
          "(version 1)",
          "(allow default)",
          "(deny network*)",
          "(deny file-write*)",
          `(deny file-read* (require-all (subpath \"${workspace}\") (require-not (subpath \"${packageRoot}\"))))`,
          `(deny file-read* (require-all (subpath \"${userHome}\") (require-not (subpath \"${packageRoot}\"))))`,
        ].join(" ");
        const result = await runProcess({
          executable: "/usr/bin/sandbox-exec",
          args: ["-p", profile, "python3", "-I", "-c", script.content, ...args.args],
          cwd,
          timeoutMs: args.timeout_ms,
          maxOutputBytes: 60_000,
          signal: context.signal,
          env: {
            PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8",
            PYTHONDONTWRITEBYTECODE: "1",
          },
        });
        const metadata: NonNullable<ToolResult["metadata"]> = {
          ...(result.metadata ?? {}),
          skillId: usage.id,
          skillVersion: usage.version,
          skillScriptPath: scriptPath,
          skillScriptSha256: script.sha256,
        };
        return { ...result, metadata };
      },
    };
  }

  private async resolveTurnSkill(
    usages: SkillUseAudit[],
    skillId: string,
    workspaceRoot: string,
  ): Promise<{ usage: SkillUseAudit; skill: InternalSkill }> {
    const usage = usages.find((item) => item.id === skillId);
    if (!usage) throw new HammerCodeError("Skill 未在本轮被选择", "SKILL_NOT_SELECTED", true);
    const skill = (await this.discover(workspaceRoot)).find((item) =>
      item.manifest.id === usage.id &&
      item.manifest.version === usage.version &&
      item.source === usage.source,
    );
    if (!skill || skill.fingerprint !== usage.packageFingerprint) {
      throw new HammerCodeError("Skill 已在本轮运行期间更新；新版本只会影响下一轮", "SKILL_VERSION_CHANGED", true);
    }
    return { usage, skill };
  }

  private async discover(workspaceRoot: string | null): Promise<InternalSkill[]> {
    const statesBeforeDiscovery = JSON.stringify(this.settings.states);
    const roots: Array<{ source: SkillSource; root: string; workspaceRoot?: string }> = [
      { source: "builtin", root: this.options.builtinRoot },
      { source: "user", root: this.options.userRoot },
    ];
    if (workspaceRoot) {
      roots.push({
        source: "project",
        root: path.join(workspaceRoot, ".agents", "skills"),
        workspaceRoot,
      });
    }
    const skills: InternalSkill[] = [];
    for (const sourceRoot of roots) {
      let rootInfo;
      try {
        rootInfo = await lstat(sourceRoot.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue;
      const children = await readdir(sourceRoot.root, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink() || child.name.startsWith(".")) continue;
        try {
          skills.push(await this.inspectPackage(
            path.join(sourceRoot.root, child.name),
            sourceRoot.source,
            sourceRoot.workspaceRoot,
          ));
        } catch (error) {
          const fallbackId = child.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63) || "invalid-skill";
          const manifest: NormalizedSkillManifest = {
            id: fallbackId,
            name: child.name,
            version: "invalid",
            description: "无法读取这个 Skill 包。",
            when: "修复目录结构后可用。",
            license: "未知",
            entry: "SKILL.md" as const,
            compatibility: "",
            allowImplicitInvocation: false,
            triggers: { explicit: [fallbackId] },
            capabilities: { tools: [], scripts: [], runnableScripts: [] },
          };
          const key = stateKey(sourceRoot.source, manifest.id, sourceRoot.workspaceRoot);
          const state = this.settings.states[key] ?? this.defaultState(sourceRoot.source);
          skills.push({
            key,
            root: path.join(sourceRoot.root, child.name),
            source: sourceRoot.source,
            scope: scopeFor(sourceRoot.source),
            manifest,
            files: [],
            fingerprint: "",
            issues: [error instanceof Error ? error.message.slice(0, 300) : "Skill 包读取失败"],
            compatibilityIssues: ["包结构无效，当前无法使用"],
            trustInvalidated: Boolean(state.trustInvalidatedAt),
            ...state,
          });
        }
      }
    }
    const byId = new Map<string, InternalSkill[]>();
    for (const skill of skills) byId.set(skill.manifest.id, [...(byId.get(skill.manifest.id) ?? []), skill]);
    for (const duplicates of byId.values()) {
      if (duplicates.length < 2) continue;
      for (const skill of duplicates) skill.issues.push("Skill ID 与其他来源重复，已停止触发");
    }
    if (JSON.stringify(this.settings.states) !== statesBeforeDiscovery) await this.saveSettings();
    return skills.sort((left, right) => {
      const sourceOrder = { builtin: 0, user: 1, project: 2 } as const;
      return sourceOrder[left.source] - sourceOrder[right.source] || left.manifest.name.localeCompare(right.manifest.name, "zh-CN");
    });
  }

  private async inspectPackage(
    rootInput: string,
    source: SkillSource,
    workspaceRoot?: string,
    allowDirectoryAlias = false,
  ): Promise<InternalSkill> {
    const rootInfo = await lstat(rootInput);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new HammerCodeError("Skill 根目录无效或是符号链接", "SKILL_SYMLINK_BLOCKED");
    }
    const root = await realpath(rootInput);
    const entryPath = path.join(root, "SKILL.md");
    const entryInfo = await lstat(entryPath);
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || entryInfo.size > MAX_PACKAGE_BYTES) {
      throw new HammerCodeError("SKILL.md 缺失、过大或是符号链接", "SKILL_MANIFEST_INVALID", true);
    }
    const index = await readSkillIndex(entryPath);
    const openAiMetadata = await readOptionalOpenAiMetadata(root);
    if (!allowDirectoryAlias && path.basename(root) !== index.frontmatter.name) {
      throw new HammerCodeError(
        `Skill 目录名必须与 frontmatter name 一致：${index.frontmatter.name}`,
        "SKILL_MANIFEST_INVALID",
        true,
      );
    }
    const metadataVersion = index.frontmatter.metadata?.version;
    const manifest: NormalizedSkillManifest = {
      id: index.frontmatter.name,
      name: openAiMetadata.interface?.display_name ?? index.frontmatter.name,
      version: metadataVersion ? metadataVersion.slice(0, 80) : "unversioned",
      description: index.frontmatter.description,
      when: index.frontmatter.description,
      license: index.frontmatter.license ?? "未声明",
      entry: "SKILL.md",
      compatibility: index.frontmatter.compatibility ?? "",
      allowImplicitInvocation: openAiMetadata.policy?.allow_implicit_invocation !== false,
      triggers: {
        explicit: [index.frontmatter.name],
      },
      capabilities: {
        tools: allowedTools(index.frontmatter["allowed-tools"]),
        scripts: [],
        runnableScripts: [],
      },
    };
    const files: SkillFile[] = [];
    let totalBytes = 0;
    const issues: string[] = [];
    const compatibilityIssues: string[] = [];
    if ((openAiMetadata.dependencies?.tools?.length ?? 0) > 0) {
      compatibilityIssues.push("声明了当前版本尚未接入的外部工具依赖");
    }
    const visit = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children) {
        const candidate = path.join(directory, child.name);
        const relativePath = path.relative(root, candidate).split(path.sep).join("/");
        if (child.name.startsWith(".")) {
          issues.push(`不允许的隐藏文件或目录：${relativePath}`);
          continue;
        }
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) {
          issues.push(`禁止符号链接：${relativePath}`);
          continue;
        }
        const candidateReal = await realpath(candidate);
        if (candidateReal !== root && !candidateReal.startsWith(`${root}${path.sep}`)) {
          issues.push(`资源越出 Skill 根目录：${relativePath}`);
          continue;
        }
        if (info.isDirectory()) {
          await visit(candidate);
          continue;
        }
        if (!info.isFile()) {
          issues.push(`不支持的资源类型：${relativePath}`);
          continue;
        }
        totalBytes += info.size;
        const buffer = await readFile(candidateReal);
        const kind: SkillFile["kind"] = relativePath === manifest.entry
          ? "entry"
          : relativePath.startsWith("references/")
            ? "reference"
            : relativePath.startsWith("scripts/")
              ? "script"
              : "asset";
        files.push({
          relativePath,
          size: info.size,
          modifiedAt: info.mtimeMs,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          kind,
        });
        if (files.length > MAX_PACKAGE_FILES) issues.push(`文件数量超过 ${MAX_PACKAGE_FILES}`);
        if (info.size > MAX_PACKAGE_BYTES) issues.push(`单个资源过大：${relativePath}`);
      }
    };
    await visit(root);
    if (totalBytes > MAX_PACKAGE_BYTES) issues.push(`Skill 包总大小超过 ${MAX_PACKAGE_BYTES} 字节`);
    if (!files.some((file) => file.relativePath === manifest.entry && file.kind === "entry")) {
      issues.push("缺少标准 SKILL.md 入口");
    }
    manifest.capabilities.scripts = files
      .filter((file) => file.kind === "script")
      .map((file) => file.relativePath)
      .slice(0, 20);
    for (const script of manifest.capabilities.scripts) {
      try {
        const normalized = assertSafeRelative(script, "scripts");
        if (!files.some((file) => file.relativePath === normalized && file.kind === "script")) {
          issues.push(`声明的脚本不存在：${script}`);
        }
        if (path.extname(normalized).toLowerCase() !== ".py") {
          compatibilityIssues.push(`${script} 不是当前可执行的 Python 脚本`);
          continue;
        }
        const file = files.find((item) => item.relativePath === normalized);
        if (!file || file.size > MAX_SCRIPT_CHARACTERS) {
          compatibilityIssues.push(`${script} 超过当前脚本预算`);
          continue;
        }
        const content = (await readFile(path.join(root, ...normalized.split("/")))).toString("utf8");
        if (content.includes("\0")) {
          compatibilityIssues.push(`${script} 不是可执行的纯文本脚本`);
          continue;
        }
        const unsupported = unsupportedScriptImports(content);
        if (unsupported.length > 0) {
          compatibilityIssues.push(`${script} 需要额外依赖：${unsupported.join("、")}`);
          continue;
        }
        try {
          assertScriptSafe(content);
          manifest.capabilities.runnableScripts.push(normalized);
        } catch (error) {
          compatibilityIssues.push(`${script} 当前不可执行：${error instanceof Error ? error.message : "未通过安全检查"}`);
        }
      } catch (error) {
        issues.push(error instanceof Error ? error.message : `脚本路径无效：${script}`);
      }
    }
    const fingerprint = packageFingerprint(files);
    if (manifest.version === "unversioned") manifest.version = `sha256-${fingerprint.slice(0, 12)}`;
    const key = stateKey(source, manifest.id, workspaceRoot);
    const storedState = this.settings.states[key] ?? this.defaultState(source);
    const trustInvalidated = source === "project" && Boolean(
      storedState.trustInvalidatedAt ||
      (storedState.trusted && storedState.trustedFingerprint !== fingerprint),
    );
    const state = source === "project" && storedState.trusted && storedState.trustedFingerprint !== fingerprint
      ? {
          ...storedState,
          enabled: false,
          trusted: false,
          trustedFingerprint: undefined,
          trustInvalidatedAt: this.clock.now().toISOString(),
        }
      : storedState;
    if (state !== storedState) this.settings.states[key] = state;
    return {
      key,
      root,
      source,
      scope: scopeFor(source),
      manifest,
      files,
      fingerprint,
      issues: [...new Set(issues)].slice(0, 20),
      compatibilityIssues: [...new Set(compatibilityIssues)].slice(0, 20),
      trustInvalidated,
      ...state,
    };
  }

  private async validatePackageContents(skill: InternalSkill): Promise<void> {
    if (skill.issues.length > 0) throw new HammerCodeError(skill.issues.join("；"), "SKILL_INVALID", true);
    for (const file of skill.files) {
      if (file.kind === "asset") {
        const asset = await this.readVerifiedBuffer(skill, file.relativePath, "asset");
        if (!asset.buffer.includes(0) && asset.buffer.toString("utf8").length > MAX_RESOURCE_CHARACTERS) {
          throw new HammerCodeError(
            `Skill 文本 asset 超过 ${MAX_RESOURCE_CHARACTERS} 字符预算`,
            "SKILL_CONTEXT_BUDGET",
            true,
          );
        }
        continue;
      }
      if (file.kind === "script" && !skill.manifest.capabilities.runnableScripts.includes(file.relativePath)) {
        await this.readVerifiedBuffer(skill, file.relativePath, "script");
        continue;
      }
      const max = file.kind === "entry"
        ? MAX_ENTRY_CHARACTERS
        : file.kind === "script"
          ? MAX_SCRIPT_CHARACTERS
          : MAX_RESOURCE_CHARACTERS;
      const value = await this.readVerifiedText(skill, file.relativePath, max, file.kind);
      if (file.kind === "script") assertScriptSafe(value.content);
      else assertInstructionSafe(value.content);
    }
  }

  private async readVerifiedText(
    skill: InternalSkill,
    relativePathInput: string,
    maxCharacters: number,
    expectedKind: SkillResourceKind,
  ): Promise<{ content: string; sha256: string }> {
    const verified = await this.readVerifiedBuffer(skill, relativePathInput, expectedKind);
    if (verified.buffer.includes(0)) {
      throw new HammerCodeError("二进制 asset 只随包迁移，不能注入模型上下文", "SKILL_BINARY_BLOCKED", true);
    }
    const content = verified.buffer.toString("utf8");
    if (content.length > maxCharacters) {
      throw new HammerCodeError(`Skill 资源超过 ${maxCharacters} 字符预算`, "SKILL_CONTEXT_BUDGET", true);
    }
    return { content, sha256: verified.sha256 };
  }

  private async readVerifiedBuffer(
    skill: InternalSkill,
    relativePathInput: string,
    expectedKind: SkillResourceKind,
  ): Promise<{ buffer: Buffer; sha256: string }> {
    const relativePath = assertSafeRelative(relativePathInput);
    const listed = skill.files.find((file) => file.relativePath === relativePath);
    if (!listed || listed.kind !== expectedKind) {
      throw new HammerCodeError("Skill 资源不存在或类型不匹配", "SKILL_RESOURCE_NOT_FOUND", true);
    }
    const absolute = path.join(skill.root, ...relativePath.split("/"));
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new HammerCodeError("Skill 资源不是普通文件", "SKILL_SYMLINK_BLOCKED");
    }
    if (before.size !== listed.size || before.mtimeMs !== listed.modifiedAt) {
      throw new HammerCodeError("Skill 资源已在本轮运行期间更新", "SKILL_VERSION_CHANGED", true);
    }
    const resolved = await realpath(absolute);
    if (resolved !== skill.root && !resolved.startsWith(`${skill.root}${path.sep}`)) {
      throw new HammerCodeError("Skill 资源越出包目录", "SKILL_PATH_BLOCKED");
    }
    const buffer = await readFile(resolved);
    const after = await lstat(resolved);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new HammerCodeError("Skill 资源在读取期间发生变化", "SKILL_VERSION_CHANGED", true);
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (sha256 !== listed.sha256) {
      throw new HammerCodeError("Skill 资源内容指纹与本轮快照不一致", "SKILL_VERSION_CHANGED", true);
    }
    return { buffer, sha256 };
  }

  private async copyPackage(source: string, destination: string): Promise<void> {
    if (await lstat(destination).then(() => true).catch(() => false)) {
      throw new HammerCodeError("目标 Skill 目录已经存在", "SKILL_DUPLICATE_ID", true);
    }
    await mkdir(destination, { recursive: false, mode: 0o700 });
    const visit = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
      for (const child of await readdir(sourceDirectory, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDirectory, child.name);
        const destinationPath = path.join(destinationDirectory, child.name);
        const info = await lstat(sourcePath);
        if (info.isSymbolicLink()) throw new HammerCodeError("导入或导出时发现符号链接", "SKILL_SYMLINK_BLOCKED");
        if (info.isDirectory()) {
          await mkdir(destinationPath, { mode: 0o700 });
          await visit(sourcePath, destinationPath);
        } else if (info.isFile()) {
          await writeFile(destinationPath, await readFile(sourcePath), { mode: 0o600, flag: "wx" });
        }
      }
    };
    await visit(source, destination);
  }

  private defaultState(source: SkillSource): SkillState {
    return source === "project"
      ? { enabled: false, trusted: false }
      : { enabled: true, trusted: true };
  }

  private toPublic(skill: InternalSkill): PublicSkill {
    return {
      key: skill.key,
      id: skill.manifest.id,
      name: skill.manifest.name,
      version: skill.manifest.version,
      description: skill.manifest.description,
      when: skill.manifest.when,
      license: skill.manifest.license,
      compatibility: skill.manifest.compatibility,
      compatibilityStatus: skill.issues.length > 0
        ? "incompatible"
        : skill.compatibilityIssues.length > 0
          ? "partial"
          : "compatible",
      compatibilityIssues: [...skill.compatibilityIssues],
      source: skill.source,
      scope: skill.scope,
      enabled: skill.enabled,
      trusted: skill.trusted,
      valid: skill.issues.length === 0,
      issues: skill.issues,
      trustInvalidated: skill.trustInvalidated,
      packageFingerprint: skill.fingerprint,
      capabilities: {
        tools: [...skill.manifest.capabilities.tools],
        scripts: [...skill.manifest.capabilities.scripts],
      },
      lastUsedAt: skill.lastUsedAt,
    };
  }

  private async saveSettings(): Promise<void> {
    const temporary = `${this.options.settingsFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.options.settingsFile);
    await chmod(this.options.settingsFile, 0o600);
  }

  private async notify(workspaceRoot: string | null): Promise<SkillInventorySnapshot> {
    const snapshot = await this.inventory(workspaceRoot);
    await this.onChange?.(snapshot);
    return snapshot;
  }
}
