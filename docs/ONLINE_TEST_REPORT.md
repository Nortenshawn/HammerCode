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
