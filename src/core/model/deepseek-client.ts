import { z } from "zod";
import { parseServerSentEvents } from "./sse";
import type { ModelClient, ModelRequest, ModelStreamChunk } from "../types";
import { HammerCodeError } from "../types";
import { redactSecrets } from "../utils";

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

export interface DeepSeekClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking: "enabled" | "disabled";
  reasoningEffort: "low" | "high" | "max";
  maxOutputTokens: number;
  requestTimeoutMs: number;
}

export class DeepSeekChatClient implements ModelClient {
  constructor(private readonly config: DeepSeekClientConfig) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error("模型请求超时")),
      this.config.requestTimeoutMs,
    );
    const onAbort = () => timeoutController.abort(request.signal.reason);
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          tools: request.tools,
          tool_choice: "auto",
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: this.config.maxOutputTokens,
          thinking: { type: this.config.thinking },
          reasoning_effort: this.config.reasoningEffort,
        }),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        const body = redactSecrets((await response.text()).slice(0, 8_000));
        throw new HammerCodeError(
          `模型请求失败（HTTP ${response.status}）：${body || response.statusText}`,
          "MODEL_HTTP_ERROR",
          response.status === 408 || response.status === 429 || response.status >= 500,
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
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}
