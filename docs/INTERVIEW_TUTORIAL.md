# HammerCode 面试与源码学习教程

最后核对：2026-08-31

## 这份教程怎么用

这不是一篇只供浏览的项目介绍，而是一套从“不会运行 TypeScript、没看过源码”走到“能够解释并辩护设计”的学习路线。建议先通读第 1–4 章建立地图，再按第 14 章的课程顺序开一个新聊天逐课学习。每学完一课，都必须完成三件事：用自己的话复述、在源码中指出入口、回答本课自测题。

你不需要背下每个函数。面试真正需要的是：知道一次任务如何从 UI 进入 AgentRunner，知道模型为什么不能直接执行工具，知道每层安全检查解决什么问题，也能诚实说明当前边界与尚未收敛的问题。

## 1. 先记住项目的核心答案

### 1.1 原始题目要求什么

题目要求独立实现一个 coding agent：它与大语言模型交互，能在本地读写文件、执行命令并完成真实编程任务。禁止在现成 agent 产品上套界面，禁止使用 agent 框架或 SDK，禁止依赖服务端托管的文件或代码执行工具。对话历史、上下文、工具定义与本地执行、模型输出解析、循环终止和错误处理都要自行实现。

最终提交物是：公开 Git 仓库、1000 汉字以内的 `README.txt`、2 分钟以内且不超过 200 MB 的 MP4。面试重点是能否解释 agent 为什么这样运转、能否为设计决策辩护。

### 1.2 HammerCode 是什么

HammerCode 是面向 Apple Silicon macOS 的 Electron + TypeScript 桌面编程智能体。用户选择工作区并提交任务；模型通过 OpenAI-compatible Chat Completions 流输出文本、思考和 function tool calls；HammerCode 在本机组装、校验、授权和执行工具，把结果加入对话，再请求模型继续推理，直到完成或触发明确终止条件。

一句话版本：

> HammerCode 把模型的不可信操作提案放进一个有状态、有工作区边界、可审批、可取消、可恢复的本地执行闭环。

### 1.3 最重要的设计原则

1. 模型不是权限主体。它只能提出 JSON 工具调用，不能直接获得文件系统或 Shell。
2. Renderer 不是本地能力主体。它只能展示和发起带类型 IPC，不能直接访问 Node.js。
3. 当前工作区是能力边界。路径、cwd、Python、PDF 和 Skill 都不能绕过它。
4. 用户批准也不是万能通行证。越界、提权、擦盘等高风险行为在审批前直接阻断。
5. 历史是上下文，不是待执行队列。恢复或继续聊天绝不重放旧 tool call。
6. 每个终止都要有语义。正常完成、轮次上限、工具上限、时间上限、超时、输出耗尽、取消和模型错误不能混成一个“失败”。

## 2. TypeScript、Node.js、React、Electron 到底是什么关系

### 2.1 TypeScript 不是一个新的运行时

TypeScript 是带静态类型的 JavaScript。类型只在开发和编译阶段帮助发现错误，运行时通常已经被移除。例如：

```ts
type PermissionMode = "ask" | "full_access";

function canAutoApprove(mode: PermissionMode): boolean {
  return mode === "full_access";
}
```

`PermissionMode` 不会在最终 JavaScript 中变成一个自动校验器。来自模型、IPC 或 JSON 文件的数据仍可能是任意内容，所以 HammerCode 使用 Zod 在运行时再次校验。这是理解项目边界的关键：TypeScript 防止“开发者写错”，Zod 防止“不可信外部输入骗过系统”。

### 2.2 Node.js 做什么

Node.js 是 JavaScript 的本机运行时。HammerCode 的 Electron main process 借助 Node.js 使用：

- `node:fs/promises` 读取、写入和原子替换文件；
- `node:child_process` 创建本地进程；
- `node:path` 解析和比较路径；
- `node:crypto` 计算 SHA-256；
- 原生 `fetch` 请求模型 API。

这些能力只存在于 main/core，不暴露给 renderer。

### 2.3 React 做什么

React 只负责 renderer 中的界面和交互状态。`src/renderer/src/App.tsx` 根据 main process 发来的安全快照显示项目、聊天、Plan、工具轨迹、diff、审批面板和输入区。React 不决定工具是否安全，也不直接执行文件或命令。

`.tsx` 表示文件中同时有 TypeScript 和 JSX。JSX 是描述界面的语法，会由 Vite/React 插件转换成 JavaScript。

### 2.4 Electron 为什么有三个部分

Electron 应用至少要理解三个边界：

| 部分 | 本项目文件 | 权限与职责 |
| --- | --- | --- |
| Main process | `src/main/main.ts`、`src/main/controller.ts` | 有 Node.js 权限；管理窗口、模型、文件、子进程、凭据、会话与 Agent 生命周期 |
| Preload | `src/preload/index.ts` | 使用 `contextBridge` 暴露一组明确 IPC 方法，是 renderer 与 main 的窄桥 |
| Renderer | `src/renderer/` | 沙箱中的 React UI；不能直接访问 Node、环境变量、文件和 Shell |

`src/main/main.ts` 创建窗口时明确设置 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，并拒绝新窗口和非预期导航。

### 2.5 npm 在做什么

`package.json` 记录依赖和脚本，`package-lock.json` 固定实际安装版本。常用命令：

```bash
npm ci              # 严格按 lockfile 安装依赖，适合复现
npm run dev         # 启动开发模式
npm run typecheck   # 只做类型检查，不生成产物
npm test            # 运行 Vitest
npm run build       # 生产构建
npm run package:mac # 生成 arm64 .app 目录包
```

