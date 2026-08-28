# HammerCode 持续开发计划

最后更新：2026-08-28

## 文件职责

本文件是 HammerCode 当前范围、优先级、执行顺序和验收出口的唯一动态来源。`AGENTS.md` 维护长期安全与工程底线，`DEVELOPMENT_STATUS.md` 记录已经完成的历史，`ONLINE_TEST_REPORT.md` 保存真实模型验收证据。

计划调整时应直接修改本文件，不再把阶段性“不实现”写成永久项目约束。每项进入开发前必须明确用户价值、架构影响、风险、离线测试和在线验收方式；完成后附上提交与验证证据。

## 当前阶段：Phase 3 · 真实在线闭环与可靠性

状态：已完成（2026-08-28）

目标：让 HammerCode 的主要能力不仅通过模拟模型测试，还能在正式 Electron UI、真实 DeepSeek API 和真实本地副作用下稳定完成。

执行顺序：

1. 固化 `/Users/norten/Developer/HammerTest` 在线测试沙箱和凭据加载边界。
2. 从空目录启动任务，让模型自行读取事实、创建最小项目并运行验证命令。
3. 在同一聊天追加纠正，确认旧 tool call 不重放、累计 diff 正确。
4. 重启应用并恢复聊天，确认不会自动续跑任何副作用。
5. 通过反向 diff 审批撤销最后一次文件修改，核对磁盘结果和持久化状态。
6. 将发现的问题修复后，重新执行离线检查和关键在线场景。

退出标准：

- 真实模型至少完成一次只读工具、文件写入和命令执行闭环。
- 连续追问、重启恢复、累计 diff 与安全撤销均有可复核证据。
- 错误中不出现凭据，在线失败能区分模型、网络、工具和审批阶段。
- `npm run typecheck`、`npm test`、`npm run build` 和 Apple Silicon 打包全部通过。

完成证据：真实 `deepseek-v4-flash` 在 HammerTest 完成 4 个连续 turn、12 条工具轨迹、2 次命令验证、1 次审批拒绝、1 次路径越界阻断、1 次重启恢复和 1 次反向 diff 撤销；详见 `docs/ONLINE_TEST_REPORT.md`。离线构建证据在本阶段提交前复验。

## 当前阶段：Phase 4 · 双模型、权限模式与多工作区

状态：功能实现完成，在线验收部分完成（2026-08-28）。Fast、权限模式与多工作区已通过真实桌面闭环；Strong 因本机未配置 `GLM_API_KEY`，保留为明确待补测项，不做隐式回退。

用户价值：

- `fast` 使用 `deepseek-v4-flash`，承担低延迟日常任务；`strong` 使用 `glm-5.3-flash`，承担复杂任务。模型由用户显式选择，不做隐式路由或失败回退。
- `请求批准` 保持逐项确认；`完全访问` 让受信任工作区中的连续开发无需反复点击，同时不削弱目录边界和高风险命令禁令。
- 侧栏可以维护多个本地项目，每个文件夹下拥有独立聊天集合；单条聊天仍严格绑定一个工作区。

架构与迁移：

1. 把单模型配置升级为 `fast` / `strong` 两份 provider 配置；agent core 继续只依赖 `ModelClient`，main process 在每轮开始前创建选定客户端。
2. DeepSeek 与 GLM 复用同一 OpenAI-compatible SSE 和 tool call 组装器，由 provider profile 生成合法请求字段。GLM 开启 `tool_stream`，且 `thinking.type` 固定为 `enabled`。
3. 增加 `ModelTier = "fast" | "strong"` 与 `PermissionMode = "ask" | "full_access"`。聊天保存下一轮偏好，每个 turn 保存本轮快照；运行中禁止修改。
4. 工具轨迹增加授权来源，明确区分 `not_required`、`user_approved`、`user_rejected`、`full_access` 和 `safety_blocked`。完全访问只跳过审批网关，不跳过工具 prepare 阶段的路径和命令安全检查。
5. `session-index.json` 从单工作区 v1 迁移为多工作区 v2。索引记录当前项目、每个项目的聊天 ID、活动聊天和最近使用时间；聊天文件仍按 ID 独立保存。
6. 旧索引、旧聊天、旧 turn 和旧工具轨迹必须无损迁移：缺失模型档位默认为 `fast`，缺失权限模式默认为 `ask`，旧审批轨迹按现有状态推导授权来源。
7. renderer 只通过带类型 IPC 选择项目、聊天、模型和权限。真实凭据仍只存在于 main process；缺少某一档凭据时只禁用该档并给出明确配置提示。

