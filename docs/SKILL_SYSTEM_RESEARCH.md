# HammerCode Skill 系统调研与设计边界

最后核对：2026-08-30

## 外部格式事实

Agent Skills 是开放的目录格式。标准包至少包含一个带 YAML frontmatter 的 `SKILL.md`，其中 `name` 和 `description` 为必需字段；`scripts/`、`references/` 和 `assets/` 是可选资源目录。官方说明把加载过程分为发现、激活和执行三层：发现阶段只读取名称与描述，命中后才读取完整 `SKILL.md`，其他资料与脚本继续按需加载。来源：[Agent Skills 规范](https://agentskills.io/specification)、[Agent Skills 官方仓库](https://github.com/agentskills/agentskills)。

OpenAI 的官方说明同样采用渐进加载，并明确 Codex 可以通过 `$skill-name` 或 `/skills` 显式选择，也可以根据 `description` 隐式匹配；仓库级 Skill 使用 `.agents/skills/`。来源：[OpenAI Build skills](https://developers.openai.com/codex/skills)。

这些事实只决定 HammerCode 的可迁移文件形状与用户交互，不授权复用任何现成 Agent 的内部实现。

## HammerCode 自主设计

HammerCode 自行实现发现、触发、上下文注入、权限、执行和审计，不依赖 Agent SDK 或现成 Skill runtime：

- 应用启动与设置页只读取有界的 frontmatter 和目录元数据；每轮命中后才读取完整 `SKILL.md`，reference、文本 asset 和脚本继续由正式工具按需加载。
- 显式 `$skill-name` 优先于自动匹配；显式一轮最多两个，自动匹配最多一个。`/skills` 只打开本地列表，不安装网络内容。
- 内置、用户和项目三层来源独立。项目来源固定为当前工作区 `.agents/skills/`，默认禁用且未信任，不跨项目共享。
- `allowed-tools` 只作为外部格式声明展示，不能注册工具或授权执行。真实授权来源只可能是只读自动执行、用户批准、用户拒绝、完全访问自动批准或安全策略阻断。
- 每轮固化 Skill ID、版本、来源、包指纹和触发原因。包在运行中变化时拒绝继续读取，更新只影响下一轮。
- 历史只持久化 Skill 审计与上下文成本，不持久化成新的权限，也不在恢复时重新读取或重放工具。

## 安全收敛

导入先在临时目录完整校验，再原子移动到用户目录；导出同样先写临时目录并复核。目录穿越、绝对路径、隐藏文件、符号链接、重复 ID、缺失入口、大小预算、提示注入和凭据诱导会在加载或执行前阻断。二进制 asset 可以随标准包迁移，但不会注入模型上下文或作为脚本执行。

首版脚本只接受包内已发现的 Python 文本脚本。脚本必须通过静态依赖与高风险检查，参数不能携带路径、网络地址或凭据标记；运行时使用现有 `PreparedToolCall` 审批链、工作区 cwd 校验、超时、取消和输出上限，并在 macOS 沙箱中移除凭据环境、禁止网络和写入、禁止读取工作区。`ask` 需要逐次批准，`full_access` 只能自动批准通过上述检查的普通脚本，不能覆盖直接阻断。

首版不实现 Skill 市场、联网安装、自动更新、依赖下载、远程 Skill、自我修改或递归 Skill 调用。