不要把 `npm` 理解为运行 TypeScript 的魔法。它只是根据 `package.json` 调用具体程序。

### 2.6 `npm run dev` 的真实执行链

`package.json` 中的开发脚本先执行 `npm run build:main`：

1. `tsc -p tsconfig.main.json` 把 `src/main`、`src/preload`、`src/core`、`src/shared` 编译到 `dist/`。
2. `concurrently` 同时启动 Vite 和 Electron。
3. Vite 在 `127.0.0.1:5173` 编译、服务 React renderer。
4. `wait-on` 等待端口可用，再设置 `HAMMERCODE_DEV_SERVER_URL` 并运行 `electron .`。
5. Electron 根据 `package.json` 的 `main` 字段启动 `dist/main/main.js`。
6. Main process 创建窗口并加载 Vite 页面；preload 使用已编译的 `dist/preload/index.js`。

生产构建不同：renderer 被 Vite 写到 `dist/renderer/`，Electron 加载本地 `index.html`，electron-builder 再把 `dist/`、`skills/` 和 `package.json` 打入 `.app`。

### 2.7 三套 TypeScript 配置为什么分开

- `tsconfig.main.json`：Node16 模块规则，编译 main/preload/core/shared 到 `dist/`。
- `tsconfig.json`：renderer 的 ESNext、DOM、JSX 与 Vite 模块规则，只检查不输出。
- `tsconfig.test.json`：测试环境，包含 Node 和 Vitest 类型，只检查不输出。

分开是因为 main 与 renderer 的运行环境不同。把 Node 类型随意带进 renderer，容易掩盖进程边界错误。

## 3. 先建立源码地图

推荐按下面顺序阅读，而不是一上来钻进 1000 多行的 `AgentRunner` 或 `App.tsx`。

### 3.1 第一站：公开数据契约

文件：`src/shared/contracts.ts`

要找的类型：

- `SessionStatus`：会话状态；
- `ToolCall` / `ToolResult` / `ToolTrace`：工具提案、结果和审计；
- `ConversationMessage`：用户、助手、工具三类消息；
- `AgentTurn`：单次用户输入固定的模型、权限、Plan 和预算；
- `AgentSession`：一个聊天的全部 turns、消息、工具轨迹和文件变更；
- `HammerCodeApi`：renderer 可以调用的全部 IPC 接口。

阅读目标：先知道系统“保存什么”，再看系统“怎么运行”。

### 3.2 第二站：Electron 启动和进程边界

文件：`src/main/main.ts`、`src/preload/index.ts`

观察：

- BrowserWindow 的安全配置；
- main 中创建 `SessionStore`、`ModelCredentialStore`、`ProjectMemoryStore`、`SkillStore` 和 `AppController`；
- `registerIpc` 把固定 channel 映射到 Controller 方法；
- preload 只把这些 channel 封装成 `window.hammerCode`。

### 3.3 第三站：应用协调器

文件：`src/main/controller.ts`

重点方法：

- `initialize()`：载入凭据、Skill、导航和中断撤销状态；
- `startTask()`：创建工作区边界、模型客户端、工具执行器、审批器、子任务协调器和 AgentRunner；
- `cancelTask()` / `resolveApproval()` / `requestUndo()`：把 UI 行为接到真实执行对象；
- `refreshNavigation()`：从持久化状态恢复项目与聊天。

Controller 是“组装和生命周期层”，不应该重新实现 agent 循环。

### 3.4 第四站：Agent 核心循环

文件：`src/core/agent-runner.ts`

重点方法：

- `start()`：创建第一条 turn 和 user message；
- `resume()`：在终态聊天上创建新 turn，闭合历史未完成工具但不重放；
- `runPreparedTurn()`：统一捕获取消、时间上限和错误；
- `runLoop()`：构建上下文、请求模型、保存 assistant、执行 tool calls、判断终止；
- `requestModelWithRetry()`：只重试允许的临时错误；
- `executeTool()`：Plan 门槛、prepare、安全、审批、执行、审计、文件变更与工具消息；
- `terminate()`：写入终止原因并进入最终状态。

### 3.5 第五站：模型流

文件：

- `src/core/model/openai-compatible-client.ts`
- `src/core/model/sse.ts`
- `src/core/model/stream-assembler.ts`

阅读目标：理解 HTTP SSE 字节流怎样变成最终的文本、思考、tool calls 和 finish reason。

### 3.6 第六站：本地工具和安全

文件：

- `src/core/tools/tool-definitions.ts`
- `src/core/tools/tool-executor.ts`
- `src/core/security/path-boundary.ts`
- `src/core/security/command-policy.ts`
- `src/core/tools/command-runner.ts`

阅读目标：区分 `prepare()` 与 `execute()`。前者生成安全意图、diff 和审批；后者只能执行已经准备好的操作，并再次检查容易过期的状态。

### 3.7 第七站：持久化与恢复

文件：`src/main/session-store.ts`、`src/core/session-recovery.ts`、`src/core/file-undo.ts`

阅读目标：理解聊天为何不会在重启后自动续跑，以及撤销为什么是新副作用而不是内存回滚。

### 3.8 第八站：UI

文件：`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`

阅读目标：跟踪 `window.hammerCode.bootstrap()`、`onEvent()`、`submit()`、`resolveApproval()`，确认 UI 只是安全快照的消费者和用户意图的发送者。

