export const SESSION_STATUSES = [
  "idle",
  "requesting",
  "awaiting_approval",
  "executing_tool",
  "completed",
  "cancelled",
  "failed",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type ToolTraceStatus =
  | "proposed"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  output: string;
  metadata?: Record<string, string | number | boolean | null>;
  errorCode?: string;
  truncated?: boolean;
}

export interface ApprovalRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  title: string;
  description: string;
  details: string;
  risk: "write" | "delete" | "command";
  createdAt: string;
}

export interface ToolTrace {
  call: ToolCall;
  status: ToolTraceStatus;
  summary: string;
  target?: string;
  approval?: ApprovalRequest;
  result?: ToolResult;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  createdAt: string;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  createdAt: string;
}

export interface ToolMessage {
  id: string;
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  createdAt: string;
}

export type ConversationMessage = UserMessage | AssistantMessage | ToolMessage;

export type TerminationReason =
  | "completed"
  | "round_limit"
  | "cancelled"
  | "model_error"
  | "tool_error"
  | "invalid_model_output"
  | "context_overflow"
  | "interrupted";

export interface StateTransition {
  from: SessionStatus;
  to: SessionStatus;
  reason: string;
  at: string;
}

export interface AgentSession {
  id: string;
  workspaceRoot: string;
  status: SessionStatus;
  task: string;
  messages: ConversationMessage[];
  toolTraces: ToolTrace[];
  transitions: StateTransition[];
  streamingText: string;
  streamingReasoning: string;
  pendingApproval?: ApprovalRequest;
  terminationReason?: TerminationReason;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicRuntimeConfig {
  model: string;
  apiBaseUrl: string;
  thinking: "enabled" | "disabled";
  reasoningEffort: "low" | "high" | "max";
  maxOutputTokens: number;
  contextTokenBudget: number;
  maxAgentRounds: number;
  hasApiKey: boolean;
}

export interface AppBootstrap {
  session: AgentSession | null;
  workspaceRoot: string | null;
  config: PublicRuntimeConfig;
}

export type RendererEvent =
  | { type: "session_snapshot"; session: AgentSession }
  | { type: "session_cleared" }
  | { type: "notification"; level: "info" | "error"; message: string };

export interface HammerCodeApi {
  bootstrap(): Promise<AppBootstrap>;
  chooseWorkspace(): Promise<string | null>;
  startTask(task: string): Promise<{ sessionId: string }>;
  cancelTask(): Promise<void>;
  resolveApproval(approvalId: string, approved: boolean): Promise<void>;
  clearSession(): Promise<void>;
  onEvent(listener: (event: RendererEvent) => void): () => void;
}
