import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HammerCodeError } from "../core/types";
import { redactSecrets } from "../core/utils";
import {
  BUILTIN_MODEL_REFS,
  MODEL_TIERS,
  type BuiltinModelRef,
  type ModelConnectionProbeInput,
  type ModelConnectionSaveInput,
  type ModelConnectionTestResult,
  type ModelRef,
  type ModelTier,
  type PublicModelConnection,
} from "../shared/contracts";

const MAX_PROBE_BYTES = 1_000_000;
const MAX_MODELS = 500;
const PROBE_TIMEOUT_MS = 15_000;

const connectionIdSchema = z.union([z.enum(BUILTIN_MODEL_REFS), z.string().uuid()]);
const probeInputSchema = z.object({
  connectionId: connectionIdSchema.optional(),
  apiBaseUrl: z.string().trim().min(1).max(2_048),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
}).strict();
const saveInputSchema = z.object({
  connectionId: connectionIdSchema.optional(),
  name: z.string().trim().min(1).max(60),
  tier: z.enum(MODEL_TIERS),
  model: z.string().trim().min(1).max(500),
  apiBaseUrl: z.string().trim().min(1).max(2_048),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
}).strict();
const nameSchema = z.string().trim().min(1).max(60);
const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(500) }).passthrough()).min(1),
});
const storedConnectionSchema = z.object({
  id: connectionIdSchema,
  kind: z.enum(["default", "custom"]),
  name: z.string().min(1).max(60),
  tier: z.enum(MODEL_TIERS),
  apiBaseUrl: z.string().url(),
  model: z.string().min(1).max(500),
  encryptedApiKey: z.string().min(1).optional(),
  models: z.array(z.string().min(1).max(500)).max(MAX_MODELS),
  status: z.enum(["missing", "configured", "connected", "error"]),
  lastCheckedAt: z.string().optional(),
  error: z.string().max(1_000).optional(),
}).strict();
const storeSchema = z.object({
  version: z.literal(2),
  connections: z.array(storedConnectionSchema).max(100),
}).strict();
const legacyCredentialSchema = z.object({
  apiBaseUrl: z.string().url(),
  encryptedApiKey: z.string().min(1),
  status: z.enum(["configured", "connected", "error"]),
  lastCheckedAt: z.string().optional(),
  error: z.string().optional(),
});
const legacyStoreSchema = z.object({
  version: z.literal(1),
  credentials: z.object({
    fast: legacyCredentialSchema.optional(),
    strong: legacyCredentialSchema.optional(),
  }),
});

type StoredConnection = z.infer<typeof storedConnectionSchema>;
type LegacyCredential = z.infer<typeof legacyCredentialSchema>;

export interface CredentialCipher {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface ModelFallback {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
}

export interface ResolvedModelCredential {
  id: string;
  ref: ModelRef;
  kind: "default" | "custom";
  name: string;
  tier: ModelTier;
  model: string;
  apiKey: string;
  apiBaseUrl: string;
  status: "missing" | "configured" | "connected" | "error";
  lastCheckedAt?: string;
  error?: string;
}

export function normalizeApiBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new HammerCodeError("API URL 格式无效", "INVALID_API_URL", true);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HammerCodeError("API URL 不得包含账号、密码、查询参数或片段", "INVALID_API_URL", true);
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new HammerCodeError("远程 API 必须使用 HTTPS；仅本机地址可使用 HTTP", "INVALID_API_URL", true);
  }
  url.pathname = url.pathname
    .replace(/\/(?:chat\/completions|models)\/?$/i, "")
    .replace(/\/+$/, "") || "/";
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}

export function connectionModelRef(id: string): ModelRef {
  if (id === "builtin:fast" || id === "builtin:strong") return id;
  return `connection:${id}`;
}

