import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { Clock, IdGenerator, ModelClient, ModelRequest } from "../src/core/types";
import { AppController } from "../src/main/controller";
import type { RuntimeConfig } from "../src/main/config";
import { ModelCredentialStore, type CredentialCipher } from "../src/main/model-credential-store";
import { ProjectMemoryStore } from "../src/main/project-memory-store";
import { SessionStore } from "../src/main/session-store";
import { SkillStore } from "../src/main/skill-store";
import type { AgentSession, RendererEvent } from "../src/shared/contracts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 10,
  })));
});

class Deferred {
  private resolvePromise!: () => void;
  readonly promise = new Promise<void>((resolve) => { this.resolvePromise = resolve; });
  release(): void { this.resolvePromise(); }
}

class ControlledModels {
  readonly started = new Set<string>();
  readonly gates = new Map<string, Deferred>();
  private readonly requestCounts = new Map<string, number>();

  create(): ModelClient {
    return {
      stream: (request) => this.stream(request),
    };
  }

  gate(task: string): Deferred {
    const existing = this.gates.get(task);
    if (existing) return existing;
    const created = new Deferred();
    this.gates.set(task, created);
    return created;
  }

  private async *stream(request: ModelRequest) {
    if (request.tools.length === 0) {
      yield { content: "并发验收", finishReason: "stop" as const };
      return;
    }
    const user = [...request.messages].reverse().find((message) => message.role === "user");
    const task = user?.role === "user" ? user.content : "";
    const count = (this.requestCounts.get(task) ?? 0) + 1;
    this.requestCounts.set(task, count);
    this.started.add(task);

    if (task.startsWith("等待 ")) {
      const gate = this.gate(task);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(request.signal.reason);
        request.signal.addEventListener("abort", onAbort, { once: true });
        gate.promise.then(() => {
          request.signal.removeEventListener("abort", onAbort);
          resolve();
        }, reject);
      });
      yield { content: `${task} 完成`, finishReason: "stop" as const };
      return;
    }

    if (task.startsWith("写入 ") && count === 1) {
      const fileName = task.slice("写入 ".length).trim();
      yield {
        toolCallDeltas: [{
          index: 0,
          id: `call_${fileName.replace(/[^a-zA-Z0-9]/g, "_")}`,
          name: "write_file",
          arguments: JSON.stringify({ path: fileName, content: `${fileName} approved\n` }),
        }],
        finishReason: "tool_calls" as const,
      };
      return;
    }

    if (task === "触发失败") {
      throw new Error("fixture model failure");
    }

    yield { content: `${task} 已处理`, finishReason: "stop" as const };
  }
}

interface Harness {
  controller: AppController;
  store: SessionStore;
  workspaces: [string, string, string, string];
  events: RendererEvent[];
  models: ControlledModels;
}

const cipher: CredentialCipher = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value, "utf8"),
  decrypt: (value) => value.toString("utf8"),
};