## 4. 一次真实任务的完整调用链

下面是面试最值得画出的流程。

```text
用户点击发送
  ↓
App.tsx: submit()
  ↓ window.hammerCode.startTask(...)
preload: ipcRenderer.invoke("hammercode:start-task")
  ↓
main.ts: ipcMain.handle(...)
  ↓
AppController.startTask()
  ├─ 解析 IPC 输入
  ├─ 固化模型与权限
  ├─ WorkspaceBoundary.create()
  ├─ 创建 Model / Tools / Approval / AgentRunner
  └─ runner.start() 或 runner.resume()
        ↓
AgentRunner.runLoop()
  ├─ buildModelContext()
  ├─ model.stream()
  ├─ parseServerSentEvents()
  ├─ StreamAssembler.result()
  ├─ 保存 assistant message
  └─ 有 tool calls 时逐个 executeTool()
        ├─ Zod 参数校验
        ├─ 路径/命令/Plan 检查
        ├─ 生成 diff 或完整命令意图
        ├─ 审批或授权判断
        ├─ 本地执行
        ├─ 保存 ToolTrace / FileChange
        └─ 追加 tool message
              ↓
        下一轮模型请求
              ↓
        finish_reason=stop → completed
```

### 4.1 为什么必须把 tool result 回传模型

模型调用工具时并不知道执行是否成功。文件可能在审批期间被用户修改，命令可能非零退出，用户也可能拒绝。HammerCode 把成功、失败、拒绝、阻断都编码成 `ToolResult` 并作为 `role: "tool"` 消息回传，让模型基于真实结果继续，而不是假装副作用已经发生。

### 4.2 为什么同一响应中的工具顺序执行

`runLoop()` 对同一批 tool calls 逐个 `await executeTool()`。这样审批、文件状态和会话保存容易解释，不会出现两个写操作同时修改同一状态。需要并行的只读调查通过受限子任务协调器单独完成，其结果再结构化返回主 Agent。

### 4.3 什么情况下结束

- `finish_reason=stop` 且没有工具：正常完成；
- `tool_calls`：执行工具后继续下一轮；
- `length`：输出预算耗尽，不能伪装完成；
- `content_filter`：内容策略终止；
- `insufficient_system_resource`：按规则有限重试，耗尽后失败；
- 达到轮次、工具或时间上限：独立终止原因；
- 用户停止：AbortController 传播到模型、审批和进程；
- 无效 JSON、分片或 finish reason：模型输出错误。

## 5. 模型流和 tool call 组装

### 5.1 SSE 是什么

服务端以 `text/event-stream` 持续发送事件，每个事件常以 `data:` 开头，事件之间用空行分隔。`parseServerSentEvents()`：

1. 从 `ReadableStream` 读取字节；
2. 用 `TextDecoder` 处理跨字节边界的 UTF-8；
3. 规范化换行；
4. 按空行分事件；
5. 提取多行 `data:`；
6. 限制单个未完成事件缓冲区，防止无限增长。

### 5.2 为什么 tool call 要组装

一个 tool call 可能分多片返回：第一片只有 `id` 和函数名，后续片逐段追加 JSON 参数。`StreamAssembler` 按 `index` 保存部分调用，把 `id`、`name` 和 `arguments` 分别拼接；结束时排序并要求 id/name 完整。

不能对每个参数片段立刻 `JSON.parse`，因为中间片通常不是合法 JSON。只有组装完成后，工具执行器才把最终字符串当作不可信 JSON 校验。

### 5.3 两个 provider 为什么有 profile

共同部分是 model、messages、stream、max_tokens 和可选 tools。差异集中在模型客户端的请求体构造：

- DeepSeek：发送 `thinking.type`、`reasoning_effort`、`stream_options.include_usage`；思考模式下不发送不兼容的 `tool_choice`。
- GLM：`thinking.type` 固定 enabled，发送 `clear_thinking: false`、`reasoning_effort`，有工具时发送 `tool_choice: auto` 与 `tool_stream: true`。

AgentRunner 不出现厂商分支，它只依赖 `ModelClient` 端口。这叫依赖倒置：核心逻辑依赖抽象，具体协议适配留在边界。

## 6. 状态机、turn 与连续聊天

### 6.1 Session 和 Turn 的区别

- `AgentSession` 是一条聊天，绑定一个工作区，包含多个用户轮次。
- `AgentTurn` 是一次明确用户输入触发的运行，固定本轮模型、权限、Plan、预算和终止原因。

用户在 completed/cancelled/failed 后继续输入时，`resume()` 创建新 turn，而不是复活旧 turn。这样可以回答“本轮用了哪个模型、为什么获得某种权限、哪些工具属于本轮”。

### 6.2 为什么要显式状态机

如果只用 `isLoading`、`isWaiting` 等零散布尔值，可能出现同时为 true 的矛盾组合。`transitionState()` 只允许表中定义的转换，非法转换直接报错，并保存 `from/to/reason/at/turnId`。

面试可以举例：`awaiting_approval → executing_tool` 合法；`completed → executing_tool` 不合法，必须由新的用户输入先进入 `requesting`。

### 6.3 历史工具为什么不会重放

AgentRunner 只执行当前 `model.stream()` 新返回的 tool calls。持久化历史只是构建下一次模型 messages。恢复时若发现 assistant tool call 没有配对 tool result，`closeUnresolvedToolCalls()` 会补一个 `TOOL_CALL_INTERRUPTED` 失败结果，闭合协议，但绝不执行它。

