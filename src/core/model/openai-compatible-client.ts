import { z } from "zod";
import type { ModelClient, ModelRequest, ModelStreamChunk } from "../types";
import { HammerCodeError } from "../types";
import { redactSecrets } from "../utils";
import { parseServerSentEvents } from "./sse";

const toolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

const streamChunkSchema = z.object({
  choices: z.array(
    z.object({
      delta: z.object({
        content: z.string().nullable().optional(),
        reasoning_content: z.string().nullable().optional(),
        tool_calls: z.array(toolCallDeltaSchema).optional(),
      }),
      finish_reason: z
        .enum([
          "stop",
          "length",
          "content_filter",
          "tool_calls",
          "insufficient_system_resource",
        ])
        .nullable()
        .optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .nullable()
    .optional(),
});

export interface OpenAICompatibleClientConfig {
  provider: "deepseek" | "zhipu" | "custom";
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking: "enabled" | "disabled";
  reasoningEffort: "low" | "high" | "max";
  maxOutputTokens: number;
  requestTimeoutMs: number;
}

export function buildChatCompletionBody(
  config: OpenAICompatibleClientConfig,
  request: Pick<ModelRequest, "messages" | "tools">,
): Record<string, unknown> {
  const common: Record<string, unknown> = {
    model: config.model,
    messages: request.messages,
    tools: request.tools,
    stream: true,
    max_tokens: config.maxOutputTokens,
  };
  if (config.provider === "zhipu") {
    return {
      ...common,
      tool_choice: "auto",
      tool_stream: true,
      temperature: 1,
      top_p: 0.95,
      thinking: { type: "enabled", clear_thinking: false },
      reasoning_effort: config.reasoningEffort,
    };
  }
  if (config.provider === "custom") {
    return {
      ...common,
      tool_choice: "auto",
    };
  }
  return {
    ...common,
    stream_options: { include_usage: true },
    thinking: { type: config.thinking },
    reasoning_effort: config.reasoningEffort,
  };
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(300_000, Math.max(0, date - Date.now()));
}

export class OpenAICompatibleChatClient implements ModelClient {
  constructor(private readonly config: OpenAICompatibleClientConfig) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error("模型请求超时")),
      this.config.requestTimeoutMs,
    );
    const onAbort = () => timeoutController.abort(request.signal.reason);
    let listeningForAbort = false;
    if (request.signal.aborted) {
      onAbort();
    } else {
      request.signal.addEventListener("abort", onAbort, { once: true });
      listeningForAbort = true;
    }

    try {
      const endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(buildChatCompletionBody(this.config, request)),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        const body = redactSecrets((await response.text()).slice(0, 8_000));
        const detail = `模型请求失败（HTTP ${response.status}）：${body || response.statusText}`;
        if (response.status === 408) {
          throw new HammerCodeError(detail, "MODEL_REQUEST_TIMEOUT", true);
        }
        if (response.status === 429) {
          throw new HammerCodeError(
            detail,
            "MODEL_RATE_LIMITED",
            true,
            retryAfterMilliseconds(response.headers.get("retry-after")),
          );
        }
        if (response.status >= 500) {
          throw new HammerCodeError(
            detail,
            "MODEL_SERVER_ERROR",
            true,
            retryAfterMilliseconds(response.headers.get("retry-after")),
          );
        }
        throw new HammerCodeError(
          detail,
          "MODEL_HTTP_ERROR",
          false,
        );
      }
      if (!response.body) {
        throw new HammerCodeError("模型响应没有可读取的数据流", "MODEL_EMPTY_STREAM");
      }

      let sawDone = false;
      for await (const data of parseServerSentEvents(response.body)) {
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch {
          throw new HammerCodeError("模型返回了无效的流式 JSON", "MODEL_INVALID_JSON");
        }
        const parsed = streamChunkSchema.safeParse(raw);
        if (!parsed.success) {
          throw new HammerCodeError("模型返回了不兼容的流式事件", "MODEL_INVALID_CHUNK");
        }
        const choice = parsed.data.choices[0];
        if (!choice && !parsed.data.usage) continue;
        yield {
          content: choice?.delta.content ?? undefined,
          reasoningContent: choice?.delta.reasoning_content ?? undefined,
          toolCallDeltas: choice?.delta.tool_calls?.map((call) => ({
            index: call.index,
            id: call.id,
            name: call.function?.name,
            arguments: call.function?.arguments,
          })),
          finishReason: choice?.finish_reason,
          usage: parsed.data.usage
            ? {
                promptTokens: parsed.data.usage.prompt_tokens,
                completionTokens: parsed.data.usage.completion_tokens,
              }
            : undefined,
        };
      }

      if (!sawDone && !request.signal.aborted) {
        throw new HammerCodeError("模型流在 [DONE] 前意外结束", "MODEL_STREAM_INTERRUPTED", true);
      }
    } catch (error) {
      if (error instanceof HammerCodeError) throw error;
      if (request.signal.aborted) throw request.signal.reason;
      if (timeoutController.signal.aborted) {
        throw new HammerCodeError(
          `模型请求在 ${this.config.requestTimeoutMs}ms 后超时`,
          "MODEL_REQUEST_TIMEOUT",
          true,
        );
      }
      throw new HammerCodeError(
        `模型网络请求失败：${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        "MODEL_NETWORK_ERROR",
        true,
      );
    } finally {
      clearTimeout(timeout);
      if (listeningForAbort) request.signal.removeEventListener("abort", onAbort);
    }
  }
}
