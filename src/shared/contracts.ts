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

export const BUILTIN_MODEL_REFS = ["builtin:fast", "builtin:strong"] as const;
export type BuiltinModelRef = (typeof BUILTIN_MODEL_REFS)[number];
export type ModelRef = BuiltinModelRef;

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
  approvalPolicy?: "none" | "permission_mode" | "always";
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
  | "tool_limit"
  | "time_limit"
  | "cancelled"
  | "request_timeout"
  | "output_limit"
  | "rate_limited"
  | "server_error"
  | "resource_exhausted"
  | "model_error"
  | "tool_error"
  | "invalid_model_output"
  | "context_overflow"
  | "interrupted";

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

export interface TurnPlan {
  revision: number;
  explanation?: string;
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanCheckpoint {
  id: string;
  revision: number;
  explanation?: string;
  steps: PlanStep[];
  round: number;
  toolCalls: number;
  createdAt: string;
}

export interface ModelRetryEvent {
  attempt: number;
  reason: "rate_limited" | "server_error" | "resource_exhausted";
  delayMs: number;
  createdAt: string;
}

export interface TurnRunMetrics {
  roundsUsed: number;
  maxRounds: number;
  modelRequests: number;
  retryCount: number;
  maxRetries: number;
  toolCalls: number;
  maxToolCalls: number;
  promptTokens: number;
  completionTokens: number;
  tokenUsageEstimated: boolean;
  maxOutputTokensPerRequest: number;
  contextTokenBudget: number;
  currentContextTokens: number;
  contextCompactions: number;
  maxRunTimeMs: number;
}

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
  modelRef?: ModelRef;
  permissionMode: PermissionMode;
  planRequired?: boolean;
  plan?: TurnPlan;
  planCheckpoints?: PlanCheckpoint[];
  retryEvents?: ModelRetryEvent[];
  metrics?: TurnRunMetrics;
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
  modelRef?: ModelRef;
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
  contextMemory?: ChatContextMemory;
  terminationReason?: TerminationReason;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatContextMemory {
  version: 1;
  summary: string;
  throughMessageId: string;
  throughCreatedAt: string;
  sourceMessageCount: number;
  mode: "automatic" | "explicit";
  compactionCount: number;
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
  connectionStatus: "missing" | "configured" | "connected" | "error";
  connectionMessage?: string;
  lastCheckedAt?: string;
}

export interface PublicModelOption {
  ref: ModelRef;
  label: string;
  provider: "deepseek" | "zhipu";
  model: string;
  apiBaseUrl: string;
  hasApiKey: boolean;
  connectionStatus: PublicModelConfig["connectionStatus"];
  builtinTier: ModelTier;
}

export interface ModelConnectionInput {
  tier: ModelTier;
  apiBaseUrl: string;
  apiKey?: string;
}

export interface ModelConnectionTestResult {
  tier: ModelTier;
  apiBaseUrl: string;
  model: string;
  latencyMs: number;
  status: "connected";
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
}

export interface PublicRuntimeConfig {
  models: Record<ModelTier, PublicModelConfig>;
  availableModels: PublicModelOption[];
  contextTokenBudget: number;
  maxAgentRounds: number;
  maxToolCalls: number;
  maxRunTimeMs: number;
  maxModelRetries: number;
  autoCompactRatio: number;
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
  modelRef?: ModelRef;
  permissionMode: PermissionMode;
}

export interface StartTaskInput extends SessionSettings {
  task: string;
}

export type RendererEvent =
  | { type: "session_snapshot"; session: AgentSession }
  | { type: "session_updated"; session: AgentSession }
  | { type: "session_cleared" }
  | { type: "sessions_changed"; sessions: SessionSummary[] }
  | {
      type: "config_updated";
      config: PublicRuntimeConfig;
    }
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
  testModelConnection(input: ModelConnectionInput): Promise<ModelConnectionTestResult>;
  saveModelConnection(input: ModelConnectionInput): Promise<ModelConnectionTestResult>;
  compressContext(): Promise<ChatContextMemory>;
  searchWorkspaceEntries(query: string): Promise<WorkspaceEntry[]>;
  startTask(input: StartTaskInput): Promise<{ sessionId: string }>;
  requestUndo(changeId: string): Promise<void>;
  cancelTask(): Promise<void>;
  resolveApproval(approvalId: string, approved: boolean): Promise<void>;
  clearSession(): Promise<void>;
  onEvent(listener: (event: RendererEvent) => void): () => void;
}