这正是回答“应用在写文件前崩溃会怎样”的关键：恢复只描述真实中断，不猜成功，也不自动续跑。

## 7. 工具安全模型

### 7.1 四层防线

1. Schema：工具名必须存在，JSON 可解析，字段类型、长度、数组数量符合 Zod。
2. WorkspaceBoundary：路径必须相对，词法解析不能逃逸，realpath 不能指向外部。
3. Policy：只读、副作用、命令风险、权限模式和硬阻断共同决定授权。
4. TOCTOU 复查：审批后再次校验文件哈希、inode/size/mtime 或真实路径。

### 7.2 为什么 `..` 检查还不够

攻击者可以在工作区内建立 symlink 指向外部。`WorkspaceBoundary` 对已存在目标调用 `realpath`；对于尚不存在的写入目标，会逐级向上寻找最近存在父目录并验证其真实路径。这样能阻断“工作区内 symlink 目录 + 新文件名”的逃逸。

### 7.3 文件写入为什么分 prepare 和 execute

Prepare 阶段：

- 读取当前内容和 SHA-256；
- 生成 before/after diff；
- 形成审批请求；
- 固化预期文件变更。

Execute 阶段：

- 再读当前哈希；
- 若与 prepare 时不同，返回 `STALE_WRITE`；
- 写入同目录临时文件，`fsync` 后原子 rename。

这解决两个问题：用户看见的 diff 与实际执行一致；等待审批期间的外部编辑不会被覆盖。

### 7.4 `edit_file` 为什么要求唯一匹配

模型只提供 `old_text → new_text`。零匹配说明模型基于旧事实，多匹配说明意图不够精确。默认只允许唯一匹配，显式 `replace_all` 才能替换全部，避免悄悄改错位置。

### 7.5 命令风险如何分类

- `auto`：语法简单且在很小的本地验证白名单，例如 `npm test`、`node --test`、`tsc --noEmit`、安全 Git status/diff。
- `permission_mode`：普通工作区命令；ask 弹窗，full_access 可自动批准。
- `always`：远端、发布、上传、复合 Shell 或可能丢数据的命令，即使 full_access 也审批。
- 直接阻断：sudo、越界绝对路径、HOME、擦盘、关机、工作区整体递归删除等。

正当辩护不是“正则能证明 Shell 安全”，而是恰恰相反：任意 Shell 很难证明安全，所以自动白名单极小，其余升级为审批或阻断。

### 7.6 命令取消为什么要杀进程组

Shell 可能启动子进程。如果只杀 Shell，测试服务器或编译器仍会留在后台。`runProcess()` 使用 detached 进程组；超时或取消时先向负 PID 发送 SIGTERM，一秒后 SIGKILL，尽量清理整组。

### 7.7 ask 与 full_access 的真实差异

`full_access` 只改变普通副作用是否逐次弹窗。它不能跳过参数校验、工作区边界、文件过期检查、命令硬阻断、超时、输出上限和取消；远端/发布类 `always` 命令也仍需审批。

工具轨迹记录实际授权来源：`not_required`、`user_approved`、`user_rejected`、`full_access`、`safety_blocked`。这比只保存“执行成功”更能解释系统为什么行动。

## 8. 上下文、压缩与记忆

### 8.1 为什么需要上下文预算

聊天历史、工具输出和系统提示都会占模型上下文。HammerCode 用保守字符启发式估算 token，先尝试完整历史；超预算时保留 system、初始目标和最近协议组，把较早内容转成明确标注的本地摘要。assistant tool call 与对应 tool result 作为不可拆分组，避免形成无效协议历史。

### 8.2 为什么估算不假装精确

不同模型 tokenizer 不同，引入每个厂商 tokenizer 会增加依赖和耦合。字符估算可测试、保守，但服务端仍可能有不同计数并返回长度错误。系统会把这种情况作为真实限制，而不是声称本地数字绝对准确。

### 8.3 聊天压缩记忆是什么

`contextMemory` 属于单条聊天。达到阈值只会在新 turn 开始前自动压缩，显式压缩也只在安全状态进行。压缩请求不提供工具；模型生成语义摘要后，本地再附加原始目标、最新约束、文件哈希、验证结果、错误和 Plan 等事实锚点。只有请求成功才替换旧记忆，取消或失败保持旧边界。

完整消息和工具审计仍在磁盘中；压缩只影响以后发给模型的上下文。

### 8.4 项目记忆与聊天记忆有什么不同

| 机制 | 范围 | 目的 | 默认与信任 |
| --- | --- | --- | --- |
| Chat context memory | 单聊天 | 压缩长历史，支持同聊天继续 | 历史摘要，不是新指令 |
| Project memory | 同一工作区跨聊天 | 保存稳定文件事实、验证、决定和约束 | 新项目默认关闭，读取/生成分别控制 |
| Skill | 当前 turn | 提供可迁移操作流程 | 低优先级不可信指令，不授予权限 |
| BTW | 内存临时分支 | 在不污染主线时提问 | 无工具、无持久化、关闭销毁 |

项目记忆中的文件事实绑定 after hash；磁盘变化后失效。验证事实绑定工作区 revision；后续文件变化使旧验证失效。模型决定标记 `model_inference`，不能伪装成工具核验。

## 9. 持久化、恢复和撤销

### 9.1 数据保存在哪里

正式应用使用 Electron `app.getPath("userData")` 下的目录：

