HammerCode
Git 公开仓库（完整历史）：https://github.com/Nortenshawn/HammerCode

一、如何运行
平台：Apple Silicon macOS，需 Node.js 22+、npm；PDF/Python 工具另需 pdftotext/Python 3。进入仓库后运行：
npm ci
cp .env.example .env
npm run dev
在未入库的 .env 填写模型 key。验证：npm run typecheck、npm test、npm run build；打包：npm run package:mac。凭据不得提交。

二、核心功能
HammerCode 是我用 Electron+TypeScript 独立实现的本地 coding agent，未封装现成产品、未使用 agent 框架/SDK。核心是“模型提出意图—本地校验—授权执行—结果回传—继续推理”：自研分片 tool call、上下文压缩、Plan、状态机、重试与终止。工具覆盖文件、搜索、PDF、Python、Shell、只读 Git；聊天绑定工作区，阻断路径穿越/symlink，修改先展示 diff、落盘前复查哈希。请求批准/完全访问、命令分层、取消恢复与旧工具不重放共同控制副作用。Fast=deepseek-v4-flash，Strong=glm-5.3，也支持自定义接口。

三、我的 AI 协作方式
我先把题目和安全边界写成机器可读的 AGENTS.md，再用 DEVELOPMENT_PLAN.md 拆分阶段、风险和验收标准，让规划、实现、审查、测试、实机验收由多 Agent/角色协作，证据写入 docs。遵循“需求—架构—实现—自动测试—模型/Electron 验证—复盘—提交”，不直接接受生成代码。我用截图/录屏反馈交互与竞态，要求 AI 查官方文档、解释取舍、复现失败，只在 HammerTest 沙箱验证副作用。我负责产品决策、安全边界和验收，能解释设计。

四、验证与提交
36 个测试文件、218 项测试通过。应用仅支持 Apple Silicon，未签名。只提交 README.txt 与 2 分钟内、200 MB 以下的 MP4，压缩为“姓名.zip”；不得包含凭据。截止 2026-09-02 24:00，之后不再推送。
