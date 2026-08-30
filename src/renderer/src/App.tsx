import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import logoUrl from "../../../logos/logo.png";
import type {
  AgentSession,
  AgentTurn,
  AppBootstrap,
  ArchivedProjectSummary,
  ArchivedWorkspaceSummary,
  AssistantMessage,
  EphemeralSideChatState,
  ModelRef,
  ModelTier,
  PermissionMode,
  ProjectMemorySnapshot,
  PublicModelConnection,
  PublicSkill,
  ReferencePreview,
  RendererEvent,
  SessionStatus,
  SessionSummary,
  TerminationReason,
  ToolAuthorization,
  ToolCall,
  ToolTrace,
  WorkspaceSummary,
  WorkspaceEntry,
} from "../../shared/contracts";
import { buildFileReviews, type FileReview } from "../../shared/file-reviews";
import { fallbackChatTitle } from "../../shared/chat-title";
import { filterComposerCommands, type ComposerCommandId } from "./composer-commands";
import {
  appendComposerEntity,
  serializeComposerTask,
  skillComposerEntity,
  workspaceComposerEntity,
  type ComposerEntity,
} from "./composer-entities";
import { renderDiffLines } from "./diff-renderer";
import { detectComposerToken, replaceComposerToken } from "./composer-tokens";
import { computeWorkbenchLayout, DEFAULT_PANEL_RATIO, panelRatioFromDivider } from "./panel-layout";
import { memoryDescription, memorySourceTitle, memoryTitle } from "./memory-presentation";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "空闲",
  requesting: "思考中",
  awaiting_approval: "等待审批",
  executing_tool: "执行工具",
  completed: "已完成",
  cancelled: "已取消",
  failed: "未完成",
};
const ACTIVE_STATUSES: SessionStatus[] = ["requesting", "awaiting_approval", "executing_tool"];
const TERMINAL_STATUSES: SessionStatus[] = ["completed", "cancelled", "failed"];

type IconName =
  | "arrow-up"
  | "archive"
  | "check"
  | "chevron"
  | "file"
  | "folder"
  | "branch"
  | "compose"
  | "gear"
  | "more"
  | "pin"
  | "plus"
  | "remove"
  | "spark"
  | "square"
  | "stop"
  | "terminal"
  | "undo";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    "arrow-up": <><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></>,
    archive: <><path d="M4 7h16v13H4Z"/><path d="M3 3h18v4H3Z"/><path d="M9 11h6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></>,
    folder: <><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><path d="M1 10h20"/></>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10"/><path d="M8 11h4a6 6 0 0 0 6-2"/></>,
    compose: <><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L11 15l-4 1 1-4Z"/></>,
    gear: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.16.37.37.7.6 1 .3.32.68.46 1.1.46h.1v4h-.1A1.7 1.7 0 0 0 19.4 15Z"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    pin: <><path d="M12 17v5"/><path d="m5 17 2-5V4h10v8l2 5Z"/></>,
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    remove: <><path d="M5 5l14 14"/><path d="M19 5 5 19"/></>,
    spark: <><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z"/><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/></>,
    square: <rect x="4" y="4" width="16" height="16" rx="3"/>,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>,
    terminal: <><path d="m4 7 5 5-5 5"/><path d="M12 17h8"/></>,
    undo: <><path d="M9 7 4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6"/></>,
  };
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

const TERMINATION_LABELS: Record<TerminationReason, string> = {
  completed: "正常完成",
  round_limit: "轮次预算耗尽",
  tool_limit: "工具预算耗尽",
  time_limit: "运行时间耗尽",
  cancelled: "用户停止",
  request_timeout: "请求超时",
  output_limit: "输出长度耗尽",
  rate_limited: "服务端限流",
  server_error: "服务端异常",
  resource_exhausted: "服务资源不足",
  model_error: "模型请求异常",
  tool_error: "工具异常",
  invalid_model_output: "模型输出无效",
  context_overflow: "上下文预算不足",
  interrupted: "运行被中断",
};

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatMemoryTokens(value: number): string {
  if (value < 1_000) return String(Math.max(0, Math.round(value)));
  const thousands = value / 1_000;
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
}

function formatDurationLimit(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60 ? `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} 小时` : `${minutes} 分钟`;
}

function userFacingError(error: unknown): string {
  return String(error)
    .replace(/^Error:\s+Error invoking remote method '[^']+':\s+Error:\s+/i, "")
    .replace(/^Error:\s+/i, "");
}

function turnModelLabel(turn: AgentTurn): string {
  return turn.modelTier === "fast" ? "Fast" : "Strong";
}

function folderName(value: string | null): string {
  if (!value) return "选择工作区";
  return value.split("/").filter(Boolean).at(-1) ?? value;
}

