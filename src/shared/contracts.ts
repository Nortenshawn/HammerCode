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

export const MODEL_TIERS = ["fast", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const PERMISSION_MODES = ["ask", "full_access"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type ToolAuthorization =
  | "not_required"
  | "user_approved"
  | "user_rejected"
  | "full_access"
  | "safety_blocked";

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
  turnId?: string;
  operation?: "agent_tool" | "undo";
  createdAt: string;
}

export interface ToolTrace {
  turnId: string;
  call: ToolCall;
  status: ToolTraceStatus;
  summary: string;
  target?: string;
  approval?: ApprovalRequest;
  result?: ToolResult;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  fileChangeId?: string;
  authorization?: ToolAuthorization;
}

export interface UserMessage {
  id: string;
  turnId: string;
  role: "user";
  content: string;
  createdAt: string;
}

export interface AssistantMessage {
  id: string;
  turnId: string;
  role: "assistant";
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  createdAt: string;
}

export interface ToolMessage {
  id: string;
  turnId: string;
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
  turnId: string;
  from: SessionStatus;
  to: SessionStatus;
  reason: string;
  at: string;
}

export interface AgentTurn {
  id: string;
  userMessageId: string;
  status: SessionStatus;
  terminationReason?: TerminationReason;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  modelTier: ModelTier;
  permissionMode: PermissionMode;
}

export type FileChangeKind = "create" | "modify" | "delete";
export type FileChangeStatus = "applied" | "reverted";

export interface FileChange {
  id: string;
  turnId: string;
  toolCallId: string;
  path: string;
  kind: FileChangeKind;
  beforeContent: string | null;
  afterContent: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  patch: string;
  status: FileChangeStatus;
  appliedAt: string;
  revertedAt?: string;
}

export interface PendingUndo {
  id: string;
  changeId: string;
  approvalId: string;
  status: "awaiting_approval" | "executing";
  createdAt: string;
}

export interface AgentSession {
  id: string;
  workspaceRoot: string;
  status: SessionStatus;
  task: string;
  modelTier: ModelTier;
  permissionMode: PermissionMode;
  turns: AgentTurn[];
  activeTurnId: string;
  messages: ConversationMessage[];
  toolTraces: ToolTrace[];
  fileChanges: FileChange[];
  transitions: StateTransition[];
  streamingText: string;
  streamingReasoning: string;
  pendingApproval?: ApprovalRequest;
  pendingUndo?: PendingUndo;
  terminationReason?: TerminationReason;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  workspaceRoot: string;
  title: string;
  status: SessionStatus;
  turnCount: number;
  changedFileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary {
  root: string;
  name: string;
  sessionCount: number;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  updatedAt: string;
}

export interface PublicModelConfig {
  tier: ModelTier;
  label: string;
  provider: "deepseek" | "zhipu";
  model: string;
  apiBaseUrl: string;
  thinking: "enabled" | "disabled";
  reasoningEffort: "low" | "high" | "max";
  maxOutputTokens: number;
  hasApiKey: boolean;
}

export interface PublicRuntimeConfig {
  models: Record<ModelTier, PublicModelConfig>;
  contextTokenBudget: number;
  maxAgentRounds: number;
}

export interface AppBootstrap {
  session: AgentSession | null;
  sessions: SessionSummary[];
  workspaces: WorkspaceSummary[];
  workspaceRoot: string | null;
  config: PublicRuntimeConfig;
}

export interface SessionSettings {
  modelTier: ModelTier;
  permissionMode: PermissionMode;
}

export interface StartTaskInput extends SessionSettings {
  task: string;
}

export type RendererEvent =
  | { type: "session_snapshot"; session: AgentSession }
  | { type: "session_cleared" }
  | { type: "sessions_changed"; sessions: SessionSummary[] }
  | {
      type: "workspace_changed";
      workspaceRoot: string | null;
      workspaces: WorkspaceSummary[];
      sessions: SessionSummary[];
      session: AgentSession | null;
    }
  | { type: "notification"; level: "info" | "error"; message: string };

export interface HammerCodeApi {
  bootstrap(): Promise<AppBootstrap>;
  chooseWorkspace(): Promise<string | null>;
  selectWorkspace(workspaceRoot: string): Promise<void>;
  newChat(): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  updateSessionSettings(settings: SessionSettings): Promise<void>;
  startTask(input: StartTaskInput): Promise<{ sessionId: string }>;
  requestUndo(changeId: string): Promise<void>;
  cancelTask(): Promise<void>;
  resolveApproval(approvalId: string, approved: boolean): Promise<void>;
  clearSession(): Promise<void>;
  onEvent(listener: (event: RendererEvent) => void): () => void;
}
