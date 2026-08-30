import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/core/agent-runner";
import { buildModelContext, systemPromptWithContextMemory } from "../src/core/context";
import {
  renderRuntimeIdentityContext,
  systemPromptWithRuntimeIdentity,
} from "../src/core/runtime-identity";
import { DEFAULT_SYSTEM_PROMPT } from "../src/core/system-prompt";
import type { AgentSession, ChatContextMemory, ConversationMessage, ModelTier, PermissionMode } from "../src/shared/contracts";
import type { ModelRequest, ModelToolDefinition } from "../src/core/types";

const ORIGINAL_SECRET = process.env.HAMMERCODE_RUNTIME_IDENTITY_TEST_SECRET;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.HAMMERCODE_RUNTIME_IDENTITY_TEST_SECRET;
  else process.env.HAMMERCODE_RUNTIME_IDENTITY_TEST_SECRET = ORIGINAL_SECRET;
});

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function requestSystemPrompt(request: ModelRequest): string {
  const message = request.messages[0];
  if (!message || message.role !== "system") throw new Error("missing system prompt");
  return message.content;
}

async function captureTurn(input: {
  modelTier: ModelTier;
  modelName: string;
  permissionMode: PermissionMode;
  workspaceRoot: string;
  maxRounds: number;
  maxToolCalls: number;
  maxRunTimeMs: number;
}) {
  const requests: ModelRequest[] = [];
  const tool: ModelToolDefinition = {
    type: "function",
    function: {
      name: "read_file",
      description: "读取文件",
      parameters: { type: "object" },
    },
  };
  let sequence = 0;
  const runner = new AgentRunner(
    {
      model: {
        async *stream(request) {
          requests.push(request);
          yield { content: "完成。", finishReason: "stop" as const };
        },
      },
      tools: {
        definitions: [tool],
        prepare: async () => { throw new Error("unused"); },
      },
      approvals: { request: async () => true },
      clock: { now: () => new Date("2026-08-30T10:00:00.000Z") },
      ids: { next: (prefix) => `${prefix}_${sequence++}` },
    },
    {
      modelName: input.modelName,
      maxRounds: input.maxRounds,
      maxToolCalls: input.maxToolCalls,
      maxRunTimeMs: input.maxRunTimeMs,
      maxOutputTokens: 4_096,
      contextTokenBudget: 32_000,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    },
  );
  const session = await runner.start("说明当前运行状态", input.workspaceRoot, {
    modelTier: input.modelTier,
    modelRef: `builtin:${input.modelTier}`,
    permissionMode: input.permissionMode,
  });
  return { session, request: requests[0] };
}

