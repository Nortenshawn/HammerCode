import type {
  AgentSession,
  ApprovalRequest,
  ToolCall,
  ToolResult,
} from "../shared/contracts";

export type ModelFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_calls"
  | "insufficient_system_resource"
  | null;

export interface ModelToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface ModelStreamChunk {
  content?: string;
  reasoningContent?: string;
  toolCallDeltas?: ModelToolCallDelta[];
  finishReason?: ModelFinishReason;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  signal: AbortSignal;
}

export interface ModelClient {
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk>;
}

export interface ApprovalGateway {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface AgentDependencies {
  model: ModelClient;
  tools: ToolExecutorPort;
  approvals: ApprovalGateway;
  clock: Clock;
  ids: IdGenerator;
  onSessionChange?: (session: AgentSession) => void | Promise<void>;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  approvals: ApprovalGateway;
  now: () => Date;
}

export interface PreparedToolCall {
  call: ToolCall;
  summary: string;
  target?: string;
  requiresApproval: boolean;
  approvalRequest?: ApprovalRequest;
  execute(context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolExecutorPort {
  definitions: ModelToolDefinition[];
  prepare(call: ToolCall, now: Date): Promise<PreparedToolCall>;
}

export interface AgentRunOptions {
  maxRounds: number;
  contextTokenBudget: number;
  systemPrompt: string;
}

export class HammerCodeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly recoverable = false,
  ) {
    super(message);
    this.name = "HammerCodeError";
  }
}
