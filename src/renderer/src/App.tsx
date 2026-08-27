import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSession,
  AppBootstrap,
  RendererEvent,
  SessionStatus,
  ToolTrace,
} from "../../shared/contracts";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "空闲",
  requesting: "模型思考中",
  awaiting_approval: "等待审批",
  executing_tool: "执行工具中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

const ACTIVE_STATUSES: SessionStatus[] = [
  "requesting",
  "awaiting_approval",
  "executing_tool",
];

function shortPath(value: string | null): string {
  if (!value) return "尚未选择";
  const parts = value.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : value;
}

function formatTime(value?: string): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function parseToolContent(content: string): { summary: string; output: string; ok: boolean } {
  try {
    const value = JSON.parse(content) as { summary?: unknown; output?: unknown; ok?: unknown };
    return {
      summary: typeof value.summary === "string" ? value.summary : "工具结果",
      output: typeof value.output === "string" ? value.output : content,
      ok: value.ok === true,
    };
  } catch {
    return { summary: "工具结果", output: content, ok: false };
  }
}

function ToolActivity({ trace }: { trace: ToolTrace }) {
  const statusText: Record<ToolTrace["status"], string> = {
    proposed: "已提出",
    awaiting_approval: "待审批",
    approved: "已批准",
    rejected: "已拒绝",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    blocked: "已阻断",
    cancelled: "已取消",
  };
  return (
    <details className={`tool-card tool-${trace.status}`} open={trace.status === "running"}>
      <summary>
        <span className="tool-icon">{trace.call.name === "run_command" ? "›_" : "◇"}</span>
        <span className="tool-main">
          <strong>{trace.call.name}</strong>
          <small>{trace.summary}</small>
        </span>
        <span className="tool-status">{statusText[trace.status]}</span>
      </summary>
      <div className="tool-details">
        {trace.target && <div className="detail-row"><span>目标</span><code>{trace.target}</code></div>}
        {trace.durationMs !== undefined && (
          <div className="detail-row"><span>耗时</span><code>{trace.durationMs} ms</code></div>
        )}
        {trace.result && <pre>{trace.result.output || trace.result.summary}</pre>}
      </div>
    </details>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ level: "info" | "error"; text: string } | null>(null);
  const conversationRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let mounted = true;
    window.hammerCode
      .bootstrap()
      .then((value) => {
        if (!mounted) return;
        setBootstrap(value);
        setSession(value.session);
        setWorkspaceRoot(value.workspaceRoot);
      })
      .catch((error: unknown) => setNotice({ level: "error", text: String(error) }));
    const unsubscribe = window.hammerCode.onEvent((event: RendererEvent) => {
      if (event.type === "session_snapshot") setSession(event.session);
      if (event.type === "session_cleared") setSession(null);
      if (event.type === "notification") setNotice({ level: event.level, text: event.message });
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const isRunning = Boolean(session && ACTIVE_STATUSES.includes(session.status));
  const latestAssistant = useMemo(
    () => [...(session?.messages ?? [])].reverse().find((message) => message.role === "assistant"),
    [session?.messages],
  );

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
    return <main className="loading"><div className="brand-mark">H</div><p>正在点燃锻炉…</p></main>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="drag-region" />
        <header className="brand">
          <div className="brand-mark">H</div>
          <div><h1>HammerCode</h1><p>把想法锻造成软件</p></div>
        </header>

        <section className="side-section">
          <div className="section-label">工作区</div>
          <button className="workspace-button" onClick={chooseWorkspace} disabled={busy || isRunning}>
            <span className="folder-icon">⌁</span>
            <span><strong>{shortPath(workspaceRoot)}</strong><small>{workspaceRoot ? "单击切换目录" : "选择一个本地目录"}</small></span>
            <span className="chevron">›</span>
          </button>
        </section>

        <section className="side-section grow">
          <div className="section-label">工具轨迹</div>
          <div className="tool-list">
            {session?.toolTraces.length ? (
              session.toolTraces.map((trace) => <ToolActivity key={trace.call.id} trace={trace} />)
            ) : (
              <div className="empty-tools"><span>◇</span><p>工具调用会在这里逐步出现</p></div>
            )}
          </div>
        </section>

        <footer className="runtime-card">
          <div><span className={`health-dot ${bootstrap.config.hasApiKey ? "healthy" : "warning"}`} />{bootstrap.config.model}</div>
          <small>{bootstrap.config.apiBaseUrl}</small>
          <small>思考 {bootstrap.config.thinking === "enabled" ? "开启" : "关闭"} · 最多 {bootstrap.config.maxAgentRounds} 轮</small>
        </footer>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className={`status-pill status-${session?.status ?? "idle"}`}>
              <i />{STATUS_LABELS[session?.status ?? "idle"]}
            </span>
            {session && <span className="session-id">{session.id.slice(0, 18)}</span>}
          </div>
          <div className="top-actions">
            {isRunning && <button className="quiet danger" onClick={() => window.hammerCode.cancelTask()}>停止任务</button>}
            {session && !isRunning && (
              <button className="quiet" onClick={() => window.hammerCode.clearSession()}>清空会话</button>
            )}
          </div>
        </header>

        <section className="conversation" ref={conversationRef}>
          {!session ? (
            <div className="welcome">
              <div className="welcome-symbol">⌁</div>
              <h2>今天想锻造什么？</h2>
              <p>描述一个真实开发任务。HammerCode 会先理解工作区，再逐步读取、修改并验证；任何写入或命令都会在执行前向你确认。</p>
              {!bootstrap.config.hasApiKey && (
                <div className="config-warning">尚未检测到 <code>DEEPSEEK_API_KEY</code>。请在本地 <code>.env</code> 中配置后重启应用。</div>
              )}
            </div>
          ) : (
            <div className="message-stack">
              {session.messages.map((message) => {
                if (message.role === "tool") {
                  const parsed = parseToolContent(message.content);
                  return (
                    <article className={`message tool-message ${parsed.ok ? "ok" : "not-ok"}`} key={message.id}>
                      <div className="message-meta"><span>{message.toolName}</span><time>{formatTime(message.createdAt)}</time></div>
                      <strong>{parsed.summary}</strong>
                      <details><summary>查看工具输出</summary><pre>{parsed.output || "（无输出）"}</pre></details>
                    </article>
                  );
                }
                return (
                  <article className={`message ${message.role}`} key={message.id}>
                    <div className="message-meta"><span>{message.role === "user" ? "你" : "HammerCode"}</span><time>{formatTime(message.createdAt)}</time></div>
                    {message.role === "assistant" && message.reasoningContent && (
                      <details className="reasoning"><summary>模型思考过程</summary><pre>{message.reasoningContent}</pre></details>
                    )}
                    {message.content && <div className="message-content">{message.content}</div>}
                    {message.role === "assistant" && message.toolCalls?.length && !message.content && (
                      <div className="tool-intent">已请求 {message.toolCalls.length} 个工具调用</div>
                    )}
                  </article>
                );
              })}
              {(session.streamingReasoning || session.streamingText) && (
                <article className="message assistant streaming">
                  <div className="message-meta"><span>HammerCode</span><span className="live-dot">实时</span></div>
                  {session.streamingReasoning && <details className="reasoning" open={!session.streamingText}><summary>正在思考</summary><pre>{session.streamingReasoning}</pre></details>}
                  {session.streamingText && <div className="message-content">{session.streamingText}<span className="cursor" /></div>}
                </article>
              )}
              {session.error && <div className="error-panel"><strong>任务未完成</strong><p>{session.error}</p><small>当前状态已保存；未确认的副作用不会被自动重放。</small></div>}
              {session.status === "completed" && latestAssistant && <div className="completion-line">✓ 任务已正常结束并保存</div>}
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
              placeholder={workspaceRoot ? "描述你希望 HammerCode 完成的任务…" : "请先从左侧选择工作区"}
              disabled={!workspaceRoot || isRunning || busy}
              rows={3}
            />
            <div className="composer-footer">
              <span>Enter 发送 · Shift + Enter 换行</span>
              <button className="send" onClick={submit} disabled={!task.trim() || !workspaceRoot || isRunning || busy}>锻造 <span>↗</span></button>
            </div>
          </div>
        </section>
      </main>

      {session?.pendingApproval && (
        <div className="approval-backdrop">
          <section className="approval-panel" role="dialog" aria-modal="true" aria-labelledby="approval-title">
            <div className="approval-heading">
              <span className={`risk-icon risk-${session.pendingApproval.risk}`}>!</span>
              <div><small>需要你的确认</small><h2 id="approval-title">{session.pendingApproval.title}</h2></div>
            </div>
            <p>{session.pendingApproval.description}</p>
            <pre className="approval-details">{session.pendingApproval.details}</pre>
            <div className="approval-actions">
              <button className="reject" onClick={() => resolveApproval(false)}>拒绝，不执行</button>
              <button className="approve" onClick={() => resolveApproval(true)}>批准并执行</button>
            </div>
            <div className="approval-note">拒绝是可恢复结果；模型会收到“未产生副作用”的明确说明。</div>
          </section>
        </div>
      )}
    </div>
  );
}