风险控制：

- 不允许在模型失败时静默换档；错误必须指明所选档位与失败阶段。
- 不允许一条聊天跨工作区访问，也不允许通过多工作区索引扩大本轮工具根目录。
- `full_access` 不能批准 `sudo`、磁盘擦除、关机等高风险命令，也不能批准路径穿越、绝对路径或 symlink 逃逸。
- 首次切换完全访问必须显示一次警告；正在运行、等待审批或撤销时，模型与权限选择器均锁定。
- 撤销继续使用可见反向 diff 和独立确认，不因聊天处于完全访问而自动执行。

离线测试：

- 两个 provider 的请求体、SSE 文本、思考内容、分片 tool call、`[DONE]`、HTTP 错误和取消。
- 每轮模型/权限快照、旧数据默认迁移、运行中不可切换、缺少 strong 凭据时不回退。
- `ask` 的批准/拒绝，`full_access` 的自动批准，以及两种模式下相同的高风险与路径阻断。
- 多工作区 v1 → v2 迁移、空项目、项目切换、每项目活动聊天、删除聊天和重启恢复。
- renderer 的项目导航、模型/权限选择器、首次警告和工具授权标签。

在线退出标准：

- 在 `/Users/norten/Developer/HammerTest` 使用真实 DeepSeek 完成 `fast + ask` 与 `fast + full_access` 的读、写、命令和安全阻断闭环。
- 在同一沙箱使用真实 GLM-5.3-Flash 完成 `strong` 的流式思考、分片工具调用、文件修改和命令验证；若本地未配置 GLM 凭据，必须记录为明确阻塞，不能用模拟测试冒充通过。
- 添加第二个临时工作区，证明项目与聊天可以切换、重启后恢复，且工具不能跨项目访问。
- 工具轨迹可见地区分用户批准、用户拒绝、完全访问自动批准和安全策略阻断。
- `npm run typecheck`、`npm test`、`npm run build` 和 Apple Silicon 打包全部通过。

当前证据：共享 OpenAI-compatible 客户端、双模型配置、逐 turn 模型/权限快照、授权来源审计和多工作区 v2 索引均已落地；12 个测试文件共 55 项离线测试通过，类型检查、生产构建和未签名 Apple Silicon 目录包均构建成功。真实 `deepseek-v4-flash` 已分别完成 `fast + ask` 与 `fast + full_access` 闭环，完全访问下普通写入/命令自动批准且 `sudo` 仍被直接阻断；三个工作区和两条聊天经重启恢复后未重放副作用。Strong 请求结构已经官方协议对照与离线测试覆盖，但真实 GLM 验收仍等待本地安全配置 `GLM_API_KEY`。详见 `docs/ONLINE_TEST_REPORT.md`。

## 后续能力池

以下方向不再被永久排除，但尚未排期：

- 显式任务计划、进度检查点与可编辑 plan UI。
- 多 agent 或子任务编排，以及它们的权限继承、预算和失败隔离。
- MCP、插件与技能系统，包括供应链、授权和本地执行边界。
- 直接服务 agent 闭环的代码浏览、诊断和轻量 IDE 能力。
- macOS 签名、公证与 App Sandbox；根据实际需求评估 Windows/Linux。
- Responses API 或厂商原生协议适配，但不得削弱现有本地工具与审批边界。

任何能力从“能力池”进入实施前，都必须拆成独立阶段，补齐威胁模型、兼容策略、自动测试和在线退出标准。