- sessions：会话索引与逐聊天 JSON；
- settings：加密模型连接元数据与 Skill 设置；
- project-memory：按工作区隔离的项目记忆；
- skills：用户 Skill 包。

Renderer 不知道这些存储路径，也没有任意文件读取接口。

### 9.2 为什么使用 JSON + 原子替换

项目是本地、单用户、演示规模。JSON 可检查、迁移和测试；写入先落临时文件再 rename，权限设为 `0600`。代价是不适合高并发或超大历史，这也是可以诚实承认的边界。

### 9.3 重启时发生什么

`SessionStore` 读取数据时用 Zod 验证并迁移旧版本。如果上次状态仍是 requesting/awaiting_approval/executing_tool，而本次没有对应的活跃 runner，就：

1. 闭合没有结果的 tool calls；
2. 清空 pending approval 和 streaming 字段；
3. 把当前 turn 标为 interrupted/failed；
4. 保存修复结果；
5. 等待用户主动发送新消息。

### 9.4 撤销为什么不是简单写回内存

撤销本身也是文件副作用，必须可见、可审批、可过期。系统只允许撤销同一路径最新且仍 applied 的变更，先检查磁盘哈希等于记录的 after hash，再使用正式文件工具生成反向 diff。审批后仍会再次复查。

如果崩溃发生在撤销执行附近，恢复只比较当前哈希：等于 before 表示已撤销，等于 after 表示没执行，其他值表示外部冲突。不会自动重放反向写入。

## 10. 高级能力该怎么解释

这些能力不是面试开场重点。先讲清主闭环和安全，再根据追问展开。

### 10.1 BTW 临时侧边聊天

BTW 创建时单向复制主聊天快照，使用独立模型请求和 AbortController，tools 为空。它不持有 AgentRunner、审批器或 SessionStore，消息不写回主线；关闭、切换主聊天或退出应用即销毁。

设计价值：允许用户在主任务运行时问“现在在做什么”，又不引入第二条可写执行链。

### 10.2 受限子 Agent

主 Agent 单 turn 最多创建三个子任务。子任务模型继承父模型，但实际权限固定只读，只有计划、目录/文件/PDF读取、搜索和只读 Git 等工具；没有递归 spawn、通用命令、项目记忆写入和直接文件写入。

子任务的完整历史独立保存，主 Agent 只收到结构化摘要、发现、文件/行号证据、风险和预算。这样避免把大量中间输出塞进主上下文。可选 patch proposal 只生成私有 diff，不直接落盘；真实修改仍由主 Agent重新校验并执行。

### 10.3 Skill 系统

Skill 对外兼容标准 `SKILL.md` 目录，但内部发现、选择、读取、信任和执行由 HammerCode 自行实现。

- 常驻目录只包含有界名称/description 元数据；
- 用户显式 `$skill-name` 优先；
- 未显式指定时，模型只能通过 `activate_skill` 选择最多一个；
- 正文、references 和脚本在激活后按需加载；
- `allowed-tools` 只展示声明，不注册工具、不授权；
- 项目 Skill 信任绑定每个文件内容 SHA-256 形成的全包指纹；
- 任意文件增加、删除、修改都会撤销信任；
- 脚本继续走正式工具、审批、工作区和沙箱边界。

### 10.4 模型连接

Agent core 只依赖 `ModelClient`。main process 根据每个 turn 固化的 modelRef 解析连接并创建 OpenAI-compatible 客户端。API key 只在 main process 解密和使用；公开配置只有 hasApiKey、脱敏 endpoint、模型与检测状态。

注意：截至本教程日期，代码仍保留 `connection:<id>` 自定义连接，而最新 `AGENTS.md` 的硬约束要求产品入口只保留固定 Fast/Strong 双槽。这是提交前必须解决的 P0 一致性问题，不能在面试中把二者同时说成“当前最终设计”。详见第 15 章。

## 11. 自动测试和真实在线测试

### 11.1 为什么测试是这个项目的核心证据

Coding agent 的难点主要在失败分支：流分片恰好断在 JSON 中间、用户在审批时取消、文件在 diff 后被外部编辑、重启遇到未完成 tool call、命令留下子进程。只演示一次成功路径无法证明这些语义。

### 11.2 当前测试地图

当前基线为 31 个测试文件、186 项测试。按主题可分为：

- Agent：`agent-runner.test.ts`、`state-machine.test.ts`、`plan.test.ts`、`context*.test.ts`；
- 模型：`model-client.test.ts`、`streaming.test.ts`、`runtime-identity.test.ts`；
- 工具安全：`tool-executor.test.ts`、`path-boundary.test.ts`、`policy.test.ts`、`command-runner.test.ts`；
- 恢复与审查：`session-store.test.ts`、`file-undo.test.ts`、`file-reviews.test.ts`；
- 产品能力：`side-chat.test.ts`、`project-memory-store.test.ts`、`skill-store.test.ts`、`subagent-coordinator.test.ts`；
- UI 纯逻辑：composer、diff、layout、memory presentation 等测试。

### 11.3 模拟模型怎样测试 Agent 循环

测试中的 `ScriptedModel` 或类似夹具按顺序返回预设 stream chunks。这样可以稳定制造：先 tool call 再 stop、无效分片、超时、资源不足、重复 call id 等场景。模型端口、审批器、时钟和 ID 生成器都可替换，所以测试不需要真实网络，也能验证状态和副作用。

### 11.4 离线与在线证据的区别

