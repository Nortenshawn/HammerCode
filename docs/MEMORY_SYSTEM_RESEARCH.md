# 编程 Agent 记忆系统调研

调研日期：2026-08-29

本文只记录官方资料能够支持的产品事实，并将 HammerCode 的设计选择单独列出。第三方逆向实现可用于理解鲁棒性问题，但不作为产品行为证据。

## Codex

OpenAI 官方文档说明，本地 Codex 客户端使用独立的本地记忆存储。记忆默认关闭；全局启用后，单个聊天还可以分别控制是否读取既有记忆、是否把本聊天作为未来记忆的输入。记忆抽取在聊天空闲后于后台进行，会跳过活动或短生命周期会话，并可在剩余限额过低时跳过。主要生成状态位于 `~/.codex/memories/`，但必须长期生效的团队规则仍应放在 `AGENTS.md` 或版本控制文档中。

官方导入流程可以从 Claude Code 或 Cursor 导入设置、项目、近期聊天和项目记忆；它不删除现有配置。当前官方记忆页没有把一个通用、双向、版本稳定的“记忆导出格式”作为产品契约，因此不能把“可导入”直接等同于“完整可逆迁移”。

来源：

- [OpenAI：Memories](https://learn.chatgpt.com/docs/customization/memories)
- [OpenAI：Import from another agent](https://learn.chatgpt.com/docs/import)
- [OpenAI：Projects and chats](https://learn.chatgpt.com/docs/projects)

## Claude Code

Anthropic 官方文档把持久上下文分成用户维护的 `CLAUDE.md` 与模型维护的 auto memory。与 Codex 不同，Claude Code auto memory 当前默认开启，可由 `/memory`、项目设置或环境变量关闭。

Auto memory 以 Git 仓库为项目单位；同一仓库的 worktree 和子目录共享，同机不同仓库不共享，非 Git 目录使用项目根目录。每次会话启动只自动加载 `MEMORY.md` 的前 200 行或 25KB，详细主题文件按需读取。这说明“索引常驻、详情按需加载”比每轮注入全部记忆更稳健。其记忆是本机 Markdown 文件，可以人工查看、编辑、删除或复制，但官方文档没有描述独立的版本化导出/导入协议。

来源：

- [Anthropic：How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Anthropic：Explore the context window](https://code.claude.com/docs/en/context-window)

## 对 HammerCode 的结论

1. 跨聊天记忆应是可撤销的辅助层，不是安全规则或项目真相的唯一来源。
2. HammerCode 面向本地代码工作区，默认不跨项目共享。不同真实工作区路径拥有独立存储、开关、导出和冲突集合。
3. 新项目默认关闭记忆更符合显式授权与演示可解释性；读取与生成必须分开控制。
4. 当前 Phase 9 每轮最多注入 12 条、6000 字符，不会无限占满上下文，但默认常开且预算偏宽。Phase 10 收紧为 6 条、3000 字符，并记录实际注入开销。
5. HammerCode 提供自己的版本化 JSON 导入/导出，目标是可验证迁移，不声称兼容未公开的 Codex 或 Claude 内部文件格式。导入始终重绑定到当前项目，不允许借迁移跨越工作区权限边界。
