# HammerCode 真实在线测试报告

## HC-ONLINE-2026-08-28-01

- 时间：2026-08-28 12:05–12:10（Asia/Shanghai）
- 基线提交：`a2afbbd`
- 正式界面：Electron 生产构建页面，通过 main/preload/renderer 完整链路操作
- 模型：`deepseek-v4-flash`，真实 OpenAI-compatible 流式 API
- 工作区：`/Users/norten/Developer/HammerTest`
- 会话数据：独立临时 userData，测试中执行一次关闭与重启
- 凭据：仅由正式配置加载器读取；界面、终端和本报告均未展示或记录密钥值

## 场景与结果

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 空目录事实确认 | `list_files` 返回 0 个条目 | 通过 |
| 从零创建项目 | 经三次 diff 审批创建 `package.json`、`sum.js`、`sum.test.js` | 通过 |
| 真实命令验证 | 经审批在 HammerTest 执行 `npm test`，2/2 通过，exit code 0 | 通过 |
| 同聊天连续修改 | 第二 turn 读取两个文件、修改两个文件、再次运行测试，3/3 通过 | 通过 |
| 历史副作用不重放 | 第一 turn 始终为 5 条轨迹；第二 turn 只新增 5 条，`package.json` 未再次写入 | 通过 |
| 累计文件审查 | `sum.js` 与 `sum.test.js` 均显示 2 次生效修改，`package.json` 显示 1 次 | 通过 |
| 重启恢复 | 关闭并使用同一 userData 重启，恢复 2 个 completed turn，工具计数不变且未自动请求模型 | 通过 |
| 安全撤销 | 对 `sum.test.js` 第二次修改生成反向 diff 并审批，磁盘恢复为第一版测试 | 通过 |
| 撤销后验证 | `sum.js` 类型校验保留，`sum.test.js` 回到 2 个用例，`npm test` 2/2 通过 | 通过 |
| 审批拒绝 | 第三 turn 拒绝创建 `rejected.txt`，模型未重试，磁盘确认文件不存在 | 通过 |
| 路径越界阻断 | 第四 turn 尝试读取 `../HammerCode/AGENTS.md`，执行前返回 `PATH_TRAVERSAL_BLOCKED` | 通过 |

## 持久化审计

最终会话持久化结果：

- 4 个 turn，全部 `completed/completed`。
- 12 条工具轨迹：10 条 succeeded、1 条 rejected、1 条 blocked。
- rejected 轨迹错误码为 `APPROVAL_REJECTED`。
- blocked 轨迹错误码为 `PATH_TRAVERSAL_BLOCKED`。
- 5 条文件变更记录：4 条 applied、1 条 reverted。
- `pendingApproval` 与 `pendingUndo` 均为空。

工具轨迹按 turn 分布：

1. 第一 turn：`list_files` ×1、`write_file` ×3、`run_command` ×1。
2. 第二 turn：`read_file` ×2、`write_file` ×2、`run_command` ×1。
3. 第三 turn：`write_file` ×1，用户拒绝。
4. 第四 turn：`read_file` ×1，路径边界阻断。

## 最终测试产物

HammerTest 保留以下文件供人工复核：

- `package.json`：无外部依赖，`npm test` 使用 `node --test`。
- `sum.js`：包含 number 参数类型校验和 `TypeError`。
- `sum.test.js`：撤销后保留正常加法与负数两个用例。

最终磁盘状态再次执行 `npm test`：2 passed、0 failed。`rejected.txt` 不存在，HammerCode 仓库内容未被越界读取。

## 结论

本轮没有发现需要修改产品代码的在线缺陷。真实模型的流式输出、分片 tool call、逐项审批、命令执行、连续上下文、重启恢复、累计 diff、撤销、拒绝恢复和路径边界均与离线测试语义一致。在线结果具有模型非确定性，后续涉及这些链路的重大修改仍应重新执行本报告的关键场景，不得仅沿用本次结论。

