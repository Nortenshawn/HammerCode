import { describe, expect, it } from "vitest";
import { parseServerSentEvents } from "../src/core/model/sse";
import { StreamAssembler } from "../src/core/model/stream-assembler";

describe("stream assembly", () => {
  it("assembles text, reasoning and fragmented tool calls", () => {
    const assembler = new StreamAssembler();
    assembler.push({ reasoningContent: "先看" });
    assembler.push({ content: "我来读取", toolCallDeltas: [{ index: 0, id: "call_1", name: "read_", arguments: '{"pa' }] });
    assembler.push({ toolCallDeltas: [{ index: 0, name: "file", arguments: 'th":"README.md"}' }], finishReason: "tool_calls" });
    expect(assembler.result()).toEqual({
      content: "我来读取",
      reasoningContent: "先看",
      toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' }],
      finishReason: "tool_calls",
    });
  });

  it("rejects incomplete tool calls", () => {
    const assembler = new StreamAssembler();
    assembler.push({ toolCallDeltas: [{ index: 0, id: "call_1" }], finishReason: "tool_calls" });
    expect(() => assembler.result()).toThrow("不完整");
  });

  it("parses SSE split across transport chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"a\":"));
        controller.enqueue(encoder.encode("1}\r\n\r\ndata: [DONE]\n\n"));
        controller.close();
      },
    });
    const values: string[] = [];
    for await (const value of parseServerSentEvents(stream)) values.push(value);
    expect(values).toEqual(['{"a":1}', "[DONE]"]);
  });
});
