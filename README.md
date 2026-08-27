# HammerCode

> **Forge ideas into working software.**

HammerCode 是南京大学软件学院预推免“构建编程智能体”项目考核作品：一个面向 Apple Silicon macOS 的本地、透明、可审批的编程智能体。

它不是现成 agent 产品的套壳，也没有使用 agent 框架。对话循环、流式 tool call 组装、上下文预算、工具校验、审批策略、工作区隔离、命令生命周期和终止条件都在本仓库中独立实现。

## 已实现能力

- DeepSeek V4 Flash 的 OpenAI-compatible Chat Completions 流式接入，支持思考内容、文本和分片 tool calls。
- 显式会话状态机：`idle`、`requesting`、`awaiting_approval`、`executing_tool`、`completed`、`cancelled`、`failed`。
- 本地只读工具：列目录、读文件、固定字符串搜索。
- 本地副作用工具：写文件、删文件、运行命令；全部先展示完整意图或 diff，再等待用户审批。
- 真实路径和符号链接边界检查，阻断 `..`、绝对路径、越界 symlink、提权与明显破坏性命令。
- 命令超时、输出截断、用户取消和进程组清理。
- 保守的上下文预算和本地历史压缩；摘要会明确标注为程序生成，不伪装成新事实。
- 单工作区多聊天历史：每条聊天独立原子持久化，可切换查看；重启后不重放等待审批或正在执行的副作用。
- 完成前实时展示思考与工具链，完成后自动折叠过程，并使用 Markdown 渲染最终答复。
- Electron 安全隔离：renderer 关闭 Node integration，通过 context-isolated preload 暴露最小 IPC。

## 本地运行

要求：Apple Silicon Mac、Node.js 22 或更新版本、npm。

```bash
npm install
cp .env.example .env
# 只在本地 .env 中填写 DEEPSEEK_API_KEY；不要提交该文件
npm run dev
```

`.env.example` 列出了全部可配置项。默认模型为 `deepseek-v4-flash`，默认 endpoint 为 `https://api.deepseek.com`。真实 `.env` 已被 Git 忽略，应用只在 Electron main process 中加载凭据。

开发模式读取仓库根目录的 `.env`。打包后的 `.app` 不会携带或复制真实凭据；双击运行时可把同样的 `.env` 放在 `~/Library/Application Support/HammerCode/.env`，也可以从已设置环境变量的终端启动应用。

为兼容已有 OpenAI-compatible 配置，main process 也接受 `OPENAI_API_KEY` / `API_KEY`、`DEEPSEEK_BASE_URL` / `BASE_URL` 和 `DEEPSEEK_MODEL` / `MODEL` 作为回退别名；新配置仍推荐使用模板中的明确前缀变量。

## 质量检查

```bash
npm run typecheck
npm test
npm run build
```

生成 Apple Silicon `.app` 目录：

```bash
npm run package:mac
```

## 使用流程

1. 在左侧选择一个工作区。一个会话只绑定这一个目录。
2. 输入开发目标。agent 会先通过只读工具了解代码库。
3. 文件变更会显示 patch，命令会显示完整命令和 cwd。批准后才执行；拒绝不会产生副作用。
4. 可随时停止模型请求、审批等待或命令执行。
5. 左侧按当前工作区列出独立聊天；对话内实时展示思考和工具链，结束后自动折叠并呈现 Markdown 总结。

## 目录结构

```text
src/
  core/       与 Electron 无关的 agent core、模型流、上下文、安全和工具
  main/       模型访问、会话持久化、审批与 Electron 生命周期
  preload/    最小、带类型的 IPC 桥
  renderer/   中文桌面界面
  shared/     main/preload/renderer 共用的安全数据契约
tests/        核心单元与端到端模拟测试
```

更详细的边界、数据流和安全决策见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，演示检查单见 [docs/DEMO.md](docs/DEMO.md)。

## 基础设施依赖说明

- Electron、React：桌面运行时和展示层，不参与 agent 决策。
- react-markdown、remark-gfm：安全渲染模型最终答复的 Markdown/GFM，不执行原始 HTML，也不参与 agent 逻辑。
- Zod：校验模型参数、IPC 和持久化数据等不可信输入。
- `diff`：为写文件审批生成统一 diff。
- dotenv：仅由 main process 加载未入库的本地配置。
- TypeScript、Vite、Vitest、electron-builder：类型、构建、测试和 macOS 打包工具。

项目没有引入 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 或其他 agent 框架。