- 离线测试证明确定性状态和边界，快且可重复。
- 在线测试证明真实 provider、SSE、Electron UI、审批和本地工具能一起工作，但模型输出有非确定性。

`docs/ONLINE_TEST_REPORT.md` 记录了 Fast/Strong 的真实桌面闭环、连续 turn、重启、撤销、PDF/Python、上下文压缩、Skill 和子任务。不要把模拟测试说成真实模型通过，也不要把一次在线成功说成所有边界都已证明。

## 12. 面试高频问题与参考回答

### 12.1 “你的 Agent 为什么能连续工作？”

因为 AgentRunner 是显式循环：构建上下文，请求模型；若模型返回 tool calls，就在本地校验、授权和执行，把 tool result 加回历史，再发起下一轮；只有 stop 或明确预算/错误/取消条件才终止。不是一次 prompt 里让模型自己幻想完成。

### 12.2 “为什么不用 LangChain？”

题目明确禁止 agent 框架；更重要的是本项目要展示并控制核心语义，所以状态机、流组装、工具执行、审批、上下文和恢复都独立实现。使用 React、Zod 或 diff 只解决 UI、校验和基础设施，不替代 agent core。

### 12.3 “function calling 本身安全吗？”

不安全。它只是模型输出一种结构化建议。参数仍是不可信字符串，必须等分片组装完成后做 schema、路径、命令风险和权限校验。真正安全边界在本地执行器，不在模型 schema 描述。

### 12.4 “用户批准了 sudo 为什么还不执行？”

批准不应覆盖系统硬安全策略。用户可能误点，模型也可能诱导。提权、擦盘、关机、越界等不属于工作区普通开发权限，所以在审批前直接阻断。

### 12.5 “完全访问是不是很危险？”

它只免除工作区内普通副作用的逐次弹窗，不放宽路径真实边界、高风险阻断、远端命令审批、参数校验、超时、输出和取消。每次自动批准还会记录 `full_access` 授权来源。

### 12.6 “如何防止模型读取工作区外文件？”

所有文件工具只接收相对路径。先做词法解析拒绝绝对路径和 `..`，再对已存在目标 realpath；新文件则验证最近存在父目录的 realpath，阻断 symlink 逃逸。命令 cwd 也必须由同一边界解析。

### 12.7 “审批后文件被用户改了怎么办？”

Prepare 时保存 SHA-256 和 diff，execute 前重新读取。哈希不同就返回 STALE_WRITE，不落盘，要求模型重新读取并生成意图。删除还比较 inode、size 和 mtime。

### 12.8 “为什么不用 Git 来撤销？”

工作区可能不是 Git 仓库，也不能假设用户愿意让 Agent提交。当前撤销只覆盖本工具产生的文本副作用，使用 before/after 哈希和反向 diff，语义明确。代价是命令产生的变化和大/二进制文件不在撤销链。

### 12.9 “应用崩溃后会自动继续吗？”

不会。恢复会闭合未完成 tool call，并把活动状态标为 interrupted/failed；只有新的用户输入才能创建新 turn。这样不会在用户看不到的情况下重放副作用。

### 12.10 “如何取消一个正在运行的命令？”

用户停止触发 AgentRunner 的 AbortController，信号传到模型、审批和命令执行器。命令执行器终止整个进程组，先 SIGTERM 后 SIGKILL，并记录 cancelled/timeout、exit code、signal 和耗时。

### 12.11 “为什么需要 turn？”

同一聊天可以多次输入，但每次输入的模型、权限、预算和工具应当固定且可审计。Turn 把这些本轮事实封装起来，避免设置变化反向修改正在运行或已经发生的历史。

### 12.12 “上下文压缩会丢事实吗？”

有风险，所以完整历史仍持久化；模型摘要之外还附加本地确定性提取的目标、最新约束、文件哈希、验证结果、错误和 Plan。只有压缩成功才更新边界，失败或取消保留旧记忆。仍然不能声称零损失，只能说明如何降低并暴露风险。

### 12.13 “为什么 token 不是精确值？”

项目同时支持不同 provider，tokenizer 可能不同。选择保守字符估算保持实现独立且可测试，UI 明确把它当估算；服务端 length 仍有独立错误处理。

### 12.14 “模型失败为什么不自动换另一个模型？”

静默回退会改变成本、能力和行为，使审计失真。每个 turn 固化实际模型；失败明确告诉用户，由用户决定下一轮是否换档。

### 12.15 “为什么 Electron？”

题目允许语言不限，Electron + TypeScript 能用一套语言覆盖 macOS UI、IPC、网络、文件、进程和测试，适合快速做出透明审批界面。代价是包体和内存较大，正式发行还需签名、公证和 App Sandbox。

### 12.16 “为什么 core 不依赖 renderer？”

Agent 状态机应能在无 UI 的自动测试中运行，也不应由 React 状态决定安全。Core 通过 ModelClient、ToolExecutorPort、ApprovalGateway、Clock 等端口接收依赖，main process 负责组装，renderer 只展示快照。

### 12.17 “Zod 和 TypeScript 有什么区别？”

TypeScript 类型在编译后消失，只约束源码。Zod 在运行时真正检查模型 JSON、IPC 参数和持久化文件。二者分别覆盖静态错误和边界输入。

### 12.18 “SSE 中途断了会怎样？”

如果没有看到 `[DONE]`，客户端返回可恢复的 stream interrupted；Runner 只对允许的临时错误有界重试，并且不会提交半截 assistant/tool call。已经执行过的本地副作用不会因为模型重试而重复。