async function createHarness(options: { failModelCreationOnce?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hammercode-controller-concurrency-"));
  directories.push(root);
  const firstPath = path.join(root, "workspace-a");
  const secondPath = path.join(root, "workspace-b");
  const thirdPath = path.join(root, "workspace-c");
  const fourthPath = path.join(root, "workspace-d");
  await Promise.all([
    mkdir(firstPath, { recursive: true }),
    mkdir(secondPath, { recursive: true }),
    mkdir(thirdPath, { recursive: true }),
    mkdir(fourthPath, { recursive: true }),
    mkdir(path.join(root, "skills", "builtin"), { recursive: true }),
  ]);
  const [first, second, third, fourth] = await Promise.all([
    realpath(firstPath),
    realpath(secondPath),
    realpath(thirdPath),
    realpath(fourthPath),
  ]);
  const store = new SessionStore(path.join(root, "sessions"));
  for (const workspace of [first, second, third, fourth]) await store.setWorkspaceRoot(workspace);
  await store.selectWorkspace(first);
  let sequence = 0;
  const clock: Clock = { now: () => new Date(Date.parse("2026-08-31T00:00:00.000Z") + sequence++) };
  const ids: IdGenerator = { next: (prefix) => `${prefix}_${sequence++}` };
  const projectMemory = new ProjectMemoryStore(path.join(root, "memory"), clock, ids);
  const skills = new SkillStore({
    builtinRoot: path.join(root, "skills", "builtin"),
    userRoot: path.join(root, "skills", "user"),
    settingsFile: path.join(root, "skills", "settings.json"),
    trashRoot: path.join(root, "skills", "removed"),
  }, clock, ids);
  const modelCredentials = new ModelCredentialStore(path.join(root, "models"), cipher);
  const events: RendererEvent[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, event: RendererEvent) => events.push(event) },
  } as unknown as BrowserWindow;
  const config: RuntimeConfig = {
    models: {
      fast: {
        provider: "deepseek",
        apiKey: "fast-test-key",
        apiBaseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        thinking: "enabled",
        reasoningEffort: "high",
        maxOutputTokens: 4_096,
        requestTimeoutMs: 30_000,
      },
      strong: {
        provider: "zhipu",
        apiKey: "strong-test-key",
        apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-5.3-flash",
        thinking: "enabled",
        reasoningEffort: "max",
        maxOutputTokens: 4_096,
        requestTimeoutMs: 30_000,
      },
    },
    contextTokenBudget: 32_000,
    maxAgentRounds: 6,
    maxConcurrentMainAgents: 3,
    maxToolCalls: 20,
    maxRunTimeMs: 60_000,
    maxModelRetries: 0,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 100,
    autoCompactRatio: 0.78,
  };
  const models = new ControlledModels();
  let failModelCreation = options.failModelCreationOnce === true;
  const controller = new AppController(
    window,
    config,
    store,
    modelCredentials,
    projectMemory,
    skills,
    {
      createModelClient: () => {
        if (failModelCreation) {
          failModelCreation = false;
          throw new Error("fixture model construction failure");
        }
        return models.create();
      },
    },
  );
  await controller.initialize();
  return { controller, store, workspaces: [first, second, third, fourth], events, models };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for controller state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function eventSession(event: RendererEvent): AgentSession | null {
  return event.type === "session_snapshot" || event.type === "session_updated" ? event.session : null;
}

function latestSession(events: RendererEvent[], sessionId: string): AgentSession | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const session = eventSession(events[index]);
    if (session?.id === sessionId) return session;
  }
  return null;
}

