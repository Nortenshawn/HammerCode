import type {
  ModelFinishReason,
  ModelStreamChunk,
  ModelToolCallDelta,
} from "../types";
import { HammerCodeError } from "../types";
import type { ToolCall } from "../../shared/contracts";

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AssembledModelResponse {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: ModelFinishReason;
}

export class StreamAssembler {
  private content = "";
  private reasoningContent = "";
  private readonly toolCalls = new Map<number, PartialToolCall>();
  private finishReason: ModelFinishReason = null;

  push(chunk: ModelStreamChunk): void {
    if (chunk.content) this.content += chunk.content;
    if (chunk.reasoningContent) this.reasoningContent += chunk.reasoningContent;
    for (const delta of chunk.toolCallDeltas ?? []) this.pushToolDelta(delta);
    if (chunk.finishReason !== undefined) this.finishReason = chunk.finishReason;
  }

  private pushToolDelta(delta: ModelToolCallDelta): void {
    if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index > 127) {
      throw new HammerCodeError("模型返回了无效的 tool call 索引", "INVALID_TOOL_CALL");
    }
    const current = this.toolCalls.get(delta.index) ?? {
      id: "",
      name: "",
      arguments: "",
    };
    if (delta.id) current.id += delta.id;
    if (delta.name) current.name += delta.name;
    if (delta.arguments) current.arguments += delta.arguments;
    this.toolCalls.set(delta.index, current);
  }

  result(): AssembledModelResponse {
    const toolCalls = [...this.toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => {
        if (!call.id || !call.name) {
          throw new HammerCodeError("模型返回了不完整的 tool call", "INVALID_TOOL_CALL");
        }
        return call;
      });

    if (this.finishReason === "tool_calls" && toolCalls.length === 0) {
      throw new HammerCodeError(
        "模型声明调用工具，但没有提供完整调用",
        "INVALID_TOOL_CALL",
      );
    }

    return {
      content: this.content,
      reasoningContent: this.reasoningContent,
      toolCalls,
      finishReason: this.finishReason,
    };
  }
}