### 12.19 “项目最强的部分是什么？”

建议回答：不是某个 UI 功能，而是副作用的完整语义——模型提案、参数校验、路径与命令策略、授权来源、过期复查、结构化结果、取消、持久化和恢复不重放由同一条链闭合，并有失败分支测试和真实桌面证据。

### 12.20 “项目目前最明显的不足是什么？”

诚实回答：当前正式目标只覆盖 Apple Silicon macOS，包未签名；Shell 风险分类只能通过小白名单和审批降低风险，不能证明任意命令安全；撤销仅覆盖 1 MB 内 UTF-8 文件工具变更；token 是估算；单时刻只有一个主任务；此外提交前仍需解决自定义连接实现与最新固定双槽约束的 P0 一致性。

## 13. 介绍与演示话术

### 13.1 30 秒介绍

> HammerCode 是我用 Electron 和 TypeScript 独立实现的本地编程智能体。模型通过 OpenAI-compatible SSE 返回文本、思考和工具调用，但它没有直接系统权限；所有工具参数先在 main process 经过运行时校验、工作区真实路径检查、命令风险分类和权限判断。文件修改先展示 diff，审批后还会用哈希防止覆盖外部编辑。AgentRunner 把工具结果回传模型继续推理，并对完成、预算、错误、取消和重启恢复分别处理。我的重点是一个透明、可解释、不会重放历史副作用的 Agent 闭环。

### 13.2 90 秒设计介绍

> 我把系统分成 renderer、preload、main 和与 UI 解耦的 agent core。renderer 关闭 Node integration，只展示安全快照；preload 暴露固定 IPC；main 独占模型、凭据、文件和进程。一次任务进入 AgentRunner 后，先按预算构建上下文，再请求 OpenAI-compatible SSE。StreamAssembler 把分片文本、reasoning 和 tool calls 按索引组装。模型工具参数被视为不可信 JSON：只读工具可自动执行，写入和命令先生成 diff 或完整意图，再按请求批准/完全访问授权；路径逃逸、sudo 和擦盘等在审批前直接阻断。执行结果无论成功、拒绝还是失败都会作为 tool message 回传模型。每个用户输入形成独立 turn，固定模型、权限、Plan 和预算；重启只闭合未完成调用，不自动续跑。文本变更记录 before/after hash，可通过反向 diff 二次审批撤销。离线测试覆盖失败和取消分支，真实 Fast/Strong 则通过正式桌面链路验收。

### 13.3 两分钟视频脚本

建议准备一个很小的失败测试夹具，提前确认没有密钥和隐私文件。

0–15 秒：显示 HammerCode 与已选工作区，口述“一条聊天绑定一个目录，renderer 没有直接文件或 Shell 权限”。

15–35 秒：输入“阅读代码，定位失败测试，做最小修复并验证”。展示 Plan 和只读工具自动执行。

35–65 秒：模型提出 `edit_file`，展开 diff；批准后强调“审批后还会复查文件哈希”。

65–90 秒：展示本地测试命令、cwd、退出码和通过结果。若命令是白名单本地验证，可说明为何无需弹窗；不要为了视频故意执行危险命令。

90–110 秒：展示完成总结、工具授权来源和累计 diff。

110–120 秒：收尾口述“模型只提案，本地边界负责校验、授权、执行和恢复；历史工具不会在继续聊天或重启时重放”。

## 14. 在新聊天中逐课学习

把本文件附到新聊天，然后发送下面的总提示：

> 你是我的 HammerCode 面试教练。请严格依据 `docs/INTERVIEW_TUTORIAL.md` 和仓库当前源码教学，不假设我会 TypeScript。每次只教一课：先给概念地图，再带我打开相关源码，解释关键代码，最后用 5 个问题口试；我回答后逐条纠正，再决定是否进入下一课。不要一次把全部答案倾倒给我，也不要修改代码。

### 第 1 课：运行环境与 TypeScript

目标：能解释 npm、Node、TypeScript、React、Electron、Vite 的关系。

源码：`package.json`、三份 tsconfig、`vite.config.mts`。

必须回答：`npm run dev` 每一步做什么？为什么 TS 类型不能替代 Zod？

### 第 2 课：Electron 安全边界

目标：能画出 main/preload/renderer。

源码：`src/main/main.ts`、`src/preload/index.ts`、`src/shared/contracts.ts` 的 HammerCodeApi。

必须回答：renderer 为什么不能直接读文件？preload 为什么不是任意代理？

### 第 3 课：数据模型与状态机

目标：理解 Session、Turn、Message、ToolTrace、StateTransition。

源码：`src/shared/contracts.ts`、`src/core/state-machine.ts`。

必须回答：completed 后如何继续？为什么不复活旧 turn？

### 第 4 课：AgentRunner 主循环

目标：能从 `start()` 讲到 `terminate()`。

源码：`src/core/agent-runner.ts`。

必须回答：tool call 成功/拒绝/失败怎样回到模型？哪些条件结束循环？

### 第 5 课：模型 SSE 与 tool call

目标：理解 HTTP、SSE、AsyncIterable、分片组装和 provider profile。

源码：`src/core/model/`。

必须回答：为什么不能逐片 JSON.parse arguments？为什么 AgentRunner 没有厂商 if/else？

### 第 6 课：工具、工作区和审批

目标：能解释从 schema 到 prepare/execute 的四层防线。