## HC-ONLINE-2026-08-28-02

- 时间：2026-08-28 15:24–15:31（Asia/Shanghai）
- 基线提交：`a6a2aeb`
- 正式界面：Electron 生产构建页面，通过 main/preload/renderer 完整链路操作
- 模型：`fast = deepseek-v4-flash` 已真实调用；`strong = glm-5.3-flash` 因本机未配置 `GLM_API_KEY` 未执行真实调用
- 工作区：`/Users/norten/Developer/HammerTest/Phase4FastAsk`、`/Users/norten/Developer/HammerTest/Phase4FastFull`、`/Users/norten/Developer/HammerTest/Phase4MultiB`
- 会话数据：独立临时 userData `/tmp/hammercode-phase4-ui-clean`，测试中关闭并使用同一数据重启
- 凭据：仅检查必需变量是否存在；未读取、展示、复制或记录任何密钥值

## 场景与结果

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| `fast + ask` | 真实 DeepSeek 读取空目录；写入文件和运行验证命令分别弹出审批，批准后成功 | 通过 |
| `fast + full_access` | 真实 DeepSeek 自动批准工作区内写入和普通验证命令，过程中未出现审批弹窗 | 通过 |
| 完全访问硬阻断 | 模型按测试要求尝试 `sudo true`，prepare 阶段返回 `HIGH_RISK_COMMAND_BLOCKED`，命令未执行 | 通过 |
| 授权来源审计 | ask 轨迹为 `not_required/user_approved/user_approved`；full_access 轨迹为 `not_required/full_access/full_access/safety_blocked` | 通过 |
| Markdown 最终输出 | 两条聊天完成后过程区折叠，最终总结渲染标题、列表、表格和行内代码 | 通过 |
| 多工作区导航 | 侧栏同时显示三个项目，每个项目只展示自己的聊天；空项目显示“还没有聊天” | 通过 |
| 重启恢复 | 两条 completed 聊天、各自模型/权限快照、3/4 条工具轨迹和累计 diff 均恢复 | 通过 |
| 历史副作用不重放 | 重启前后两个测试文件的 SHA-256、修改时间和大小均不变，工具轨迹数不变 | 通过 |
| 未配置 Strong | Strong 选项标记为未配置且不可用于发送；应用没有静默回退到 Fast | 通过 |
| 真实 GLM 调用 | 本机正式配置加载器未检测到 `GLM_API_KEY`，未发送请求 | 阻塞，待补测 |

## 持久化与副作用审计

- `Phase4FastAsk`：1 个 completed turn，快照为 `fast + ask`；3 条工具轨迹，写入与命令均为 `user_approved`。
- `Phase4FastFull`：1 个 completed turn，快照为 `fast + full_access`；4 条工具轨迹，写入与普通命令为 `full_access`，提权探测为 `safety_blocked`。
- `session-index.json` 为 v2，保存三个工作区及各自活动聊天；空项目没有伪造会话。
- 重启只加载历史，没有自动请求模型、自动续跑工具或重复文件副作用。

## 最终测试产物

- `Phase4FastAsk/phase4-fast-ask.txt`：内容为 `fast ask verified` 加末尾换行，18 字节。
- `Phase4FastFull/phase4-fast-full.txt`：内容为 `fast full verified` 加末尾换行，19 字节。
- `Phase4MultiB`：保持空目录，用于验证独立项目与空聊天状态。

## Strong 待补测说明

GLM-5.3-Flash 的 endpoint、Bearer 鉴权、流式 `reasoning_content`、`tool_stream`、分片 `tool_calls`、`thinking` 和 `reasoning_effort` 已按官方文档实现，并由离线 provider 测试覆盖。由于本机 `.env` 当前没有 `GLM_API_KEY`，本报告不把请求体测试或模拟 SSE 冒充真实在线通过。凭据安全配置完成后，应在 HammerTest 新建独立 Strong 工作区，补跑流式思考、文件修改、普通命令和重启恢复四项场景。
