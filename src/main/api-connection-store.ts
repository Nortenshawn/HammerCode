import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HammerCodeError } from "../core/types";
import { redactSecrets } from "../core/utils";
import type {
  ApiConnectionInput,
  ApiConnectionTestResult,
  PublicApiConnection,
  PublicModelOption,
} from "../shared/contracts";

const MAX_PROBE_BYTES = 1_000_000;
const MAX_MODELS = 500;
const PROBE_TIMEOUT_MS = 15_000;

const connectionInputSchema = z
  .object({
    apiBaseUrl: z.string().trim().min(1).max(2_048),
    apiKey: z.string().trim().min(1).max(16_384),
  })
  .strict();

const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(500) }).passthrough()).min(1),
});

const storedConnectionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  apiBaseUrl: z.string().url(),
  encryptedApiKey: z.string().min(1),
  models: z.array(z.string()).min(1).max(MAX_MODELS),
  status: z.enum(["connected", "error"]),
  lastCheckedAt: z.string(),
  error: z.string().optional(),
});

const storeSchema = z.object({
  version: z.literal(1),
  connections: z.array(storedConnectionSchema),
});

type StoredConnection = z.infer<typeof storedConnectionSchema>;

export interface CredentialCipher {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface ResolvedCustomModel {
  connectionId: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

function displayName(baseUrl: string): string {
  const url = new URL(baseUrl);
  const suffix = url.pathname === "/" ? "" : url.pathname;
  return `${url.hostname}${suffix}`;
}

export function normalizeApiBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new HammerCodeError("API URL 格式无效", "INVALID_API_URL", true);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HammerCodeError(
      "API URL 不得包含账号、密码、查询参数或片段",
      "INVALID_API_URL",
      true,
    );
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new HammerCodeError(
      "远程 API 必须使用 HTTPS；仅本机地址可使用 HTTP",
      "INVALID_API_URL",
      true,
    );
  }
  url.pathname = url.pathname
    .replace(/\/(?:chat\/completions|models)\/?$/i, "")
    .replace(/\/+$/, "") || "/";
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}

export function customModelRef(connectionId: string, model: string): string {
  return `custom:${connectionId}:${encodeURIComponent(model)}`;
}

export function parseCustomModelRef(ref: string): { connectionId: string; model: string } | null {
  const match = /^custom:([0-9a-f-]{36}):(.+)$/i.exec(ref);
  if (!match) return null;
  try {
    const model = decodeURIComponent(match[2]);
    return model ? { connectionId: match[1], model } : null;
  } catch {
    return null;
  }
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

export class ApiConnectionStore {
  private readonly filePath: string;
  private readonly fetchImpl: typeof fetch;
  private connections: StoredConnection[] = [];
  private loaded = false;

  constructor(
    dataDirectory: string,
    private readonly cipher: CredentialCipher,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.filePath = path.join(dataDirectory, "api-connections.json");
    this.fetchImpl = fetchImpl;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = storeSchema.safeParse(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
      this.connections = parsed.success ? parsed.data.connections : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.connections = [];
    }
  }

  listPublic(): PublicApiConnection[] {
    return this.connections.map(({ encryptedApiKey: _secret, ...connection }) => ({ ...connection }));
  }

  listModelOptions(): PublicModelOption[] {
    return this.connections.flatMap((connection) =>
      connection.models.map((model) => ({
        ref: customModelRef(connection.id, model),
        label: `${model} · ${connection.name}`,
        provider: "custom" as const,
        model,
        apiBaseUrl: connection.apiBaseUrl,
        hasApiKey: true,
        connectionId: connection.id,
      })),
    );
  }

  async test(input: ApiConnectionInput): Promise<ApiConnectionTestResult> {
    const parsed = connectionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new HammerCodeError("请提供有效的 API URL 和 API Key", "INVALID_API_CONNECTION", true);
    }
    const apiBaseUrl = normalizeApiBaseUrl(parsed.data.apiBaseUrl);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("连接检测超时", "TimeoutError")),
      PROBE_TIMEOUT_MS,
    );
    try {
      const response = await this.fetchImpl(`${apiBaseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${parsed.data.apiKey}`,
          Accept: "application/json",
        },
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
        throw new HammerCodeError(
          "服务端 /models 响应不符合 OpenAI-compatible 格式",
          "API_PROBE_INCOMPATIBLE",
          true,
        );
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

  async save(input: ApiConnectionInput): Promise<PublicApiConnection> {
    const result = await this.test(input);
    if (!this.cipher.isAvailable()) {
      throw new HammerCodeError(
        "系统安全存储当前不可用，连接检测成功但未保存 API Key",
        "SECURE_STORAGE_UNAVAILABLE",
        true,
      );
    }
    const parsed = connectionInputSchema.parse(input);
    const existing = this.connections.find((item) => item.apiBaseUrl === result.apiBaseUrl);
    const connection: StoredConnection = {
      id: existing?.id ?? randomUUID(),
      name: displayName(result.apiBaseUrl),
      apiBaseUrl: result.apiBaseUrl,
      encryptedApiKey: this.cipher.encrypt(parsed.apiKey).toString("base64"),
      models: result.models,
      status: "connected",
      lastCheckedAt: new Date().toISOString(),
    };
    this.connections = [connection, ...this.connections.filter((item) => item.id !== connection.id)];
    await this.persist();
    const { encryptedApiKey: _secret, ...publicConnection } = connection;
    return publicConnection;
  }

  resolve(ref: string): ResolvedCustomModel | null {
    const parsed = parseCustomModelRef(ref);
    if (!parsed) return null;
    const connection = this.connections.find((item) => item.id === parsed.connectionId);
    if (!connection || !connection.models.includes(parsed.model)) return null;
    if (!this.cipher.isAvailable()) {
      throw new HammerCodeError("系统安全存储当前不可用，无法读取自定义 API Key", "SECURE_STORAGE_UNAVAILABLE", true);
    }
    let apiKey: string;
    try {
      apiKey = this.cipher.decrypt(Buffer.from(connection.encryptedApiKey, "base64"));
    } catch {
      throw new HammerCodeError("自定义 API Key 无法解密，请重新保存连接", "API_KEY_DECRYPT_FAILED", true);
    }
    return {
      connectionId: connection.id,
      apiBaseUrl: connection.apiBaseUrl,
      apiKey,
      model: parsed.model,
    };
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(
        temp,
        `${JSON.stringify({ version: 1, connections: this.connections }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temp, this.filePath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
