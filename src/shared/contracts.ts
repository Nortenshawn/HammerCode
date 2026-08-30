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
export type ConnectionModelRef = `connection:${string}`;
export type ModelRef = BuiltinModelRef | ConnectionModelRef;

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
  projectMemoryRecords: number;
  projectMemoryCharacters: number;
  projectMemoryTokens: number;
  skillCount: number;
  skillCharacters: number;
  skillTokens: number;
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
  projectMemorySettings?: ProjectMemorySettings;
  skills?: SkillUseAudit[];
}

export type SkillSource = "builtin" | "user" | "project";
export type SkillScope = "application" | "user" | "project";
export type SkillTriggerMode = "explicit" | "model" | "automatic";
export type SkillResourceKind = "entry" | "reference" | "script" | "asset";
export type SkillCompatibilityStatus = "compatible" | "partial" | "incompatible";

export interface SkillResourceAudit {
  path: string;
  kind: SkillResourceKind;
  characters: number;
  tokens: number;
  sha256: string;
  readAt: string;
}

export interface SkillScriptAudit {
  path: string;
  toolCallId: string;
  status: "succeeded" | "failed" | "blocked" | "cancelled";
  authorization?: ToolAuthorization;
  durationMs?: number;
  finishedAt: string;
}

export interface SkillUseAudit {
  id: string;
  name: string;
  version: string;
  source: SkillSource;
  scope: SkillScope;
  trigger: SkillTriggerMode;
  reason: string;
  packageFingerprint: string;
  entryPath: string;
  instructionCharacters: number;
  instructionTokens: number;
  availableResources: string[];
  availableScripts: string[];
  resources: SkillResourceAudit[];
  scripts: SkillScriptAudit[];
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

export const SUBAGENT_ROLES = ["analysis", "test_localization", "code_review"] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];
export const SUBAGENT_MODES = ["read_only", "patch_proposal"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];
export type SubagentStatus = "pending" | "requesting" | "executing_tool" | "completed" | "cancelled" | "failed";

export interface SubagentEvidence {
  path: string;
  line?: number;
  detail: string;
}

export interface SubagentFinding {
  title: string;
  detail: string;
  confidence: "high" | "medium" | "low";
  evidence: SubagentEvidence[];
}

export interface SubagentResult {
  summary: string;
  findings: SubagentFinding[];
  relatedFiles: string[];
  verificationSuggestions: string[];
  risks: string[];
}

export interface SubagentPatchProposal {
  id: string;
  path: string;
  kind: FileChangeKind;
  beforeHash: string | null;
  afterHash: string | null;
  patch: string;
  createdAt: string;
}

export interface SubagentBudget {
  maxRounds: number;
  maxToolCalls: number;
  maxRunTimeMs: number;
  contextTokenBudget: number;
}