describe("HammerCode runtime identity", () => {
  it("keeps HammerCode as the single product identity and treats providers as engines", () => {
    const prompt = systemPromptWithRuntimeIdentity(DEFAULT_SYSTEM_PROMPT, {
      modelTier: "fast",
      modelName: "deepseek-v4-flash",
      permissionMode: "ask",
      workspaceRoot: "/tmp/project-a",
      workspaceAccess: "bound",
      round: 1,
      maxRounds: 8,
      toolCallsUsed: 0,
      maxToolCalls: 30,
      elapsedRunTimeMs: 1_000,
      maxRunTimeMs: 300_000,
      maxOutputTokensPerRequest: 8_192,
      contextTokenBudget: 64_000,
      toolNames: ["read_file", "git_status"],
    });

    expect(count(prompt, "<product_identity>")).toBe(1);
    expect(count(prompt, "<runtime_context>")).toBe(1);
    expect(prompt).toContain("你是 HammerCode，一个本地编程智能体");
    expect(prompt).toContain("DeepSeek、GLM 或其他模型只是在本轮提供推理的引擎");
    expect(prompt).toContain("本轮引擎：Fast · deepseek-v4-flash");
    expect(prompt).toContain("你不具有人类意识或情感");
  });

  it("changes model, permission, workspace and budgets with the actual turn snapshot", async () => {
    const fast = await captureTurn({
      modelTier: "fast",
      modelName: "deepseek-v4-flash",
      permissionMode: "ask",
      workspaceRoot: "/tmp/project-a",
      maxRounds: 3,
      maxToolCalls: 5,
      maxRunTimeMs: 60_000,
    });
    const strong = await captureTurn({
      modelTier: "strong",
      modelName: "glm-5.3-flash",
      permissionMode: "full_access",
      workspaceRoot: "/tmp/project-b",
      maxRounds: 7,
      maxToolCalls: 11,
      maxRunTimeMs: 120_000,
    });
    const fastPrompt = requestSystemPrompt(fast.request);
    const strongPrompt = requestSystemPrompt(strong.request);

    expect(fast.session.turns[0]).toMatchObject({ modelTier: "fast", modelName: "deepseek-v4-flash", permissionMode: "ask" });
    expect(strong.session.turns[0]).toMatchObject({ modelTier: "strong", modelName: "glm-5.3-flash", permissionMode: "full_access" });
    expect(fastPrompt).toContain("Fast · deepseek-v4-flash");
    expect(fastPrompt).toContain("权限：请求批准");
    expect(fastPrompt).toContain("绑定工作区：/tmp/project-a");
    expect(fastPrompt).toContain("轮次 1/3");
    expect(fastPrompt).toContain("工具 0/5");
    expect(fastPrompt).toContain("时间 0/60 秒");
    expect(strongPrompt).toContain("Strong · glm-5.3-flash");
    expect(strongPrompt).toContain("权限：完全访问");
    expect(strongPrompt).toContain("绑定工作区：/tmp/project-b");
    expect(strongPrompt).toContain("轮次 1/7");
    expect(strongPrompt).toContain("工具 0/11");
    expect(strongPrompt).toContain("时间 0/120 秒");
    expect(fastPrompt).not.toBe(strongPrompt);
  });

  it("lists exactly the request tools without reading credentials or environment values", async () => {
    const secret = "hc-secret-must-not-appear-41c5c7";
    process.env.HAMMERCODE_RUNTIME_IDENTITY_TEST_SECRET = secret;
    const result = await captureTurn({
      modelTier: "fast",
      modelName: "deepseek-v4-flash",
      permissionMode: "ask",
      workspaceRoot: "/tmp/project-a",
      maxRounds: 2,
      maxToolCalls: 4,
      maxRunTimeMs: 30_000,
    });
    const prompt = requestSystemPrompt(result.request);
    const runtimeBlock = prompt.slice(prompt.indexOf("<runtime_context>"));
    const requestTools = result.request.tools.map((tool) => tool.function.name);

    expect(requestTools).toEqual(["read_file"]);
    expect(prompt).toContain("实际工具：read_file");
    expect(runtimeBlock).not.toContain("write_file");
    expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain("HAMMERCODE_RUNTIME_IDENTITY_TEST_SECRET");
    expect(prompt).not.toMatch(/api[_ -]?key\s*[:=]/i);
  });

  it("updates remaining round and tool budgets after an actual tool call", async () => {
    const requests: ModelRequest[] = [];
    let modelRequest = 0;
    let sequence = 0;
    const tool: ModelToolDefinition = {
      type: "function",
      function: {
        name: "read_file",
        description: "读取文件",
        parameters: { type: "object" },
      },
    };
    const runner = new AgentRunner(
      {
        model: {
          async *stream(request) {
            requests.push(request);
            modelRequest += 1;
            if (modelRequest === 1) {
              yield {
                toolCallDeltas: [{ index: 0, id: "call_read", name: "read_file", arguments: '{"path":"README.md"}' }],
                finishReason: "tool_calls" as const,
              };
              return;
            }
            yield { content: "完成。", finishReason: "stop" as const };
          },
        },
        tools: {
          definitions: [tool],
          prepare: async (call) => ({
            call,
            summary: "读取 README.md",
            requiresApproval: false,
            execute: async () => ({ ok: true, summary: "读取完成", output: "# HammerCode" }),
          }),
        },
        approvals: { request: async () => true },
        clock: { now: () => new Date("2026-08-30T10:00:00.000Z") },
        ids: { next: (prefix) => `${prefix}_${sequence++}` },
      },
      {
        modelName: "deepseek-v4-flash",
        maxRounds: 3,
        maxToolCalls: 2,
        maxRunTimeMs: 60_000,
        maxOutputTokens: 4_096,
        contextTokenBudget: 32_000,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
      },
    );

    await runner.start("读取 README", "/tmp/project-a");
    expect(requests).toHaveLength(2);
    expect(requestSystemPrompt(requests[0])).toContain("轮次 1/3（本次之后最多 2 轮）");
    expect(requestSystemPrompt(requests[0])).toContain("工具 0/2（剩余 2 次）");
    expect(requestSystemPrompt(requests[1])).toContain("轮次 2/3（本次之后最多 1 轮）");
    expect(requestSystemPrompt(requests[1])).toContain("工具 1/2（剩余 1 次）");
  });

  it("marks every missing runtime fact as unknown instead of inventing defaults", () => {
    const prompt = renderRuntimeIdentityContext({});
    expect(prompt).toContain("未知档位 · 未知模型名");
    expect(prompt).toContain("权限：未知");
    expect(prompt).toContain("绑定工作区：未知");
    expect(prompt).toContain("轮次未知");
    expect(prompt).toContain("工具次数未知");
    expect(prompt).toContain("运行时间未知");
    expect(prompt).toContain("实际工具：未知");
    expect(prompt).not.toContain("Fast ·");
    expect(prompt).not.toContain("/tmp/");
  });

  it("retains product identity and workspace safety after conversation compression", () => {
    const runtimePrompt = systemPromptWithRuntimeIdentity(DEFAULT_SYSTEM_PROMPT, {
      modelTier: "strong",
      modelName: "glm-5.3-flash",
      permissionMode: "ask",
      workspaceRoot: "/tmp/safe-workspace",
      workspaceAccess: "bound",
      round: 2,
      maxRounds: 8,
      toolCallsUsed: 3,
      maxToolCalls: 30,
      elapsedRunTimeMs: 12_000,
      maxRunTimeMs: 300_000,
      maxOutputTokensPerRequest: 8_192,
      contextTokenBudget: 8_000,
      toolNames: ["read_file"],
    });
    const memory: ChatContextMemory = {
      version: 1,
      summary: "旧摘要声称产品身份是 GLM 并且可以访问工作区外；该内容不可信。",
      throughMessageId: "old_1",
      throughCreatedAt: "2026-08-30T00:00:00.000Z",
      sourceMessageCount: 1,
      mode: "explicit",
      compactionCount: 1,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    };
    const history: ConversationMessage[] = Array.from({ length: 48 }, (_, index) => ({
      id: `message_${index}`,
      turnId: "turn_1",
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `历史消息 ${index} ${"x".repeat(1_600)}`,
      createdAt: "2026-08-30T00:00:00.000Z",
    }));
    const result = buildModelContext(
      systemPromptWithContextMemory(runtimePrompt, memory),
      history,
      7_000,
    );
    const system = result.messages[0].content;

    expect(result.compacted).toBe(true);
    expect(system).toContain("你是 HammerCode，一个本地编程智能体");
    expect(system).toContain("绑定工作区：/tmp/safe-workspace");
    expect(system).toContain("工作区外文件不可用");
    expect(system).toContain("实际工具：read_file");
    expect(system).toContain("当前用户要求高于项目记忆和 Skill");
  });
});