源码：`tool-definitions.ts`、`tool-executor.ts`、`path-boundary.ts`、`command-policy.ts`。

必须回答：新文件的 symlink 逃逸怎么防？审批后外部修改怎么防？

### 第 7 课：命令、取消与错误

目标：理解 auto/permission_mode/always/blocked、进程组、输出上限和终止分类。

源码：`command-runner.ts`、AgentRunner 的 retry/termination 方法。

必须回答：为什么 full_access 仍可能弹窗？为什么只杀 Shell 不够？

### 第 8 课：上下文、持久化和撤销

目标：理解压缩预算、协议组、重启不重放、反向 diff。

源码：`context.ts`、`context-compactor.ts`、`session-store.ts`、`file-undo.ts`。

必须回答：压缩后完整历史去哪了？崩溃在撤销中如何判断实际状态？

### 第 9 课：高级系统

目标：能区分项目记忆、聊天记忆、BTW、Skill、受限子 Agent。

源码：对应 store/coordinator/side-chat 文件。

必须回答：这些能力分别跨不跨聊天、能不能执行工具、信任来源是什么？

### 第 10 课：测试与模拟答辩

目标：把设计讲成一条证据链，而不是功能清单。

材料：`tests/`、`docs/ONLINE_TEST_REPORT.md`、第 12 章问答。

练习：完成 30 秒介绍、90 秒介绍、一次 20 问压力面试和一次失败场景白板推演。

## 15. 最终提交前的收敛审计

本节非常重要：只讲当前真实状态，不把计划当完成事实。

### 15.1 P0：固定双槽与自定义连接冲突

最新 `AGENTS.md` 规定产品模型入口只保留固定 Fast/Strong 双槽，不得重新引入任意已保存连接列表；当前 `ModelRef`、`ModelCredentialStore`、Controller 和设置 UI 仍支持 `connection:<id>`。

最终提交前必须选择与硬约束一致的处理：移除产品中的自定义连接入口并保留必要兼容迁移，同时更新测试和文档。不能仅在 README 隐藏功能，也不能在没有授权依据时弱化 `AGENTS.md` 硬约束。本轮只记录问题，没有实施该代码收敛。

### 15.2 必须完成的提交检查

- `README.md` 的功能、模型、测试数字与当前代码一致；
- `README.txt` 不超过 1000 汉字/字符的保守限制，含正确仓库地址和运行命令；
- 录制 2 分钟以内、MP4、不超过 200 MB 的视频；
- 视频与文档不出现 `.env`、API key、用户数据目录中的密文或私密路径；
- `npm run typecheck`、`npm test`、`npm run build`、`npm run package:mac` 通过；
- `npm audit --omit=dev` 复核生产依赖；
- `git status`、`git diff --cached` 和 tracked files 中无 `.env`、缓存、release、日志；
- 公开仓库保留完整历史，截止时间后不再 push；
- 最终 zip 只包含 `README.txt` 和 MP4，并以本人姓名命名。

### 15.3 面试前必须重新核对的动态事实

不要死背会变化的数字。现场前从仓库核对：

- 当前 commit hash 与公开远端是否一致；
- 测试文件数和测试项数；
- Fast/Strong 最终模型名与 provider 配置；
- P0 连接冲突是否已经解决；
- `.app` 是否仍为未签名目录包；
- 视频中的工作区、命令和结果是否与最终代码一致。

## 16. 术语表

| 术语 | 本项目含义 |
| --- | --- |
| Agent | 模型请求、工具执行、结果回传和终止判断组成的循环系统，不只是一次聊天 |
| Tool calling | 模型输出结构化函数名和 JSON 参数；不等于已经执行 |
| SSE | 服务端按事件持续推送数据的 HTTP 流格式 |
| Runtime validation | 程序运行时检查外部数据，项目使用 Zod |
| IPC | Electron renderer/preload/main 之间的进程通信 |
| Dependency injection | AgentRunner 从构造参数接收模型、工具、审批等端口，便于替换和测试 |
| AbortController | 传播取消信号的标准机制 |
| TOCTOU | 检查时与使用时之间状态变化；项目通过审批后复查哈希/指纹降低风险 |
| Atomic rename | 先写临时文件，再一次 rename 替换目标，减少半写状态 |
| Tool trace | 一次工具从提案、审批到结果的审计记录 |
| Context window | 单次模型请求能容纳的输入/输出 token 范围 |
| Chat memory | 单聊天历史的压缩摘要 |
| Project memory | 同工作区跨聊天共享的有来源记录 |
| Skill | 可迁移的低优先级操作流程，不是权限或新工具 |

## 17. 最终自测清单

在面试前，不看文档完成下面练习：

1. 画出 renderer → preload → main → AgentRunner → model/tools 的图。
2. 用 90 秒讲完一次任务从发送到完成。
3. 解释 tool calling 为什么仍是不可信输入。
4. 说出路径安全的词法、realpath、新文件父目录三层检查。
5. 说出 ask/full_access/always/blocked 的差别。
6. 解释审批后哈希复查和原子写入分别解决什么问题。
7. 解释应用崩溃后为什么不自动续跑。
8. 区分 session、turn、chat memory、project memory、BTW 和 Skill。
9. 说明离线测试与真实在线测试分别证明什么。
10. 主动说出至少四个真实限制，以及 P0 连接一致性问题的当前状态。

如果这十项中有任何一项只能背句子、不能指到源码，就回到第 14 章对应课程继续学习。