describe("AppController multi-project main agents", () => {
  it("runs two workspaces concurrently, keeps background snapshots from stealing navigation, and cancels only the target", async () => {
    const harness = await createHarness();
    const firstTask = "等待 A";
    const secondTask = "等待 B";
    const first = await harness.controller.startTask({ task: firstTask, sessionId: null, modelTier: "fast", modelRef: "builtin:fast", permissionMode: "ask" });
    await waitFor(() => harness.models.started.has(firstTask));

    await harness.controller.newChat();
    await expect(harness.controller.startTask({ task: "同项目第二任务", sessionId: null, modelTier: "fast", modelRef: "builtin:fast", permissionMode: "ask" }))
      .rejects.toMatchObject({ code: "WORKSPACE_MAIN_AGENT_BUSY" });

    await harness.controller.selectWorkspace(harness.workspaces[1]);
    await harness.controller.newChat();
    const second = await harness.controller.startTask({ task: secondTask, sessionId: null, modelTier: "strong", modelRef: "builtin:strong", permissionMode: "ask" });
    await waitFor(() => harness.models.started.has(secondTask));
    expect(harness.controller.bootstrap().session?.id).toBe(second.sessionId);
    const marker = harness.events.length;

    harness.controller.cancelTask(first.sessionId, "只停止 A");
    await waitFor(() => latestSession(harness.events, first.sessionId)?.status === "cancelled");
    expect(harness.controller.bootstrap().session?.id).toBe(second.sessionId);
    expect(latestSession(harness.events, second.sessionId)?.status).toBe("requesting");
    expect(harness.events.slice(marker).some((event) => event.type === "session_updated" && event.session.id === first.sessionId)).toBe(true);
    expect(harness.events.slice(marker).some((event) => event.type === "session_snapshot" && event.session.id === first.sessionId)).toBe(false);

    harness.models.gate(secondTask).release();
    await waitFor(() => latestSession(harness.events, second.sessionId)?.status === "completed");
    expect(harness.controller.bootstrap().session).toMatchObject({ id: second.sessionId, status: "completed" });
    await waitFor(() => Boolean(latestSession(harness.events, first.sessionId)?.title));
    await waitFor(() => Boolean(latestSession(harness.events, second.sessionId)?.title));
  });

  it("keeps simultaneous approvals session-bound while the other project remains live", async () => {
    const harness = await createHarness();
    const first = await harness.controller.startTask({ task: "写入 approved-a.txt", sessionId: null, modelTier: "fast", modelRef: "builtin:fast", permissionMode: "ask" });
    await waitFor(() => latestSession(harness.events, first.sessionId)?.status === "awaiting_approval");
    const firstApproval = latestSession(harness.events, first.sessionId)?.pendingApproval;
    expect(firstApproval).toBeDefined();

    await harness.controller.selectWorkspace(harness.workspaces[1]);
    await harness.controller.newChat();
    const second = await harness.controller.startTask({ task: "写入 rejected-b.txt", sessionId: null, modelTier: "strong", modelRef: "builtin:strong", permissionMode: "ask" });
    await waitFor(() => latestSession(harness.events, second.sessionId)?.status === "awaiting_approval");
    const secondApproval = latestSession(harness.events, second.sessionId)?.pendingApproval;
    expect(secondApproval).toBeDefined();

    expect(() => harness.controller.resolveApproval(second.sessionId, firstApproval!.id, true))
      .toThrowError(expect.objectContaining({ code: "APPROVAL_SESSION_MISMATCH" }));
    harness.controller.resolveApproval(first.sessionId, firstApproval!.id, true);
    await waitFor(() => latestSession(harness.events, first.sessionId)?.status === "completed");
    expect(harness.controller.bootstrap().session).toMatchObject({ id: second.sessionId, status: "awaiting_approval" });

    harness.controller.resolveApproval(second.sessionId, secondApproval!.id, false);
    await waitFor(() => latestSession(harness.events, second.sessionId)?.status === "completed");
    expect(await readFile(path.join(harness.workspaces[0], "approved-a.txt"), "utf8")).toBe("approved-a.txt approved\n");
    await expect(readFile(path.join(harness.workspaces[1], "rejected-b.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(latestSession(harness.events, second.sessionId)?.toolTraces[0]).toMatchObject({
      status: "rejected",
      authorization: "user_rejected",
    });
    await waitFor(() => Boolean(latestSession(harness.events, first.sessionId)?.title));
    await waitFor(() => Boolean(latestSession(harness.events, second.sessionId)?.title));
  });

  it("lets another workspace finish while the first task remains at approval", async () => {
    const harness = await createHarness();
    const waiting = await harness.controller.startTask({
      task: "写入 waiting-approval.txt",
      sessionId: null,
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
    });
    await waitFor(() => latestSession(harness.events, waiting.sessionId)?.status === "awaiting_approval");
    const approval = latestSession(harness.events, waiting.sessionId)?.pendingApproval;
    expect(approval).toBeDefined();

    await harness.controller.selectWorkspace(harness.workspaces[1]);
    await harness.controller.newChat();
    const independent = await harness.controller.startTask({
      task: "直接完成 B",
      sessionId: null,
      modelTier: "strong",
      modelRef: "builtin:strong",
      permissionMode: "ask",
    });
    await waitFor(() => latestSession(harness.events, independent.sessionId)?.status === "completed");
    expect(latestSession(harness.events, waiting.sessionId)).toMatchObject({
      status: "awaiting_approval",
      pendingApproval: { id: approval!.id },
    });

    harness.controller.resolveApproval(waiting.sessionId, approval!.id, false);
    await waitFor(() => latestSession(harness.events, waiting.sessionId)?.status === "completed");
    await expect(readFile(path.join(harness.workspaces[0], "waiting-approval.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await waitFor(() => Boolean(latestSession(harness.events, waiting.sessionId)?.title));
    await waitFor(() => Boolean(latestSession(harness.events, independent.sessionId)?.title));
  });

  it("binds continuation to the explicit session and safely starts a new turn after failure", async () => {
    const harness = await createHarness();
    const failed = await harness.controller.startTask({
      task: "触发失败",
      sessionId: null,
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
    });
    await waitFor(() => latestSession(harness.events, failed.sessionId)?.status === "failed");
    await waitFor(() => Boolean(latestSession(harness.events, failed.sessionId)?.title));

    await expect(harness.controller.startTask({
      task: "继续完成",
      sessionId: "another_session",
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
    })).rejects.toMatchObject({ code: "SESSION_OPERATION_MISMATCH" });

    const continued = await harness.controller.startTask({
      task: "继续完成",
      sessionId: failed.sessionId,
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
    });
    expect(continued.sessionId).toBe(failed.sessionId);
    await waitFor(() => latestSession(harness.events, failed.sessionId)?.status === "completed");
    const final = latestSession(harness.events, failed.sessionId);
    expect(final?.turns).toHaveLength(2);
    expect(final?.turns.map((turn) => turn.status)).toEqual(["failed", "completed"]);
    expect(final?.toolTraces).toEqual([]);
  });

  it("enforces the configured global limit through the real start path", async () => {
    const harness = await createHarness();
    const started: Array<{ sessionId: string; task: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      if (index > 0) {
        await harness.controller.selectWorkspace(harness.workspaces[index]);
        await harness.controller.newChat();
      }
      const task = `等待 limit-${index}`;
      const result = await harness.controller.startTask({
        task,
        sessionId: null,
        modelTier: index === 1 ? "strong" : "fast",
        modelRef: index === 1 ? "builtin:strong" : "builtin:fast",
        permissionMode: "ask",
      });
      started.push({ sessionId: result.sessionId, task });
      await waitFor(() => harness.models.started.has(task));
    }
    await harness.controller.selectWorkspace(harness.workspaces[3]);
    await harness.controller.newChat();
    await expect(harness.controller.startTask({
      task: "第四个任务",
      sessionId: null,
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
    })).rejects.toMatchObject({ code: "MAIN_AGENT_CONCURRENCY_LIMIT" });

    harness.controller.shutdown();
    for (const item of started) {
      await waitFor(() => latestSession(harness.events, item.sessionId)?.status === "cancelled");
      await waitFor(() => Boolean(latestSession(harness.events, item.sessionId)?.title));
    }
  });

  it("releases the workspace reservation when startup fails before attach", async () => {
    const harness = await createHarness({ failModelCreationOnce: true });
    await expect(harness.controller.startTask({
      task: "首次启动失败",
      sessionId: null,
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
    })).rejects.toThrow("fixture model construction failure");

    const recovered = await harness.controller.startTask({
      task: "失败后正常启动",
      sessionId: null,
      modelTier: "fast",
      modelRef: "builtin:fast",
      permissionMode: "ask",
    });
    await waitFor(() => latestSession(harness.events, recovered.sessionId)?.status === "completed");
    await waitFor(() => Boolean(latestSession(harness.events, recovered.sessionId)?.title));
  });
});
