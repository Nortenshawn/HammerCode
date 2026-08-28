import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import logoUrl from "../../../logos/logo.png";
import type {
  AgentSession,
  AgentTurn,
  AppBootstrap,
  AssistantMessage,
  ModelTier,
  PermissionMode,
  RendererEvent,
  SessionStatus,
  SessionSummary,
  ToolAuthorization,
  ToolCall,
  ToolTrace,
  WorkspaceSummary,
} from "../../shared/contracts";
import { buildFileReviews, type FileReview } from "../../shared/file-reviews";

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
  | "check"
  | "chevron"
  | "file"
  | "folder"
  | "plus"
  | "square"
  | "stop"
  | "terminal"
  | "undo";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    "arrow-up": <><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></>,
    folder: <><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><path d="M1 10h20"/></>,
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
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

function folderName(value: string | null): string {
  if (!value) return "选择工作区";
  return value.split("/").filter(Boolean).at(-1) ?? value;
}

function formatClock(value?: string): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatListDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatClock(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
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
    title: session.task.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || "未命名对话",
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

function Markdown({ children }: { children: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown></div>;
}

interface RenderedDiffLine {
  kind: "addition" | "deletion" | "context" | "hunk" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
}

function renderDiffLines(diff: string): RenderedDiffLine[] {
  const rendered: RenderedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rendered.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk && (line.startsWith("---") || line.startsWith("+++"))) continue;
    if (line.startsWith("Index:") || line.startsWith("====") || line.startsWith("diff ")) {
      rendered.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rendered.push({ kind: "addition", text: line.slice(1), newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rendered.push({ kind: "deletion", text: line.slice(1), oldLine });
      oldLine += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      rendered.push({ kind: "meta", text: line });
      continue;
    }
    if (!inHunk) {
      rendered.push({ kind: "meta", text: line });
      continue;
    }
    if (!line && rendered.length > 0) continue;
    rendered.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }
  return rendered;
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
        {trace?.authorization && <div><span>授权</span><code className={`authorization authorization-${trace.authorization}`}>{AUTHORIZATION_LABELS[trace.authorization]}</code></div>}
        {trace?.target && <div><span>目标</span><code>{trace.target}</code></div>}
        <div><span>参数</span><code>{argumentPreview(call) || "（无）"}</code></div>
        {trace?.durationMs !== undefined && <div><span>耗时</span><code>{trace.durationMs} ms</code></div>}
        {trace?.result && <pre>{trace.result.output || trace.result.summary}</pre>}
      </div>
    </details>
  );
}

function WorkProcess({ session, turn, finalMessageId }: { session: AgentSession; turn: AgentTurn; finalMessageId?: string }) {
  const terminal = TERMINAL_STATUSES.includes(turn.status);
  const tracesForTurn = session.toolTraces.filter((trace) => trace.turnId === turn.id);
  const traces = useMemo(() => new Map(tracesForTurn.map((trace) => [trace.call.id, trace])), [tracesForTurn]);
  const processMessages = session.messages.filter((message) => message.turnId === turn.id && message.role !== "user" && message.id !== finalMessageId);
  const isActiveTurn = session.activeTurnId === turn.id && !terminal;
  const hasContent = processMessages.length > 0 || Boolean(isActiveTurn && (session.streamingReasoning || session.streamingText));
  const turnLabel = `${turn.modelTier === "fast" ? "Fast" : "Strong"} · ${turn.permissionMode === "ask" ? "请求批准" : "完全访问"}`;

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
          <footer><span className={`final-state final-state-${turn.status}`}><Icon name={turn.status === "completed" ? "check" : "square"} size={14}/>{STATUS_LABELS[turn.status]}</span><span>{turn.modelTier === "fast" ? "Fast" : "Strong"} · {turn.permissionMode === "ask" ? "请求批准" : "完全访问"}</span><time>{formatClock(finalAssistant.createdAt)}</time></footer>
        </article>
      )}
      {turn.error && <div className="error-panel"><strong>这一轮未完成</strong><p>{turn.error}</p><small>可以直接在下方继续说明或纠正；未完成的工具调用不会重放。</small></div>}
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

