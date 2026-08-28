import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/core/agent-runner";
import { RestrictedSubagentCoordinator } from "../src/core/subagent-coordinator";
import { WorkspaceBoundary } from "../src/core/security/path-boundary";
import { LocalToolExecutor } from "../src/core/tools/tool-executor";
import type { ApprovalGateway, Clock, IdGenerator, ModelClient, ModelRequest, ModelStreamChunk } from "../src/core/types";
import { WorkspaceWriteLeaseManager } from "../src/core/write-leases";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class CounterIds implements IdGenerator {
  private value = 0;
  next(prefix: string): string {
    this.value += 1;
    return `${prefix}_${this.value}`;
  }
}

const clock: Clock = { now: () => new Date("2026-08-29T00:00:00.000Z") };
const approvals: ApprovalGateway = {
  request: async () => {
    throw new Error("restricted subagents must never request approval");
  },
};

function toolRound(id: string, name: string, args: unknown): ModelStreamChunk[] {
  return [{
    toolCallDeltas: [{ index: 0, id, name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
  }];
}

class RoutingModel implements ModelClient {
  readonly childToolSets: string[][] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const isChild = system.includes("隔离子 Agent");
    const calls = request.messages.flatMap((message) =>
      message.role === "assistant" ? (message.tool_calls ?? []).map((call) => call.function.name) : [],
    );
    if (!isChild) {
      if (!calls.includes("spawn_subagents")) {
        yield* toolRound("spawn_1", "spawn_subagents", {
          tasks: [
            { role: "analysis", mode: "read_only", task: "读取 source.ts 并分析导出值，给出带行号证据。" },
            { role: "test_localization", mode: "read_only", task: "读取 source.ts 并定位需要覆盖的测试，给出带行号证据。" },
          ],
        });
        return;
      }
      yield { content: "主任务已复核两个结构化调查结果。", finishReason: "stop" };
      return;
    }

    this.childToolSets.push(request.tools.map((tool) => tool.function.name));
    if (!calls.includes("update_plan")) {
      yield* toolRound(`plan_${request.messages.length}`, "update_plan", {
        steps: [
          { id: "inspect", title: "读取来源", status: "in_progress" },
          { id: "report", title: "形成结论", status: "pending" },
        ],
      });
      return;
    }
    if (!calls.includes("read_file")) {
      yield* toolRound(`read_${request.messages.length}`, "read_file", { path: "source.ts" });
      return;
    }
    yield {
      content: JSON.stringify({
        summary: "source.ts 导出 answer 常量。",
        findings: [{
          title: "导出值已定位",
          detail: "answer 的值为 42。",
          confidence: "high",
          evidence: [{ path: "source.ts", line: 1, detail: "export const answer = 42" }],
        }],
        relatedFiles: ["source.ts"],
        verificationSuggestions: ["增加导出值断言"],
        risks: [],
      }),
      finishReason: "stop",
    };
  }
}

class ProposalModel implements ModelClient {
  readonly toolSets: string[][] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.toolSets.push(request.tools.map((tool) => tool.function.name));
    const calls = request.messages.flatMap((message) =>
      message.role === "assistant" ? (message.tool_calls ?? []).map((call) => call.function.name) : [],
    );
    if (!calls.includes("update_plan")) {
      yield* toolRound("plan_proposal", "update_plan", {
        steps: [
          { id: "inspect", title: "检查目标", status: "in_progress" },
          { id: "proposal", title: "生成提案", status: "pending" },
        ],
      });
      return;
    }
    if (!calls.includes("propose_file_change")) {
      yield* toolRound("proposal_1", "propose_file_change", {
        path: "source.ts",
        content: "export const answer = 43;\n",
      });
      return;
    }
    yield {
      content: JSON.stringify({
        summary: "已生成候选补丁，未写入磁盘。",
        findings: [{
          title: "候选值调整",
          detail: "提议把 answer 改为 43。",
          confidence: "high",
          evidence: [{ path: "source.ts", line: 1, detail: "当前值为 42" }],
        }],
        relatedFiles: ["source.ts"],
        verificationSuggestions: ["由主 Agent 审核并运行测试"],
        risks: ["尚未应用"],
      }),
      finishReason: "stop",
    };
  }
}

