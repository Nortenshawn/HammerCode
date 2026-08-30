import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/main/session-store";
import type { AgentSession } from "../src/shared/contracts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

function createSession(
  id: string,
  task: string,
  updatedAt: string,
  workspaceRoot = "/tmp/workspace",
): AgentSession {
  const turnId = `${id}_turn`;
  const userMessageId = `${id}_user`;
  return {
    id,
    workspaceRoot,
    status: "completed",
    task,
    modelTier: "fast",
    permissionMode: "ask",
    turns: [{ id: turnId, userMessageId, status: "completed", terminationReason: "completed", modelTier: "fast", permissionMode: "ask", createdAt: updatedAt, updatedAt, finishedAt: updatedAt }],
    activeTurnId: turnId,
    messages: [
      { id: userMessageId, turnId, role: "user", content: task, createdAt: updatedAt },
      { id: `${id}_assistant`, turnId, role: "assistant", content: "done", createdAt: updatedAt },
    ],
    toolTraces: [],
    fileChanges: [],
    transitions: [{ turnId, from: "requesting", to: "completed", reason: "done", at: updatedAt }],
    streamingText: "",
    streamingReasoning: "",
    terminationReason: "completed",
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("session persistence", () => {
  it("ignores malformed persistence instead of crashing startup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "active-session.json"), "{broken", "utf8");
    await expect(store.load()).resolves.toBeNull();
  });

  it("marks interrupted side-effect states as failed without replaying approval", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const at = "2026-08-27T00:00:00.000Z";
    const approval = {
      id: "approval_1",
      toolCallId: "call_1",
      toolName: "write_file",
      title: "修改文件",
      description: "修改 a.txt",
      details: "diff",
      risk: "write" as const,
      createdAt: at,
    };
    const session: AgentSession = {
      id: "session_1",
      workspaceRoot: "/tmp/workspace",
      status: "awaiting_approval",
      task: "edit",
      modelTier: "fast",
      permissionMode: "ask",
      turns: [{ id: "turn_1", userMessageId: "m1", status: "awaiting_approval", modelTier: "fast", permissionMode: "ask", createdAt: at, updatedAt: at }],
      activeTurnId: "turn_1",
      messages: [
        { id: "m1", turnId: "turn_1", role: "user", content: "edit", createdAt: at },
        { id: "m2", turnId: "turn_1", role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' }], createdAt: at },
      ],
      toolTraces: [{ turnId: "turn_1", call: { id: "call_1", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' }, status: "awaiting_approval", summary: "修改 a.txt", approval }],
      fileChanges: [],
      transitions: [{ turnId: "turn_1", from: "idle", to: "requesting", reason: "start", at }],
      streamingText: "partial",
      streamingReasoning: "thinking",
      pendingApproval: approval,
      createdAt: at,
      updatedAt: at,
    };
    await store.save(session);
    const restored = await store.load();
    expect(restored).toMatchObject({
      status: "failed",
      terminationReason: "interrupted",
      pendingApproval: undefined,
      streamingText: "",
      streamingReasoning: "",
    });
    expect(restored?.transitions.at(-1)).toMatchObject({
      from: "awaiting_approval",
      to: "failed",
    });
    expect(restored?.messages.filter((message) => message.role === "tool" && message.toolCallId === "call_1")).toHaveLength(1);
    expect(restored?.toolTraces[0]).toMatchObject({ status: "cancelled", result: { errorCode: "TOOL_CALL_INTERRUPTED" } });

    const restoredAgain = await store.load();
    expect(restoredAgain?.messages.filter((message) => message.role === "tool" && message.toolCallId === "call_1")).toHaveLength(1);
  });

  it("keeps independent chats and restores the selected chat", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const first = createSession("session_first", "检查项目结构", "2026-08-27T01:00:00.000Z");
    const second = createSession("session_second", "修复类型错误", "2026-08-27T02:00:00.000Z");

    await store.save(first);
    first.title = "项目结构检查";
    await store.save(first);
    await store.save(second);
    let state = await store.loadState();
    expect(state.sessions.map((item) => item.id)).toEqual(["session_second", "session_first"]);
    expect(state.activeSession?.id).toBe("session_second");
    expect(state.workspaceRoot).toBe("/tmp/workspace");

    await store.setActive("session_first");
    state = await store.loadState();
    expect(state.activeSession?.task).toBe("检查项目结构");
    expect(state.activeSession?.title).toBe("项目结构检查");
    expect(state.sessions.find((item) => item.id === "session_first")?.title).toBe("项目结构检查");
    expect(state.sessions).toHaveLength(2);
  });

  it("keeps independent chat collections and active chats for multiple workspaces", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const rootA = "/tmp/project-a";
    const rootB = "/tmp/project-b";
    const firstA = createSession("session_a1", "A first", "2026-08-27T01:00:00.000Z", rootA);
    const secondA = createSession("session_a2", "A second", "2026-08-27T02:00:00.000Z", rootA);
    const onlyB = createSession("session_b1", "B only", "2026-08-27T03:00:00.000Z", rootB);

    await store.save(firstA);
    await store.save(secondA);
    await store.save(onlyB);
    let state = await store.loadState();
    expect(state.workspaces.map((workspace) => workspace.root)).toEqual([rootA, rootB]);
    expect(state.workspaceRoot).toBe(rootB);
    expect(state.activeSession?.id).toBe("session_b1");
    expect(state.workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ root: rootA, sessionCount: 2, activeSessionId: "session_a2" }),
      expect.objectContaining({ root: rootB, sessionCount: 1, activeSessionId: "session_b1" }),
    ]));
    expect(state.workspaces.find((workspace) => workspace.root === rootA)?.sessions.map((item) => item.id)).toEqual(["session_a2", "session_a1"]);

    await store.selectWorkspace(rootA);
    state = await store.loadState();
    expect(state.workspaces.map((workspace) => workspace.root)).toEqual([rootA, rootB]);
    expect(state.workspaceRoot).toBe(rootA);
    expect(state.activeSession?.id).toBe("session_a2");
    expect(state.sessions.map((item) => item.id)).toEqual(["session_a2", "session_a1"]);

    await store.setActive("session_a1");
    await store.selectWorkspace(rootB);
    await store.selectWorkspace(rootA);
    state = await store.loadState();
    expect(state.workspaces.map((workspace) => workspace.root)).toEqual([rootA, rootB]);
    expect(state.activeSession?.id).toBe("session_a1");
  });

  it("clears only the active chat in the selected workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const rootA = "/tmp/project-clear-a";
    const rootB = "/tmp/project-clear-b";
    await store.save(createSession("session_clear_a", "A chat", "2026-08-27T01:00:00.000Z", rootA));
    await store.save(createSession("session_clear_b", "B chat", "2026-08-27T02:00:00.000Z", rootB));

    await store.selectWorkspace(rootA);
    await store.clear();
    let state = await store.loadState();
    expect(state.workspaceRoot).toBe(rootA);
    expect(state.activeSession).toBeNull();
    expect(state.sessions).toEqual([]);
    expect(state.workspaces.find((workspace) => workspace.root === rootB)).toMatchObject({
      sessionCount: 1,
      activeSessionId: "session_clear_b",
    });

    await store.selectWorkspace(rootB);
    state = await store.loadState();
    expect(state.activeSession?.id).toBe("session_clear_b");
  });

  it("saves a background session without changing the selected workspace or chat", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const rootA = "/tmp/project-background-a";
    const rootB = "/tmp/project-background-b";
    const running = createSession("session_running", "Running", "2026-08-27T01:00:00.000Z", rootA);
    const selected = createSession("session_selected", "Selected", "2026-08-27T02:00:00.000Z", rootB);
    await store.save(running);
    await store.save(selected);

    running.status = "requesting";
    running.updatedAt = "2026-08-27T03:00:00.000Z";
    await store.save(running, { activate: false });

    const state = await store.loadState({ liveSessionIds: ["session_running"] });
    expect(state.workspaceRoot).toBe(rootB);
    expect(state.activeSession?.id).toBe("session_selected");
    expect(state.workspaces.find((workspace) => workspace.root === rootA)).toMatchObject({
      activeSessionId: "session_running",
      sessions: [expect.objectContaining({ id: "session_running", status: "requesting" })],
    });
  });

  it("migrates a v1 workspace index and old chat settings to safe defaults", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const legacy = createSession("session_v1", "升级旧聊天", "2026-08-27T04:00:00.000Z");
    const raw = JSON.parse(JSON.stringify(legacy)) as {
      modelTier?: unknown;
      permissionMode?: unknown;
      turns: Array<{ modelTier?: unknown; permissionMode?: unknown }>;
    };
    delete raw.modelTier;
    delete raw.permissionMode;
    raw.turns.forEach((turn) => {
      delete turn.modelTier;
      delete turn.permissionMode;
    });
    await mkdir(path.join(directory, "chats"), { recursive: true });
    await writeFile(path.join(directory, "chats", "session_v1.json"), JSON.stringify(raw), "utf8");
    await writeFile(path.join(directory, "session-index.json"), JSON.stringify({
      version: 1,
      workspaceRoot: "/tmp/workspace",
      activeSessionId: "session_v1",
      sessionIds: ["session_v1"],
    }), "utf8");

    const state = await new SessionStore(directory).loadState();
    expect(state.activeSession).toMatchObject({
      id: "session_v1",
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
      turns: [expect.objectContaining({ modelTier: "fast", modelRef: "builtin:fast", permissionMode: "ask" })],
    });
    const migratedIndex = JSON.parse(await readFile(path.join(directory, "session-index.json"), "utf8")) as { version: number; workspaces: unknown[] };
    expect(migratedIndex.version).toBe(4);
    expect(migratedIndex.workspaces).toHaveLength(1);
  });

  it("migrates a v2 index with all existing chats kept active", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const session = createSession("session_v2", "保留活动聊天", "2026-08-30T01:00:00.000Z");
    await mkdir(path.join(directory, "chats"), { recursive: true });
    await writeFile(path.join(directory, "chats", "session_v2.json"), JSON.stringify(session), "utf8");
    await writeFile(path.join(directory, "session-index.json"), JSON.stringify({
      version: 2,
      activeWorkspaceRoot: session.workspaceRoot,
      workspaces: [{
        root: session.workspaceRoot,
        activeSessionId: session.id,
        sessionIds: [session.id],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }],
    }), "utf8");

    const state = await new SessionStore(directory).loadState();
    expect(state.activeSession?.id).toBe(session.id);
    expect(state.archivedWorkspaces[0]).toMatchObject({ sessionCount: 0, sessions: [] });
    const migrated = JSON.parse(await readFile(path.join(directory, "session-index.json"), "utf8")) as {
      version: number;
      workspaces: Array<{ archivedSessionIds: string[] }>;
    };
    expect(migrated).toMatchObject({
      version: 4,
      workspaces: [{
        archivedSessionIds: [],
        displayName: "workspace",
        pinned: false,
        status: "active",
        memoryExport: { mode: "project" },
      }],
    });
  });

  it("migrates the v3 archive index to project metadata defaults", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const session = createSession("session_v3", "迁移项目元数据", "2026-08-30T02:30:00.000Z", "/tmp/project-v3");
    await mkdir(path.join(directory, "chats"), { recursive: true });
    await writeFile(path.join(directory, "chats", `${session.id}.json`), JSON.stringify(session), "utf8");
    await writeFile(path.join(directory, "session-index.json"), JSON.stringify({
      version: 3,
      activeWorkspaceRoot: session.workspaceRoot,
      workspaces: [{
        root: session.workspaceRoot,
        activeSessionId: session.id,
        sessionIds: [session.id],
        archivedSessionIds: [],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }],
    }), "utf8");

    const state = await new SessionStore(directory).loadState();
    expect(state.workspaces[0]).toMatchObject({
      root: session.workspaceRoot,
      name: "project-v3",
      pinned: false,
      memoryExport: { mode: "project" },
    });
    const migrated = JSON.parse(await readFile(path.join(directory, "session-index.json"), "utf8")) as { version: number };
    expect(migrated.version).toBe(4);
  });

  it("archives and restores chats without deleting chat files or the project", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const root = "/tmp/project-archive";
    await store.save(createSession("session_archive_1", "第一条", "2026-08-30T01:00:00.000Z", root));
    await store.save(createSession("session_archive_2", "第二条", "2026-08-30T02:00:00.000Z", root));

    await store.archiveSession("session_archive_2");
    let state = await store.loadState();
    expect(state.activeSession).toBeNull();
    expect(state.workspaces[0]).toMatchObject({ root, sessionCount: 1 });
    expect(state.archivedWorkspaces[0].sessions.map((item) => item.id)).toEqual(["session_archive_2"]);
    expect(JSON.parse(await readFile(path.join(directory, "chats", "session_archive_2.json"), "utf8"))).toMatchObject({ id: "session_archive_2" });

    await store.archiveWorkspaceChats(root);
    state = await store.loadState();
    expect(state.workspaces).toEqual([expect.objectContaining({ root, sessionCount: 0, sessions: [] })]);
    expect(state.archivedWorkspaces[0].sessions.map((item) => item.id)).toEqual(["session_archive_2", "session_archive_1"]);

    await store.restoreSession("session_archive_1");
    await store.restoreWorkspaceChats(root);
    state = await store.loadState();
    expect(state.workspaces[0].sessions.map((item) => item.id)).toEqual(["session_archive_2", "session_archive_1"]);
    expect(state.archivedWorkspaces[0]).toMatchObject({ sessionCount: 0, sessions: [] });
  });

  it("rejects a whole-project archive atomically when one chat is active", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const root = "/tmp/project-running-archive";
    await store.save(createSession("session_archive_done", "完成", "2026-08-30T01:00:00.000Z", root));
    const running = createSession("session_archive_running", "运行", "2026-08-30T02:00:00.000Z", root);
    running.status = "requesting";
    running.turns[0].status = "requesting";
    running.terminationReason = undefined;
    running.turns[0].terminationReason = undefined;
    running.turns[0].finishedAt = undefined;
    await store.save(running);

    await expect(store.archiveWorkspaceChats(root)).rejects.toThrow("不能归档");
    const state = await store.loadState({ liveSessionIds: [running.id] });
    expect(state.workspaces[0].sessions.map((item) => item.id)).toEqual([running.id, "session_archive_done"]);
    expect(state.archivedWorkspaces[0].sessions).toEqual([]);
  });

  it("persists project names, pin order, archive state and export preferences without moving chats", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const firstRoot = "/tmp/project-first";
    const secondRoot = "/tmp/project-second";
    await store.save(createSession("session_project_first", "第一项目", "2026-08-30T03:00:00.000Z", firstRoot));
    await store.save(createSession("session_project_second", "第二项目", "2026-08-30T04:00:00.000Z", secondRoot));

    await store.renameProject(firstRoot, "置顶项目");
    await store.setProjectPinned(firstRoot, true);
    await store.updateProjectMemoryExport(firstRoot, { mode: "custom", customDirectory: "/tmp/exports" });
    let state = await store.loadState();
    expect(state.workspaceRoot).toBe(secondRoot);
    expect(state.workspaces.map((item) => item.root)).toEqual([firstRoot, secondRoot]);
    expect(state.workspaces[0]).toMatchObject({
      name: "置顶项目",
      pinned: true,
      memoryExport: { mode: "custom", customDirectory: "/tmp/exports" },
    });

    await store.archiveProject(firstRoot);
    state = await store.loadState();
    expect(state.workspaceRoot).toBe(secondRoot);
    expect(state.workspaces.map((item) => item.root)).toEqual([secondRoot]);
    expect(state.archivedProjects[0]).toMatchObject({
      root: firstRoot,
      name: "置顶项目",
      sessionCount: 1,
      archivedSessionCount: 0,
      memoryExport: { mode: "custom", customDirectory: "/tmp/exports" },
    });
    expect(JSON.parse(await readFile(path.join(directory, "chats", "session_project_first.json"), "utf8"))).toMatchObject({ id: "session_project_first" });

    await store.restoreProject(firstRoot);
    state = await store.loadState();
    expect(state.workspaceRoot).toBe(secondRoot);
    expect(state.workspaces.find((item) => item.root === firstRoot)).toMatchObject({ name: "置顶项目", pinned: false, sessionCount: 1 });
  });

  it("removes a project from navigation and restores its chats when the folder is opened again", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const root = "/tmp/project-reopen";
    await store.save(createSession("session_project_reopen", "保留聊天", "2026-08-30T05:00:00.000Z", root));

    await store.removeProject(root);
    let state = await store.loadState();
    expect(state.workspaceRoot).toBeNull();
    expect(state.workspaces).toEqual([]);
    expect(state.archivedProjects).toEqual([]);
    expect(JSON.parse(await readFile(path.join(directory, "chats", "session_project_reopen.json"), "utf8"))).toMatchObject({ id: "session_project_reopen" });

    await store.setWorkspaceRoot(root);
    state = await store.loadState();
    expect(state.workspaceRoot).toBe(root);
    expect(state.workspaces[0]).toMatchObject({ root, sessionCount: 1, activeSessionId: "session_project_reopen" });
  });

  it("rejects project archive and removal while a contained chat is active", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const store = new SessionStore(directory);
    const root = "/tmp/project-active-lifecycle";
    const running = createSession("session_project_active", "运行", "2026-08-30T06:00:00.000Z", root);
    running.status = "executing_tool";
    running.turns[0].status = "executing_tool";
    running.terminationReason = undefined;
    running.turns[0].terminationReason = undefined;
    running.turns[0].finishedAt = undefined;
    await store.save(running);

    await expect(store.archiveProject(root)).rejects.toThrow("不能归档");
    await expect(store.removeProject(root)).rejects.toThrow("不能归档");
    const state = await store.loadState({ liveSessionIds: [running.id] });
    expect(state.workspaces[0]).toMatchObject({ root, sessionCount: 1 });
    expect(state.archivedProjects).toEqual([]);
  });

  it("persists plans, metrics and context memory while migrating custom model references", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const session = createSession("session_phase6", "phase 6", "2026-08-28T04:00:00.000Z");
    (session as unknown as { modelRef: string }).modelRef = "custom:00000000-0000-4000-8000-000000000000:model-x";
    const turn = session.turns[0];
    (turn as unknown as { modelRef: string }).modelRef = "custom:00000000-0000-4000-8000-000000000000:model-x";
    turn.planRequired = true;
    turn.plan = {
      revision: 1,
      explanation: "checkpoint",
      steps: [{ id: "verify", title: "验证", status: "completed" }],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
    turn.planCheckpoints = [{
      id: "checkpoint_1",
      revision: 1,
      explanation: "checkpoint",
      steps: [{ id: "verify", title: "验证", status: "completed" }],
      round: 2,
      toolCalls: 3,
      createdAt: session.updatedAt,
    }];
    turn.retryEvents = [{ attempt: 1, reason: "server_error", delayMs: 1000, createdAt: session.updatedAt }];
    turn.metrics = {
      roundsUsed: 2,
      maxRounds: 20,
      modelRequests: 3,
      retryCount: 1,
      maxRetries: 2,
      toolCalls: 3,
      maxToolCalls: 100,
      promptTokens: 1000,
      completionTokens: 200,
      tokenUsageEstimated: true,
      maxOutputTokensPerRequest: 32768,
      contextTokenBudget: 120000,
      currentContextTokens: 2400,
      contextCompactions: 1,
      projectMemoryRecords: 0,
      projectMemoryCharacters: 0,
      projectMemoryTokens: 0,
      skillCount: 0,
      skillCharacters: 0,
      skillTokens: 0,
      maxRunTimeMs: 1800000,
    };
    turn.skills = [{
      id: "pdf-review",
      name: "pdf-review",
      version: "1.0.0",
      source: "builtin",
      scope: "application",
      trigger: "explicit",
      reason: "用户显式指定 $pdf-review",
      packageFingerprint: "a".repeat(64),
      entryPath: "SKILL.md",
      instructionCharacters: 420,
      instructionTokens: 120,
      availableResources: ["references/analysis-checklist.md"],
      availableScripts: [],
      resources: [{
        path: "SKILL.md",
        kind: "entry",
        characters: 420,
        tokens: 120,
        sha256: "b".repeat(64),
        readAt: session.updatedAt,
      }],
      scripts: [],
    }];
    session.contextMemory = {
      version: 1,
      summary: "当前聊天的压缩记忆",
      throughMessageId: session.messages.at(-1)!.id,
      throughCreatedAt: session.messages.at(-1)!.createdAt,
      sourceMessageCount: session.messages.length,
      mode: "explicit",
      compactionCount: 1,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
    const store = new SessionStore(directory);
    await store.save(session);
    const restored = await store.load();
    expect(restored?.modelRef).toBe("builtin:fast");
    expect(restored?.turns[0]).toMatchObject({
      modelRef: "builtin:fast",
      plan: { revision: 1 },
      metrics: { retryCount: 1, currentContextTokens: 2400, contextCompactions: 1 },
      skills: [expect.objectContaining({ id: "pdf-review", trigger: "explicit", instructionTokens: 120 })],
    });
    expect(restored?.contextMemory).toMatchObject({ summary: "当前聊天的压缩记忆", mode: "explicit", compactionCount: 1 });
    expect(restored?.turns[0].planCheckpoints?.[0]).toMatchObject({ id: "checkpoint_1" });
    expect(restored?.turns[0].retryEvents?.[0]).toMatchObject({ reason: "server_error" });
  });

  it("preserves current connection references across restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const session = createSession("session_connection", "使用导入模型", "2026-08-29T04:00:00.000Z");
    const ref = "connection:00000000-0000-4000-8000-000000000001" as const;
    session.modelRef = ref;
    session.turns[0].modelRef = ref;

    const store = new SessionStore(directory);
    await store.save(session);

    const restored = await store.load();
    expect(restored?.modelRef).toBe(ref);
    expect(restored?.turns[0].modelRef).toBe(ref);
  });

  it("migrates the legacy active-session file without losing the chat", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const legacy = createSession("session_legacy", "保留旧聊天", "2026-08-27T03:00:00.000Z");
    const raw = JSON.parse(JSON.stringify(legacy)) as {
      turns?: unknown;
      activeTurnId?: unknown;
      fileChanges?: unknown;
      messages: Array<{ turnId?: string }>;
      toolTraces: Array<{ turnId?: string }>;
      transitions: Array<{ turnId?: string }>;
    };
    delete raw.turns;
    delete raw.activeTurnId;
    delete raw.fileChanges;
    raw.messages.forEach((message) => delete message.turnId);
    raw.toolTraces.forEach((trace) => delete trace.turnId);
    raw.transitions.forEach((transition) => delete transition.turnId);
    await writeFile(path.join(directory, "active-session.json"), JSON.stringify(raw), "utf8");

    const state = await new SessionStore(directory).loadState();
    expect(state.activeSession).toMatchObject({ id: "session_legacy", task: "保留旧聊天" });
    expect(state.activeSession?.turns).toHaveLength(1);
    expect(state.activeSession?.messages.every((message) => Boolean(message.turnId))).toBe(true);
    expect(state.sessions).toEqual([
      expect.objectContaining({ id: "session_legacy", title: "保留旧聊天" }),
    ]);
  });

  it("persists isolated subtask plans, evidence, budgets and patch proposals", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-session-"));
    directories.push(directory);
    const at = "2026-08-29T00:00:00.000Z";
    const session = createSession("session_subtasks", "parallel review", at);
    session.subtasks = [{
      id: "subtask_1",
      parentSessionId: session.id,
      parentTurnId: session.activeTurnId,
      role: "code_review",
      mode: "patch_proposal",
      task: "review source.ts",
      status: "completed",
      modelTier: "fast",
      modelRef: "builtin:fast",
      parentPermissionMode: "full_access",
      effectivePermission: "proposal_only",
      budget: { maxRounds: 8, maxToolCalls: 30, maxRunTimeMs: 300_000, contextTokenBudget: 64_000 },
      plan: {
        revision: 1,
        steps: [{ id: "inspect", title: "检查来源", status: "completed" }],
        createdAt: at,
        updatedAt: at,
      },
      messages: [{ id: "sub_message", turnId: "sub_turn", role: "assistant", content: "structured", createdAt: at }],
      toolTraces: [],
      patches: [{
        id: "proposal_1",
        path: "source.ts",
        kind: "modify",
        beforeHash: "before",
        afterHash: "after",
        patch: "diff",
        createdAt: at,
      }],
      result: {
        summary: "reviewed",
        findings: [{
          title: "finding",
          detail: "detail",
          confidence: "high",
          evidence: [{ path: "source.ts", line: 1, detail: "source" }],
        }],
        relatedFiles: ["source.ts"],
        verificationSuggestions: ["run tests"],
        risks: [],
      },
      createdAt: at,
      updatedAt: at,
      finishedAt: at,
    }];
    const store = new SessionStore(directory);
    await store.save(session);
    const restored = await store.load();
    expect(restored?.subtasks?.[0]).toMatchObject({
      status: "completed",
      parentPermissionMode: "full_access",
      effectivePermission: "proposal_only",
      plan: { steps: [{ status: "completed" }] },
      result: { findings: [{ evidence: [{ path: "source.ts", line: 1 }] }] },
      patches: [{ path: "source.ts", patch: "diff" }],
    });
  });
});
