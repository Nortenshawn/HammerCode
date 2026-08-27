import path from "node:path";
import { app } from "electron";
import dotenv from "dotenv";
import { z } from "zod";
import type { PublicRuntimeConfig } from "../shared/contracts";
import { HammerCodeError } from "../core/types";

const configSchema = z.object({
  apiKey: z.string(),
  apiBaseUrl: z.string().url(),
  model: z.string().min(1),
  thinking: z.enum(["enabled", "disabled"]),
  reasoningEffort: z.enum(["low", "high", "max"]),
  maxOutputTokens: z.number().int().min(256).max(384_000),
  contextTokenBudget: z.number().int().min(4_000).max(900_000),
  maxAgentRounds: z.number().int().min(1).max(100),
  requestTimeoutMs: z.number().int().min(5_000).max(600_000),
});

export type RuntimeConfig = z.infer<typeof configSchema>;

function readInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const localConfigPaths = app.isPackaged
    ? [path.join(app.getPath("userData"), ".env")]
    : [path.join(app.getAppPath(), ".env"), path.join(app.getPath("userData"), ".env")];
  for (const configPath of localConfigPaths) {
    dotenv.config({ path: configPath, quiet: true });
  }
  const parsed = configSchema.safeParse({
    apiKey:
      process.env.DEEPSEEK_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.API_KEY ??
      "",
    apiBaseUrl:
      process.env.HAMMERCODE_API_BASE_URL ??
      process.env.DEEPSEEK_BASE_URL ??
      process.env.BASE_URL ??
      "https://api.deepseek.com",
    model:
      process.env.HAMMERCODE_MODEL ??
      process.env.DEEPSEEK_MODEL ??
      process.env.MODEL ??
      "deepseek-v4-flash",
    thinking: process.env.HAMMERCODE_THINKING ?? "enabled",
    reasoningEffort: process.env.HAMMERCODE_REASONING_EFFORT ?? "high",
    maxOutputTokens: readInteger(process.env.HAMMERCODE_MAX_OUTPUT_TOKENS, 16_384),
    contextTokenBudget: readInteger(
      process.env.HAMMERCODE_CONTEXT_TOKEN_BUDGET,
      120_000,
    ),
    maxAgentRounds: readInteger(process.env.HAMMERCODE_MAX_AGENT_ROUNDS, 20),
    requestTimeoutMs: readInteger(process.env.HAMMERCODE_REQUEST_TIMEOUT_MS, 180_000),
  });
  if (!parsed.success) {
    const safeIssues = parsed.error.issues.map((issue) => issue.path.join(".")).join("、");
    throw new HammerCodeError(`运行配置无效：${safeIssues}`, "INVALID_CONFIG", true);
  }
  const endpoint = new URL(parsed.data.apiBaseUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new HammerCodeError(
      "API base URL 不得包含凭据、查询参数或片段",
      "INVALID_CONFIG",
      true,
    );
  }
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname))
  ) {
    throw new HammerCodeError(
      "远程 API endpoint 必须使用 HTTPS（本机 localhost 可使用 HTTP）",
      "INVALID_CONFIG",
      true,
    );
  }
  return parsed.data;
}

export function toPublicConfig(config: RuntimeConfig): PublicRuntimeConfig {
  let displayBaseUrl: string;
  try {
    const url = new URL(config.apiBaseUrl);
    displayBaseUrl = `${url.protocol}//${url.host}`;
  } catch {
    displayBaseUrl = "（无效地址）";
  }
  return {
    model: config.model,
    apiBaseUrl: displayBaseUrl,
    thinking: config.thinking,
    reasoningEffort: config.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens,
    contextTokenBudget: config.contextTokenBudget,
    maxAgentRounds: config.maxAgentRounds,
    hasApiKey: Boolean(config.apiKey),
  };
}