class HangingModel implements ModelClient {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    await new Promise<void>((_resolve, reject) => {
      if (request.signal.aborted) {
        reject(request.signal.reason);
        return;
      }
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  }
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hammercode-subagent-"));
  directories.push(directory);
  await writeFile(path.join(directory, "source.ts"), "export const answer = 42;\n", "utf8");
  return { directory, boundary: await WorkspaceBoundary.create(directory) };
}

describe("restricted subagent orchestration", () => {
  it("persists independent child state while exposing only structured results to the parent", async () => {
    const { directory, boundary } = await fixture();
    const ids = new CounterIds();
    const model = new RoutingModel();
    const leases = new WorkspaceWriteLeaseManager();
    const coordinator = new RestrictedSubagentCoordinator(model, boundary, clock, ids, leases);
    const runner = new AgentRunner(
      {
        model,
        tools: new LocalToolExecutor(boundary, ids),
        approvals,
        clock,
        ids,
        subagents: coordinator,
        writeLeases: leases,
      },
      { maxRounds: 5, maxToolCalls: 10, maxRunTimeMs: 60_000, contextTokenBudget: 64_000, systemPrompt: "main" },
    );
    const session = await runner.start("请并行分析源文件及测试定位，然后汇总结论。", directory);
    expect(session.status).toBe("completed");
    expect(session.subtasks).toHaveLength(2);
    expect(session.subtasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "completed",
        effectivePermission: "read_only",
        result: expect.objectContaining({ relatedFiles: ["source.ts"] }),
        plan: expect.objectContaining({ steps: expect.arrayContaining([expect.objectContaining({ status: "completed" })]) }),
      }),
    ]));
    const spawnMessage = session.messages.find((message) => message.role === "tool" && message.toolName === "spawn_subagents");
    expect(spawnMessage?.role).toBe("tool");
    if (spawnMessage?.role !== "tool") throw new Error("missing spawn result");
    const toolResult = JSON.parse(spawnMessage.content) as { output: string };
    const parentPayload = JSON.parse(toolResult.output) as Array<Record<string, unknown>>;
    expect(parentPayload).toHaveLength(2);
    expect(parentPayload[0]).not.toHaveProperty("messages");
    expect(parentPayload[0]).not.toHaveProperty("toolTraces");
    expect(model.childToolSets.length).toBeGreaterThan(0);
    for (const names of model.childToolSets) {
      expect(names).toEqual(expect.arrayContaining(["update_plan", "read_file", "git_status", "git_diff"]));
      expect(names).not.toEqual(expect.arrayContaining([
        "write_file", "edit_file", "delete_file", "run_command", "run_python",
        "spawn_subagents", "remember_project", "search_project_memory",
      ]));
    }
  });

  it("creates an independent patch proposal without changing the workspace", async () => {
    const { directory, boundary } = await fixture();
    const ids = new CounterIds();
    const model = new ProposalModel();
    const leases = new WorkspaceWriteLeaseManager();
    const coordinator = new RestrictedSubagentCoordinator(model, boundary, clock, ids, leases);
    const updates: string[] = [];
    const [task] = await coordinator.spawn({
      workspaceRoot: directory,
      parentSessionId: "parent",
      parentTurnId: "turn",
      parentModelTier: "fast",
      parentModelRef: "builtin:fast",
      parentPermissionMode: "full_access",
      tasks: [{ role: "code_review", mode: "patch_proposal", task: "为 source.ts 生成一个候选补丁。" }],
      signal: new AbortController().signal,
      onUpdate: (current) => { updates.push(current.status); },
    });
    expect(task).toMatchObject({
      status: "completed",
      parentPermissionMode: "full_access",
      effectivePermission: "proposal_only",
      patches: [expect.objectContaining({ path: "source.ts", kind: "modify" })],
    });
    expect(task.patches[0]?.patch).toContain("+export const answer = 43;");
    expect(await readFile(path.join(directory, "source.ts"), "utf8")).toBe("export const answer = 42;\n");
    expect(leases.snapshot()).toEqual([]);
    expect(updates).toContain("pending");
    expect(model.toolSets.every((names) => names.includes("propose_file_change"))).toBe(true);
    expect(model.toolSets.every((names) => !names.includes("write_file"))).toBe(true);
  });

  it("rejects a second concurrent proposal for the same normalized path", async () => {
    const { directory, boundary } = await fixture();
    const ids = new CounterIds();
    const leases = new WorkspaceWriteLeaseManager();
    const coordinator = new RestrictedSubagentCoordinator(
      new ProposalModel(), boundary, clock, ids, leases,
    );
    const tasks = await coordinator.spawn({
      workspaceRoot: directory,
      parentSessionId: "parent",
      parentTurnId: "turn",
      parentModelTier: "fast",
      parentModelRef: "builtin:fast",
      parentPermissionMode: "full_access",
      tasks: [
        { role: "analysis", mode: "patch_proposal", task: "propose change A" },
        { role: "code_review", mode: "patch_proposal", task: "propose change B" },
      ],
      signal: new AbortController().signal,
      onUpdate: () => undefined,
    });
    expect(tasks.reduce((total, task) => total + task.patches.length, 0)).toBe(1);
    expect(tasks.flatMap((task) => task.toolTraces).some((trace) =>
      trace.call.name === "propose_file_change" && trace.result?.errorCode === "WRITE_LEASE_CONFLICT",
    )).toBe(true);
    expect(await readFile(path.join(directory, "source.ts"), "utf8")).toBe("export const answer = 42;\n");
    expect(leases.snapshot()).toEqual([]);
  });

  it("enforces the one-to-three child limit before any model request", async () => {
    const { directory, boundary } = await fixture();
    const coordinator = new RestrictedSubagentCoordinator(
      new RoutingModel(), boundary, clock, new CounterIds(), new WorkspaceWriteLeaseManager(),
    );
    await expect(coordinator.spawn({
      workspaceRoot: directory,
      parentSessionId: "parent",
      parentTurnId: "turn",
      parentModelTier: "fast",
      parentModelRef: "builtin:fast",
      parentPermissionMode: "ask",
      tasks: Array.from({ length: 4 }, (_, index) => ({
        role: "analysis" as const,
        mode: "read_only" as const,
        task: `task ${index}`,
      })),
      signal: new AbortController().signal,
      onUpdate: () => undefined,
    })).rejects.toMatchObject({ code: "SUBAGENT_LIMIT" });
  });

  it("cancels every active child when the parent signal stops", async () => {
    const { directory, boundary } = await fixture();
    const coordinator = new RestrictedSubagentCoordinator(
      new HangingModel(), boundary, clock, new CounterIds(), new WorkspaceWriteLeaseManager(),
    );
    const abort = new AbortController();
    const run = coordinator.spawn({
      workspaceRoot: directory,
      parentSessionId: "parent",
      parentTurnId: "turn",
      parentModelTier: "fast",
      parentModelRef: "builtin:fast",
      parentPermissionMode: "ask",
      tasks: [
        { role: "analysis", mode: "read_only", task: "wait for cancellation A" },
        { role: "test_localization", mode: "read_only", task: "wait for cancellation B" },
      ],
      signal: abort.signal,
      onUpdate: () => undefined,
    });
    await Promise.resolve();
    abort.abort(new DOMException("stop parent", "AbortError"));
    const tasks = await run;
    expect(tasks.map((task) => task.status)).toEqual(["cancelled", "cancelled"]);
    expect(tasks.every((task) => Boolean(task.finishedAt))).toBe(true);
  });
});
