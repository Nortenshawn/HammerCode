import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChatCompletionBody,
  OpenAICompatibleChatClient,
} from "../src/core/model/openai-compatible-client";
import type { OpenAICompatibleClientConfig } from "../src/core/model/openai-compatible-client";
import type { ModelRequest, ModelStreamChunk } from "../src/core/types";

const request = {
  messages: [{ role: "user" as const, content: "test" }],
  tools: [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "read",
        parameters: { type: "object" },
      },
    },
  ],
};

function config(
  provider: OpenAICompatibleClientConfig["provider"],
): OpenAICompatibleClientConfig {
  return {
    provider,
    apiKey: "test-placeholder",
    baseUrl: provider === "zhipu" ? "https://open.bigmodel.cn/api/paas/v4" : "https://api.deepseek.com",
    model: provider === "zhipu" ? "glm-5.3-flash" : "deepseek-v4-flash",
    thinking: provider === "zhipu" ? "enabled" : "disabled",
    reasoningEffort: provider === "zhipu" ? "max" : "high",
    maxOutputTokens: 4096,
    requestTimeoutMs: 10_000,
  };
}

describe("OpenAI-compatible provider requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds the DeepSeek request without GLM-only fields", () => {
    const body = buildChatCompletionBody(config("deepseek"), request);
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      max_tokens: 4096,
      reasoning_effort: "high",
      thinking: { type: "disabled" },
      stream_options: { include_usage: true },
    });
    expect(body).not.toHaveProperty("tool_stream");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("temperature");
  });

  it("builds the GLM-5.3-Flash streaming tool request without DeepSeek-only fields", () => {
    const body = buildChatCompletionBody(config("zhipu"), request);
    expect(body).toMatchObject({
      model: "glm-5.3-flash",
      stream: true,
      tool_choice: "auto",
      tool_stream: true,
      max_tokens: 4096,
      reasoning_effort: "max",
      temperature: 1,
      top_p: 0.95,
      thinking: { type: "enabled", clear_thinking: false },
    });
    expect(body).not.toHaveProperty("stream_options");
  });

  it("parses shared reasoning, content, fragmented tool calls, usage and DONE events", async () => {
    const payload = [
      { choices: [{ delta: { reasoning_content: "先检查" }, finish_reason: null }] },
      { choices: [{ delta: { content: "准备调用" }, finish_reason: null }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "read_file", arguments: '{"path":"AG' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { arguments: 'ENTS.md"}' } }] },
          finish_reason: "tool_calls",
        }],
      },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(payload, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const client = new OpenAICompatibleChatClient(config("zhipu"));
    const chunks: ModelStreamChunk[] = [];
    const modelRequest: ModelRequest = {
      ...request,
      signal: new AbortController().signal,
    };
    for await (const chunk of client.stream(modelRequest)) chunks.push(chunk);

    expect(chunks).toEqual([
      expect.objectContaining({ reasoningContent: "先检查" }),
      expect.objectContaining({ content: "准备调用" }),
      expect.objectContaining({
        toolCallDeltas: [{
          index: 0,
          id: "call_1",
          name: "read_file",
          arguments: '{"path":"AG',
        }],
      }),
      expect.objectContaining({
        finishReason: "tool_calls",
        toolCallDeltas: [{ index: 0, arguments: 'ENTS.md"}' }],
      }),
      expect.objectContaining({ usage: { promptTokens: 12, completionTokens: 7 } }),
    ]);
  });

  it("reports provider HTTP failures without exposing authorization data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '{"error":"Authorization: Bearer provider-test-secret"}',
      { status: 429, statusText: "Too Many Requests" },
    )));
    const client = new OpenAICompatibleChatClient(config("deepseek"));
    const collect = async () => {
      for await (const _chunk of client.stream({
        ...request,
        signal: new AbortController().signal,
      })) {
        // The request is expected to fail before yielding.
      }
    };

    await expect(collect()).rejects.toMatchObject({
      code: "MODEL_HTTP_ERROR",
      recoverable: true,
    });
    await expect(collect()).rejects.not.toThrow(/provider-test-secret/);
  });
});