function formatClock(value?: string): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatElapsed(start: string, end?: string): string {
  const milliseconds = Math.max(0, new Date(end ?? Date.now()).getTime() - new Date(start).getTime());
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${remainder} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function ElapsedTime({ start, end, prefix }: { start: string; end?: string; prefix: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (end) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [end]);
  return <span className="elapsed-time">{prefix} {formatElapsed(start, end)}</span>;
}

function parseToolContent(content: string): { summary: string; output: string; ok: boolean } {
  try {
    const value = JSON.parse(content) as { summary?: unknown; output?: unknown; ok?: unknown };
    return {
      summary: typeof value.summary === "string" ? value.summary : "工具返回结果",
      output: typeof value.output === "string" ? value.output : content,
      ok: value.ok === true,
    };
  } catch {
    return { summary: "工具返回结果", output: content, ok: false };
  }
}

function summaryFromSession(session: AgentSession): SessionSummary {
  return {
    id: session.id,
    workspaceRoot: session.workspaceRoot,
    title: fallbackChatTitle(session.title ?? session.task),
    status: session.status,
    turnCount: session.turns.length,
    changedFileCount: new Set(session.fileChanges.filter((change) => change.status === "applied").map((change) => change.path)).size,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function upsertSessionSummary(items: SessionSummary[], session: AgentSession): SessionSummary[] {
  const summary = summaryFromSession(session);
  return [summary, ...items.filter((item) => item.id !== summary.id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function upsertWorkspaceSession(items: WorkspaceSummary[], session: AgentSession, activate = true): WorkspaceSummary[] {
  return items.map((workspace) => {
    if (workspace.root !== session.workspaceRoot) return workspace;
    const sessions = upsertSessionSummary(workspace.sessions, session);
    return {
      ...workspace,
      sessions,
      sessionCount: sessions.length,
      activeSessionId: activate ? session.id : workspace.activeSessionId,
      updatedAt: session.updatedAt,
    };
  });
}

type SettingsSection = "models" | "skills" | "memory" | "archived";
type ProjectDialog = { mode: "rename" | "archive" | "remove"; root: string; name: string };

function Markdown({ children }: { children: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown></div>;
}

const TOOL_STATUS_LABELS: Record<ToolTrace["status"], string> = {
  proposed: "准备中",
  awaiting_approval: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  blocked: "已阻断",
  cancelled: "已取消",
};
const AUTHORIZATION_LABELS: Record<ToolAuthorization, string> = {
  not_required: "只读工具，无需批准",
  user_approved: "用户批准",
  user_rejected: "用户拒绝",
  full_access: "完全访问自动批准",
  safety_blocked: "安全策略直接阻断",
};

function argumentPreview(call: ToolCall): string {
  try {
    const value = JSON.parse(call.arguments) as Record<string, unknown>;
    return Object.entries(value).slice(0, 2).map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`).join(" · ");
  } catch {
    return call.arguments;
  }
}

function ToolIntent({ call, trace }: { call: ToolCall; trace?: ToolTrace }) {
  const status = trace?.status ?? "proposed";
  return (
    <details className={`process-tool process-tool-${status}`} open={status === "running" || status === "awaiting_approval"}>
      <summary>
        <span className="process-node"><Icon name={call.name === "run_command" ? "terminal" : "file"} size={15}/></span>
        <span className="process-tool-copy"><strong>{call.name}</strong><small>{trace?.summary || argumentPreview(call)}</small></span>
        <span className="process-status">{TOOL_STATUS_LABELS[status]}</span>
      </summary>
      <div className="process-tool-detail">
        {trace?.approvalPolicy === "always" && <div><span>风险层级</span><code className="authorization authorization-user_rejected">始终需要用户批准</code></div>}
        {trace?.authorization && <div><span>授权</span><code className={`authorization authorization-${trace.authorization}`}>{AUTHORIZATION_LABELS[trace.authorization]}</code></div>}
        {trace?.target && <div><span>目标</span><code>{trace.target}</code></div>}
        <div><span>参数</span><code>{argumentPreview(call) || "（无）"}</code></div>
        {trace?.durationMs !== undefined && <div><span>耗时</span><code>{trace.durationMs} ms</code></div>}
        {trace?.result && <pre>{trace.result.output || trace.result.summary}</pre>}
      </div>
    </details>
  );
}

function TurnPlanView({ turn }: { turn: AgentTurn }) {
  if (!turn.plan && !turn.planRequired) return null;
  return (
    <section className="turn-plan" aria-label="本轮计划">
      <header><strong>Plan</strong><span>{turn.plan ? `检查点 ${turn.plan.revision}` : "等待模型建立计划"}</span></header>
      {turn.plan ? (
        <ol>
          {turn.plan.steps.map((step) => (
            <li className={`plan-step plan-step-${step.status}`} key={step.id}>
              <span>{step.status === "completed" ? "✓" : step.status === "in_progress" ? "•" : ""}</span>
              <div><strong>{step.title}</strong><small>{step.status === "completed" ? "已完成" : step.status === "in_progress" ? "进行中" : "待处理"}</small></div>
            </li>
          ))}
        </ol>
      ) : <p>复杂任务在首次文件修改或命令执行前，必须先记录可恢复的步骤。</p>}
    </section>
  );
}

function TurnMetrics({ turn }: { turn: AgentTurn }) {
  const metrics = turn.metrics;
  if (!metrics) return null;
  return (
    <div className="turn-metrics" aria-label="运行预算">
      <span>轮次 <b>{metrics.roundsUsed}/{metrics.maxRounds}</b></span>
      <span>请求 <b>{metrics.modelRequests}</b>{metrics.retryCount > 0 && ` · 重试 ${metrics.retryCount}/${metrics.maxRetries}`}</span>
      <span>工具 <b>{metrics.toolCalls}/{metrics.maxToolCalls}</b></span>
      <span>输出 <b>{formatCompactNumber(metrics.completionTokens)}</b> / 单次 {formatCompactNumber(metrics.maxOutputTokensPerRequest)}</span>
      <span>上下文 <b>{formatCompactNumber(metrics.currentContextTokens)}/{formatCompactNumber(metrics.contextTokenBudget)}</b> · 压缩 {metrics.contextCompactions}</span>
      {metrics.skillCount > 0 && <span>Skill <b>{metrics.skillCount}</b> · 约 {formatCompactNumber(metrics.skillTokens)} tokens</span>}
      <span>累计输入 <b>{formatCompactNumber(metrics.promptTokens)}</b>{metrics.tokenUsageEstimated ? " 约" : ""}</span>
      <span>时限 <b>{formatDurationLimit(metrics.maxRunTimeMs)}</b></span>
    </div>
  );
}

function SkillUsageView({ turn }: { turn: AgentTurn }) {
  if (!turn.skills?.length) return null;
  return (
    <section className="turn-skills" aria-label="本轮 Skills">
      <header><strong>Skills</strong><span>{turn.skills.length} 个 · 约 {formatCompactNumber(turn.skills.reduce((sum, skill) => sum + skill.resources.reduce((resourceSum, resource) => resourceSum + resource.tokens, 0), 0))} tokens</span></header>
      {turn.skills.map((skill) => (
        <article key={`${turn.id}-${skill.source}-${skill.id}-${skill.version}`}>
          <div><strong>{skill.id}</strong><span>{skill.trigger === "explicit" ? "用户指定" : skill.trigger === "model" ? "模型选择" : "旧版自动匹配"} · {skill.source === "builtin" ? "内置" : skill.source === "user" ? "用户" : "项目"}</span></div>
          <p>{skill.reason}</p>
          <small>版本 {skill.version} · 已读取 {skill.resources.length} 项资源{skill.scripts.length > 0 ? ` · 脚本 ${skill.scripts.length} 次` : ""}</small>
        </article>
      ))}
    </section>
  );
}

function SubagentTasksView({ session, turn }: { session: AgentSession; turn: AgentTurn }) {
  const tasks = (session.subtasks ?? []).filter((task) => task.parentTurnId === turn.id);
  if (tasks.length === 0) return null;
  return (
    <section className="subagent-tasks" aria-label="隔离子任务">
      <header><strong>子任务</strong><span>{tasks.filter((task) => task.status === "completed").length}/{tasks.length} 已完成</span></header>
      <div className="subagent-list">
        {tasks.map((task) => (
          <details className={`subagent-card subagent-${task.status}`} key={task.id} open={!['completed', 'cancelled', 'failed'].includes(task.status)}>
            <summary>
              <span className={`subagent-dot ${task.status}`}/>
              <span><strong>{task.role === "analysis" ? "代码分析" : task.role === "test_localization" ? "测试定位" : "代码审查"}</strong><small>{task.mode === "patch_proposal" ? "补丁提案 · 不落盘" : "只读调查"}</small></span>
              <em>{task.status === "completed" ? "已完成" : task.status === "failed" ? "失败" : task.status === "cancelled" ? "已取消" : "运行中"}</em>
            </summary>
            <div className="subagent-detail">
              <p>{task.task}</p>
              <div className="subagent-budget"><span>轮次 {task.metrics?.roundsUsed ?? 0}/{task.budget.maxRounds}</span><span>工具 {task.metrics?.toolCalls ?? 0}/{task.budget.maxToolCalls}</span><span>{task.effectivePermission === "proposal_only" ? "仅提案" : "只读"}</span></div>
              <ol>{task.plan.steps.map((step) => <li key={step.id} className={`subagent-step-${step.status}`}><span>{step.status === "completed" ? "✓" : step.status === "in_progress" ? "•" : ""}</span>{step.title}</li>)}</ol>
              {task.result && <div className="subagent-result"><strong>{task.result.summary}</strong>{task.result.findings.map((finding) => <div key={`${task.id}-${finding.title}`}><p>{finding.title}：{finding.detail}</p>{finding.evidence.map((evidence, index) => <code key={`${evidence.path}-${evidence.line ?? 0}-${index}`}>{evidence.path}{evidence.line ? `:${evidence.line}` : ""} · {evidence.detail}</code>)}</div>)}</div>}
              {task.patches.length > 0 && <p className="subagent-proposals">{task.patches.length} 个候选补丁，均未写入磁盘</p>}
              {task.error && <p className="subagent-error">{task.error}</p>}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function WorkProcess({ session, turn, finalMessageId }: { session: AgentSession; turn: AgentTurn; finalMessageId?: string }) {
  const terminal = TERMINAL_STATUSES.includes(turn.status);
  const tracesForTurn = session.toolTraces.filter((trace) => trace.turnId === turn.id);
  const traces = useMemo(() => new Map(tracesForTurn.map((trace) => [trace.call.id, trace])), [tracesForTurn]);
  const processMessages = session.messages.filter((message) => message.turnId === turn.id && message.role !== "user" && message.id !== finalMessageId);
  const isActiveTurn = session.activeTurnId === turn.id && !terminal;
  const hasContent = processMessages.length > 0 || Boolean(isActiveTurn && (session.streamingReasoning || session.streamingText));
  const turnLabel = `${turnModelLabel(turn)} · ${turn.permissionMode === "ask" ? "请求批准" : "完全访问"}`;

  return (
    <details className="work-process" key={`${turn.id}-${terminal ? "terminal" : "active"}`} open={!terminal}>
      <summary className="work-process-summary">
        <span className={`activity-orb ${terminal ? "done" : "live"}`}>{terminal ? <Icon name="check" size={13}/> : <span/>}</span>
        <span className="work-process-title">
          <strong>{terminal ? "过程与工具调用" : STATUS_LABELS[turn.status]}</strong>
          <small>{terminal ? <>{tracesForTurn.length} 次工具调用 · {turnLabel} · <ElapsedTime start={turn.createdAt} end={turn.finishedAt ?? turn.updatedAt} prefix="用时"/></> : <>实时展示模型思考与执行链 · {turnLabel} · <ElapsedTime start={turn.createdAt} prefix="已运行"/></>}</small>
        </span>
        <Icon name="chevron" size={15}/>
      </summary>
      <div className="process-timeline">
        <TurnPlanView turn={turn}/>
        <TurnMetrics turn={turn}/>
        <SkillUsageView turn={turn}/>
        <SubagentTasksView session={session} turn={turn}/>
        {!hasContent && <div className="process-placeholder">正在理解这轮请求…</div>}
        {processMessages.map((message) => {
          if (message.role === "tool") {
            const parsed = parseToolContent(message.content);
            return (
              <div className={`tool-result ${parsed.ok ? "success" : "failure"}`} key={message.id}>
                <span className="process-node"><Icon name={parsed.ok ? "check" : "square"} size={14}/></span>
                <div><strong>{message.toolName}</strong><span>{parsed.summary}</span><details><summary>查看输出</summary><pre>{parsed.output || "（无输出）"}</pre></details></div>
              </div>
            );
          }
          if (message.role === "user") return null;
          return (
            <div className="assistant-process" key={message.id}>
              {message.reasoningContent && <div className="thinking-copy"><span className="process-node"><span className="thought-dot"/></span><div><strong>思考</strong><p>{message.reasoningContent}</p></div></div>}
              {message.content && <div className="intermediate-copy"><Markdown>{message.content}</Markdown></div>}
              {message.toolCalls?.map((call) => <ToolIntent key={call.id} call={call} trace={traces.get(call.id)}/>)}
            </div>
          );
        })}
        {isActiveTurn && session.streamingReasoning && <div className="thinking-copy streaming-copy"><span className="process-node"><span className="thought-dot"/></span><div><strong>正在思考</strong><p>{session.streamingReasoning}</p></div></div>}
        {isActiveTurn && session.streamingText && <div className="intermediate-copy live-copy"><Markdown>{session.streamingText}</Markdown><span className="typing-caret"/></div>}
      </div>
    </details>
  );
}

function TurnView({ session, turn, index }: { session: AgentSession; turn: AgentTurn; index: number }) {
  const messages = session.messages.filter((message) => message.turnId === turn.id);
  const user = messages.find((message) => message.role === "user");
  const finalAssistant = TERMINAL_STATUSES.includes(turn.status)
    ? [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant" && Boolean(message.content) && !message.toolCalls?.length)
    : undefined;
  return (
    <section className="turn-block" aria-label={`第 ${index + 1} 轮对话`}>
      {index > 0 && <div className="turn-divider"><span>第 {index + 1} 轮</span></div>}
      {user && <article className="user-message"><div>{user.content}</div><time>{formatClock(user.createdAt)}</time></article>}
      <WorkProcess session={session} turn={turn} finalMessageId={finalAssistant?.id}/>
      {finalAssistant && (
        <article className="final-answer">
          <Markdown>{finalAssistant.content}</Markdown>
          <footer><span className={`final-state final-state-${turn.status}`}><Icon name={turn.status === "completed" ? "check" : "square"} size={14}/>{STATUS_LABELS[turn.status]}</span><span>{turnModelLabel(turn)} · {turn.permissionMode === "ask" ? "请求批准" : "完全访问"}</span><time>{formatClock(finalAssistant.createdAt)}</time></footer>
        </article>
      )}
      {turn.error && <div className="error-panel"><strong>{turn.terminationReason ? TERMINATION_LABELS[turn.terminationReason] : "这一轮未完成"}</strong><p>{turn.error}</p><small>可以直接在下方继续说明或纠正；未完成的工具调用不会重放。</small></div>}
    </section>
  );
}

function ChangeReviewPanel({ reviews, onOpen }: { reviews: FileReview[]; onOpen: (review: FileReview) => void }) {
  if (reviews.length === 0) return null;
  const additions = reviews.reduce((total, review) => total + review.additions, 0);
  const deletions = reviews.reduce((total, review) => total + review.deletions, 0);
  return (
    <section className="change-review" aria-label="文件修改审阅">
      <header className="change-review-heading"><div><span className="review-icon"><Icon name="file" size={17}/></span><span><strong>已编辑 {reviews.length} 个文件</strong><small>点击文件，在右侧查看渲染后的变更</small></span></div><span className="review-total"><b>+{additions}</b><em>-{deletions}</em></span></header>
      <div className="review-files">
        {reviews.map((review) => (
          <button className="review-file" key={review.path} onClick={() => onOpen(review)}>
            <span className="review-file-name"><code>{review.path}</code><small>{review.kind === "create" ? "新增" : review.kind === "delete" ? "删除" : "修改"}</small></span>
            <span className="review-stats"><b>+{review.additions}</b><em>-{review.deletions}</em><Icon name="chevron" size={16}/></span>
          </button>
        ))}
      </div>
    </section>
  );
}

function DiffDrawer({ review, busy, undoing, onClose, onUndo, onResizeStart }: { review: FileReview; busy: boolean; undoing: boolean; onClose: () => void; onUndo: () => void; onResizeStart: (clientX: number) => void }) {
  const lines = useMemo(() => renderDiffLines(review.diff), [review.diff]);
  return (
    <aside className="diff-drawer" aria-label={`${review.path} 变更详情`}>
      <div className="diff-resize-handle" onPointerDown={(event) => { event.preventDefault(); onResizeStart(event.clientX); }} aria-hidden="true"/>
      <header className="diff-drawer-header">
        <div><small>文件变更</small><strong>{review.path}</strong></div>
        <button className="diff-close" onClick={onClose} aria-label="关闭变更详情">×</button>
      </header>
      <div className="diff-drawer-summary"><span>{review.kind === "create" ? "新增文件" : review.kind === "delete" ? "删除文件" : "修改文件"}</span><b>+{review.additions}</b><em>-{review.deletions}</em><small>{review.appliedChangeCount} 次生效修改{review.revertedChangeCount ? ` · ${review.revertedChangeCount} 次已撤销` : ""}</small></div>
      <div className="rendered-diff" role="table" aria-label="渲染后的代码差异">
        {lines.map((line, index) => (
          <div className={`diff-line diff-line-${line.kind}`} role="row" key={`${index}-${line.kind}`}>
            <span className="diff-old" role="cell">{line.oldLine ?? ""}</span>
            <span className="diff-new" role="cell">{line.newLine ?? ""}</span>
            <span className="diff-marker" role="cell">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : ""}</span>
            <code role="cell">{line.text || " "}</code>
          </div>
        ))}
        {review.truncated && <div className="diff-truncated">diff 超过安全展示上限，已截断</div>}
      </div>
      <footer className="diff-drawer-actions"><button disabled={busy} onClick={onUndo}><Icon name="undo" size={16}/>{undoing ? "正在撤销" : "撤销最近修改"}</button></footer>
    </aside>
  );
}

function UtilityPanelNavigation({
  active,
  hasPreview,
  hasSideChat,
  onSelect,
}: {
  active: "preview" | "side_chat";
  hasPreview: boolean;
  hasSideChat: boolean;
  onSelect: (mode: "preview" | "side_chat") => void;
}) {
  return <nav className="utility-panel-navigation" aria-label="右侧面板导航">
    {hasPreview && <button className={active === "preview" ? "active" : ""} onClick={() => onSelect("preview")}><Icon name="file" size={14}/>预览</button>}
    {hasSideChat && <button className={active === "side_chat" ? "active" : ""} onClick={() => onSelect("side_chat")}><Icon name="branch" size={14}/>侧边聊天</button>}
  </nav>;
}

function ReferencePreviewPanel({
  preview,
  navigation,
  onClose,
  onResizeStart,
}: {
  preview: ReferencePreview;
  navigation: ReactNode;
  onClose: () => void;
  onResizeStart: (clientX: number) => void;
}) {
  return <aside className="utility-panel reference-preview-panel" aria-label={`${preview.title} 预览`}>
    <div className="panel-resize-handle" onPointerDown={(event) => { event.preventDefault(); onResizeStart(event.clientX); }} aria-hidden="true"/>
    {navigation}
    <header className="reference-preview-header"><div><small>{preview.kind === "skill" ? "Skill" : preview.kind === "directory" ? "文件夹" : "文件"}</small><strong>{preview.title}</strong><span>{preview.subtitle}</span></div><button className="panel-close" onClick={onClose} aria-label="关闭预览">×</button></header>
    <div className="reference-preview-content">
      {preview.kind === "skill" ? <Markdown>{preview.content}</Markdown> : <pre><code>{preview.content}</code></pre>}
      {preview.truncated && <p className="preview-truncated">内容超过侧边预览上限，已截断</p>}
    </div>
  </aside>;
}

function SideChatPanel({
  sideChat,
  navigation,
  onClose,
  onSend,
  onCancel,
  onResizeStart,
}: {
  sideChat: EphemeralSideChatState;
  navigation: ReactNode;
  onClose: () => void;
  onSend: (content: string) => Promise<void>;
  onCancel: () => void;
  onResizeStart: (clientX: number) => void;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requesting = sideChat.status === "requesting";

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTo({ top: element.scrollHeight });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sideChat.updatedAt]);

  const submit = async () => {
    if (!input.trim() || requesting || sending) return;
    setSending(true);
    try {
      await onSend(input);
      setInput("");
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="utility-panel side-chat-panel" aria-label="侧边聊天">
      <div className="panel-resize-handle" onPointerDown={(event) => { event.preventDefault(); onResizeStart(event.clientX); }} aria-hidden="true"/>
      {navigation}
      <header className="side-chat-header">
        <div><Icon name="branch" size={15}/><strong>侧边聊天</strong></div>
        <button className="panel-close" onClick={onClose} aria-label="关闭侧边聊天">×</button>
      </header>
      <p className="side-chat-boundary">侧边聊天是临时聊天，关闭后会消失</p>
      <div className="side-chat-messages" ref={scrollRef}>
        {sideChat.messages.length === 0 && !requesting && <div className="side-chat-welcome"><Icon name="branch" size={21}/><strong>临时问一件事</strong><p>回答只留在这里，不会写回主聊天，也不会调用工具。</p></div>}
        {sideChat.messages.map((message) => message.role === "user"
          ? <article className="side-chat-user" key={message.id}>{message.content}</article>
          : <article className="side-chat-assistant" key={message.id}>{message.reasoningContent && <details><summary>思考过程</summary><p>{message.reasoningContent}</p></details>}<Markdown>{message.content}</Markdown></article>)}
        {requesting && <article className="side-chat-assistant side-chat-streaming">
          {sideChat.streamingReasoning && <details open><summary>正在思考</summary><p>{sideChat.streamingReasoning}</p></details>}
          {sideChat.streamingText && <Markdown>{sideChat.streamingText}</Markdown>}
          <span className="typing-caret"/>
        </article>}
        {sideChat.error && <div className={`side-chat-error ${sideChat.status === "cancelled" ? "cancelled" : ""}`}>{sideChat.error}</div>}
      </div>
      <footer className="side-chat-composer">
        <textarea
          rows={1}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="询问当前主线"
          disabled={requesting}
        />
        {requesting
          ? <button className="side-chat-stop" onClick={onCancel} aria-label="停止 BTW"><Icon name="stop" size={14}/></button>
          : <button className="side-chat-send" onClick={() => void submit()} disabled={!input.trim() || sending} aria-label="发送 BTW"><Icon name="arrow-up" size={16}/></button>}
      </footer>
    </aside>
  );
}

function ChatList({ sessions, activeId, selectDisabled, archiveDisabled, onSelect, onArchive }: { sessions: SessionSummary[]; activeId?: string; selectDisabled: boolean; archiveDisabled: boolean; onSelect: (id: string) => void; onArchive: (id: string) => void }) {
  if (sessions.length === 0) return <p className="empty-chat-list">还没有聊天</p>;
  return <div className="chat-list">{sessions.map((item) => (
    <div className={`chat-item ${item.id === activeId ? "active" : ""}`} key={item.id}>
      <button className="chat-open" disabled={selectDisabled} onClick={() => onSelect(item.id)} title={item.title}><span className="chat-title">{item.title}</span></button>
      <button className="chat-archive" disabled={archiveDisabled} onClick={() => onArchive(item.id)} title="归档聊天" aria-label={`归档 ${item.title}`}><Icon name="archive" size={13}/></button>
    </div>
  ))}</div>;
}

function ModelConnectionEditor({
  connection,
  busy,
  onBusyChange,
  onSaved,
  onNotice,
}: {
  connection?: PublicModelConnection;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved?: () => void;
  onNotice: (notice: { level: "info" | "error"; text: string }) => void;
}) {
  const [name, setName] = useState(connection?.name ?? "新连接");
  const [apiBaseUrl, setApiBaseUrl] = useState(connection?.apiBaseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [tier, setTier] = useState<ModelTier>(connection?.tier ?? "fast");
  const [models, setModels] = useState<string[]>(connection ? [connection.model] : []);
  const [model, setModel] = useState(connection?.model ?? "");
  const [action, setAction] = useState<"test" | "save" | "rename" | "delete" | null>(null);

  useEffect(() => {
    if (!connection) return;
    setName(connection.name);
    setApiBaseUrl(connection.apiBaseUrl);
    setTier(connection.tier);
    setModels((current) => current.includes(connection.model) ? current : [connection.model, ...current]);
    setModel(connection.model);
  }, [connection?.id, connection?.name, connection?.apiBaseUrl, connection?.tier, connection?.model]);

  const run = async (nextAction: "test" | "save" | "rename" | "delete") => {
    if (busy || action) return;
    setAction(nextAction);
    onBusyChange(true);
    try {
      if (nextAction === "test") {
        const result = await window.hammerCode.testModelConnection({
          connectionId: connection?.id,
          apiBaseUrl,
          apiKey: apiKey.trim() || undefined,
        });
        setApiBaseUrl(result.apiBaseUrl);
        setModels(result.models);
        if (!result.models.includes(model)) setModel(result.models[0] ?? "");
        onNotice({ level: "info", text: `连接可用，发现 ${result.models.length} 个模型，耗时 ${result.latencyMs} ms。` });
      } else if (nextAction === "save") {
        const saved = await window.hammerCode.saveModelConnection({
          connectionId: connection?.id,
          name,
          tier,
          model,
          apiBaseUrl,
          apiKey: apiKey.trim() || undefined,
        });
        setApiKey("");
        onNotice({ level: "info", text: `${saved.name} 已保存并通过连接检测。` });
        onSaved?.();
      } else if (nextAction === "rename" && connection) {
        const renamed = await window.hammerCode.renameModelConnection(connection.id, name);
        onNotice({ level: "info", text: `已重命名为 ${renamed.name}。` });
      } else if (nextAction === "delete" && connection) {
        await window.hammerCode.deleteModelConnection(connection.id);
        onNotice({ level: "info", text: `${connection.name} 已删除。` });
      }
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setAction(null);
      onBusyChange(false);
    }
  };

  const status = connection?.connectionStatus ?? "missing";
  const statusLabel = status === "connected" ? "已连接" : status === "configured" ? "已配置" : status === "error" ? "检测失败" : "未配置";
  const canUseExistingKey = Boolean(connection?.hasApiKey);
  const canProbe = Boolean(apiBaseUrl.trim() && (apiKey.trim() || canUseExistingKey));
  const canSave = Boolean(canProbe && name.trim() && model && (connection || models.length > 0));

  return <section className="settings-card model-settings-card">
    <div className="settings-card-title"><div><h2>{connection?.name ?? "新增连接"}</h2><p>{connection?.kind === "default" ? "默认模型槽" : "OpenAI-compatible 连接"} · {tier === "fast" ? "Fast" : "Strong"}</p></div><span className={`model-status status-${status}`}><i className={`connection-dot ${status === "missing" ? "missing" : status === "error" ? "error" : "ready"}`}/>{statusLabel}</span></div>
    <div className="api-form connection-editor-form">
      <div className="connection-form-grid">
        <label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoComplete="off"/></label>
        <label><span>运行档位</span><select value={tier} disabled={connection?.kind === "default"} onChange={(event) => setTier(event.target.value as ModelTier)}><option value="fast">Fast</option><option value="strong">Strong</option></select></label>
      </div>
      <label><span>API URL</span><input type="url" value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} autoComplete="off" spellCheck={false}/></label>
      <label><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={canUseExistingKey ? "已安全保存；留空则继续使用" : "请输入 API Key"} autoComplete="new-password" spellCheck={false}/></label>
      <label><span>模型</span><select value={model} disabled={models.length === 0} onChange={(event) => setModel(event.target.value)}>{models.length === 0 ? <option value="">先检测连接</option> : models.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <div className="api-form-actions connection-actions">
        {connection && <button className="secondary-action" disabled={!name.trim() || name.trim() === connection.name || busy} onClick={() => void run("rename")}>{action === "rename" ? "重命名中…" : "重命名"}</button>}
        {connection?.kind === "custom" && <button className="danger-action" disabled={busy} onClick={() => void run("delete")}>{action === "delete" ? "删除中…" : "删除"}</button>}
        <span/>
        <button className="secondary-action" disabled={!canProbe || busy} onClick={() => void run("test")}>{action === "test" ? "正在检测…" : "检测"}</button>
        <button className="primary-action" disabled={!canSave || busy} onClick={() => void run("save")}>{action === "save" ? "正在保存…" : "保存"}</button>
      </div>
    </div>
    {connection && (connection.connectionMessage || connection.lastCheckedAt) && <div className={`api-test-result ${status === "error" ? "failed" : ""}`}><span className={`connection-dot ${status === "error" ? "error" : "ready"}`}/><div><strong>{statusLabel}</strong><p>{connection.apiBaseUrl}{connection.connectionMessage ? ` · ${connection.connectionMessage}` : ""}</p>{connection.lastCheckedAt && <small>最近检测 {new Date(connection.lastCheckedAt).toLocaleString("zh-CN")}</small>}</div></div>}
  </section>;
}

function SettingsView({
  bootstrap,
  section,
  appBusy,
  onNotice,
}: {
  bootstrap: AppBootstrap;
  section: SettingsSection;
  appBusy: boolean;
  onNotice: (notice: { level: "info" | "error"; text: string }) => void;
}) {
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [showNewConnection, setShowNewConnection] = useState(false);
  const [deletingMemory, setDeletingMemory] = useState<string | null>(null);
  const [savingMemory, setSavingMemory] = useState(false);
  const [transferringMemory, setTransferringMemory] = useState<"import" | "export" | null>(null);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [pendingSkillTrust, setPendingSkillTrust] = useState<PublicSkill | null>(null);
  const [archiveBusy, setArchiveBusy] = useState<string | null>(null);
  const memoryProjects = useMemo(
    () => [...bootstrap.workspaces, ...bootstrap.archivedProjects],
    [bootstrap.workspaces, bootstrap.archivedProjects],
  );
  const [memoryWorkspaceRoot, setMemoryWorkspaceRoot] = useState(
    bootstrap.workspaceRoot ?? memoryProjects[0]?.root ?? "",
  );
  const [viewedMemory, setViewedMemory] = useState<ProjectMemorySnapshot | null>(
    bootstrap.projectMemory,
  );
  const [loadingMemory, setLoadingMemory] = useState(false);
  const [exportPreferenceBusy, setExportPreferenceBusy] = useState(false);
  const memoryProject = memoryProjects.find((project) => project.root === memoryWorkspaceRoot);
  const memoryProjectRoots = memoryProjects.map((project) => project.root).join("\n");

  useEffect(() => {
    if (memoryWorkspaceRoot && memoryProjects.some((project) => project.root === memoryWorkspaceRoot)) return;
    setMemoryWorkspaceRoot(bootstrap.workspaceRoot ?? memoryProjects[0]?.root ?? "");
  }, [bootstrap.workspaceRoot, memoryProjectRoots, memoryWorkspaceRoot]);

  useEffect(() => {
    if (bootstrap.projectMemory?.workspaceRoot === memoryWorkspaceRoot) {
      setViewedMemory(bootstrap.projectMemory);
    }
  }, [bootstrap.projectMemory, memoryWorkspaceRoot]);

  useEffect(() => {
    if (section !== "memory" || !memoryWorkspaceRoot) return;
    let cancelled = false;
    setLoadingMemory(true);
    window.hammerCode.listProjectMemory(memoryWorkspaceRoot).then((snapshot) => {
      if (!cancelled) setViewedMemory(snapshot);
    }).catch((error) => {
      if (!cancelled) onNotice({ level: "error", text: userFacingError(error) });
    }).finally(() => {
      if (!cancelled) setLoadingMemory(false);
    });
    return () => { cancelled = true; };
  }, [memoryWorkspaceRoot, section]);

  const deleteMemory = async (memoryId: string) => {
    if (deletingMemory || !memoryWorkspaceRoot) return;
    setDeletingMemory(memoryId);
    try {
      setViewedMemory(await window.hammerCode.deleteProjectMemory(memoryWorkspaceRoot, memoryId));
      onNotice({ level: "info", text: "项目记忆已删除。" });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setDeletingMemory(null);
    }
  };

  const updateMemorySettings = async (next: Partial<NonNullable<AppBootstrap["projectMemory"]>["settings"]>) => {
    const current = viewedMemory?.settings;
    if (!current || !memoryWorkspaceRoot || savingMemory) return;
    setSavingMemory(true);
    try {
      setViewedMemory(await window.hammerCode.updateProjectMemorySettings(memoryWorkspaceRoot, { ...current, ...next }));
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setSavingMemory(false);
    }
  };

  const transferMemory = async (mode: "import" | "export") => {
    if (transferringMemory || !memoryWorkspaceRoot) return;
    setTransferringMemory(mode);
    try {
      const result = mode === "import"
        ? await window.hammerCode.importProjectMemory(memoryWorkspaceRoot)
        : await window.hammerCode.exportProjectMemory(memoryWorkspaceRoot);
      if (result.status === "cancelled") return;
      if (mode === "import") setViewedMemory(await window.hammerCode.listProjectMemory(memoryWorkspaceRoot));
      onNotice({
        level: "info",
        text: result.status === "exported"
          ? `已导出 ${result.recordCount ?? 0} 条项目记忆到 ${result.fileName ?? "文件"}。`
          : `已从 ${result.fileName ?? "文件"} 导入 ${result.imported ?? 0} 条，跳过 ${result.skipped ?? 0} 条重复记录。`,
      });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setTransferringMemory(null);
    }
  };

  const configureMemoryExport = async (mode: "project" | "custom") => {
    if (!memoryWorkspaceRoot || exportPreferenceBusy || appBusy) return;
    setExportPreferenceBusy(true);
    try {
      const result = await window.hammerCode.configureProjectMemoryExport(memoryWorkspaceRoot, mode);
      if (result.status === "updated") {
        onNotice({
          level: "info",
          text: result.preference.mode === "project"
            ? "默认导出位置已设为项目地址；导出时仍会由访达确认。"
            : "自定义默认目录已保存；导出时仍会由访达确认。",
        });
      }
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setExportPreferenceBusy(false);
    }
  };

  const updateSkillModelActivation = async (enabled: boolean) => {
    if (skillBusy || appBusy) return;
    setSkillBusy("settings");
    try {
      await window.hammerCode.updateSkillSettings({ modelActivationEnabled: enabled });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setSkillBusy(null);
    }
  };

  const setSkillEnabled = async (skill: PublicSkill, enabled: boolean, trustProject = false) => {
    if (skillBusy || appBusy) return;
    if (enabled && skill.source === "project" && !skill.trusted && !trustProject) {
      setPendingSkillTrust(skill);
      return;
    }
    setSkillBusy(skill.key);
    try {
      await window.hammerCode.setSkillEnabled(skill.key, enabled, trustProject);
      setPendingSkillTrust(null);
      onNotice({ level: "info", text: `${skill.name} 已${enabled ? "启用" : "禁用"}；只影响下一轮。` });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setSkillBusy(null);
    }
  };

  const importSkill = async () => {
    if (skillBusy || appBusy) return;
    setSkillBusy("import");
    try {
      const result = await window.hammerCode.importSkill();
      if (result.status !== "cancelled") onNotice({ level: "info", text: `已导入 ${result.skillId ?? "Skill"}。` });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setSkillBusy(null);
    }
  };

  const exportSkill = async (skill: PublicSkill) => {
    if (skillBusy || appBusy) return;
    setSkillBusy(`export:${skill.key}`);
    try {
      const result = await window.hammerCode.exportSkill(skill.key);
      if (result.status !== "cancelled") onNotice({ level: "info", text: `已导出 ${result.fileName ?? skill.name}。` });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setSkillBusy(null);
    }
  };

  const uninstallSkill = async (skill: PublicSkill) => {
    if (skillBusy || appBusy || !window.confirm(`卸载 ${skill.name}？Skill 文件会移入 HammerCode 的可恢复移除目录。`)) return;
    setSkillBusy(`remove:${skill.key}`);
    try {
      await window.hammerCode.uninstallSkill(skill.key);
      onNotice({ level: "info", text: `${skill.name} 已卸载。` });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setSkillBusy(null);
    }
  };

  const changeWorkspaceArchive = async (root: string, mode: "archive" | "restore") => {
    if (archiveBusy || appBusy) return;
    setArchiveBusy(`${mode}:${root}`);
    try {
      if (mode === "archive") await window.hammerCode.archiveWorkspaceChats(root);
      else await window.hammerCode.restoreWorkspaceChats(root);
      onNotice({ level: "info", text: mode === "archive" ? "项目中的聊天已归档，项目仍保留。" : "项目中的归档聊天已恢复。" });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setArchiveBusy(null);
    }
  };

  const restoreArchivedProject = async (root: string) => {
    if (archiveBusy || appBusy) return;
    setArchiveBusy(`project:${root}`);
    try {
      await window.hammerCode.restoreProject(root);
      onNotice({ level: "info", text: "项目已恢复到左侧导航，主聊天位置没有改变。" });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setArchiveBusy(null);
    }
  };

  const restoreArchivedSession = async (sessionId: string) => {
    if (archiveBusy || appBusy) return;
    setArchiveBusy(`restore:${sessionId}`);
    try {
      await window.hammerCode.restoreSession(sessionId);
      onNotice({ level: "info", text: "聊天已恢复到原项目。" });
    } catch (error) {
      onNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setArchiveBusy(null);
    }
  };

  const headings: Record<SettingsSection, { title: string; description: string }> = {
    models: { title: "模型连接", description: "管理默认模型与 OpenAI-compatible 接口。API Key 只会在主进程中加密保存。" },
    skills: { title: "Skills", description: "管理本地工作流、项目级 Skill 和模型自动选择。Skill 不会绕过工具权限。" },
    memory: { title: "项目记忆", description: "记忆按项目隔离，并由你分别控制读取、生成、导入与导出。" },
    archived: { title: "已归档", description: "管理已归档的项目和聊天；归档不会删除任何内容。" },
  };
  const skillControlsDisabled = Boolean(skillBusy) || appBusy;

  return (
    <section className="settings-view">
      <header className="settings-heading"><h1>{headings[section].title}</h1><p>{headings[section].description}</p></header>
      <div className={`settings-section-panel ${section === "models" ? "active" : ""}`}>
      <div className="settings-section-heading"><div><h2>已保存连接</h2><p>检测 URL 后选择服务端返回的模型。</p></div><button className="primary-action settings-create" disabled={connectionBusy || showNewConnection || appBusy} onClick={() => setShowNewConnection(true)}><Icon name="plus" size={14}/>新增连接</button></div>
      {bootstrap.config.connections.map((connection) => <ModelConnectionEditor key={connection.id} connection={connection} busy={connectionBusy || appBusy} onBusyChange={setConnectionBusy} onNotice={onNotice}/>)}
      {showNewConnection && <div className="new-connection-wrap"><div className="new-connection-dialog" role="dialog" aria-modal="true" aria-label="新增模型连接"><button className="cancel-new-connection" disabled={connectionBusy} onClick={() => setShowNewConnection(false)} aria-label="关闭新增连接">×</button><ModelConnectionEditor busy={connectionBusy} onBusyChange={setConnectionBusy} onSaved={() => setShowNewConnection(false)} onNotice={onNotice}/></div></div>}
      </div>
      <section className={`settings-card skill-settings-card settings-section-panel ${section === "skills" ? "active" : ""}`} id="skill-settings">
        <div className="settings-card-title"><div><h2>Skills</h2><p>本地工作流按需加载且默认只对当前 turn 生效，不会授予工具或权限。输入 $ 可显式选择；项目 Skill 来自当前工作区的 .agents/skills/。</p></div><span>{bootstrap.skills.skills.filter((skill) => skill.enabled && skill.valid).length} 个启用</span></div>
        <div className="skill-controls">
          <label className="setting-switch"><span><strong>允许模型选择</strong><small>向模型提供有界名称与 description 目录，正文仍需通过 activate_skill 加载</small></span><input type="checkbox" checked={bootstrap.skills.settings.modelActivationEnabled} disabled={skillControlsDisabled} onChange={(event) => void updateSkillModelActivation(event.target.checked)}/><i aria-hidden="true"/></label>
          <button className="secondary-action" disabled={skillControlsDisabled} onClick={() => void importSkill()}>{skillBusy === "import" ? "正在检查…" : "导入文件夹"}</button>
        </div>
        {bootstrap.skills.skills.length === 0 ? <p className="memory-empty">还没有发现本地 Skill。</p> : <div className="skill-list">
          {bootstrap.skills.skills.map((skill) => <article className={`skill-item ${skill.valid ? "" : "invalid"} compatibility-${skill.compatibilityStatus}`} key={skill.key}>
            <div className="skill-item-main"><div><strong>{skill.id}</strong><span>{skill.name} · {skill.version}</span></div><label className="mini-switch" title={skill.valid ? (skill.enabled ? "禁用" : "启用") : "校验未通过"}><input type="checkbox" checked={skill.enabled} disabled={!skill.valid || skillControlsDisabled} onChange={(event) => void setSkillEnabled(skill, event.target.checked)}/><i aria-hidden="true"/></label></div>
            <p>{skill.description}</p>
            <div className="skill-capabilities"><span>来源 {skill.source === "builtin" ? "内置" : skill.source === "user" ? "用户" : "当前项目"}</span><span>License {skill.license}</span><span className={`skill-compatibility compatibility-${skill.compatibilityStatus}`}>{skill.compatibilityStatus === "compatible" ? "完全兼容" : skill.compatibilityStatus === "partial" ? "可导入但部分不兼容" : "不可使用"}</span><span>声明工具 {skill.capabilities.tools.length} 项（不授权）</span><span>脚本 {skill.capabilities.scripts.length} 个</span>{skill.lastUsedAt && <span>最近使用 {new Date(skill.lastUsedAt).toLocaleString("zh-CN")}</span>}</div>
            {skill.compatibility && <div className="skill-compatibility-note">兼容声明：{skill.compatibility}</div>}
            {skill.compatibilityIssues.length > 0 && <div className="skill-compatibility-note partial">{skill.compatibilityIssues.join("；")}</div>}
            {skill.trustInvalidated && <div className="skill-trust-invalidated">包内容已变化，先前信任已自动撤销；重新启用时需要再次确认完整内容指纹。</div>}
            {skill.issues.length > 0 && <div className="skill-issues">{skill.issues.join("；")}</div>}
            {pendingSkillTrust?.key === skill.key && <div className="skill-trust"><strong>信任当前项目 Skill？</strong><p>来源：当前工作区 .agents/skills/ · 内容指纹 {skill.packageFingerprint.slice(0, 16)}… · 声明工具 {skill.capabilities.tools.join("、") || "无"}（不会授权）· 脚本 {skill.capabilities.scripts.join("、") || "无"}。信任绑定完整包内容，任意文件变化后会自动撤销；操作仍受工作区与审批保护。</p><div><button className="secondary-action" onClick={() => setPendingSkillTrust(null)}>取消</button><button className="primary-action" disabled={appBusy} onClick={() => void setSkillEnabled(skill, true, true)}>检查并信任此版本</button></div></div>}
            <footer><button className="secondary-action" disabled={skillControlsDisabled || !skill.valid} onClick={() => void exportSkill(skill)}>导出</button>{skill.source !== "builtin" && <button className="danger-action" disabled={skillControlsDisabled} onClick={() => void uninstallSkill(skill)}>卸载</button>}</footer>
          </article>)}
        </div>}
      </section>
      <section className={`settings-card memory-settings-card settings-section-panel ${section === "memory" ? "active" : ""}`}>
        <div className="settings-card-title"><div><h2>项目记忆</h2><p>默认跟随主聊天项目，也可以只在这里查看其他项目，不会切换主聊天。</p></div><span>{viewedMemory?.records.filter((record) => record.status === "active").length ?? 0} 条有效</span></div>
        {memoryProjects.length > 0 && <div className="memory-project-picker">
          <label><span>查看项目</span><select value={memoryWorkspaceRoot} disabled={loadingMemory || savingMemory || Boolean(transferringMemory)} onChange={(event) => setMemoryWorkspaceRoot(event.target.value)}>{memoryProjects.map((project) => <option key={project.root} value={project.root}>{project.name}{bootstrap.archivedProjects.some((item) => item.root === project.root) ? "（已归档）" : ""}</option>)}</select></label>
          {memoryProject && <div><strong>{memoryProject.name}</strong><code>{memoryProject.root}</code>{memoryProject.root === bootstrap.workspaceRoot && <small>主聊天当前项目</small>}</div>}
        </div>}
        {memoryProject && viewedMemory?.workspaceRoot === memoryWorkspaceRoot && <div className="memory-controls">
          <label className="setting-switch"><span><strong>启用项目记忆</strong><small>新项目默认关闭</small></span><input type="checkbox" checked={viewedMemory.settings.enabled} disabled={savingMemory} onChange={(event) => void updateMemorySettings({ enabled: event.target.checked })}/><i aria-hidden="true"/></label>
          <div className="memory-subcontrols">
            <label className="setting-switch"><span><strong>读取记忆</strong><small>向新一轮注入相关记录</small></span><input type="checkbox" checked={viewedMemory.settings.useMemories} disabled={!viewedMemory.settings.enabled || savingMemory} onChange={(event) => void updateMemorySettings({ useMemories: event.target.checked })}/><i aria-hidden="true"/></label>
            <label className="setting-switch"><span><strong>生成记忆</strong><small>记录文件变更、验证和明确决定</small></span><input type="checkbox" checked={viewedMemory.settings.generateMemories} disabled={!viewedMemory.settings.enabled || savingMemory} onChange={(event) => void updateMemorySettings({ generateMemories: event.target.checked })}/><i aria-hidden="true"/></label>
          </div>
          <div className="memory-budget"><span>每轮最多 {viewedMemory.settings.maxRecallRecords} 条 · {viewedMemory.settings.maxRecallCharacters.toLocaleString("zh-CN")} 字符</span><span>{memoryWorkspaceRoot === bootstrap.workspaceRoot && bootstrap.session?.turns.at(-1)?.metrics ? `最近注入 ${bootstrap.session.turns.at(-1)!.metrics!.projectMemoryRecords} 条 · 约 ${bootstrap.session.turns.at(-1)!.metrics!.projectMemoryTokens} tokens` : "此处查看不会切换主聊天"}</span></div>
          <div className="memory-export-setting"><div><strong>默认导出位置</strong><small>每次导出仍会打开访达保存面板，由你确认文件名和最终位置。</small></div><div className="memory-export-options"><button className={memoryProject.memoryExport.mode === "project" ? "active" : ""} disabled={exportPreferenceBusy || appBusy} onClick={() => void configureMemoryExport("project")}>项目地址</button><button className={memoryProject.memoryExport.mode === "custom" ? "active" : ""} disabled={exportPreferenceBusy || appBusy} onClick={() => void configureMemoryExport("custom")}>自定义地址</button></div><code>{memoryProject.memoryExport.mode === "custom" ? memoryProject.memoryExport.customDirectory ?? "尚未选择" : memoryProject.root}</code></div>
          <div className="memory-transfer-actions"><button className="secondary-action" disabled={Boolean(transferringMemory) || appBusy} onClick={() => void transferMemory("import")}>{transferringMemory === "import" ? "正在导入…" : "导入"}</button><button className="secondary-action" disabled={Boolean(transferringMemory) || appBusy} onClick={() => void transferMemory("export")}>{transferringMemory === "export" ? "等待访达确认…" : "导出"}</button></div>
        </div>}
        {loadingMemory ? <p className="memory-empty">正在读取项目记忆…</p> : !memoryProject ? <p className="memory-empty">添加项目后可查看项目记忆。</p> : viewedMemory?.workspaceRoot !== memoryWorkspaceRoot ? <p className="memory-empty">无法读取这个项目的记忆。</p> : !viewedMemory.records.length ? <p className="memory-empty">这个项目还没有项目记忆。</p> : <div className="memory-list">
          {viewedMemory.records.map((record) => <article className={`memory-item memory-${record.status} memory-kind-${record.kind}`} key={record.id}>
            <div><strong>{memoryTitle(record)}</strong><span>{record.kind === "decision" ? "决定" : record.kind === "constraint" ? "约束" : record.kind === "verification" ? "验证" : "事实"} · {record.status === "active" ? "有效" : record.status === "conflicted" ? "冲突" : record.status === "invalidated" ? "已失效" : "已删除"}</span></div>
            <p>{memoryDescription(record)}</p>
            <footer><span>{memorySourceTitle(record, bootstrap.workspaces, bootstrap.archivedWorkspaces, bootstrap.archivedProjects)}</span>{record.status !== "deleted" && <button disabled={Boolean(deletingMemory) || appBusy} onClick={() => void deleteMemory(record.id)}>{deletingMemory === record.id ? "删除中…" : "删除"}</button>}</footer>
          </article>)}
        </div>}
      </section>
      <div className={`archive-settings settings-section-panel ${section === "archived" ? "active" : ""}`}>
        {bootstrap.archivedProjects.length > 0 && <section className="settings-card archived-projects-card">
          <div className="settings-card-title"><div><h2>已归档项目</h2><p>恢复项目只让它重新出现在左侧，不会切换当前主聊天。</p></div><span>{bootstrap.archivedProjects.length} 个项目</span></div>
          <div className="archive-project-list">{bootstrap.archivedProjects.map((project) => <div className="archive-project-row" key={project.root}>
            <div><Icon name="folder" size={17}/><span><strong>{project.name}</strong><small>{project.sessionCount} 条活动聊天 · {project.archivedSessionCount} 条归档聊天</small><code>{project.root}</code></span></div>
            <button className="secondary-action" disabled={Boolean(archiveBusy) || appBusy} onClick={() => void restoreArchivedProject(project.root)}>{archiveBusy === `project:${project.root}` ? "恢复中…" : "恢复项目"}</button>
          </div>)}</div>
        </section>}
        <section className="settings-card archive-active-card">
          <div className="settings-card-title"><div><h2>批量整理</h2><p>归档一个项目中的全部聊天，项目本身会继续留在左侧。</p></div></div>
          <div className="archive-project-list">
            {bootstrap.workspaces.map((workspace) => <div className="archive-project-row" key={workspace.root}>
              <div><Icon name="folder" size={17}/><span><strong>{workspace.name}</strong><small>{workspace.sessionCount} 条活动聊天</small></span></div>
              <button className="secondary-action" disabled={workspace.sessionCount === 0 || Boolean(archiveBusy) || appBusy} onClick={() => void changeWorkspaceArchive(workspace.root, "archive")}>{archiveBusy === `archive:${workspace.root}` ? "归档中…" : "全部归档"}</button>
            </div>)}
          </div>
        </section>
        {bootstrap.archivedWorkspaces.every((workspace) => workspace.sessionCount === 0)
          ? bootstrap.archivedProjects.length === 0 && <div className="archive-empty"><Icon name="archive" size={23}/><strong>还没有归档内容</strong><p>归档后的项目和聊天会显示在这里。</p></div>
          : bootstrap.archivedWorkspaces.filter((workspace) => workspace.sessionCount > 0).map((workspace) => <section className="settings-card archived-group" key={workspace.root}>
            <div className="settings-card-title"><div><h2>{workspace.name}</h2><p>{workspace.sessionCount} 条已归档聊天</p></div><button className="secondary-action" disabled={Boolean(archiveBusy) || appBusy} onClick={() => void changeWorkspaceArchive(workspace.root, "restore")}>{archiveBusy === `restore:${workspace.root}` ? "恢复中…" : "全部恢复"}</button></div>
            <div className="archived-chat-list">{workspace.sessions.map((item) => <div className="archived-chat-row" key={item.id}><span><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleString("zh-CN")}</small></span><button disabled={Boolean(archiveBusy) || appBusy} onClick={() => void restoreArchivedSession(item.id)}>{archiveBusy === `restore:${item.id}` ? "恢复中…" : "恢复"}</button></div>)}</div>
          </section>)}
      </div>
    </section>
  );
}

function SettingsShell({
  bootstrap,
  section,
  busy,
  notice,
  onSectionChange,
  onBack,
  onNotice,
  onDismissNotice,
}: {
  bootstrap: AppBootstrap;
  section: SettingsSection;
  busy: boolean;
  notice: { level: "info" | "error"; text: string } | null;
  onSectionChange: (section: SettingsSection) => void;
  onBack: () => void;
  onNotice: (notice: { level: "info" | "error"; text: string }) => void;
  onDismissNotice: () => void;
}) {
  const items: Array<{ id: SettingsSection; label: string; icon: IconName }> = [
    { id: "models", label: "模型连接", icon: "spark" },
    { id: "skills", label: "Skills", icon: "gear" },
    { id: "memory", label: "项目记忆", icon: "branch" },
    { id: "archived", label: "已归档", icon: "archive" },
  ];
  const archivedCount = bootstrap.archivedProjects.length + bootstrap.archivedWorkspaces.reduce((total, workspace) => total + workspace.sessionCount, 0);
  return <div className="settings-shell">
    <aside className="settings-sidebar">
      <div className="settings-sidebar-drag"/>
      <button className="settings-back" onClick={onBack}>← 返回</button>
      <div className="settings-nav-title"><img src={logoUrl} alt=""/><strong>设置</strong></div>
      <nav>{items.map((item) => <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => onSectionChange(item.id)}><Icon name={item.icon} size={16}/><span>{item.label}</span>{item.id === "archived" && archivedCount > 0 && <small>{archivedCount}</small>}</button>)}</nav>
    </aside>
    <main className="settings-main">
      <div className="settings-content">
        {notice && <div className={`notice ${notice.level}`}><span>{notice.text}</span><button onClick={onDismissNotice}>×</button></div>}
        <SettingsView bootstrap={bootstrap} section={section} appBusy={busy} onNotice={onNotice}/>
      </div>
    </main>
  </div>;
}

function ContextRing({
  session,
  budget,
  autoCompactRatio,
  compacting,
}: {
  session: AgentSession | null;
  budget: number;
  autoCompactRatio: number;
  compacting: boolean;
}) {
  const turn = session?.turns.find((item) => item.id === session.activeTurnId) ?? session?.turns.at(-1);
  const used = turn?.metrics?.currentContextTokens ?? 0;
  const ratio = Math.max(0, Math.min(1, budget > 0 ? used / budget : 0));
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const compactions = session?.contextMemory?.compactionCount ?? turn?.metrics?.contextCompactions ?? 0;
  const tooltip = compacting
    ? "正在使用模型压缩上下文，完成前不会替换现有记忆"
    : `已用 ${Math.round(ratio * 100)}% · 记忆窗口 ${formatMemoryTokens(used)}/${formatMemoryTokens(budget)} · 自动压缩 ${Math.round(autoCompactRatio * 100)}% · 已压缩 ${compactions} 次`;
  return <span className={`context-ring ${session ? "" : "empty"} ${compacting ? "compacting" : ""}`} data-tooltip={tooltip} role="img" aria-label={tooltip}>
    <svg viewBox="0 0 22 22" aria-hidden="true"><circle className="context-ring-track" cx="11" cy="11" r={radius}/><circle className="context-ring-value" cx="11" cy="11" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)}/></svg>
  </span>;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [archivedWorkspaces, setArchivedWorkspaces] = useState<ArchivedWorkspaceSummary[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProjectSummary[]>([]);
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(new Set());
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [modelTier, setModelTier] = useState<ModelTier>("fast");
  const [modelRef, setModelRef] = useState<ModelRef>("builtin:fast");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
  const [projectMenu, setProjectMenu] = useState<{ root: string; top: number; left: number } | null>(null);
  const [projectDialog, setProjectDialog] = useState<ProjectDialog | null>(null);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [task, setTask] = useState("");
  const [composerEntities, setComposerEntities] = useState<ComposerEntity[]>([]);
  const [busy, setBusy] = useState(false);
  const [contextCompacting, setContextCompacting] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [showFullAccessWarning, setShowFullAccessWarning] = useState(false);
  const [selectedReviewPath, setSelectedReviewPath] = useState<string | null>(null);
  const [sideChat, setSideChat] = useState<EphemeralSideChatState | null>(null);
  const [referencePreview, setReferencePreview] = useState<ReferencePreview | null>(null);
  const [panelMode, setPanelMode] = useState<"review" | "preview" | "side_chat" | null>(null);
  const [panelRatio, setPanelRatio] = useState(DEFAULT_PANEL_RATIO);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [composerCursor, setComposerCursor] = useState(0);
  const [paletteMode, setPaletteMode] = useState<"models" | null>(null);
  const [mentionEntries, setMentionEntries] = useState<WorkspaceEntry[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [notice, setNotice] = useState<{ level: "info" | "error"; text: string } | null>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoScrollRef = useRef(true);
  const navigationRef = useRef<{ workspaceRoot: string | null; sessionId: string | null }>({ workspaceRoot: null, sessionId: null });

  useEffect(() => {
    let mounted = true;
    window.hammerCode.bootstrap().then((value) => {
      if (!mounted) return;
      setBootstrap(value);
      setSession(value.session);
      setSessions(value.sessions);
      setWorkspaces(value.workspaces);
      setArchivedWorkspaces(value.archivedWorkspaces);
      setArchivedProjects(value.archivedProjects);
      navigationRef.current = { workspaceRoot: value.workspaceRoot, sessionId: value.session?.id ?? null };
      setExpandedRoots(new Set(value.workspaces.map((workspace) => workspace.root)));
      setWorkspaceRoot(value.workspaceRoot);
      setModelTier(value.session?.modelTier ?? "fast");
      setModelRef(value.session?.modelRef ?? `builtin:${value.session?.modelTier ?? "fast"}`);
      setPermissionMode(value.session?.permissionMode ?? "ask");
    }).catch((error: unknown) => setNotice({ level: "error", text: userFacingError(error) }));
    const unsubscribe = window.hammerCode.onEvent((event: RendererEvent) => {
      if (event.type === "session_snapshot") {
        navigationRef.current.sessionId = event.session.id;
        setSession(event.session);
        setSessions((items) => upsertSessionSummary(items, event.session));
        setWorkspaces((items) => upsertWorkspaceSession(items, event.session));
        setModelTier(event.session.modelTier);
        setModelRef(event.session.modelRef ?? `builtin:${event.session.modelTier}`);
        setPermissionMode(event.session.permissionMode);
      }
      if (event.type === "session_updated") {
        setSessions((items) => upsertSessionSummary(items, event.session));
        setWorkspaces((items) => upsertWorkspaceSession(items, event.session, false));
      }
      if (event.type === "session_cleared") {
        navigationRef.current.sessionId = null;
        setSession(null);
        setModelTier("fast");
        setModelRef("builtin:fast");
        setPermissionMode("ask");
      }
      if (event.type === "sessions_changed") setSessions(event.sessions);
      if (event.type === "side_chat_snapshot") setSideChat(event.sideChat);
      if (event.type === "side_chat_closed") setSideChat(null);
      if (event.type === "workspace_changed") {
        const navigationChanged = navigationRef.current.workspaceRoot !== event.workspaceRoot || navigationRef.current.sessionId !== (event.session?.id ?? null);
        navigationRef.current = { workspaceRoot: event.workspaceRoot, sessionId: event.session?.id ?? null };
        setWorkspaceRoot(event.workspaceRoot);
        setWorkspaces(event.workspaces);
        setArchivedWorkspaces(event.archivedWorkspaces);
        setArchivedProjects(event.archivedProjects);
        setSessions(event.sessions);
        setSession(event.session);
        setExpandedRoots((roots) => {
          const next = new Set(roots);
          if (event.workspaceRoot) next.add(event.workspaceRoot);
          return next;
        });
        setModelTier(event.session?.modelTier ?? "fast");
        setModelRef(event.session?.modelRef ?? `builtin:${event.session?.modelTier ?? "fast"}`);
        setPermissionMode(event.session?.permissionMode ?? "ask");
        if (navigationChanged) {
          setTask("");
          setComposerEntities([]);
          setReferencePreview(null);
          setPanelMode(null);
        }
        setBootstrap((current) => current ? {
          ...current,
          session: event.session,
          sessions: event.sessions,
          workspaces: event.workspaces,
          archivedWorkspaces: event.archivedWorkspaces,
          archivedProjects: event.archivedProjects,
          workspaceRoot: event.workspaceRoot,
        } : current);
      }
      if (event.type === "config_updated") {
        setBootstrap((current) => current ? {
          ...current,
          config: event.config,
        } : current);
      }
      if (event.type === "project_memory_updated") {
        setBootstrap((current) => current ? { ...current, projectMemory: event.memory } : current);
      }
      if (event.type === "skills_updated") {
        setBootstrap((current) => current ? { ...current, skills: event.skills } : current);
      }
      if (event.type === "notification") setNotice({ level: event.level, text: event.message });
    });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (view !== "settings") return;
    textareaRef.current?.blur();
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".settings-back")?.focus());
  }, [view]);

  const isRunning = Boolean(session && ACTIVE_STATUSES.includes(session.status));
  const isBusy = isRunning || Boolean(session?.pendingUndo);
  const hasRunningSession = workspaces.some((workspace) =>
    workspace.sessions.some((item) => ACTIVE_STATUSES.includes(item.status)),
  );
  const anotherSessionIsRunning = hasRunningSession && !isRunning;
  const selectedModel = bootstrap?.config.availableModels.find((option) => option.ref === modelRef);
  const fileReviews = useMemo(
    () => session ? buildFileReviews(session.fileChanges) : [],
    [session?.fileChanges],
  );
  const selectedReview = fileReviews.find((review) => review.path === selectedReviewPath);
  const panelOpen = Boolean(
    (panelMode === "review" && selectedReview) ||
    (panelMode === "preview" && referencePreview) ||
    (panelMode === "side_chat" && sideChat),
  );
  const workbenchLayout = useMemo(
    () => computeWorkbenchLayout(viewportWidth, panelRatio),
    [viewportWidth, panelRatio],
  );
  const activeTurn = session?.turns.find((turn) => turn.id === session.activeTurnId);
  const composerToken = useMemo(() => detectComposerToken(task, composerCursor), [task, composerCursor]);

  useEffect(() => {
    if (composerToken?.kind !== "mention" || !workspaceRoot) {
      setMentionEntries([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.hammerCode.searchWorkspaceEntries(composerToken.query).then((entries) => {
        if (!cancelled) setMentionEntries(entries);
      }).catch((error) => {
        if (!cancelled) setNotice({ level: "error", text: userFacingError(error) });
      });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [composerToken?.kind, composerToken?.query, workspaceRoot]);

  useEffect(() => setPaletteIndex(0), [composerToken?.kind, composerToken?.query, paletteMode]);

  useEffect(() => {
    setSelectedReviewPath(null);
    setSideChat(null);
    setReferencePreview(null);
    setPanelMode(null);
    setComposerEntities([]);
    autoScrollRef.current = true;
    setShowJumpToLatest(false);
  }, [session?.id]);

  useEffect(() => {
    if (selectedReviewPath && !selectedReview) setSelectedReviewPath(null);
  }, [selectedReview, selectedReviewPath]);

  useEffect(() => {
    if (panelMode === "side_chat" && !sideChat) setPanelMode(referencePreview ? "preview" : null);
    if (panelMode === "preview" && !referencePreview) setPanelMode(sideChat ? "side_chat" : null);
    if (panelMode === "review" && !selectedReview) setPanelMode(null);
  }, [panelMode, referencePreview, selectedReview, sideChat]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation || !session || !autoScrollRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      conversation.scrollTo({ top: conversation.scrollHeight });
      setShowJumpToLatest(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [session?.updatedAt]);

  const handleConversationScroll = () => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 72;
    autoScrollRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  };

  const scrollToLatest = () => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    autoScrollRef.current = true;
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: "smooth" });
    setShowJumpToLatest(false);
  };

  const chooseWorkspace = async () => {
    setBusy(true);
    try { await window.hammerCode.chooseWorkspace(); setNotice(null); }
    catch (error) { setNotice({ level: "error", text: userFacingError(error) }); }
    finally { setBusy(false); }
  };

  const toggleWorkspace = (root: string) => {
    setExpandedRoots((roots) => {
      const next = new Set(roots);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  const startChatInWorkspace = async (root: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (root !== workspaceRoot) await window.hammerCode.selectWorkspace(root);
      await window.hammerCode.newChat();
      setView("chat");
      setTask("");
      setComposerEntities([]);
      setNotice(null);
    } catch (error) {
      setNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  };

  const newChat = async () => {
    if (busy) return;
    try { await window.hammerCode.newChat(); setView("chat"); setTask(""); setComposerEntities([]); setNotice(null); }
    catch (error) { setNotice({ level: "error", text: userFacingError(error) }); }
  };

  const selectSession = async (id: string) => {
    if (id === session?.id) return;
    setBusy(true);
    try { await window.hammerCode.selectSession(id); setView("chat"); setNotice(null); }
    catch (error) { setNotice({ level: "error", text: userFacingError(error) }); }
    finally { setBusy(false); }
  };

  const archiveSession = async (id: string) => {
    if (busy || isBusy) return;
    setBusy(true);
    try {
      await window.hammerCode.archiveSession(id);
      setNotice({ level: "info", text: "聊天已归档，可在设置的“已归档”中恢复。" });
    } catch (error) {
      setNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  };

  const openProjectMenu = (event: ReactMouseEvent<HTMLButtonElement>, root: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 184;
    setProjectMenu({
      root,
      top: Math.min(rect.bottom + 5, window.innerHeight - 174),
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    });
  };

  const pinProject = async (project: WorkspaceSummary) => {
    if (busy || hasRunningSession) return;
    setProjectMenu(null);
    setBusy(true);
    try {
      await window.hammerCode.setProjectPinned(project.root, !project.pinned);
      setNotice({ level: "info", text: project.pinned ? `${project.name} 已取消置顶。` : `${project.name} 已置顶。` });
    } catch (error) {
      setNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  };

  const openProjectDialog = (project: WorkspaceSummary, mode: ProjectDialog["mode"]) => {
    setProjectMenu(null);
    setProjectNameDraft(project.name);
    setProjectDialog({ mode, root: project.root, name: project.name });
  };

  const confirmProjectDialog = async () => {
    if (!projectDialog || busy || hasRunningSession) return;
    const nextName = projectNameDraft.trim();
    if (projectDialog.mode === "rename" && !nextName) return;
    setBusy(true);
    try {
      if (projectDialog.mode === "rename") {
        await window.hammerCode.renameProject(projectDialog.root, nextName);
        setNotice({ level: "info", text: `项目已重命名为 ${nextName}。磁盘文件夹名称没有改变。` });
      } else if (projectDialog.mode === "archive") {
        await window.hammerCode.archiveProject(projectDialog.root);
        setNotice({ level: "info", text: `${projectDialog.name} 已归档，可在设置中恢复。` });
      } else {
        await window.hammerCode.removeProject(projectDialog.root);
        setNotice({ level: "info", text: `${projectDialog.name} 已从导航移除。重新打开该文件夹可恢复原聊天。` });
      }
      setProjectDialog(null);
    } catch (error) {
      setNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  };

  const focusComposerAt = (position: number) => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(position, position);
      setComposerCursor(position);
    });
  };

  const replaceActiveToken = (replacement: string) => {
    if (!composerToken) return;
    const next = replaceComposerToken(task, composerToken, replacement);
    const position = composerToken.start + replacement.length;
    setTask(next);
    focusComposerAt(position);
  };

  const compressContext = async () => {
    if (!session || isBusy || busy) return;
    setBusy(true);
    setContextCompacting(true);
    try {
      await window.hammerCode.compressContext();
      setNotice(null);
    } catch (error) {
      const message = userFacingError(error);
      setNotice(message.includes("上下文压缩已停止") ? null : { level: "error", text: message });
    } finally {
      setContextCompacting(false);
      setBusy(false);
    }
  };

  const openSideChat = async () => {
    if (!session) return;
    try {
      setSelectedReviewPath(null);
      setSideChat(await window.hammerCode.openSideChat());
      setPanelMode("side_chat");
      setNotice(null);
    } catch (error) {
      setNotice({ level: "error", text: userFacingError(error) });
    }
  };

  const closeSideChat = async () => {
    const current = sideChat;
    setSideChat(null);
    setPanelMode(referencePreview ? "preview" : null);
    if (!current) return;
    try { await window.hammerCode.closeSideChat(current.id); }
    catch (error) { setNotice({ level: "error", text: userFacingError(error) }); }
  };

  const selectSlashCommand = (id: ComposerCommandId) => {
    replaceActiveToken("");
    if (id === "side_chat") {
      setPaletteMode(null);
      void openSideChat();
      return;
    }
    if (id === "compress") {
      setPaletteMode(null);
      void compressContext();
      return;
    }
    if (id === "skills") {
      setPaletteMode(null);
      setSettingsSection("skills");
      setView("settings");
      return;
    }
    setPaletteMode(id);
  };

  const selectMention = (entry: WorkspaceEntry) => {
    replaceActiveToken("");
    setComposerEntities((items) => appendComposerEntity(items, workspaceComposerEntity(entry)));
    setMentionEntries([]);
    setPaletteMode(null);
  };

  const selectSkill = (skill: PublicSkill) => {
    replaceActiveToken("");
    setComposerEntities((items) => appendComposerEntity(items, skillComposerEntity(skill)));
    setPaletteMode(null);
  };

  const removeComposerEntity = (key: string) => {
    setComposerEntities((items) => items.filter((item) => item.key !== key));
  };

  const openEntityPreview = async (entity: ComposerEntity) => {
    setSelectedReviewPath(null);
    setPanelMode("preview");
    setReferencePreview({
      key: entity.key,
      kind: entity.kind,
      title: entity.label,
      subtitle: entity.detail,
      content: "正在读取预览…",
      truncated: false,
    });
    try {
      const preview = entity.kind === "skill"
        ? await window.hammerCode.previewSkill(entity.value)
        : await window.hammerCode.previewWorkspaceEntry(entity.value);
      setReferencePreview(preview);
      setNotice(null);
    } catch (error) {
      setReferencePreview(null);
      setPanelMode(sideChat ? "side_chat" : null);
      setNotice({ level: "error", text: userFacingError(error) });
    }
  };

  const closeReferencePreview = () => {
    setReferencePreview(null);
    setPanelMode(sideChat ? "side_chat" : null);
  };

  const startPanelResize = (_clientX: number) => {
    document.body.classList.add("panel-resizing");
    const onMove = (event: PointerEvent) => {
      setPanelRatio(panelRatioFromDivider(window.innerWidth, event.clientX));
    };
    const onUp = () => {
      document.body.classList.remove("panel-resizing");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  };

  const persistSettings = async (nextModelRef: ModelRef, nextPermission: PermissionMode) => {
    if (isBusy || settingsBusy) return;
    const option = bootstrap?.config.availableModels.find((item) => item.ref === nextModelRef);
    if (!option?.hasApiKey) {
      setNotice({
        level: "error",
        text: "这个模型尚未配置可用的 API key。",
      });
      return;
    }
    const nextModel = option.builtinTier ?? modelTier;
    const previousModel = modelTier;
    const previousModelRef = modelRef;
    const previousPermission = permissionMode;
    setModelTier(nextModel);
    setModelRef(nextModelRef);
    setPermissionMode(nextPermission);
    if (!session) return;
    setSettingsBusy(true);
    try {
      await window.hammerCode.updateSessionSettings({ modelTier: nextModel, modelRef: nextModelRef, permissionMode: nextPermission });
      setNotice(null);
    } catch (error) {
      setModelTier(previousModel);
      setModelRef(previousModelRef);
      setPermissionMode(previousPermission);
      setNotice({ level: "error", text: userFacingError(error) });
    } finally {
      setSettingsBusy(false);
    }
  };

  const choosePermission = (nextPermission: PermissionMode) => {
    if (nextPermission !== "full_access") {
      void persistSettings(modelRef, nextPermission);
      return;
    }
    let confirmed = false;
    try { confirmed = window.localStorage.getItem("hammercode.full-access-warning") === "acknowledged"; }
    catch { confirmed = false; }
    if (!confirmed) {
      setShowFullAccessWarning(true);
      return;
    }
    void persistSettings(modelRef, nextPermission);
  };

  const confirmFullAccess = () => {
    try { window.localStorage.setItem("hammercode.full-access-warning", "acknowledged"); }
    catch { /* The warning is still acknowledged for this selection. */ }
    setShowFullAccessWarning(false);
    void persistSettings(modelRef, "full_access");
  };

  const submit = async () => {
    const serializedTask = serializeComposerTask(task, composerEntities);
    if (!serializedTask || !workspaceRoot || isBusy || anotherSessionIsRunning || !selectedModel?.hasApiKey) return;
    setBusy(true);
    autoScrollRef.current = true;
    setShowJumpToLatest(false);
    setNotice(null);
    try {
      await window.hammerCode.startTask({ task: serializedTask, modelTier, modelRef, permissionMode });
      setTask("");
      setComposerEntities([]);
    } catch (error) { setNotice({ level: "error", text: userFacingError(error) }); }
    finally { setBusy(false); }
  };

  const resolveApproval = async (approved: boolean) => {
    if (!session?.pendingApproval) return;
    try { await window.hammerCode.resolveApproval(session.pendingApproval.id, approved); }
    catch (error) { setNotice({ level: "error", text: userFacingError(error) }); }
  };

  const requestUndo = async (changeId: string) => {
    try { await window.hammerCode.requestUndo(changeId); setNotice(null); }
    catch (error) { setNotice({ level: "error", text: userFacingError(error) }); }
  };

  if (!bootstrap) return <main className="loading"><img className="loading-mark" src={logoUrl} alt=""/><p>正在打开 HammerCode…</p></main>;

  const slashCommands = filterComposerCommands(composerToken?.query ?? "").map((command) => ({
    ...command,
    disabled: command.id === "skills" ? false : command.id === "side_chat" ? !session : command.id === "models" ? isBusy : !session || isBusy,
  }));
  const skillOptions = composerToken?.kind === "skill"
    ? bootstrap.skills.skills.filter((skill) =>
        skill.valid && skill.enabled && skill.trusted &&
        `${skill.id} ${skill.name} ${skill.description}`.toLocaleLowerCase("zh-CN").includes(composerToken.query.toLocaleLowerCase("zh-CN")),
      )
    : [];
  const paletteCount = paletteMode === "models"
      ? bootstrap.config.availableModels.length
      : composerToken?.kind === "mention"
        ? mentionEntries.length
        : composerToken?.kind === "skill"
          ? skillOptions.length
        : composerToken?.kind === "slash"
          ? slashCommands.length
          : 0;
  const paletteOpen = paletteCount > 0 || Boolean(paletteMode) || Boolean(composerToken);

  const selectPaletteItem = (index: number) => {
    if (paletteMode === "models") {
      const option = bootstrap.config.availableModels[index];
      if (option?.hasApiKey) { setPaletteMode(null); void persistSettings(option.ref, permissionMode); }
      return;
    }
    if (composerToken?.kind === "mention") {
      const entry = mentionEntries[index];
      if (entry) selectMention(entry);
      return;
    }
    if (composerToken?.kind === "skill") {
      const skill = skillOptions[index];
      if (skill) selectSkill(skill);
      return;
    }
    if (composerToken?.kind === "slash") {
      const command = slashCommands[index];
      if (command && !command.disabled) selectSlashCommand(command.id);
    }
  };

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (paletteOpen && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setPaletteIndex((value) => paletteCount > 0 ? (value + direction + paletteCount) % paletteCount : 0);
      return;
    }
    if (paletteOpen && event.key === "Escape") {
      event.preventDefault();
      setPaletteMode(null);
      setComposerCursor(-1);
      return;
    }
    if (paletteOpen && event.key === "Enter" && !event.shiftKey && paletteCount > 0) {
      event.preventDefault();
      selectPaletteItem(Math.min(paletteIndex, paletteCount - 1));
      return;
    }
    if (
      event.key === "Backspace" &&
      !paletteOpen &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0 &&
      composerEntities.length > 0
    ) {
      event.preventDefault();
      setComposerEntities((items) => items.slice(0, -1));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
      void submit();
    }
  };

  const panelVisible = panelOpen && !workbenchLayout.panelCollapsed;
  const layoutStyle = {
    "--sidebar-column": `${workbenchLayout.sidebarWidth}px`,
    "--main-column": `${workbenchLayout.mainWidth}px`,
    "--panel-column": `${workbenchLayout.panelWidth}px`,
  } as CSSProperties;
  const composerLocked = !workspaceRoot || anotherSessionIsRunning || busy || Boolean(session?.pendingUndo);
  const settingsBootstrap: AppBootstrap = { ...bootstrap, session, sessions, workspaces, archivedWorkspaces, archivedProjects, workspaceRoot };
  const menuProject = projectMenu ? workspaces.find((project) => project.root === projectMenu.root) : undefined;

  return (
    <div className={`app-shell ${panelVisible ? "panel-open" : ""} ${panelOpen && workbenchLayout.panelCollapsed ? "panel-auto-collapsed" : ""}`} style={layoutStyle}>
      {projectMenu && menuProject && <div className="project-menu-layer" onMouseDown={() => setProjectMenu(null)}><div className="project-menu" style={{ top: projectMenu.top, left: projectMenu.left }} role="menu" onMouseDown={(event) => event.stopPropagation()}>
        <button role="menuitem" disabled={hasRunningSession || busy} onClick={() => void pinProject(menuProject)}><Icon name="pin" size={15}/>{menuProject.pinned ? "取消置顶" : "置顶项目"}</button>
        <button role="menuitem" disabled={hasRunningSession || busy} onClick={() => openProjectDialog(menuProject, "rename")}><Icon name="compose" size={15}/>重命名</button>
        <button role="menuitem" disabled={hasRunningSession || busy} onClick={() => openProjectDialog(menuProject, "archive")}><Icon name="archive" size={15}/>归档项目</button>
        <button className="danger" role="menuitem" disabled={hasRunningSession || busy} onClick={() => openProjectDialog(menuProject, "remove")}><Icon name="remove" size={15}/>移除项目</button>
      </div></div>}
      {projectDialog && <div className="project-dialog-layer"><div className="project-dialog" role="dialog" aria-modal="true" aria-label={projectDialog.mode === "rename" ? "重命名项目" : projectDialog.mode === "archive" ? "归档项目" : "移除项目"}>
        <h2>{projectDialog.mode === "rename" ? "重命名项目" : projectDialog.mode === "archive" ? `归档 ${projectDialog.name}？` : `移除 ${projectDialog.name}？`}</h2>
        {projectDialog.mode === "rename" ? <><p>只改变 HammerCode 中的显示名称，不会重命名磁盘文件夹。</p><input autoFocus maxLength={80} value={projectNameDraft} onChange={(event) => setProjectNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void confirmProjectDialog(); }}/></> : <p>{projectDialog.mode === "archive" ? "项目会从左侧隐藏，并保留全部聊天和记忆；之后可在设置的“已归档”中恢复。" : "项目会从 HammerCode 导航中解除绑定，但不会删除项目文件、聊天或记忆。重新打开同一文件夹即可恢复。"}</p>}
        <div><button className="secondary-action" disabled={busy} onClick={() => setProjectDialog(null)}>取消</button><button className={projectDialog.mode === "remove" ? "danger-action" : "primary-action"} disabled={busy || (projectDialog.mode === "rename" && !projectNameDraft.trim())} onClick={() => void confirmProjectDialog()}>{busy ? "处理中…" : projectDialog.mode === "rename" ? "保存名称" : projectDialog.mode === "archive" ? "归档项目" : "移除项目"}</button></div>
      </div></div>}
      {view === "settings" && <SettingsShell bootstrap={settingsBootstrap} section={settingsSection} busy={hasRunningSession || isBusy || busy} notice={notice} onSectionChange={setSettingsSection} onBack={() => { setView("chat"); setNotice(null); }} onNotice={setNotice} onDismissNotice={() => setNotice(null)}/>}
      <aside className="sidebar" aria-hidden={view === "settings"}>
        <div className="sidebar-drag"/>
        <header className="brand-row"><button className="brand-button" aria-label="HammerCode"><img className="brand-logo" src={logoUrl} alt=""/>HammerCode <span>⌄</span></button></header>
        <nav className="primary-nav" aria-label="主要导航"><button className="new-chat-button" onClick={newChat} disabled={busy || !workspaceRoot}><Icon name="plus" size={17}/><span>新对话</span></button></nav>
        <section className="projects-section">
          <div className="section-heading"><span>项目</span><button onClick={chooseWorkspace} disabled={busy || Boolean(session?.pendingUndo)} aria-label="添加工作区"><Icon name="plus" size={14}/></button></div>
          <div className="project-list">
            {workspaces.map((workspace) => (
              <section className={`project-group ${workspace.root === workspaceRoot ? "active" : ""}`} key={workspace.root}>
                <div className="project-row" title={workspace.root}><button className="project-toggle" onClick={() => toggleWorkspace(workspace.root)} aria-expanded={expandedRoots.has(workspace.root)}><span className={`project-chevron ${expandedRoots.has(workspace.root) ? "expanded" : ""}`}><Icon name="chevron" size={14}/></span><Icon name="folder" size={18}/><span className="project-name">{workspace.pinned && <Icon name="pin" size={12}/>}<span>{workspace.name}</span></span><small>{workspace.sessionCount || ""}</small></button><button className="project-add-chat" onClick={() => void startChatInWorkspace(workspace.root)} disabled={busy || Boolean(session?.pendingUndo)} aria-label={`在 ${workspace.name} 中新建聊天`} title="新建聊天"><Icon name="compose" size={15}/></button><button className="project-more" onClick={(event) => openProjectMenu(event, workspace.root)} disabled={busy} aria-label={`${workspace.name} 项目选项`} title="项目选项"><Icon name="more" size={16}/></button></div>
                {expandedRoots.has(workspace.root) && (
                  workspace.sessions.length > 0
                    ? <ChatList sessions={workspace.sessions} activeId={session?.id} selectDisabled={busy || Boolean(session?.pendingUndo)} archiveDisabled={busy || hasRunningSession || isBusy} onSelect={(id) => void selectSession(id)} onArchive={(id) => void archiveSession(id)}/>
                    : <button className="empty-chat-list" disabled={busy || Boolean(session?.pendingUndo)} onClick={() => void startChatInWorkspace(workspace.root)}>在此项目开始新对话</button>
                )}
              </section>
            ))}
            {workspaces.length === 0 && <button className="empty-projects" onClick={chooseWorkspace}><Icon name="folder" size={17}/>打开文件夹</button>}
          </div>
        </section>
        <footer className="sidebar-footer">
          <button className={`settings-nav ${view === "settings" ? "active" : ""}`} onClick={() => setView("settings")}><Icon name="gear" size={17}/><span>设置</span></button>
          {(["fast", "strong"] as ModelTier[]).map((tier) => {
            const state = bootstrap.config.models[tier].connectionStatus;
            return <div className="runtime-line" key={tier}><span className={`connection-dot ${state === "missing" ? "missing" : state === "error" ? "error" : "ready"}`}/><strong>{tier === "fast" ? "Fast" : "Strong"} · {bootstrap.config.models[tier].model}</strong></div>;
          })}
          <span>本地工具受工作区安全边界保护</span>
        </footer>
      </aside>

      <main className="workspace" aria-hidden={view === "settings"}>
        <header className="topbar">
          <div className="topbar-title"><Icon name={view === "settings" ? "gear" : "folder"} size={17}/><strong>{view === "settings" ? "设置" : session ? fallbackChatTitle(session.title ?? session.task) : "新对话"}</strong>{view === "chat" && workspaceRoot && <span>{folderName(workspaceRoot)}</span>}</div>
          <div className="top-actions">{isRunning && activeTurn && <div className="run-status" aria-label="任务正在运行"><span className="run-status-dot"/>运行中 · <ElapsedTime start={activeTurn.createdAt} prefix="已运行"/></div>}{session?.pendingUndo?.status === "executing" && <span className="undo-running"><Icon name="undo" size={14}/>正在撤销</span>}</div>
        </header>

        <section className="conversation" ref={conversationRef} onScroll={handleConversationScroll}>
          {!session ? (
            <div className="welcome"><img className="welcome-mark" src={logoUrl} alt="HammerCode"/><h1>{workspaceRoot ? `在 ${folderName(workspaceRoot)} 中开始` : "选择一个工作区"}</h1><p>{workspaceRoot ? (permissionMode === "ask" ? "描述你想完成的开发任务。文件修改和命令执行会逐次向你确认。" : "完全访问已选中：普通工作区操作会自动执行，安全边界仍然生效。") : "HammerCode 会把所有本地操作限制在你明确选择的目录中。"}</p>{!workspaceRoot && <button onClick={chooseWorkspace}><Icon name="folder" size={17}/>打开文件夹</button>}{workspaceRoot && !selectedModel?.hasApiKey && <div className="config-warning">{modelTier === "fast" ? "Fast" : "Strong"} 模型尚未配置本地 API key，请切换可用模型或完成配置。</div>}</div>
          ) : (
            <div className="message-stack">
              {session.turns.map((turn, index) => <TurnView key={turn.id} session={session} turn={turn} index={index}/>)}
              {TERMINAL_STATUSES.includes(session.status) && (
                <ChangeReviewPanel
                  reviews={fileReviews}
                  onOpen={(review) => {
                    if (sideChat) void closeSideChat();
                    setReferencePreview(null);
                    setSelectedReviewPath(review.path);
                    setPanelMode("review");
                  }}
                />
              )}
            </div>
          )}
        </section>

        {view === "chat" && showJumpToLatest && <button className="jump-latest" onClick={scrollToLatest}><span>↓</span>{isRunning ? "查看最新进度" : "回到底部"}</button>}

        {view === "chat" && <section className="composer-wrap">
          {notice && <div className={`notice ${notice.level}`}><span>{notice.text}</span><button onClick={() => setNotice(null)}>×</button></div>}
          <div className={`composer ${composerLocked ? "disabled" : ""}`}>
            {paletteOpen && !busy && !session?.pendingUndo && <div className="composer-palette" role="listbox" aria-label={paletteMode === "models" ? "模型" : composerToken?.kind === "mention" ? "工作区文件" : composerToken?.kind === "skill" ? "Skills" : "命令"} onMouseDown={(event) => event.preventDefault()}>
              <header><strong>{paletteMode === "models" ? "选择模型" : composerToken?.kind === "mention" ? "引用文件或文件夹" : composerToken?.kind === "skill" ? "选择 Skill" : "命令"}</strong></header>
              <div className="palette-list">
                {paletteMode === "models" ? bootstrap.config.availableModels.map((option, index) => <button key={option.ref} disabled={!option.hasApiKey} className={index === paletteIndex ? "active" : ""} onMouseEnter={() => setPaletteIndex(index)} onClick={() => selectPaletteItem(index)}><span className={`connection-dot ${option.connectionStatus === "missing" ? "missing" : option.connectionStatus === "error" ? "error" : "ready"}`}/><span><strong>{option.label}</strong><small>{option.apiBaseUrl}{option.hasApiKey ? "" : " · 未配置"}</small></span></button>)
                    : composerToken?.kind === "mention" ? (mentionEntries.length > 0 ? mentionEntries.map((entry, index) => <button key={entry.path} className={index === paletteIndex ? "active" : ""} onMouseEnter={() => setPaletteIndex(index)} onClick={() => selectPaletteItem(index)}><Icon name={entry.kind === "directory" ? "folder" : "file"} size={15}/><span><strong>{entry.name}</strong><small>{entry.path}</small></span></button>) : <p>没有匹配的工作区条目</p>)
                    : composerToken?.kind === "skill" ? (skillOptions.length > 0 ? skillOptions.map((skill, index) => <button key={skill.key} className={index === paletteIndex ? "active" : ""} onMouseEnter={() => setPaletteIndex(index)} onClick={() => selectPaletteItem(index)}><Icon name="spark" size={15}/><span><strong>{skill.id}</strong><small>{skill.description}</small></span></button>) : <p>没有匹配且已启用的 Skill</p>)
                      : slashCommands.map((command, index) => <button key={command.id} disabled={command.disabled} className={`command-palette-row ${index === paletteIndex ? "active" : ""}`} onMouseEnter={() => setPaletteIndex(index)} onClick={() => selectPaletteItem(index)}><Icon name={command.id === "side_chat" ? "branch" : command.id === "models" || command.id === "skills" ? "gear" : "chevron"} size={15}/><strong>{command.label}</strong></button>)}
              </div>
            </div>}
            <div className="composer-row">
              <div className="composer-editor">
                {composerEntities.map((entity) => <span className="composer-entity" data-kind={entity.kind} key={entity.key}>
                  <button className="composer-entity-open" type="button" onClick={() => void openEntityPreview(entity)} title={`预览 ${entity.detail}`}><Icon name={entity.kind === "skill" ? "spark" : entity.kind === "directory" ? "folder" : "file"} size={14}/><span>{entity.label}</span></button>
                  <button className="composer-entity-remove" type="button" onClick={() => removeComposerEntity(entity.key)} aria-label={`移除 ${entity.label}`}>×</button>
                </span>)}
                <textarea ref={textareaRef} value={task} onChange={(event) => { setTask(event.target.value); setComposerCursor(event.target.selectionStart); if (paletteMode) setPaletteMode(null); }} onSelect={(event) => setComposerCursor(event.currentTarget.selectionStart)} onKeyDown={handleComposerKeyDown} placeholder={composerEntities.length > 0 ? "继续输入" : workspaceRoot ? (contextCompacting ? "正在压缩上下文" : anotherSessionIsRunning ? "另一条聊天正在运行" : isRunning ? "主任务运行中" : session ? "继续追问" : "交给 HammerCode 一个开发任务") : "请先选择工作区"} disabled={composerLocked} rows={1}/>
              </div>
              <div className="composer-controls">
                <ContextRing session={session} budget={bootstrap.config.contextTokenBudget} autoCompactRatio={bootstrap.config.autoCompactRatio} compacting={contextCompacting}/>
                <select aria-label="模型" title="模型" value={modelRef} disabled={isBusy || busy || settingsBusy} onChange={(event) => void persistSettings(event.target.value as ModelRef, permissionMode)}>{bootstrap.config.availableModels.map((option) => <option key={option.ref} value={option.ref} disabled={!option.hasApiKey}>{option.label}{option.hasApiKey ? "" : "（未配置）"}</option>)}</select>
                <select aria-label="权限" title="权限" value={permissionMode} disabled={isBusy || busy || settingsBusy} onChange={(event) => choosePermission(event.target.value as PermissionMode)}><option value="ask">请求批准</option><option value="full_access">完全访问</option></select>
              </div>
              {isRunning || contextCompacting
                ? <button key="stop" className="composer-stop" onClick={() => window.hammerCode.cancelTask()} aria-label={contextCompacting ? "停止上下文压缩" : "停止任务"}><Icon name="stop" size={15}/></button>
                : <button key="send" className="send-button" onClick={(event) => { event.currentTarget.blur(); void submit(); }} disabled={(!task.trim() && composerEntities.length === 0) || !workspaceRoot || isBusy || anotherSessionIsRunning || busy || !selectedModel?.hasApiKey} aria-label="发送任务"><Icon name="arrow-up" size={18}/></button>}
            </div>
          </div>
        </section>}
      </main>

      {view === "chat" && panelVisible && panelMode === "review" && selectedReview && session && (
        <DiffDrawer
          review={selectedReview}
          busy={isBusy}
          undoing={session.pendingUndo?.changeId === selectedReview.latestChangeId}
          onClose={() => { setSelectedReviewPath(null); setPanelMode(null); }}
          onUndo={() => void requestUndo(selectedReview.latestChangeId)}
          onResizeStart={startPanelResize}
        />
      )}

      {view === "chat" && panelVisible && panelMode === "preview" && referencePreview && (
        <ReferencePreviewPanel
          preview={referencePreview}
          navigation={<UtilityPanelNavigation active="preview" hasPreview hasSideChat={Boolean(sideChat)} onSelect={setPanelMode}/>}
          onClose={closeReferencePreview}
          onResizeStart={startPanelResize}
        />
      )}

      {view === "chat" && panelVisible && panelMode === "side_chat" && sideChat && (
        <SideChatPanel
          sideChat={sideChat}
          navigation={<UtilityPanelNavigation active="side_chat" hasPreview={Boolean(referencePreview)} hasSideChat onSelect={setPanelMode}/>}
          onClose={() => void closeSideChat()}
          onSend={async (content) => {
            try { await window.hammerCode.sendSideChat(sideChat.id, content); }
            catch (error) { setNotice({ level: "error", text: userFacingError(error) }); }
          }}
          onCancel={() => void window.hammerCode.cancelSideChat(sideChat.id)}
          onResizeStart={startPanelResize}
        />
      )}

      {showFullAccessWarning && (
        <div className="approval-backdrop"><section className="approval-panel permission-warning" role="dialog" aria-modal="true" aria-labelledby="full-access-title">
          <div className="approval-heading"><span className="approval-icon">!</span><div><small>仅对受信任的工作区使用</small><h2 id="full-access-title">启用完全访问？</h2></div></div>
          <p>启用后，HammerCode 将在下一轮开始：</p>
          <ul><li>自动创建、修改和删除当前工作区内的文件；</li><li>自动运行通过安全检查的普通命令；</li><li>继续阻断路径逃逸、<code>sudo</code>、磁盘擦除和系统关机等高风险操作。</li></ul>
          <div className="approval-actions"><button className="reject" onClick={() => setShowFullAccessWarning(false)}>保持请求批准</button><button className="approve" onClick={confirmFullAccess}>确认启用</button></div>
          <span className="approval-note">本设置按聊天保存，当前正在运行的轮次不会改变。</span>
        </section></div>
      )}

      {session?.pendingApproval && (
        <div className="approval-backdrop"><section className="approval-panel" role="dialog" aria-modal="true" aria-labelledby="approval-title">
          <div className="approval-heading"><span className="approval-icon">{session.pendingApproval.operation === "undo" ? "↶" : "!"}</span><div><small>{session.pendingApproval.operation === "undo" ? "撤销也需要确认" : "需要你的确认"}</small><h2 id="approval-title">{session.pendingApproval.title}</h2></div></div>
          <p>{session.pendingApproval.description}</p><pre>{session.pendingApproval.details}</pre>
          <div className="approval-actions"><button className="reject" onClick={() => resolveApproval(false)}>拒绝</button><button className="approve" onClick={() => resolveApproval(true)}>{session.pendingApproval.operation === "undo" ? "确认撤销" : "批准并执行"}</button></div>
          <span className="approval-note">{session.pendingApproval.operation === "undo" ? "执行前会再次校验文件状态，防止覆盖后续修改。" : "拒绝后不会产生副作用，智能体可以继续处理。"}</span>
        </section></div>
      )}
    </div>
  );
}
