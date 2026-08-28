import path from "node:path";
import { app } from "electron";
import dotenv from "dotenv";
import { z } from "zod";
import { HammerCodeError } from "../core/types";
import type { ModelTier, PublicModelConfig, PublicRuntimeConfig } from "../shared/contracts";

const modelConfigSchema = z.object({
  provider: z.enum(["deepseek", "zhipu"]),
  apiKey: z.string(),
  apiBaseUrl: z.string().url(),
  model: z.string().min(1),
  thinking: z.enum(["enabled", "disabled"]),
  reasoningEffort: z.enum(["low", "high", "max"]),
  maxOutputTokens: z.number().int().min(256).max(384_000),
  requestTimeoutMs: z.number().int().min(5_000).max(600_000),
});
const configSchema = z.object({
  models: z.object({ fast: modelConfigSchema, strong: modelConfigSchema }),
  contextTokenBudget: z.number().int().min(4_000).max(900_000),
  maxAgentRounds: z.number().int().min(1).max(100),
});

export type RuntimeModelConfig = z.infer<typeof modelConfigSchema>;
export type RuntimeConfig = z.infer<typeof configSchema>;

function readInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function validateEndpoint(value: string): void {
  const endpoint = new URL(value);
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
}

export function loadRuntimeConfig(): RuntimeConfig {
  const localConfigPaths = app.isPackaged
    ? [path.join(app.getPath("userData"), ".env")]
    : [path.join(app.getAppPath(), ".env"), path.join(app.getPath("userData"), ".env")];
  for (const configPath of localConfigPaths) dotenv.config({ path: configPath, quiet: true });

  const requestTimeoutMs = readInteger(process.env.HAMMERCODE_REQUEST_TIMEOUT_MS, 600_000);
  const parsed = configSchema.safeParse({
    models: {
      fast: {
        provider: "deepseek",
        apiKey:
          process.env.DEEPSEEK_API_KEY ??
          process.env.OPENAI_API_KEY ??
          process.env.API_KEY ??
          "",
        apiBaseUrl:
          process.env.DEEPSEEK_BASE_URL ??
          process.env.HAMMERCODE_API_BASE_URL ??
          process.env.BASE_URL ??
          "https://api.deepseek.com",
        model:
          process.env.DEEPSEEK_MODEL ??
          process.env.HAMMERCODE_MODEL ??
          process.env.MODEL ??
          "deepseek-v4-flash",
        thinking:
          process.env.HAMMERCODE_FAST_THINKING ??
          process.env.HAMMERCODE_THINKING ??
          "enabled",
        reasoningEffort:
          process.env.HAMMERCODE_FAST_REASONING_EFFORT ??
          process.env.HAMMERCODE_REASONING_EFFORT ??
          "high",
        maxOutputTokens: readInteger(
          process.env.HAMMERCODE_FAST_MAX_OUTPUT_TOKENS ??
            process.env.HAMMERCODE_MAX_OUTPUT_TOKENS,
          32_768,
        ),
        requestTimeoutMs,
      },
      strong: {
        provider: "zhipu",
        apiKey: process.env.GLM_API_KEY ?? process.env.ZHIPU_API_KEY ?? "",
        apiBaseUrl:
          process.env.GLM_API_BASE_URL ??
          process.env.ZHIPU_API_BASE_URL ??
          "https://open.bigmodel.cn/api/paas/v4",
        model: process.env.GLM_MODEL ?? "glm-5.3-flash",
        thinking: "enabled",
        reasoningEffort: process.env.HAMMERCODE_STRONG_REASONING_EFFORT ?? "max",
        maxOutputTokens: readInteger(
          process.env.HAMMERCODE_STRONG_MAX_OUTPUT_TOKENS,
          32_768,
        ),
        requestTimeoutMs,
      },
    },
    contextTokenBudget: readInteger(
      process.env.HAMMERCODE_CONTEXT_TOKEN_BUDGET,
      120_000,
    ),
    maxAgentRounds: readInteger(process.env.HAMMERCODE_MAX_AGENT_ROUNDS, 20),
  });
  if (!parsed.success) {
    const safeIssues = parsed.error.issues.map((issue) => issue.path.join(".")).join("、");
    throw new HammerCodeError(`运行配置无效：${safeIssues}`, "INVALID_CONFIG", true);
  }
  if (parsed.data.models.strong.maxOutputTokens > 131_072) {
    throw new HammerCodeError(
      "运行配置无效：models.strong.maxOutputTokens 超过 GLM-5.3-Flash 的 128K 上限",
      "INVALID_CONFIG",
      true,
    );
  }
  for (const model of Object.values(parsed.data.models)) validateEndpoint(model.apiBaseUrl);
  return parsed.data;
}

function publicModel(
  tier: ModelTier,
  label: string,
  config: RuntimeModelConfig,
): PublicModelConfig {
  let displayBaseUrl: string;
  try {
    const url = new URL(config.apiBaseUrl);
    displayBaseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    displayBaseUrl = "（无效地址）";
  }
  return {
    tier,
    label,
    provider: config.provider,
    model: config.model,
    apiBaseUrl: displayBaseUrl,
    thinking: config.thinking,
    reasoningEffort: config.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens,
    hasApiKey: Boolean(config.apiKey),
  };
}

export function toPublicConfig(config: RuntimeConfig): PublicRuntimeConfig {
  return {
    models: {
      fast: publicModel("fast", "Fast", config.models.fast),
      strong: publicModel("strong", "Strong", config.models.strong),
    },
    contextTokenBudget: config.contextTokenBudget,
    maxAgentRounds: config.maxAgentRounds,
  };
}