export function parseConnectionModelRef(ref: string): string | null {
  if (ref === "builtin:fast" || ref === "builtin:strong") return ref;
  const match = /^connection:([0-9a-f-]{36})$/i.exec(ref);
  return match && z.string().uuid().safeParse(match[1]).success ? match[1] : null;
}

async function readResponseLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PROBE_BYTES) {
    throw new HammerCodeError("模型列表响应过大", "API_PROBE_RESPONSE_TOO_LARGE", true);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PROBE_BYTES) {
        await reader.cancel();
        throw new HammerCodeError("模型列表响应过大", "API_PROBE_RESPONSE_TOO_LARGE", true);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class ModelCredentialStore {
  private readonly filePath: string;
  private readonly obsoleteFilePath: string;
  private readonly fetchImpl: typeof fetch;
  private connections: StoredConnection[] = [];
  private loaded = false;

  constructor(
    settingsDirectory: string,
    private readonly cipher: CredentialCipher,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.filePath = path.join(settingsDirectory, "model-credentials.json");
    this.obsoleteFilePath = path.join(settingsDirectory, "api-connections.json");
    this.fetchImpl = fetchImpl;
  }

  async load(fallbacks: Record<ModelTier, ModelFallback>): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let legacy: Partial<Record<ModelTier, LegacyCredential>> = {};
    let changed = false;
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      const current = storeSchema.safeParse(raw);
      if (current.success) this.connections = current.data.connections;
      else {
        const previous = legacyStoreSchema.safeParse(raw);
        if (previous.success) legacy = previous.data.credentials;
        changed = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") changed = true;
    }

    for (const tier of MODEL_TIERS) {
      const id: BuiltinModelRef = tier === "fast" ? "builtin:fast" : "builtin:strong";
      const index = this.connections.findIndex((connection) => connection.id === id);
      if (index >= 0) {
        const current = this.connections[index];
        if (current.kind !== "default" || current.tier !== tier) {
          this.connections[index] = { ...current, kind: "default", tier };
          changed = true;
        }
        continue;
      }
      const fallback = fallbacks[tier];
      const previous = legacy[tier];
      let encryptedApiKey = previous?.encryptedApiKey;
      if (!encryptedApiKey && fallback.apiKey && this.cipher.isAvailable()) {
        encryptedApiKey = this.cipher.encrypt(fallback.apiKey).toString("base64");
      }
      this.connections.push({
        id,
        kind: "default",
        name: tier === "fast" ? "Fast" : "Strong",
        tier,
        apiBaseUrl: normalizeApiBaseUrl(previous?.apiBaseUrl ?? fallback.apiBaseUrl),
        model: fallback.model,
        encryptedApiKey,
        models: [fallback.model],
        status: previous?.status ?? (fallback.apiKey ? "configured" : "missing"),
        lastCheckedAt: previous?.lastCheckedAt,
        error: previous?.error,
      });
      changed = true;
    }
    this.connections = this.sortedConnections(this.connections);
    if (changed) await this.persist();
    await rm(this.obsoleteFilePath, { force: true });
  }

  listPublic(fallbacks: Record<ModelTier, ModelFallback>): PublicModelConnection[] {
    return this.connections.map((connection) => this.toPublic(connection, fallbacks));
  }

  resolve(ref: string, fallbacks: Record<ModelTier, ModelFallback>): ResolvedModelCredential | null {
    const id = parseConnectionModelRef(ref);
    if (!id) return null;
    const connection = this.connections.find((item) => item.id === id);
    if (!connection) return null;
    const fallback = connection.kind === "default" ? fallbacks[connection.tier] : undefined;
    let apiKey = fallback?.apiKey ?? "";
    let error = connection.error;
    if (connection.encryptedApiKey) {
      if (!this.cipher.isAvailable()) {
        if (!apiKey) error = "系统安全存储不可用";
      } else {
        try {
          apiKey = this.cipher.decrypt(Buffer.from(connection.encryptedApiKey, "base64"));
        } catch {
          if (!apiKey) error = "已保存的 API Key 无法解密，请重新配置";
        }
      }
    }
    const status = apiKey
      ? error ? "error" : connection.status === "missing" ? "configured" : connection.status
      : error ? "error" : "missing";
    return {
      id: connection.id,
      ref: connectionModelRef(connection.id),
      kind: connection.kind,
      name: connection.name,
      tier: connection.tier,
      model: connection.model,
      apiKey,
      apiBaseUrl: connection.apiBaseUrl,
      status,
      lastCheckedAt: connection.lastCheckedAt,
      error,
    };
  }

  async test(
    input: ModelConnectionProbeInput,
    fallbacks: Record<ModelTier, ModelFallback>,
  ): Promise<ModelConnectionTestResult> {
    const parsed = probeInputSchema.parse(input);
    const existing = parsed.connectionId
      ? this.connections.find((connection) => connection.id === parsed.connectionId)
      : undefined;
    if (parsed.connectionId && !existing) {
      throw new HammerCodeError("找不到这条模型连接", "MODEL_CONNECTION_NOT_FOUND", true);
    }
    const resolved = existing ? this.resolve(connectionModelRef(existing.id), fallbacks) : null;
    const apiKey = parsed.apiKey ?? resolved?.apiKey ?? "";
    const apiBaseUrl = normalizeApiBaseUrl(parsed.apiBaseUrl);
    const probe = await this.probe(apiBaseUrl, apiKey);
    return { connectionId: parsed.connectionId, ...probe, status: "connected" };
  }

  async save(
    input: ModelConnectionSaveInput,
    fallbacks: Record<ModelTier, ModelFallback>,
  ): Promise<PublicModelConnection> {
    const parsed = saveInputSchema.parse(input);
    const existing = parsed.connectionId
      ? this.connections.find((connection) => connection.id === parsed.connectionId)
      : undefined;
    if (parsed.connectionId && !existing) {
      throw new HammerCodeError("找不到这条模型连接", "MODEL_CONNECTION_NOT_FOUND", true);
    }
    if (existing?.kind === "default" && existing.tier !== parsed.tier) {
      throw new HammerCodeError("Fast/Strong 默认槽不能改变运行档位", "DEFAULT_MODEL_TIER_IMMUTABLE", true);
    }
    if (!this.cipher.isAvailable()) {
      throw new HammerCodeError("系统安全存储当前不可用，不能保存 API Key", "SECURE_STORAGE_UNAVAILABLE", true);
    }
    const resolved = existing ? this.resolve(connectionModelRef(existing.id), fallbacks) : null;
    const apiKey = parsed.apiKey ?? resolved?.apiKey ?? "";
    if (!apiKey) throw new HammerCodeError("请输入 API Key", "API_KEY_REQUIRED", true);
    const apiBaseUrl = normalizeApiBaseUrl(parsed.apiBaseUrl);
    const probe = await this.probe(apiBaseUrl, apiKey);
    if (!probe.models.includes(parsed.model)) {
      throw new HammerCodeError(`服务端没有返回所选模型 ${parsed.model}`, "MODEL_NOT_AVAILABLE", true);
    }
    const id = existing?.id ?? randomUUID();
    const connection: StoredConnection = {
      id,
      kind: existing?.kind ?? "custom",
      name: parsed.name,
      tier: existing?.kind === "default" ? existing.tier : parsed.tier,
      apiBaseUrl,
      model: parsed.model,
      encryptedApiKey: this.cipher.encrypt(apiKey).toString("base64"),
      models: probe.models,
      status: "connected",
      lastCheckedAt: new Date().toISOString(),
    };
    this.connections = this.sortedConnections([
      ...this.connections.filter((item) => item.id !== id),
      connection,
    ]);
    await this.persist();
    return this.toPublic(connection, fallbacks);
  }

  async rename(
    connectionId: string,
    name: string,
    fallbacks: Record<ModelTier, ModelFallback>,
  ): Promise<PublicModelConnection> {
    const id = connectionIdSchema.parse(connectionId);
    const connection = this.connections.find((item) => item.id === id);
    if (!connection) throw new HammerCodeError("找不到这条模型连接", "MODEL_CONNECTION_NOT_FOUND", true);
    connection.name = nameSchema.parse(name);
    await this.persist();
    return this.toPublic(connection, fallbacks);
  }

  async delete(connectionId: string): Promise<void> {
    const id = connectionIdSchema.parse(connectionId);
    const connection = this.connections.find((item) => item.id === id);
    if (!connection) throw new HammerCodeError("找不到这条模型连接", "MODEL_CONNECTION_NOT_FOUND", true);
    if (connection.kind === "default") {
      throw new HammerCodeError("Fast/Strong 默认连接不能删除", "DEFAULT_MODEL_CONNECTION_REQUIRED", true);
    }
    this.connections = this.connections.filter((item) => item.id !== id);
    await this.persist();
  }

  private async probe(apiBaseUrl: string, apiKey: string): Promise<{
    apiBaseUrl: string;
    models: string[];
    latencyMs: number;
  }> {
    if (!apiKey.trim()) throw new HammerCodeError("请输入 API Key", "API_KEY_REQUIRED", true);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("连接检测超时", "TimeoutError")),
      PROBE_TIMEOUT_MS,
    );
    try {
      const response = await this.fetchImpl(`${apiBaseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      const body = await readResponseLimited(response);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new HammerCodeError("API Key 未通过服务端认证", "API_AUTH_FAILED", true);
        }
        throw new HammerCodeError(
          `连接检测失败（HTTP ${response.status}）：${redactSecrets(body).slice(0, 500) || response.statusText}`,
          "API_PROBE_HTTP_ERROR",
          true,
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new HammerCodeError("服务端 /models 返回的不是有效 JSON", "API_PROBE_INVALID_JSON", true);
      }
      const models = modelsResponseSchema.safeParse(json);
      if (!models.success) {
        throw new HammerCodeError("服务端 /models 响应不符合 OpenAI-compatible 格式", "API_PROBE_INCOMPATIBLE", true);
      }
      return {
        apiBaseUrl,
        models: [...new Set(models.data.data.map((item) => item.id))]
          .sort((left, right) => left.localeCompare(right))
          .slice(0, MAX_MODELS),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HammerCodeError("连接检测超时，请检查地址或网络", "API_PROBE_TIMEOUT", true);
      }
      if (error instanceof HammerCodeError) throw error;
      throw new HammerCodeError(
        `无法连接 API 服务：${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        "API_PROBE_NETWORK_ERROR",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private toPublic(
    connection: StoredConnection,
    fallbacks: Record<ModelTier, ModelFallback>,
  ): PublicModelConnection {
    const resolved = this.resolve(connectionModelRef(connection.id), fallbacks)!;
    return {
      id: connection.id,
      ref: connectionModelRef(connection.id),
      kind: connection.kind,
      name: connection.name,
      tier: connection.tier,
      provider: connection.tier === "fast" ? "deepseek" : "zhipu",
      model: connection.model,
      apiBaseUrl: connection.apiBaseUrl,
      hasApiKey: Boolean(resolved.apiKey),
      connectionStatus: resolved.status,
      connectionMessage: resolved.error,
      lastCheckedAt: resolved.lastCheckedAt,
    };
  }

  private sortedConnections(connections: StoredConnection[]): StoredConnection[] {
    return [...connections].sort((left, right) => {
      const priority = (value: StoredConnection): number => value.id === "builtin:fast" ? 0 : value.id === "builtin:strong" ? 1 : 2;
      return priority(left) - priority(right) || left.name.localeCompare(right.name);
    });
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const checked = storeSchema.parse({ version: 2, connections: this.connections });
      await writeFile(temp, `${JSON.stringify(checked, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temp, this.filePath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