function DiffDrawer({ review, busy, undoing, onClose, onUndo }: { review: FileReview; busy: boolean; undoing: boolean; onClose: () => void; onUndo: () => void }) {
  const lines = useMemo(() => renderDiffLines(review.diff), [review.diff]);
  return (
    <aside className="diff-drawer" aria-label={`${review.path} 变更详情`}>
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

function ChatList({ sessions, activeId, disabled, onSelect }: { sessions: SessionSummary[]; activeId?: string; disabled: boolean; onSelect: (id: string) => void }) {
  if (sessions.length === 0) return <p className="empty-chat-list">还没有聊天</p>;
  return <div className="chat-list">{sessions.map((item) => (
    <button className={`chat-item ${item.id === activeId ? "active" : ""}`} disabled={disabled} key={item.id} onClick={() => onSelect(item.id)}>
      <span className="chat-title">{item.title}</span>
      <span className="chat-meta"><i className={`chat-state state-${item.status}`}/>{STATUS_LABELS[item.status]} · {item.turnCount} 轮 · {formatListDate(item.updatedAt)}</span>
    </button>
  ))}</div>;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(new Set());
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [modelTier, setModelTier] = useState<ModelTier>("fast");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [showFullAccessWarning, setShowFullAccessWarning] = useState(false);
  const [selectedReviewPath, setSelectedReviewPath] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [notice, setNotice] = useState<{ level: "info" | "error"; text: string } | null>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    let mounted = true;
    window.hammerCode.bootstrap().then((value) => {
      if (!mounted) return;
      setBootstrap(value);
      setSession(value.session);
      setSessions(value.sessions);
      setWorkspaces(value.workspaces);
      setExpandedRoots(new Set(value.workspaces.map((workspace) => workspace.root)));
      setWorkspaceRoot(value.workspaceRoot);
      setModelTier(value.session?.modelTier ?? "fast");
      setPermissionMode(value.session?.permissionMode ?? "ask");
    }).catch((error: unknown) => setNotice({ level: "error", text: String(error) }));
    const unsubscribe = window.hammerCode.onEvent((event: RendererEvent) => {
      if (event.type === "session_snapshot") {
        setSession(event.session);
        setSessions((items) => upsertSessionSummary(items, event.session));
        setWorkspaces((items) => upsertWorkspaceSession(items, event.session));
        setModelTier(event.session.modelTier);
        setPermissionMode(event.session.permissionMode);
      }
      if (event.type === "session_updated") {
        setSessions((items) => upsertSessionSummary(items, event.session));
        setWorkspaces((items) => upsertWorkspaceSession(items, event.session, false));
      }
      if (event.type === "session_cleared") {
        setSession(null);
        setModelTier("fast");
        setPermissionMode("ask");
      }
      if (event.type === "sessions_changed") setSessions(event.sessions);
      if (event.type === "workspace_changed") {
        setWorkspaceRoot(event.workspaceRoot);
        setWorkspaces(event.workspaces);
        setSessions(event.sessions);
        setSession(event.session);
        setExpandedRoots((roots) => {
          const next = new Set(roots);
          if (event.workspaceRoot) next.add(event.workspaceRoot);
          return next;
        });
        setModelTier(event.session?.modelTier ?? "fast");
        setPermissionMode(event.session?.permissionMode ?? "ask");
      }
      if (event.type === "notification") setNotice({ level: event.level, text: event.message });
    });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  const isRunning = Boolean(session && ACTIVE_STATUSES.includes(session.status));
  const isBusy = isRunning || Boolean(session?.pendingUndo);
  const hasRunningSession = workspaces.some((workspace) =>
    workspace.sessions.some((item) => ACTIVE_STATUSES.includes(item.status)),
  );
  const anotherSessionIsRunning = hasRunningSession && !isRunning;
  const selectedModel = bootstrap?.config.models[modelTier];
  const fileReviews = useMemo(
    () => session ? buildFileReviews(session.fileChanges) : [],
    [session?.fileChanges],
  );
  const selectedReview = fileReviews.find((review) => review.path === selectedReviewPath);
  const activeTurn = session?.turns.find((turn) => turn.id === session.activeTurnId);

  useEffect(() => {
    setSelectedReviewPath(null);
    autoScrollRef.current = true;
    setShowJumpToLatest(false);
  }, [session?.id]);

  useEffect(() => {
    if (selectedReviewPath && !selectedReview) setSelectedReviewPath(null);
  }, [selectedReview, selectedReviewPath]);

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
    catch (error) { setNotice({ level: "error", text: String(error) }); }
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
      setTask("");
      setNotice(null);
    } catch (error) {
      setNotice({ level: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const newChat = async () => {
    if (busy) return;
    try { await window.hammerCode.newChat(); setTask(""); setNotice(null); }
    catch (error) { setNotice({ level: "error", text: String(error) }); }
  };

  const selectSession = async (id: string) => {
    if (id === session?.id) return;
    setBusy(true);
    try { await window.hammerCode.selectSession(id); setNotice(null); }
    catch (error) { setNotice({ level: "error", text: String(error) }); }
    finally { setBusy(false); }
  };

  const persistSettings = async (nextModel: ModelTier, nextPermission: PermissionMode) => {
    if (isBusy || settingsBusy) return;
    const selectsUnavailableModel = !bootstrap?.config.models[nextModel].hasApiKey
      && (!session || nextModel !== session.modelTier);
    if (selectsUnavailableModel) {
      setNotice({
        level: "error",
        text: `${nextModel === "fast" ? "Fast" : "Strong"} 模型尚未配置本地 API key。`,
      });
      return;
    }
    const previousModel = modelTier;
    const previousPermission = permissionMode;
    setModelTier(nextModel);
    setPermissionMode(nextPermission);
    if (!session) return;
    setSettingsBusy(true);
    try {
      await window.hammerCode.updateSessionSettings({ modelTier: nextModel, permissionMode: nextPermission });
      setNotice(null);
    } catch (error) {
      setModelTier(previousModel);
      setPermissionMode(previousPermission);
      setNotice({ level: "error", text: String(error) });
    } finally {
      setSettingsBusy(false);
    }
  };

  const choosePermission = (nextPermission: PermissionMode) => {
    if (nextPermission !== "full_access") {
      void persistSettings(modelTier, nextPermission);
      return;
    }
    let confirmed = false;
    try { confirmed = window.localStorage.getItem("hammercode.full-access-warning") === "acknowledged"; }
    catch { confirmed = false; }
    if (!confirmed) {
      setShowFullAccessWarning(true);
      return;
    }
    void persistSettings(modelTier, nextPermission);
  };

  const confirmFullAccess = () => {
    try { window.localStorage.setItem("hammercode.full-access-warning", "acknowledged"); }
    catch { /* The warning is still acknowledged for this selection. */ }
    setShowFullAccessWarning(false);
    void persistSettings(modelTier, "full_access");
  };

  const submit = async () => {
    if (!task.trim() || !workspaceRoot || isBusy || anotherSessionIsRunning || !selectedModel?.hasApiKey) return;
    setBusy(true);
    autoScrollRef.current = true;
    setShowJumpToLatest(false);
    setNotice(null);
    try {
      await window.hammerCode.startTask({ task, modelTier, permissionMode });
      setTask("");
    } catch (error) { setNotice({ level: "error", text: String(error) }); }
    finally { setBusy(false); }
  };

  const resolveApproval = async (approved: boolean) => {
    if (!session?.pendingApproval) return;
    try { await window.hammerCode.resolveApproval(session.pendingApproval.id, approved); }
    catch (error) { setNotice({ level: "error", text: String(error) }); }
  };

  const requestUndo = async (changeId: string) => {
    try { await window.hammerCode.requestUndo(changeId); setNotice(null); }
    catch (error) { setNotice({ level: "error", text: String(error) }); }
  };

  if (!bootstrap) return <main className="loading"><img className="loading-mark" src={logoUrl} alt=""/><p>正在打开 HammerCode…</p></main>;

  return (
    <div className={`app-shell ${selectedReview ? "review-open" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-drag"/>
        <header className="brand-row"><button className="brand-button" aria-label="HammerCode"><img className="brand-logo" src={logoUrl} alt=""/>HammerCode <span>⌄</span></button></header>
        <nav className="primary-nav" aria-label="主要导航"><button className="new-chat-button" onClick={newChat} disabled={busy || !workspaceRoot}><Icon name="plus" size={17}/><span>新对话</span></button></nav>
        <section className="projects-section">
          <div className="section-heading"><span>项目</span><button onClick={chooseWorkspace} disabled={busy || Boolean(session?.pendingUndo)} aria-label="添加工作区"><Icon name="plus" size={14}/></button></div>
          <div className="project-list">
            {workspaces.map((workspace) => (
              <section className={`project-group ${workspace.root === workspaceRoot ? "active" : ""}`} key={workspace.root}>
                <div className="project-row" title={workspace.root}><button className="project-toggle" onClick={() => toggleWorkspace(workspace.root)} aria-expanded={expandedRoots.has(workspace.root)}><span className={`project-chevron ${expandedRoots.has(workspace.root) ? "expanded" : ""}`}><Icon name="chevron" size={14}/></span><Icon name="folder" size={18}/><span>{workspace.name}</span><small>{workspace.sessionCount || ""}</small></button><button className="project-add-chat" onClick={() => void startChatInWorkspace(workspace.root)} disabled={busy || Boolean(session?.pendingUndo)} aria-label={`在 ${workspace.name} 中新建聊天`} title="新建聊天"><Icon name="plus" size={14}/></button></div>
                {expandedRoots.has(workspace.root) && (
                  workspace.sessions.length > 0
                    ? <ChatList sessions={workspace.sessions} activeId={session?.id} disabled={busy || Boolean(session?.pendingUndo)} onSelect={(id) => void selectSession(id)}/>
                    : <button className="empty-chat-list" disabled={busy || Boolean(session?.pendingUndo)} onClick={() => void startChatInWorkspace(workspace.root)}>在此项目开始新对话</button>
                )}
              </section>
            ))}
            {workspaces.length === 0 && <button className="empty-projects" onClick={chooseWorkspace}><Icon name="folder" size={17}/>打开文件夹</button>}
          </div>
        </section>
        <footer className="sidebar-footer">
          {(["fast", "strong"] as ModelTier[]).map((tier) => <div className="runtime-line" key={tier}><span className={`connection-dot ${bootstrap.config.models[tier].hasApiKey ? "ready" : "missing"}`}/><strong>{tier === "fast" ? "Fast" : "Strong"} · {bootstrap.config.models[tier].model}</strong></div>)}
          <span>本地工具受工作区安全边界保护</span>
        </footer>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-title"><Icon name="folder" size={17}/><strong>{session?.task.split(/\r?\n/, 1)[0]?.slice(0, 64) || "新对话"}</strong>{workspaceRoot && <span>{folderName(workspaceRoot)}</span>}</div>
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
                  onOpen={(review) => setSelectedReviewPath(review.path)}
                />
              )}
            </div>
          )}
        </section>

        {showJumpToLatest && <button className="jump-latest" onClick={scrollToLatest}><span>↓</span>{isRunning ? "查看最新进度" : "回到底部"}</button>}

        <section className="composer-wrap">
          {notice && <div className={`notice ${notice.level}`}><span>{notice.text}</span><button onClick={() => setNotice(null)}>×</button></div>}
          <div className={`composer ${isBusy ? "disabled" : ""}`}>
            <textarea value={task} onChange={(event) => setTask(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); void submit(); } }} placeholder={workspaceRoot ? (anotherSessionIsRunning ? "另一条聊天正在运行，结束后即可发送" : session ? "继续追问、补充要求或纠正上一轮" : "交给 HammerCode 一个开发任务") : "请先从左侧选择工作区"} disabled={!workspaceRoot || isBusy || anotherSessionIsRunning || busy} rows={3}/>
            <div className="composer-footer">
              <div className="composer-controls">
                <label><span>模型</span><select value={modelTier} disabled={isBusy || busy || settingsBusy} onChange={(event) => void persistSettings(event.target.value as ModelTier, permissionMode)}><option value="fast">Fast · {bootstrap.config.models.fast.model}</option><option value="strong" disabled={!bootstrap.config.models.strong.hasApiKey}>Strong · {bootstrap.config.models.strong.model}{bootstrap.config.models.strong.hasApiKey ? "" : "（未配置）"}</option></select></label>
                <label><span>权限</span><select value={permissionMode} disabled={isBusy || busy || settingsBusy} onChange={(event) => choosePermission(event.target.value as PermissionMode)}><option value="ask">请求批准</option><option value="full_access">完全访问</option></select></label>
              </div>
              {isRunning
                ? <button key="stop" className="composer-stop" onClick={() => window.hammerCode.cancelTask()} aria-label="停止任务"><Icon name="stop" size={15}/></button>
                : <button key="send" className="send-button" onClick={(event) => { event.currentTarget.blur(); void submit(); }} disabled={!task.trim() || !workspaceRoot || isBusy || anotherSessionIsRunning || busy || !selectedModel?.hasApiKey} aria-label="发送任务"><Icon name="arrow-up" size={18}/></button>}
            </div>
          </div>
        </section>
      </main>

      {selectedReview && session && (
        <DiffDrawer
          review={selectedReview}
          busy={isBusy}
          undoing={session.pendingUndo?.changeId === selectedReview.latestChangeId}
          onClose={() => setSelectedReviewPath(null)}
          onUndo={() => void requestUndo(selectedReview.latestChangeId)}
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
