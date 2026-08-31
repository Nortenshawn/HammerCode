HammerCode 编程智能体项目说明

Git 仓库：https://github.com/Nortenshawn/HammerCode

一、如何运行
环境：Apple Silicon macOS、Node.js 22+、npm。克隆仓库后执行：
1. npm ci
2. cp .env.example .env
3. 使用内置档位时在 .env 填写对应 key；也可启动后添加自定义连接
4. npm run dev
.env 已被 Git 忽略，不得提交或公开。检查：npm run typecheck、npm test、npm run build；打包：npm run package:mac。PDF/Python 工具需 pdftotext/Python 3。

二、特色功能
HammerCode 使用 Electron + TypeScript 独立实现，没有封装现成 agent 产品或使用 agent 框架。核心包含 SSE 流解析、分片 tool call 组装、上下文压缩、状态机、Plan、工具执行和错误处理。Fast/Strong 是本调试版默认选择；用户可保存自定义名称、endpoint、key 和模型 ID 的 OpenAI-compatible 连接。每个 turn 固化实际连接和权限，不静默回退。

模型只能提出工具调用，不能直接操作系统。执行前校验不可信 JSON、工作区真实路径和命令风险；只读工具可自动执行，文件 diff 和普通命令按“请求批准/完全访问”授权，越界、提权、擦盘等操作直接阻断。命令支持超时、输出截断、取消和进程组清理。

不同项目最多 3 个主任务并行，同项目保持单任务；聊天可连续追问且不重放旧副作用。会话、工具、授权、预算与终止原因可恢复。文本修改提供累计 diff、哈希过期检查和二次审批撤销。renderer 关闭 Node integration，只通过最小 preload IPC 通信；API key 仅在 main process 使用并由 safeStorage 加密保存。

三、说明
当前支持 Apple Silicon macOS 本地运行，目录包未签名；自动撤销仅覆盖不超过 1 MB 的 UTF-8 文本工具变更。设计与验证证据见 README.md 和 docs/。