export interface SubagentTask {
  id: string;
  parentSessionId: string;
  parentTurnId: string;
  role: SubagentRole;
  mode: SubagentMode;
  task: string;
  status: SubagentStatus;
  modelTier: ModelTier;
  modelRef: ModelRef;
  parentPermissionMode: PermissionMode;
  effectivePermission: "read_only" | "proposal_only";
  budget: SubagentBudget;
  metrics?: TurnRunMetrics;
  plan: TurnPlan;
  messages: ConversationMessage[];
  toolTraces: ToolTrace[];
  patches: SubagentPatchProposal[];
  result?: SubagentResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface AgentSession {
  id: string;
  workspaceRoot: string;
  status: SessionStatus;
  task: string;
  title?: string;
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
  subtasks?: SubagentTask[];
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
  pinned: boolean;
  memoryExport: ProjectMemoryExportPreference;
  sessionCount: number;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  updatedAt: string;
}

export interface ArchivedWorkspaceSummary {
  root: string;
  name: string;
  sessionCount: number;
  sessions: SessionSummary[];
  updatedAt: string;
}

export interface ArchivedProjectSummary {
  root: string;
  name: string;
  sessionCount: number;
  archivedSessionCount: number;
  sessions: SessionSummary[];
  archivedSessions: SessionSummary[];
  memoryExport: ProjectMemoryExportPreference;
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
  connectionId: string;
  kind: "default" | "custom";
}

export interface PublicModelConnection {
  id: string;
  ref: ModelRef;
  kind: "default" | "custom";
  name: string;
  tier: ModelTier;
  provider: "deepseek" | "zhipu";
  model: string;
  apiBaseUrl: string;
  hasApiKey: boolean;
  connectionStatus: PublicModelConfig["connectionStatus"];
  connectionMessage?: string;
  lastCheckedAt?: string;
}

export interface ModelConnectionProbeInput {
  connectionId?: string;
  apiBaseUrl: string;
  apiKey?: string;
}

export interface ModelConnectionTestResult {
  connectionId?: string;
  apiBaseUrl: string;
  models: string[];
  latencyMs: number;
  status: "connected";
}

export interface ModelConnectionSaveInput {
  connectionId?: string;
  name: string;
  tier: ModelTier;
  model: string;
  apiBaseUrl: string;
  apiKey?: string;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
}

export type ProjectMemoryKind = "fact" | "decision" | "constraint" | "verification";
export type ProjectMemoryConfidence = "tool_verified" | "user_confirmed" | "model_inference";
export type ProjectMemoryStatus = "active" | "conflicted" | "invalidated" | "deleted";

export interface ProjectMemorySource {
  type: "tool" | "user" | "model" | "subagent";
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  subtaskId?: string;
  label: string;
}

export type ProjectMemoryInvalidation =
  | { type: "none" }
  | { type: "file_hash"; path: string; expectedHash: string }
  | { type: "workspace_revision"; revision: number }
  | { type: "expires_at"; expiresAt: string };

export interface ProjectMemoryRecord {
  id: string;
  workspaceRoot: string;
  kind: ProjectMemoryKind;
  subject: string;
  statement: string;
  confidence: ProjectMemoryConfidence;
  source: ProjectMemorySource;
  invalidation: ProjectMemoryInvalidation;
  status: ProjectMemoryStatus;
  conflictWith: string[];
  invalidatedReason?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ProjectMemorySnapshot {
  workspaceRoot: string;
  revision: number;
  settings: ProjectMemorySettings;
  records: ProjectMemoryRecord[];
  updatedAt: string;
}

export interface ProjectMemorySettings {
  enabled: boolean;
  useMemories: boolean;
  generateMemories: boolean;
  maxRecallRecords: number;
  maxRecallCharacters: number;
}

export interface ProjectMemoryRecall {
  records: ProjectMemoryRecord[];
  rendered: string;
  truncated: boolean;
  characterCount: number;
}

export interface ProjectMemoryTransferResult {
  status: "exported" | "imported" | "cancelled";
  fileName?: string;
  imported?: number;
  skipped?: number;
  conflicted?: number;
  recordCount?: number;
}

export interface ProjectMemoryExportPreference {
  mode: "project" | "custom";
  customDirectory?: string;
}

export interface ProjectMemoryExportPreferenceResult {
  status: "updated" | "cancelled";
  preference: ProjectMemoryExportPreference;
}

export interface SkillSettings {
  modelActivationEnabled: boolean;
}

export interface PublicSkillCapabilities {
  tools: string[];
  scripts: string[];
}

export interface PublicSkill {
  key: string;
  id: string;
  name: string;
  version: string;
  description: string;
  when: string;
  license: string;
  compatibility: string;
  compatibilityStatus: SkillCompatibilityStatus;
  compatibilityIssues: string[];
  source: SkillSource;
  scope: SkillScope;
  enabled: boolean;
  trusted: boolean;
  valid: boolean;
  issues: string[];
  trustInvalidated: boolean;
  packageFingerprint: string;
  capabilities: PublicSkillCapabilities;
  lastUsedAt?: string;
}

export interface SkillInventorySnapshot {
  workspaceRoot: string | null;
  settings: SkillSettings;
  skills: PublicSkill[];
  updatedAt: string;
}

export interface SkillTransferResult {
  status: "imported" | "exported" | "cancelled";
  skillId?: string;
  fileName?: string;
}

export interface ReferencePreview {
  key: string;
  kind: "file" | "directory" | "skill";
  title: string;
  subtitle: string;
  content: string;
  truncated: boolean;
  language?: string;
}

export interface PublicRuntimeConfig {
  models: Record<ModelTier, PublicModelConfig>;
  connections: PublicModelConnection[];
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
  archivedWorkspaces: ArchivedWorkspaceSummary[];
  archivedProjects: ArchivedProjectSummary[];
  workspaceRoot: string | null;
  projectMemory: ProjectMemorySnapshot | null;
  skills: SkillInventorySnapshot;
  config: PublicRuntimeConfig;
}

export interface SessionSettings {
  modelTier: ModelTier;
  modelRef?: ModelRef;
  permissionMode: PermissionMode;
}

export const SIDE_CHAT_STATUSES = ["idle", "requesting", "completed", "cancelled", "failed"] as const;
export type SideChatStatus = (typeof SIDE_CHAT_STATUSES)[number];

export interface SideChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoningContent?: string;
  createdAt: string;
}

export interface EphemeralSideChatState {
  id: string;
  sourceSessionId: string;
  sourceTitle: string;
  sourceUpdatedAt: string;
  modelTier: ModelTier;
  modelRef: ModelRef;
  status: SideChatStatus;
  messages: SideChatMessage[];
  streamingText: string;
  streamingReasoning: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StartTaskInput extends SessionSettings {
  task: string;
}

export type RendererEvent =
  | { type: "session_snapshot"; session: AgentSession }
  | { type: "session_updated"; session: AgentSession }
  | { type: "session_cleared" }
  | { type: "sessions_changed"; sessions: SessionSummary[] }
  | { type: "side_chat_snapshot"; sideChat: EphemeralSideChatState }
  | { type: "side_chat_closed" }
  | { type: "project_memory_updated"; memory: ProjectMemorySnapshot | null }
  | { type: "skills_updated"; skills: SkillInventorySnapshot }
  | {
      type: "config_updated";
      config: PublicRuntimeConfig;
    }
  | {
      type: "workspace_changed";
      workspaceRoot: string | null;
      workspaces: WorkspaceSummary[];
      archivedWorkspaces: ArchivedWorkspaceSummary[];
      archivedProjects: ArchivedProjectSummary[];
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
  archiveSession(sessionId: string): Promise<void>;
  restoreSession(sessionId: string): Promise<void>;
  archiveWorkspaceChats(workspaceRoot: string): Promise<void>;
  restoreWorkspaceChats(workspaceRoot: string): Promise<void>;
  setProjectPinned(workspaceRoot: string, pinned: boolean): Promise<void>;
  renameProject(workspaceRoot: string, name: string): Promise<void>;
  archiveProject(workspaceRoot: string): Promise<void>;
  restoreProject(workspaceRoot: string): Promise<void>;
  removeProject(workspaceRoot: string): Promise<void>;
  updateSessionSettings(settings: SessionSettings): Promise<void>;
  testModelConnection(input: ModelConnectionProbeInput): Promise<ModelConnectionTestResult>;
  saveModelConnection(input: ModelConnectionSaveInput): Promise<PublicModelConnection>;
  renameModelConnection(connectionId: string, name: string): Promise<PublicModelConnection>;
  deleteModelConnection(connectionId: string): Promise<void>;
  compressContext(): Promise<ChatContextMemory>;
  openSideChat(): Promise<EphemeralSideChatState>;
  sendSideChat(sideChatId: string, content: string): Promise<void>;
  cancelSideChat(sideChatId: string): Promise<void>;
  closeSideChat(sideChatId: string): Promise<void>;
  searchWorkspaceEntries(query: string): Promise<WorkspaceEntry[]>;
  chooseWorkspaceEntry(): Promise<WorkspaceEntry | null>;
  previewWorkspaceEntry(path: string): Promise<ReferencePreview>;
  previewSkill(skillKey: string): Promise<ReferencePreview>;
  listProjectMemory(workspaceRoot: string): Promise<ProjectMemorySnapshot>;
  updateProjectMemorySettings(workspaceRoot: string, settings: ProjectMemorySettings): Promise<ProjectMemorySnapshot>;
  configureProjectMemoryExport(workspaceRoot: string, mode: ProjectMemoryExportPreference["mode"]): Promise<ProjectMemoryExportPreferenceResult>;
  exportProjectMemory(workspaceRoot: string): Promise<ProjectMemoryTransferResult>;
  importProjectMemory(workspaceRoot: string): Promise<ProjectMemoryTransferResult>;
  deleteProjectMemory(workspaceRoot: string, memoryId: string): Promise<ProjectMemorySnapshot>;
  updateSkillSettings(settings: SkillSettings): Promise<SkillInventorySnapshot>;
  setSkillEnabled(skillKey: string, enabled: boolean, trustProject?: boolean): Promise<SkillInventorySnapshot>;
  importSkill(): Promise<SkillTransferResult>;
  exportSkill(skillKey: string): Promise<SkillTransferResult>;
  uninstallSkill(skillKey: string): Promise<SkillInventorySnapshot>;
  startTask(input: StartTaskInput): Promise<{ sessionId: string }>;
  requestUndo(changeId: string): Promise<void>;
  cancelTask(): Promise<void>;
  resolveApproval(approvalId: string, approved: boolean): Promise<void>;
  clearSession(): Promise<void>;
  onEvent(listener: (event: RendererEvent) => void): () => void;
}
