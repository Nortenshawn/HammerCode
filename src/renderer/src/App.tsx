import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentSession,
  AppBootstrap,
  AssistantMessage,
  RendererEvent,
  SessionStatus,
  SessionSummary,
  ToolCall,
  ToolTrace,
} from "../../shared/contracts";

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
  | "terminal";

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
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function upsertSessionSummary(items: SessionSummary[], session: AgentSession): SessionSummary[] {
  const summary = summaryFromSession(session);
  return [summary, ...items.filter((item) => item.id !== summary.id)].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
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

function argumentPreview(call: ToolCall): string {
  try {
    const value = JSON.parse(call.arguments) as Record<string, unknown>;
    return Object.entries(value)
      .slice(0, 2)
      .map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`)
      .join(" · ");
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
        <span className="process-tool-copy">
          <strong>{call.name}</strong>
          <small>{trace?.summary || argumentPreview(call)}</small>
        </span>
        <span className="process-status">{TOOL_STATUS_LABELS[status]}</span>
      </summary>
      <div className="process-tool-detail">
        {trace?.target && <div><span>目标</span><code>{trace.target}</code></div>}
        <div><span>参数</span><code>{argumentPreview(call) || "（无）"}</code></div>
        {trace?.durationMs !== undefined && <div><span>耗时</span><code>{trace.durationMs} ms</code></div>}
        {trace?.result && <pre>{trace.result.output || trace.result.summary}</pre>}
      </div>
    </details>
  );
}

function WorkProcess({ session, finalMessageId }: { session: AgentSession; finalMessageId?: string }) {
  const terminal = TERMINAL_STATUSES.includes(session.status);
  const traces = useMemo(
    () => new Map(session.toolTraces.map((trace) => [trace.call.id, trace])),
    [session.toolTraces],
  );
  const processMessages = session.messages.filter(
    (message) => message.role !== "user" && message.id !== finalMessageId,
  );
  const hasContent = processMessages.length > 0 || session.streamingReasoning || session.streamingText;

  return (
    <details className="work-process" key={`${session.id}-${terminal ? "terminal" : "active"}`} open={!terminal}>
      <summary className="work-process-summary">
        <span className={`activity-orb ${terminal ? "done" : "live"}`}>
          {terminal ? <Icon name="check" size={13}/> : <span/>}
        </span>
        <span className="work-process-title">
          <strong>{terminal ? "过程与工具调用" : STATUS_LABELS[session.status]}</strong>
          <small>{terminal ? `${session.toolTraces.length} 次工具调用` : "实时展示模型思考与执行链"}</small>
        </span>
        <Icon name="chevron" size={15}/>
      </summary>
      <div className="process-timeline">
        {!hasContent && <div className="process-placeholder">正在理解任务和工作区…</div>}
        {processMessages.map((message) => {
          if (message.role === "tool") {
            const parsed = parseToolContent(message.content);
            return (
              <div className={`tool-result ${parsed.ok ? "success" : "failure"}`} key={message.id}>
                <span className="process-node"><Icon name={parsed.ok ? "check" : "square"} size={14}/></span>
                <div>
                  <strong>{message.toolName}</strong>
                  <span>{parsed.summary}</span>
                  <details><summary>查看输出</summary><pre>{parsed.output || "（无输出）"}</pre></details>
                </div>
              </div>
            );
          }
          if (message.role === "user") return null;
          return (
            <div className="assistant-process" key={message.id}>
              {message.reasoningContent && (
                <div className="thinking-copy">
                  <span className="process-node"><span className="thought-dot"/></span>
                  <div><strong>思考</strong><p>{message.reasoningContent}</p></div>
                </div>
              )}
              {message.content && <div className="intermediate-copy"><Markdown>{message.content}</Markdown></div>}
              {message.toolCalls?.map((call) => <ToolIntent key={call.id} call={call} trace={traces.get(call.id)}/>)}
            </div>
          );
        })}
        {session.streamingReasoning && (
          <div className="thinking-copy streaming-copy">
            <span className="process-node"><span className="thought-dot"/></span>
            <div><strong>正在思考</strong><p>{session.streamingReasoning}</p></div>
          </div>
        )}
        {session.streamingText && <div className="intermediate-copy live-copy"><Markdown>{session.streamingText}</Markdown><span className="typing-caret"/></div>}
      </div>
    </details>
  );
}

function ChatList({ sessions, activeId, disabled, onSelect }: {
  sessions: SessionSummary[];
  activeId?: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  if (sessions.length === 0) return <p className="empty-chat-list">这个工作区还没有聊天</p>;
  return (
    <div className="chat-list">
      {sessions.map((item) => (
        <button
          className={`chat-item ${item.id === activeId ? "active" : ""}`}
          disabled={disabled}
          key={item.id}
          onClick={() => onSelect(item.id)}
        >
          <span className="chat-title">{item.title}</span>
          <span className="chat-meta"><i className={`chat-state state-${item.status}`}/>{STATUS_LABELS[item.status]} · {formatListDate(item.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ level: "info" | "error"; text: string } | null>(null);
  const conversationRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let mounted = true;
    window.hammerCode.bootstrap().then((value) => {
      if (!mounted) return;
      setBootstrap(value);
      setSession(value.session);
      setSessions(value.sessions);
      setWorkspaceRoot(value.workspaceRoot);
    }).catch((error: unknown) => setNotice({ level: "error", text: String(error) }));
    const unsubscribe = window.hammerCode.onEvent((event: RendererEvent) => {
      if (event.type === "session_snapshot") {
        setSession(event.session);
        setSessions((items) => upsertSessionSummary(items, event.session));
      }
      if (event.type === "session_cleared") setSession(null);
      if (event.type === "sessions_changed") setSessions(event.sessions);
      if (event.type === "notification") setNotice({ level: event.level, text: event.message });
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const isRunning = Boolean(session && ACTIVE_STATUSES.includes(session.status));
  const userMessage = session?.messages.find((message) => message.role === "user");
  const finalAssistant = useMemo(() => {
    if (!session || !TERMINAL_STATUSES.includes(session.status)) return undefined;
    return [...session.messages].reverse().find((message): message is AssistantMessage =>
      message.role === "assistant" && Boolean(message.content) && !message.toolCalls?.length,
    );
  }, [session]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation || !session) return;
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: "smooth" });
  }, [session?.updatedAt]);

  const chooseWorkspace = async () => {
    setBusy(true);
    try {
      const selected = await window.hammerCode.chooseWorkspace();
      if (selected) setWorkspaceRoot(selected);
    } catch (error) {
      setNotice({ level: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const newChat = async () => {
    if (isRunning) return;
    try {
      await window.hammerCode.newChat();
      setSession(null);
      setTask("");
      setNotice(null);
    } catch (error) {
      setNotice({ level: "error", text: String(error) });
    }
  };

  const selectSession = async (id: string) => {
    if (isRunning || id === session?.id) return;
    try {
      await window.hammerCode.selectSession(id);
      setNotice(null);
    } catch (error) {
      setNotice({ level: "error", text: String(error) });
    }
  };

  const submit = async () => {
    if (!task.trim() || !workspaceRoot || isRunning) return;
    setBusy(true);
    setNotice(null);
    try {
      await window.hammerCode.startTask(task);
      setTask("");
    } catch (error) {
      setNotice({ level: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const resolveApproval = async (approved: boolean) => {
    if (!session?.pendingApproval) return;
    try {
      await window.hammerCode.resolveApproval(session.pendingApproval.id, approved);
    } catch (error) {
      setNotice({ level: "error", text: String(error) });
    }
  };

  if (!bootstrap) {
    return <main className="loading"><span className="loading-mark">H</span><p>正在打开 HammerCode…</p></main>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-drag"/>
        <header className="brand-row">
          <button className="brand-button" aria-label="HammerCode">HammerCode <span>⌄</span></button>
        </header>

        <nav className="primary-nav" aria-label="主要导航">
          <button className="new-chat-button" onClick={newChat} disabled={isRunning}>
            <Icon name="plus" size={17}/><span>新对话</span>
          </button>
        </nav>

        <section className="projects-section">
          <div className="section-heading">项目</div>
          <button className="project-row" onClick={chooseWorkspace} disabled={busy || isRunning} title={workspaceRoot ?? "选择本地工作区"}>
            <Icon name="folder" size={17}/>
            <span>{folderName(workspaceRoot)}</span>
            <Icon name="chevron" size={14}/>
          </button>
          {workspaceRoot && (
            <ChatList sessions={sessions} activeId={session?.id} disabled={isRunning} onSelect={selectSession}/>
          )}
        </section>

        <footer className="sidebar-footer">
          <div className="runtime-line"><span className={`connection-dot ${bootstrap.config.hasApiKey ? "ready" : "missing"}`}/><strong>{bootstrap.config.model}</strong></div>
          <span>{bootstrap.config.hasApiKey ? "本地工具已就绪" : "缺少 API 配置"}</span>
        </footer>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <Icon name="folder" size={17}/>
            <strong>{session?.task.split(/\r?\n/, 1)[0]?.slice(0, 64) || "新对话"}</strong>
            {workspaceRoot && <span>{folderName(workspaceRoot)}</span>}
          </div>
          <div className="top-actions">
            {isRunning && <button className="stop-button" onClick={() => window.hammerCode.cancelTask()}><Icon name="stop" size={14}/>停止</button>}
          </div>
        </header>

        <section className="conversation" ref={conversationRef}>
          {!session ? (
            <div className="welcome">
              <div className="welcome-mark">H</div>
              <h1>{workspaceRoot ? `在 ${folderName(workspaceRoot)} 中开始` : "选择一个工作区"}</h1>
              <p>{workspaceRoot ? "描述你想完成的开发任务。文件修改和命令执行仍会先向你确认。" : "HammerCode 会把所有本地操作限制在你明确选择的目录中。"}</p>
              {!workspaceRoot && <button onClick={chooseWorkspace}><Icon name="folder" size={17}/>打开文件夹</button>}
              {!bootstrap.config.hasApiKey && <div className="config-warning">未检测到 <code>DEEPSEEK_API_KEY</code>，请完成本地配置后重启。</div>}
            </div>
          ) : (
            <div className="message-stack">
              {userMessage && (
                <article className="user-message">
                  <div>{userMessage.content}</div>
                  <time>{formatClock(userMessage.createdAt)}</time>
                </article>
              )}

              <WorkProcess session={session} finalMessageId={finalAssistant?.id}/>

              {finalAssistant && (
                <article className="final-answer">
                  <Markdown>{finalAssistant.content}</Markdown>
                  <footer>
                    <span className={`final-state final-state-${session.status}`}><Icon name={session.status === "completed" ? "check" : "square"} size={14}/>{STATUS_LABELS[session.status]}</span>
                    <time>{formatClock(finalAssistant.createdAt)}</time>
                  </footer>
                </article>
              )}

              {session.error && (
                <div className="error-panel"><strong>任务未完成</strong><p>{session.error}</p><small>已保存现有结果；未确认的操作不会自动重放。</small></div>
              )}
            </div>
          )}
        </section>

        <section className="composer-wrap">
          {notice && <div className={`notice ${notice.level}`}><span>{notice.text}</span><button onClick={() => setNotice(null)}>×</button></div>}
          <div className={`composer ${isRunning ? "disabled" : ""}`}>
            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={workspaceRoot ? (session ? "输入新任务，将创建一条独立对话" : "交给 HammerCode 一个开发任务") : "请先从左侧选择工作区"}
              disabled={!workspaceRoot || isRunning || busy}
              rows={3}
            />
            <div className="composer-footer">
              <span>{isRunning ? STATUS_LABELS[session?.status ?? "requesting"] : `${folderName(workspaceRoot)} · Enter 发送`}</span>
              {isRunning ? (
                <button className="composer-stop" onClick={() => window.hammerCode.cancelTask()} aria-label="停止任务"><Icon name="stop" size={15}/></button>
              ) : (
                <button className="send-button" onClick={submit} disabled={!task.trim() || !workspaceRoot || busy} aria-label="发送任务"><Icon name="arrow-up" size={18}/></button>
              )}
            </div>
          </div>
        </section>
      </main>

      {session?.pendingApproval && (
        <div className="approval-backdrop">
          <section className="approval-panel" role="dialog" aria-modal="true" aria-labelledby="approval-title">
            <div className="approval-heading">
              <span className="approval-icon">!</span>
              <div><small>需要你的确认</small><h2 id="approval-title">{session.pendingApproval.title}</h2></div>
            </div>
            <p>{session.pendingApproval.description}</p>
            <pre>{session.pendingApproval.details}</pre>
            <div className="approval-actions">
              <button className="reject" onClick={() => resolveApproval(false)}>拒绝</button>
              <button className="approve" onClick={() => resolveApproval(true)}>批准并执行</button>
            </div>
            <span className="approval-note">拒绝后不会产生副作用，智能体可以继续处理。</span>
          </section>
        </div>
      )}
    </div>
  );
}
