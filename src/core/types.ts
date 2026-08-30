import type {
  AgentSession,
  ApprovalRequest,
  FileChangeKind,
  FileChange,
  ModelRef,
  ModelTier,
  PermissionMode,
  ProjectMemoryKind,
  ProjectMemoryRecall,
  ProjectMemoryRecord,
  ProjectMemorySettings,
  SkillUseAudit,
  SubagentMode,
  SubagentRole,
  SubagentTask,
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
  projectMemory?: ProjectMemoryPort;
  skills?: SkillPort;
  subagents?: SubagentCoordinatorPort;
  writeLeases?: WorkspaceWriteLeasePort;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onSessionChange?: (session: AgentSession) => void | Promise<void>;
}

export interface SkillSelection {
  usages: SkillUseAudit[];
  rendered: string;
  catalog: string;
  catalogCharacters: number;
  catalogTokens: number;
  candidates: SkillCatalogCandidate[];
}

export interface SkillCatalogCandidate {
  id: string;
  version: string;
  source: SkillUseAudit["source"];
  packageFingerprint: string;
}

export interface SkillPort {
  select(workspaceRoot: string, task: string, now: Date): Promise<SkillSelection>;
  definitions(usages: SkillUseAudit[], candidates: SkillCatalogCandidate[]): ModelToolDefinition[];
  prepare(
    call: ToolCall,
    usages: SkillUseAudit[],
    candidates: SkillCatalogCandidate[],
    workspaceRoot: string,
    now: Date,
  ): Promise<PreparedToolCall>;
}

export interface ProjectMemoryPort {
  settings(workspaceRoot: string): Promise<ProjectMemorySettings>;
  retrieve(
    workspaceRoot: string,
    query: string,
    options?: { maxRecords?: number; maxCharacters?: number },
  ): Promise<ProjectMemoryRecall>;
  rememberInference(input: {
    workspaceRoot: string;
    kind: ProjectMemoryKind;
    subject: string;
    statement: string;
    invalidation?: { type: "none" } | { type: "file_hash"; path: string; expectedHash: string } | { type: "expires_at"; expiresAt: string };
    source: { sessionId: string; turnId: string; toolCallId: string };
  }): Promise<ProjectMemoryRecord>;
  recordToolFact(input: {
    workspaceRoot: string;
    sessionId: string;
    turnId: string;
    call: ToolCall;
    target?: string;
    result: ToolResult;
    fileChange?: FileChange;
  }): Promise<ProjectMemoryRecord | null>;
}

export interface SubagentSpawnInput {
  role: SubagentRole;
  mode: SubagentMode;
  task: string;
}

export interface SubagentCoordinatorPort {
  spawn(input: {
    workspaceRoot: string;
    parentSessionId: string;
    parentTurnId: string;
    parentModelTier: ModelTier;
    parentModelRef: ModelRef;
    parentPermissionMode: PermissionMode;
    tasks: SubagentSpawnInput[];
    signal: AbortSignal;
    onUpdate(task: SubagentTask): void | Promise<void>;
  }): Promise<SubagentTask[]>;
}

export interface WorkspaceWriteLease {
  path: string;
  ownerId: string;
  acquiredAt: string;
}

export interface WorkspaceWriteLeasePort {
  acquire(path: string, ownerId: string, now: Date): WorkspaceWriteLease;
  release(path: string, ownerId: string): void;
  releaseOwner(ownerId: string): void;
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
  approvalPolicy?: "permission_mode" | "always";
  approvalRequest?: ApprovalRequest;
  fileMutation?: {
    path: string;
    kind: FileChangeKind;
    beforeContent: string | null;
    afterContent: string | null;
    beforeHash: string | null;
    afterHash: string | null;
    patch: string;
  };
  execute(context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolExecutorPort {
  definitions: ModelToolDefinition[];
  prepare(call: ToolCall, now: Date): Promise<PreparedToolCall>;
}

export interface AgentRunOptions {
  maxRounds: number;
  maxToolCalls?: number;
  maxRunTimeMs?: number;
  maxModelRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxOutputTokens?: number;
  autoCompactRatio?: number;
  contextTokenBudget: number;
  systemPrompt: string;
}

export class HammerCodeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly recoverable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HammerCodeError";
  }
}
