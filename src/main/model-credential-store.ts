import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HammerCodeError } from "../core/types";
import { redactSecrets } from "../core/utils";
import { MODEL_TIERS, type ModelConnectionInput, type ModelConnectionTestResult, type ModelTier } from "../shared/contracts";

const MAX_PROBE_BYTES = 1_000_000;
const PROBE_TIMEOUT_MS = 15_000;

const inputSchema = z.object({
  tier: z.enum(MODEL_TIERS),
  apiBaseUrl: z.string().trim().min(1).max(2_048),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
}).strict();

const credentialSchema = z.object({
  apiBaseUrl: z.string().url(),
  encryptedApiKey: z.string().min(1),
  status: z.enum(["configured", "connected", "error"]),
  lastCheckedAt: z.string().optional(),
  error: z.string().optional(),
});

const storeSchema = z.object({
  version: z.literal(1),
  credentials: z.object({
    fast: credentialSchema.optional(),
    strong: credentialSchema.optional(),
  }),
});

const legacyStoreSchema = z.object({
  version: z.literal(1),
  connections: z.array(z.object({
    apiBaseUrl: z.string().url(),
    encryptedApiKey: z.string().min(1),
    models: z.array(z.string()),
  }).passthrough()),
});

const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(500) }).passthrough()).min(1),
});

type StoredCredential = z.infer<typeof credentialSchema>;

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
  private readonly legacyFilePath: string;
  private readonly fetchImpl: typeof fetch;
  private credentials: Partial<Record<ModelTier, StoredCredential>> = {};
  private loaded = false;

  constructor(
    settingsDirectory: string,
    private readonly cipher: CredentialCipher,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.filePath = path.join(settingsDirectory, "model-credentials.json");
    this.legacyFilePath = path.join(settingsDirectory, "api-connections.json");
    this.fetchImpl = fetchImpl;
  }

  async load(fallbacks: Record<ModelTier, ModelFallback>): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = storeSchema.safeParse(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
      this.credentials = parsed.success ? parsed.data.credentials : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.credentials = {};
    }

    let changed = false;
    if (this.cipher.isAvailable()) {
      const legacy = await this.readLegacy();
      for (const tier of MODEL_TIERS) {
        if (this.credentials[tier]) continue;
        const fallback = fallbacks[tier];
        let apiKey = fallback.apiKey;
        let apiBaseUrl = fallback.apiBaseUrl;
        if (!apiKey) {
          const matching = legacy.find((connection) => connection.models.includes(fallback.model));
          if (matching) {
            try {
              apiKey = this.cipher.decrypt(Buffer.from(matching.encryptedApiKey, "base64"));
              apiBaseUrl = matching.apiBaseUrl;
            } catch {
              apiKey = "";
            }
          }
        }
        if (!apiKey) continue;
        this.credentials[tier] = {
          apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
          encryptedApiKey: this.cipher.encrypt(apiKey).toString("base64"),
          status: "configured",
        };
        changed = true;
      }
      if (changed) await this.persist();
      await rm(this.legacyFilePath, { force: true });
    }
  }

  resolve(tier: ModelTier, fallback: ModelFallback): ResolvedModelCredential {
    const stored = this.credentials[tier];
    if (!stored) {
      return {
        apiKey: fallback.apiKey,
        apiBaseUrl: fallback.apiBaseUrl,
        status: fallback.apiKey ? "configured" : "missing",
      };
    }
    if (!this.cipher.isAvailable()) {
      return {
        apiKey: fallback.apiKey,
        apiBaseUrl: stored.apiBaseUrl,
        status: fallback.apiKey ? stored.status : "error",
        lastCheckedAt: stored.lastCheckedAt,
        error: fallback.apiKey ? stored.error : "系统安全存储不可用",
      };
    }
    try {
      return {
        apiKey: this.cipher.decrypt(Buffer.from(stored.encryptedApiKey, "base64")),
        apiBaseUrl: stored.apiBaseUrl,
        status: stored.status,
        lastCheckedAt: stored.lastCheckedAt,
        error: stored.error,
      };
    } catch {
      return {
        apiKey: fallback.apiKey,
        apiBaseUrl: stored.apiBaseUrl,
        status: "error",
        lastCheckedAt: stored.lastCheckedAt,
        error: "已保存的 API Key 无法解密，请重新配置",
      };
    }
  }

  async test(input: ModelConnectionInput, fallback: ModelFallback): Promise<ModelConnectionTestResult> {
    const parsed = inputSchema.parse(input);
    const resolved = this.resolve(parsed.tier, fallback);
    return this.probe(
      parsed.tier,
      normalizeApiBaseUrl(parsed.apiBaseUrl),
      parsed.apiKey ?? resolved.apiKey,
      fallback.model,
    );
  }

  async save(input: ModelConnectionInput, fallback: ModelFallback): Promise<ModelConnectionTestResult> {
    const parsed = inputSchema.parse(input);
    if (!this.cipher.isAvailable()) {
      throw new HammerCodeError("系统安全存储当前不可用，不能保存 API Key", "SECURE_STORAGE_UNAVAILABLE", true);
    }
    const current = this.resolve(parsed.tier, fallback);
    const apiKey = parsed.apiKey ?? current.apiKey;
    const apiBaseUrl = normalizeApiBaseUrl(parsed.apiBaseUrl);
    const result = await this.probe(parsed.tier, apiBaseUrl, apiKey, fallback.model);
    this.credentials[parsed.tier] = {
      apiBaseUrl,
      encryptedApiKey: this.cipher.encrypt(apiKey).toString("base64"),
      status: "connected",
      lastCheckedAt: new Date().toISOString(),
    };
    await this.persist();
    return result;
  }

  private async probe(
    tier: ModelTier,
    apiBaseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<ModelConnectionTestResult> {
    if (!apiKey.trim()) {
      throw new HammerCodeError(`${tier === "fast" ? "Fast" : "Strong"} 尚未配置 API Key`, "API_KEY_REQUIRED", true);
    }
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
      if (!models.data.data.some((item) => item.id === model)) {
        throw new HammerCodeError(`服务端没有返回当前固定模型 ${model}`, "MODEL_NOT_AVAILABLE", true);
      }
      return {
        tier,
        apiBaseUrl,
        model,
        latencyMs: Date.now() - startedAt,
        status: "connected",
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

  private async readLegacy(): Promise<Array<z.infer<typeof legacyStoreSchema>["connections"][number]>> {
    try {
      const parsed = legacyStoreSchema.safeParse(JSON.parse(await readFile(this.legacyFilePath, "utf8")) as unknown);
      return parsed.success ? parsed.data.connections : [];
    } catch {
      return [];
    }
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify({ version: 1, credentials: this.credentials }, null, 2)}\n`, {
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
