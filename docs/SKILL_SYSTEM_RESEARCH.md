# HammerCode Skill 系统调研与设计边界

最后核对：2026-08-30

## 外部格式事实

Agent Skills 是开放的目录格式。标准包至少包含一个带 YAML frontmatter 的 `SKILL.md`，其中 `name` 和 `description` 为必需字段；`license`、`compatibility`、`metadata` 与实验性的 `allowed-tools` 为可选字段，`scripts/`、`references/` 和 `assets/` 是可选资源目录。官方说明把加载过程分为目录、正文和按需资源三层。来源：[Agent Skills 规范](https://agentskills.io/specification)、[Agent Skills 客户端实现指南](https://agentskills.io/client-implementation/adding-skills-support)。

OpenAI 的官方说明同样采用渐进加载：初始目录只含名称、描述和路径，最多占上下文窗口的 2%，上下文未知时上限为 8,000 字符；选择后再读取完整正文。Codex 可通过 `$skill-name` 或 `/skills` 显式选择，也可以由模型根据 `description` 隐式选择；仓库级 Skill 使用 `.agents/skills/`。可选的 `agents/openai.yaml` 能声明展示信息、依赖及 `allow_implicit_invocation: false`，此时仍允许显式选择。来源：[OpenAI Build skills](https://developers.openai.com/codex/skills)。

这些事实只决定 HammerCode 的可迁移文件形状与用户交互，不授权复用任何现成 Agent 的内部实现。

## HammerCode 自主设计

HammerCode 自行实现发现、触发、上下文注入、权限、执行和审计，不依赖 Agent SDK 或现成 Skill runtime：

- 应用启动与设置页只读取有界的 frontmatter 和目录元数据；显式指定或 `activate_skill` 成功后才读取完整 `SKILL.md`，reference、文本 asset 和脚本继续由正式工具按需加载。
- 显式 `$skill-name` 优先并直接激活，显式一轮最多两个。未显式指定时，runner 向模型提供最多 8,000 字符的 JSON-lines 元数据目录，并只暴露 `activate_skill`；模型明确选择后才加入正文和资源工具。HammerCode 不再用字符串命中、关键词评分或本地分类器冒充“模型选择”。`/skills` 只打开本地列表，不安装网络内容。
- 内置、用户和项目三层来源独立。项目来源固定为当前工作区 `.agents/skills/`，默认禁用且未信任，不跨项目共享。
- 项目来源的信任不绑定声明版本、大小或 mtime。扫描会对每个普通文件内容计算 SHA-256，再以相对路径和内容哈希形成完整包指纹；文件增加、删除或任意字节变化后自动禁用并撤销信任，必须重新确认。
- 标准 `license`、`compatibility` 和可识别的 `agents/openai.yaml` 进入公开清单。格式有效但含 JavaScript/其他非 Python 脚本、额外依赖或未接入外部工具的包仍可导入导出，并显示“部分不兼容”；这些脚本不会进入可运行清单。
- `allowed-tools` 只作为外部格式声明展示，不能注册工具或授权执行。真实授权来源只可能是只读自动执行、用户批准、用户拒绝、完全访问自动批准或安全策略阻断。
- 每轮固化 Skill ID、版本、来源、包指纹和触发原因。Skill 默认仅对当前 turn 生效；包在运行中变化时拒绝继续读取，更新只影响下一轮。
- 历史只持久化 Skill 审计与上下文成本，不持久化成新的权限，也不在恢复时重新读取或重放工具。

## 安全收敛

导入先在临时目录完整校验，再原子移动到用户目录；导出同样先写临时目录并复核。目录穿越、绝对路径、隐藏文件、目录级或文件级符号链接、重复 ID、缺失入口、大小预算、提示注入和凭据诱导会在加载或执行前阻断。二进制 asset 可以随标准包迁移，但不会注入模型上下文或作为脚本执行。仓库中保留一个开放 Agent Skills 兼容夹具，覆盖 `license`、`compatibility`、`agents/openai.yaml`、reference、asset 和不可执行 JavaScript helper 的无损迁移。

首版脚本只接受包内已发现的 Python 文本脚本。脚本必须通过静态依赖与高风险检查，参数不能携带路径、网络地址或凭据标记；运行时使用现有 `PreparedToolCall` 审批链、工作区 cwd 校验、超时、取消和输出上限，并在 macOS 沙箱中移除凭据环境、禁止网络和写入、禁止读取工作区。`ask` 需要逐次批准，`full_access` 只能自动批准通过上述检查的普通脚本，不能覆盖直接阻断。

首版不实现 Skill 市场、联网安装、自动更新、依赖下载、远程 Skill、自我修改或递归 Skill 调用。
