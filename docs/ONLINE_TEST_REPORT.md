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

## HC-ONLINE-2026-08-28-03

- 时间：2026-08-28 16:27–17:14（Asia/Shanghai）
- 基线提交：`55ee548`
- 正式界面：Electron 生产构建页面，通过 main/preload/renderer 完整链路操作
- 模型：真实 `fast = deepseek-v4-flash` 与真实 `strong = glm-5.3-flash`
- 工作区：`/Users/norten/Developer/HammerTest/Phase5FastGomoku`、`/Users/norten/Developer/HammerTest/Phase5StrongRefactor`
- 会话数据：独立临时 userData `/tmp/hammercode-phase5-ui.M5l1Xh`
- 凭据：由正式配置加载器读取；界面、终端、测试输出和本报告均未展示或记录密钥值
- 运行配置：Fast `reasoning_effort=high`，Strong `reasoning_effort=max`，两档默认输出预算 32768；发现真实长推理超时后将统一请求超时提高到 600000 ms

## Fast 完整开发与界面验收

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 输出预算校准 | 复杂五子棋任务在旧 16K 预算下以 `length` 结束；提高到 32K 后同等推理强度完成，不通过降为 `low` 换取表面成功 | 通过，配置修复 |
| 从空目录开发 | 经真实 UI 审批创建 `index.html`、`styles.css`、`game.js`、`test.js` | 通过 |
| 工具与验证 | 7 次工具调用，最终 `node test.js` 为 12/12，通过语法检查 | 通过 |
| Markdown 与过程折叠 | 完成前持续展示思考、工具链和模型文本；完成后过程折叠，最终标题、列表、表格和行内代码按 GFM 渲染 | 通过 |
| 浏览器产物验收 | 实际打开页面并验证黑白轮流、横向五连胜、悔棋和重新开始；方向键焦点移动正常 | 通过 |
| 文件审查 | 4 个新文件累计显示 `+632/-0`，文件卡片可打开渲染后的代码差异 | 通过 |

## Strong 精确编辑与完全访问验收

首个空目录复杂生成任务在旧 300 秒超时下被请求控制器终止，因此将正式默认超时提高到 600 秒。第二次复杂生成由用户点击停止，持久化原因明确为“用户点击了停止按钮”，没有伪装成模型失败或应用退出。随后改用可确定复核的调试夹具继续真实验收。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 失败基线 | 读取 `README.md`、`task-store.js`、`test.js`，执行 `node test.js` 得到预期 1/12 通过 | 通过 |
| 精确修改 | 使用 `edit_file` 四次修复规范化、重复 id、不可变 reducer、过滤与序列化；没有整文件重写 | 通过 |
| 完全访问审计 | 写入和普通命令均记录 `full_access`；初始非零测试命令保留真实失败结果，最终命令保留成功结果 | 通过 |
| 最终验证 | `node test.js` 为 12/12，`node --check task-store.js` 通过，并创建 `VALIDATION.md` | 通过 |
| 文件审查 | `task-store.js` 与 `VALIDATION.md` 累计显示 `+144/-16`；红绿逐行 diff 在右侧并排栏展示 | 通过 |

## 运行中导航与侧栏验收

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 项目行直接新建 | 点击 `Phase5FastGomoku` 文件夹右侧 `+`，不进入已有聊天即可创建新聊天 | 通过 |
| 运行中切换聊天 | 发送读取四个文件的 Fast 任务后立即切换到另一项目的 Strong 历史聊天；原聊天仍在侧栏显示“思考中” | 通过 |
| 切回继续流式 | 8 秒时切回，已显示 `list_files` 与四次 `read_file`；任务在 16 秒正常完成，共 5 次调用 | 通过 |
| 不误恢复/不重放 | 切换期间没有把后台任务标记为应用中断，没有重复任何工具；只读任务没有文件副作用 | 通过 |
| 停止入口 | 顶部只展示不可交互运行计时，唯一停止按钮位于输入区右下角，窄宽度不再暴露右上角高误触取消按钮 | 通过 |
| 并排代码审查 | diff 打开后形成项目栏、聊天、审查栏三列，主区与审查区接近 1.618:1 共同压缩，没有覆盖聊天 | 通过 |

## 最终测试产物

- `Phase5FastGomoku`：保留可直接打开的五子棋项目和 12 项零依赖逻辑测试。
- `Phase5StrongRefactor/task-store.js`：保留修复后的状态管理模块；外部复核仍为 12/12。
- `Phase5StrongRefactor/VALIDATION.md`：保留失败基线、修复点和最终验证记录。

## 结论

两档模型均已通过真实 API 和正式桌面链路。Fast 证明从零创建、审批、测试、Markdown 和浏览器产物闭环；Strong 证明长思考、精确编辑、完全访问审计和失败基线修复闭环。运行中导航、项目行直接新建聊天、停止入口和并排代码审查均通过实际 UI 操作，不以静态截图或模拟状态冒充交互结果。

## HC-ONLINE-2026-08-28-04

- 时间：2026-08-28 18:09–18:21（Asia/Shanghai）
- 基线提交：`486b1c3`
- 正式界面：Electron 开发构建，通过 main/preload/renderer 完整链路操作
- 模型：真实 `deepseek-v4-flash`（内置 Fast 与设置页自定义连接）；本地受控 OpenAI-compatible 503 协议夹具
- 工作区：`/Users/norten/Developer/HammerTest`
- 凭据：真实 key 仅在设置页密码框与 main process 内短暂处理；没有输出、复制或记录其值

### 设置与自定义连接

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| URL/网络错误 | 本机不可达的 HTTPS 地址返回“无法连接 API 服务”，没有把错误伪装成鉴权成功 | 通过 |
| 真实模型发现 | DeepSeek 官方 `/models` 返回 3 个模型，保存后立即出现在输入框模型选择器 | 通过 |
| 自定义模型任务 | 选择发现的 `deepseek-v4-flash` 完成只读任务：2 次模型请求、1 次 `list_files`、0 文件或命令副作用、3 秒完成 | 通过 |
| 凭据边界 | 提交后密码输入框清空；应用配置文件中无明文凭据，密文由 `safeStorage` 保存，文件模式为 `0600` | 通过 |

### Plan、预算与命令分层

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 复杂任务 Plan | 真实 Fast 在首次副作用前建立计划，最终持久化 revision 1–4 共 4 个检查点，3 个步骤全部完成 | 通过 |
| 长任务预算 | 6 轮/6 请求、0 重试、9 次工具、输出 1767 token、输入 20965 token、30 分钟时限均在界面持续显示 | 通过 |
| 文件与验证 | 在 `Phase6Plan` 创建 2 个文件；`node --test Phase6Plan/marker.test.js` 自动执行，2/2 通过 | 通过 |
| 请求批准模式自动命令 | 新聊天固定 Fast + 请求批准；Plan 门槛先阻止未计划的命令，建立 2 个检查点后本地测试以 `not_required` 执行且没有审批弹窗，实际命令只运行一次并 2/2 通过 | 通过 |
| 远端/高风险层级 | `git push`、部署/发布/上传始终审批及 sudo/擦盘/关机直接阻断由 103 项自动测试覆盖；包含 `git -C`、`env`、Shell 包装器和复合命令绕过测试，本轮未实际触发远端或破坏性操作 | 自动测试通过 |

### 受控 503、失败终止与安全继续

本地协议夹具先返回一次 `write_file` tool call，随后连续返回 503。正式 runner 在副作用之后重新请求模型，按上限退避重试 2 次，最终以独立 `server_error` 结束；没有用模拟 session 直接篡改状态。

- 失败 turn：2 轮、4 次模型请求、2/2 重试、1 次成功 `write_file`，终止原因 `server_error`。
- 继续 turn：在同一聊天输入“只总结，不重复旧工具”，1 次模型请求、0 次工具调用，正常完成。
- `Phase6Failure/once.txt` 在继续前后均为 1 行，SHA-256 均为 `802683e3c2e1fa7e851e92ead1f69268130139022ca76e74308fd13046d10fb8`，证明旧副作用没有重放。

### 最终测试产物与结论

- `Phase6Plan/marker.js`、`Phase6Plan/marker.test.js`：真实 Fast 生成，外部复核仍为 2/2。
- `Phase6Failure/once.txt`：受控失败后的唯一文件副作用，保留供重放检查。
- `Phase6ProtocolFixture/server.mjs`：本地受控协议端点，只使用无效测试凭据，不包含真实 key。

Phase 6 的设置、自定义模型选择、可恢复 Plan、预算展示、本地命令自动执行、重试上限、错误分类和失败后继续均通过正式桌面链路。远端状态修改与直接阻断只使用自动测试验证，未为了验收实际 push、部署、提权或执行破坏性命令。

## HC-ONLINE-2026-08-29-01

- 时间：2026-08-28 23:52–2026-08-29 00:02（Asia/Shanghai）
- 基线提交：`1ba180c`
- 正式界面：Electron 开发构建，通过 main/preload/renderer 完整链路操作
- 模型：真实 `fast = deepseek-v4-flash`；真实 `strong = glm-5.3-flash` 执行官方 `/models` 连通检测
- 工作区：`/Users/norten/Developer/HammerTest`
- 凭据：只由正式配置加载器和加密凭据存储使用；未展示、打印、复制或记录密钥值

### 固定双模型与迁移

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 产品模型收敛 | 设置页、输入框和 `/模型（API）` 只出现 Fast/Strong | 通过 |
| Fast 连通 | DeepSeek 官方 `/models` 返回固定 `deepseek-v4-flash`，343ms | 通过 |
| Strong 连通 | 智谱官方 `/models` 返回固定 `glm-5.3-flash`，129ms | 通过 |
| 启动状态 | 两档均以绿色“已配置”启动，不再统一显示红色未连接 | 通过 |
| 旧连接清理 | `api-connections.json` 已删除；`model-credentials.json` 模式 `0600`，仅固定双槽密文 | 通过 |

### 交互与代码审查

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| `/` 命令 | 行首输入 `/` 显示侧边聊天、模型、压缩三个入口；子菜单均可打开 | 通过 |
| `@` 引用 | 输入 `@Phase6` 返回当前 HammerTest 内匹配文件和目录，路径保持相对工作区 | 通过 |
| 并排审查 | 审查栏按约 38.2% 初始宽度与聊天并排，代码按可用宽度换行 | 通过 |
| Diff 清洗 | 新文件审查只呈现代码行、行号和增删色，不出现 hunk/header 源文 | 通过 |
| 圆环提示 | 圆环不可点击；辅助文本为“已用 1% · 记忆窗口 1.3k/120k …” | 通过 |

### PDF、Python、压缩与恢复

真实 Fast 接收只读验收任务：使用 `read_pdf` 读取 `Phase7Tools/fixture.pdf`，再使用 `run_python` 运行 `Phase7Tools/inspect.py phase7-online`。第一次 Python 调用因复杂任务尚无 Plan 被 `PLAN_REQUIRED` 在执行前拦截；模型建立 3 步计划后重试，界面显示完整 cwd、脚本、参数和超时，批准后执行。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| PDF 读取 | `pdftotext` 36ms 完成，提取验证码 `HC-PDF-2026` | 通过 |
| Python 权限 | `ask` 模式弹出逐次审批；批准后无 Shell 执行，39ms、exitCode 0 | 通过 |
| Python 参数 | JSON 输出为 `{"tool": "run_python", "argument": "phase7-online"}` | 通过 |
| 工具审计 | 首轮 5 次工具调用，包含 Plan 拦截、计划检查点、PDF 和 Python 真实结果 | 通过 |
| 显式压缩 | `/压缩上下文` 后圆环由 2.7k 降至 1.3k、次数增至 1；没有全宽通知 | 通过 |
| 同聊天记忆 | 第二轮仅询问上轮事实，0 次工具调用，准确回答验证码和 Python 参数 | 通过 |
| 重启恢复 | 关闭并重启应用后，两轮消息、0 次重放、1 次压缩和 1.3k 窗口快照恢复 | 通过 |

### 最终测试产物与结论

- `Phase7Tools/fixture.pdf` 与 `pdf-source.txt`：保留供 PDF 人工复核。
- `Phase7Tools/inspect.py`：保留供 Python 参数与输出复核。
- 本轮没有创建模型生成的工作区副作用；唯一受审批执行的是已有 Python 测试脚本。

Phase 7 的固定双模型、持久化聊天记忆、静默压缩圆环、快捷命令、工作区引用、PDF/Python 工具、并排 Diff 和重启恢复均通过正式桌面链路。自动阈值触发由离线 AgentRunner 测试覆盖；未人为填充 78% 的真实模型上下文以避免无价值的大额请求。

## HC-ONLINE-2026-08-29-02

- 时间：2026-08-29 00:45–01:03（Asia/Shanghai）
- 基线提交：`a46be6e`
- 正式界面：Electron 开发构建，通过 main/preload/renderer 完整链路与真实鼠标拖动操作
- 模型：真实 `fast = deepseek-v4-flash`
- 工作区：`/Users/norten/Developer/HammerTest`
- 凭据：只由正式 main process 配置加载器使用；界面、命令输出和本报告均未展示、打印或复制密钥值

### 自适应布局与紧凑界面

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 中间分界拖动 | 将分界大幅向左拖动后，主区停在 520px 安全下限；正文、顶部栏和单行输入框始终同列，没有覆盖或越界 | 通过 |
| 外边缘缩放 | 窗口宽度变化后主区与 BTW 按保存比例共同重排，不再固定右栏像素、单独挤压主区 | 通过 |
| 窄窗折叠 | 缩到最小演示宽度时 BTW 自动隐藏，主聊天恢复完整可用宽度；放大窗口后原 BTW 两轮历史自动返回 | 通过 |
| 单行输入区 | 默认高度为一行，模型与权限只保留紧凑选择器；占位文字不再打印 `/` 或 `@` | 通过 |
| 左侧任务行 | 每条聊天只显示一行标题，无状态、轮次或日期；窄宽度使用省略号 | 通过 |

### BTW 只读隔离与真实并发

先在已完成主聊天中通过 `/btw` 打开 BTW，真实 Fast 连续回答两轮：准确复述此前执行的 Node 测试命令、2/2 结果及两个测试用例含义。随后在完全访问聊天中让主线运行 `node Phase8Btw/slow.js`；第二轮命令持续约 60.1 秒，BTW 在主线状态为 `executing_tool` 时创建。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 命令别名 | 输入 `/btw` 只显示 `/侧边聊天` 命令，回车直接创建临时分支，不再打开持久化聊天列表 | 通过 |
| 主线并发 | BTW 创建时主线已运行 31 秒，处于 `executing_tool`；BTW 面板与主线停止按钮同时可用 | 通过 |
| 快照准确性 | BTW 回答“主线正在第二次执行 `node Phase8Btw/slow.js`，尚未得到结果”，并区分此前 20.1 秒的第一次成功运行 | 通过 |
| 无工具边界 | BTW 请求发送空工具列表；真实回答产生 0 次工具调用，模型意外工具调用阻断由自动测试覆盖 | 通过 |
| 主线不受影响 | 主聊天最终为 2 个 turn、2 条命令轨迹；BTW 问题和回答没有增加主线消息、工具、Plan 或压缩次数 | 通过 |
| 不持久化 | 会话 JSON 全路径检索不含 `btw`、`sideChat` 或 BTW 问题文本；关闭后面板消失 | 通过 |
| 重启销毁 | 保持空 BTW 打开时退出开发应用并重启；主聊天恢复，BTW 未恢复 | 通过 |

### 自动标题与测试产物

- Fast 为真实聊天异步生成并持久化“运行slow脚本并报告结果”和“只读并发验收总结”；标题无 Emoji、Markdown、状态或轮次信息。
- `Phase8Btw/slow.js` 保留为 60 秒可控慢命令夹具，输出 `phase8-btw-main-finished`，供人工复核 BTW 并发。
- 本轮没有让模型创建或修改业务文件；唯一新增测试产物是人工准备的慢命令夹具。

Phase 8 的比例布局、分界边界、窄窗折叠/恢复、真实 BTW 多轮与并发、主线单向隔离、关闭/重启销毁和自动标题均通过桌面实测；未用模拟会话冒充在线结果。

## HC-ONLINE-2026-08-29-03

- 时间：2026-08-29 03:14–03:17（Asia/Shanghai）
- 基线提交：`cab2b4f`
- 正式界面：Electron 开发构建，完整 main/preload/renderer 链路
- 模型：真实 `strong = glm-5.3-flash`
- 工作区：`/Users/norten/Developer/HammerTest`
- 凭据：只由正式 main process 的加密配置读取；界面、终端输出和本报告均未展示、打印或复制密钥值

### 界面收敛

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 命令菜单 | 输入 `/` 后只显示“侧边聊天”“模型”“压缩上下文”三个单行名称；不显示斜杠、别名、API 或功能描述 | 通过 |
| 侧边聊天顶部 | 标题固定为“侧边聊天”，说明固定为“侧边聊天是临时聊天，关闭后会消失”；没有主线任务标题、Phase 名称或内部边界术语 | 通过 |
| Markdown 字号 | 正文 16px，三级标题收敛为 19/18/17px，表格继承正文；真实续问以一个自然段完成，没有机械编号或多级标题 | 通过 |

### 真实模型上下文压缩

在 Phase 7 PDF/Python 验收聊天中执行显式压缩。旧实现是同步本地摘录，本轮实现会向当前聊天所选模型发送一个不带任何工具的专用摘要请求，并把模型语义摘要与本地事实锚点合并后才提交新记忆。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 运行态 | 点击“压缩上下文”后 0.6 秒内可见输入锁定、旋转圆环、“正在压缩上下文”和停止按钮；旧圆环次数保持 3 | 通过 |
| 真实摘要 | Strong 请求约 24 秒完成；成功返回后压缩次数才从 3 更新为 4，窗口快照约 1.6k/120k | 通过 |
| 工具隔离 | 压缩请求的 `tools` 固定为空；工作区没有新增文件、命令或审批轨迹 | 通过 |
| 事实保留 | 压缩后以 Strong 继续同聊天，0 次工具调用准确回答 PDF 验证码 `HC-PDF-2026` 和 Python 参数 `phase7-online` | 通过 |
| 输出样式 | 续问结果使用单一自然段，代码事实仅用行内等宽样式，没有标题、编号或列表 | 通过 |
| 用户停止 | 第二次启动压缩后点击停止；界面恢复可输入状态，压缩次数仍为 4，旧记忆保持不变 | 通过 |

本轮没有修改 HammerTest 内的任何文件。在线调用只用于模型摘要和压缩后只读续问；成功、输出耗尽、取消、意外工具调用和自动阈值路径另由 130 项自动测试覆盖。

## HC-ONLINE-2026-08-29-04

- 时间：2026-08-29 03:57–04:00（Asia/Shanghai）
- 基线提交：`9d37941`
- 正式界面：Electron 开发构建，通过 main/preload/renderer 完整链路操作并在退出后重启恢复
- 模型：真实 `fast = deepseek-v4-flash`
- 工作区：`/Users/norten/Developer/HammerTest/Phase9`
- 凭据：仅由正式配置加载器和 main process 使用；界面、终端、测试输出和本报告均未展示、打印或复制密钥值

### 受限并行子任务与主 Agent 写入

主任务先建立六步 Plan，然后一次调用 `spawn_subagents` 并行启动两个只读子任务：`analysis` 分析 `Phase9/counter.js`，`test_localization` 定位 `Phase9/counter.test.js` 的契约断言。两者均继承 Fast 模型选择，但父聊天为请求批准时，子任务实际权限仍固定为只读。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 独立状态与预算 | 界面同时显示两个子任务，各自拥有独立 Plan、8 轮、30 次工具和 5 分钟预算；最终均为 completed | 通过 |
| 权限隔离 | 子任务只使用 `update_plan`、`list_files`、`read_file`；工具列表没有写文件、通用命令、项目记忆或递归编排入口 | 通过 |
| 带来源结论 | 子任务定位 `counter.js:1` 当前值 40 与 `counter.test.js:6` 严格断言 42；主 Agent 发现一次行号分歧后亲自重新读取并复核 | 通过 |
| 结构化边界 | 主 Agent tool result 只收到摘要、发现、文件/行号证据、预算和风险；子任务完整消息/原始工具输出仅保存在独立审计状态 | 通过 |
| 主 Agent 独占写入 | `edit_file` 仍弹出请求批准 diff；批准后仅将 `counter.js:1` 从 40 改为 42，子任务没有磁盘副作用 | 通过 |
| 命令风险分层 | `node --test Phase9/counter.test.js` 被识别为普通本地测试并自动执行；退出码 0，1 pass / 0 fail | 通过 |

### 项目记忆与跨聊天召回

文件修改和成功测试分别自动产生一条 `tool_verified` 记忆；主 Agent 使用 `remember_project` 写入 `phase9-counter-contract` 决定，明确标记为 `model_inference`。设置页显示三条有效记录及各自来源，没有把模型决定伪装为工具事实。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 文件事实 | `file:Phase9/counter.js` 保存 after hash，来源为本轮 `edit_file` | 通过 |
| 验证事实 | Node 测试的 1/1 通过结果保存为工作区修订绑定验证，来源为本轮 `run_command` | 通过 |
| 模型决定 | `phase9-counter-contract` 保存 `PHASE9_MEMORY_MARKER` 与 expectedCounter=42，界面显示“模型推断” | 通过 |
| 新聊天召回 | 新建独立聊天并明确禁止工具；0 次工具调用准确回答主题、值及 `model_inference` 置信级别 | 通过 |
| 重启恢复 | 退出并重启应用后，新聊天回答、原主聊天、两个 completed 子任务、Plan/预算和项目记忆均恢复；没有重新请求模型或重放工具 | 通过 |

### 离线隔离、受控提案与交付检查

- 自动测试验证 1/3/4 及单 turn 累计上限、子 Agent 伪造越权工具阻断、父取消传播、结构化输出、会话重启持久化、同路径写入租约冲突/释放，以及 `patch_proposal` 生成独立 diff 但磁盘内容不变。
- 顶层 `git push` 在完全访问下仍进入 `always` 审批，子 Agent 没有任何远端工具；本轮未实际执行 push、部署、发布、上传、提权或破坏性命令。
- `npm run typecheck`、26 个测试文件共 145 项测试、生产构建和 Apple Silicon 目录包全部通过；未签名目录包符合当前本地演示阶段预期。

最终测试产物保留在 `HammerTest/Phase9`：`counter.js` 当前值为 42，`counter.test.js` 外部复核仍为 1/1 通过，`package.json` 仅声明 ESM。该目录可用于人工复核真实模型闭环，未清理。

## HC-ONLINE-2026-08-29-05

- 时间：2026-08-29 14:11–14:46（Asia/Shanghai）
- 基线提交：`7ac1fd9`
- 正式界面：Electron 开发构建与 `release/mac-arm64/HammerCode.app`，均经过 main/preload/renderer 完整链路
- 模型：真实 `fast = deepseek-v4-flash`、真实 `strong = glm-5.3-flash`
- 工作区：`/Users/norten/Developer/HammerTest`；新增测试目录为 `Phase10Memory` 与 `Phase10Imported`
- 凭据：只由正式 main process 的统一配置与加密存储使用；界面、测试输出和本报告均未展示、打印或复制 key

### 记忆开关、预算与迁移

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 新项目默认值 | 未存在 Phase 9 记忆文件的 hot100 项目显示总开关关闭；读取/生成偏好保留但禁用 | 通过 |
| v1 迁移 | HammerTest 的三条 Phase 9 记录迁移到 v2 后总开关、读取和生成均保持开启 | 通过 |
| 关闭隔离 | 关闭 HammerTest 项目记忆后新建聊天，真实 Fast 在 0 工具调用下明确回答不知道 `PHASE9_MEMORY_MARKER` | 通过 |
| 开启召回 | 重新开启后另建聊天，真实 Fast 在 0 工具调用下准确回答 `phase9-counter-contract`、`expectedCounter=42` 与 `model_inference` 来源 | 通过 |
| 上下文成本 | 设置页显示最近只注入 3 条、约 285 tokens；默认上限为 6 条/3000 字符，没有装入整份记忆库 | 通过 |
| 导出隐私 | 正式包直接生成 `HammerTest-hammercode-memory.json`，模式 `0600`、2270 字节、3 条记录、SHA-256 校验有效；不含工作区绝对路径和本地 session/turn/tool/subtask 标识 | 通过 |
| 幂等导入 | 通过正式文件面板导入同一批三条记录，结果为导入 0 条、跳过 3 条；当前项目记录数保持 3 | 通过 |

### 模型连接与系统界面

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| Fast 检测 | 官方 `/models` 返回 3 个模型，耗时 197 ms；应用保持绿色已配置状态 | 通过 |
| Strong 检测 | 官方 `/models` 返回 10 个模型，耗时 182 ms；`glm-5.3-flash` 可选 | 通过 |
| 默认槽重命名 | Fast 在正式设置页改名为“日常模型”并成功恢复为 Fast；稳定引用和已有聊天不变 | 通过 |
| 新增连接入口 | 表单只要求名称、Fast/Strong 档位、API URL、API Key；检测成功前模型与保存按钮不可用。协议保存/删除和加密由自动测试覆盖，本轮未留下演示连接 | 通过 |
| 圆环浮窗 | 实际 Electron 窗口悬停显示深色小浮窗，包含百分比、`k/k` 窗口、自动阈值与压缩次数；圆环无点击行为 | 通过 |

### Finder 路径与最终交付

macOS 的旧 LaunchServices 记录曾指向会被普通构建清理的 `dist/mac-arm64/HammerCode.app`，系统因此弹出“找不到该文件”；另外相对保存路径会继承访达的失效位置。打包输出现已独立到 `release/`，工作区与导入面板使用存在的绝对默认路径，项目记忆导出改为在当前工作区用 `wx` 原子创建并自动使用 `-2/-3` 避免覆盖。最终从 `/Users/norten/Developer/HammerCode/release/mac-arm64/HammerCode.app` 启动成功，renderer URL 指向该包内的 `app.asar`，没有再次出现失效路径弹窗。

最终 `npm run typecheck`、26 个测试文件共 150 项测试、生产构建和 Apple Silicon 目录包全部通过。HammerTest 根目录只保留最终便携文件；调试阶段的旧导出已移动到 `Phase10Memory`，不会污染演示列表。

## HC-ONLINE-2026-08-30-01

- 时间：2026-08-30 03:09–03:20（Asia/Shanghai）
- 基线提交：`17a389f`
- 正式界面：Electron 开发构建，通过 main/preload/renderer 完整链路操作；最终重新构建 Apple Silicon 目录包
- 模型：真实 `fast = deepseek-v4-flash`、真实 `strong = glm-5.3-flash`
- 工作区：`/Users/norten/Developer/HammerTest`；隔离对照工作区为 `/Users/norten/Developer/leetcode/hot100`
- 凭据：只由正式 main process 加密配置使用；界面、终端、测试输出和本报告均未展示、打印或复制 key

### 标准格式、设置与项目信任

HammerTest 新增标准项目 Skill `.agents/skills/phase11-online/`，仅包含 `SKILL.md`、一份 reference 和一份纯文本 Python 脚本。重启应用后设置页发现该 Skill，但保持“未启用、未信任”；点击启用后出现来源、声明工具、脚本清单和“不授权”说明，只有“检查并信任”后才启用，并明确提示只影响下一轮。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| `$` 补全 | 单独输入 `$` 显示两个内置 Skill；选择后写入 `$pdf-review ` | 通过 |
| `/skills` | 输入 `/skills` 只显示 Skills 命令；选择后打开设置并滚动到 Skill 区 | 通过 |
| 声明非授权 | 设置页对每个 Skill 显示“声明工具 n 项（不授权）” | 通过 |
| 项目首次信任 | `phase11-online` 默认禁用/未信任；确认页显示 `.agents/skills/` 来源、3 项声明工具和 1 个脚本 | 通过 |
| 工作区隔离 | 切换到 hot100 后设置页只剩两个内置 Skill，不出现 `phase11-online` | 通过 |

### Fast 显式触发与请求批准

真实 Fast 使用 `$phase11-online` 显式触发。过程区在首轮请求前显示项目来源、版本 1.0.0、用户显式指定和约 168 tokens；随后严格按顺序执行 `read_skill_resource`、`run_skill_script`、`read_file`。

- reference 按需读取后上下文成本从约 168 增至 214 tokens，标记为 `PHASE11_REFERENCE_OK`。
- `run_skill_script` 在 ask 模式弹出完整审批，展示脚本、参数、cwd 和“无 API 凭据、无网络、不可写、不可读取工作区”；用户批准后输出 `{"alpha": 2, "beta": 1}`。
- `read_file` 读取 `Phase11/skill-fixture.txt`，标记为 `PHASE11_WORKSPACE_OK`。
- 任务 28 秒完成，3 次工具调用，最终说明全程只读、未修改文件；过程区记录已读取 2 项 Skill 资源和 1 次脚本。

### Strong 自动匹配与完全访问（Phase 11 旧基线）

该次旧基线中，真实 Strong 的任务没有写 `$skill-name`，仅以“请诊断测试失败”描述任务；当时的本地匹配器在 turn 启动时选择了 `test-failure-diagnosis`，过程区显示匹配词、内置来源、版本 1.0.0 和约 323 tokens。模型按需读取 `references/triage-checklist.md`，资源成本增至约 421 tokens，并运行真实 Node 测试定位 `failing-contract.js` 返回 2、测试契约要求 3 的根因。最终 1 分 36 秒、14 次工具调用、0 文件修改。该选择机制已由下方 `HC-ONLINE-2026-08-30-02` 的模型受控 `activate_skill` 链路替代。

随后在同一 Strong 聊天的新 turn 显式选择 `phase11-online`，只运行 Skill 脚本。第一次模型调用因遗漏 `path` 在 prepare 阶段失败，补齐参数后成功；轨迹展开后明确显示“授权 完全访问自动批准”、目标包内脚本、参数、95ms 和 exit code 0，没有审批弹窗，也没有工作区副作用。错误调用没有被静默隐藏。

在线过程中发现最终模型一度把 `allowed-tools` 描述成授权来源，而 UI 审计实际为 `full_access`。交付前已修复：runner 现在把真实 `authorization` 与 `approvalPolicy` 写入 tool result，系统提示也明确只有该元数据和过程区审计可作为授权来源；新增自动断言防止回归。

### 重启、离线安全与交付

- 退出并重启应用后，HammerTest 仍为 13 条聊天，两条 Phase 11 聊天保持 completed；没有运行指示、模型续跑、脚本或旧工具重放。
- 自动测试覆盖标准无扩展 `SKILL.md`、目录名与 name 一致性、非法名称拒绝、任意非隐藏附加资源无损迁移、显式优先/自动单选/自动开关、项目首次信任与第二工作区隔离、包指纹冻结、reference 按需读取、符号链接/越界/提示注入阻断、安全脚本真实沙箱执行、危险脚本与参数阻断、二进制 asset 只迁移不注入，以及原子导入导出和可恢复卸载。
- 最终 `npm run typecheck`、27 个测试文件共 159 项测试、`npm run build`、`npm run package:mac` 和生产依赖审计全部通过。安全脚本测试真实经过 macOS 沙箱，并验证审批等待期间包文件变化不会替换本轮已校验代码快照；`release/mac-arm64/HammerCode.app` 的 `app.asar` 已核对包含 `dist/main/skill-store.js`、两个内置 Skill 的 `SKILL.md`、references 和安全辅助脚本。

测试产物保留在 HammerTest：`.agents/skills/phase11-online/`、`Phase11/skill-fixture.txt`、`Phase11/failing-contract.js` 与 `Phase11/failing-contract.test.js`，供人工复核。首版没有联网安装、市场、自动更新或依赖下载。

## HC-ONLINE-2026-08-30-02

- 时间：2026-08-30 12:42–12:48（Asia/Shanghai）
- 基线提交：`c89d01d`
- 正式界面：Electron 开发构建，通过 main/preload/renderer 完整链路操作
- 模型：真实 `fast = deepseek-v4-flash`
- 工作区：`/Users/norten/Developer/HammerTest`
- 凭据：只由正式 main process 的既有加密配置读取；界面、终端、测试输出和本报告均未展示、打印或复制 key

### 模型受控激活与 turn 隔离

新建 HammerTest 聊天时没有输入 `$skill-name`，只描述“已经出现的测试断言失败”，并明确禁止读取文件、运行命令和修改内容。首轮请求只向模型提供有界名称/description 目录和 `activate_skill`，没有提前注入 `SKILL.md` 正文或资源工具。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 模型选择 | Fast 根据 description 主动调用 `activate_skill({ skill_id: "test-failure-diagnosis" })`，没有字符串匹配器预选审计 | 通过 |
| 渐进加载 | 首轮共 2 次模型请求、1 次工具调用；激活后才返回完整入口，并在下一请求提供资源工具 | 通过 |
| 权限边界 | `activate_skill` 不需要审批且只加载低优先级流程；本轮 0 文件读取、0 命令、0 修改 | 通过 |
| 审计与成本 | 过程区显示“模型选择 · 内置”、版本 1.0.0、1 项入口资源，Skill 总成本约 462 tokens；工具轨迹明确记录 `activate_skill` | 通过 |
| 当前 turn 生效 | 同一聊天第二轮要求只回答 `2+2` 且不使用 Skill/工具；结果为 `4`，0 Skill、0 工具，首轮 Skill 没有延续 | 通过 |

### 输入块、预览与设置页

- 单独输入 `$` 时菜单显示简洁图标与无 `$` 前缀名称；选择后形成浅蓝原子块，无法编辑内部文本，点击移除会整体删除。
- 输入 `@Phase11` 选择文件后形成同样的原子块；点击 Skill 或文件均在 BTW 共用位置打开并排右栏。顶部导航保留“预览/侧边聊天”切换位置，主聊天和输入框同步压缩。
- 初次实测发现 Skill 原始 frontmatter 被 Markdown 当成大标题；交付前改为主进程剥离 YAML 头部，复测后右栏只渲染正文层级。
- 设置页实际显示来源、License、兼容声明和兼容级别。既有项目 Skill 因旧信任没有完整内容指纹而自动变为禁用/未信任，并提示重新确认；这验证迁移不会把旧布尔信任静默升级为新版本信任。
- 上下文圆环在同一轮界面验收中正常显示应用内悬浮提示，包含 9%、10.9k/120k、自动阈值和压缩次数。

本轮没有修改 HammerTest 文件；唯一持久化副作用是新增一条两轮在线验收聊天。开放格式、同大小同 mtime 内容篡改、目录符号链接、部分兼容降级、原子输入序列化和下一轮不重放由 164 项自动测试覆盖。最终严格类型检查、28 个测试文件、生产构建、Apple Silicon 目录包和生产依赖审计均通过；`release/mac-arm64/HammerCode.app` 的 `app.asar` 已核对包含新 Skill runtime 与两个内置标准包。

## HC-ONLINE-2026-08-30-03

- 时间：2026-08-30 15:24–15:31（Asia/Shanghai）
- 基线提交：`8d7b87a`
- 正式界面：Electron 开发构建，通过 main/preload/renderer 完整链路操作；最终重新构建 Apple Silicon 目录包
- 模型：本轮为设置与本地会话持久化验收，没有发起模型请求
- 工作区：`/Users/norten/Developer/HammerTest`
- 凭据：本轮不需要读取或检测模型连接；界面、终端、测试输出和本报告均未展示、打印或复制 key

### 设置中心与项目记忆

打开设置后，内容覆盖整个应用窗口，左侧固定显示灰色“← 返回”以及“模型连接、Skills、项目记忆、已归档”；四个板块分别切换，底层聊天内容不会留在键盘和辅助功能焦点树中。返回后原聊天保持不变。

“新增连接”从模型连接页顶部打开居中模态窗口，名称、档位、API URL、API Key 和检测/保存流程与连接列表分离；关闭按钮在窄窗口和正常窗口均可见，关闭后列表位置不跳动。本轮只验证界面，没有新建、修改或删除真实连接。

项目记忆页实际显示“修改文件 · Phase9/counter.js”等可读标题，文件卡片不再展示内容哈希；来源显示为“工具 edit_file · Phase 9 契约闭环验收”等聊天标题。页面和模型召回兼容清理后的记录均不包含 session、turn 或 tool-call ID。

### 单条、整项目与重启恢复

HammerTest 验收开始时有 14 条活动聊天。先归档一条聊天并从“已归档”恢复，活动列表和归档分组即时同步。随后执行整项目归档：14 条聊天全部进入归档页，左栏中的 HammerTest 项目仍然存在并显示可在此项目开始新对话；整项目恢复后 14 条聊天全部回到活动列表。

为验证重启持久化，再次归档“Phase11只读验收完成”，退出并重启 Electron 后 HammerTest 仍为 13 条活动聊天，已归档页仍显示该记录。恢复后最终状态为 14 条活动聊天、0 条归档。归档过程只更新会话索引，聊天内容文件均保留；HammerTest 工作区文件没有创建、修改或删除。

### 离线覆盖与交付

- 会话索引 v1/v2 → v3、空项目保留、单条和整项目归档恢复、运行态原子阻断、后台保存不意外取消归档，以及聊天文件保留由自动测试覆盖。
- 项目记忆的旧内部标签清理、文件/验证标题和活动/归档来源聊天标题解析由自动测试覆盖。
- 最终 `npm run typecheck`、29 个测试文件共 172 项测试、`npm run build` 与 `npm run package:mac` 全部通过；目录包位于 `release/mac-arm64/HammerCode.app`。当前包未签名，符合本地 Apple Silicon 演示阶段预期。

## HC-ONLINE-2026-08-30-04

- 时间：2026-08-30 15:57–16:27（Asia/Shanghai）
- 基线提交：`0bc8410`
- 正式界面：Electron 开发构建，通过 main/preload/renderer、系统目录选择器和 macOS 保存面板完成操作；退出并重启后复核持久化
- 模型：本轮为项目导航、设置和本地持久化验收，没有发起模型请求
- 工作区：`/Users/norten/Developer/HammerTest`、`/Users/norten/Developer/HammerTest/Phase4FastAsk` 与 `/Users/norten/Developer/leetcode/hot100`
- 凭据：本轮不读取、不检测也不传输模型凭据；界面、终端、测试输出和本报告均未展示、打印或复制 key

### 项目菜单、生命周期与聊天恢复

项目行右侧分别显示方框书写入口和悬停三点菜单。菜单实际包含“置顶项目、重命名、归档项目、移除项目”，运行态禁用策略和提示由正式 controller 处理。HammerTest 临时重命名后确认磁盘目录未变，置顶后移动到首位；验收结束前已恢复名称并取消置顶，原稳定顺序恢复。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 项目归档 | 当前空项目 Phase4FastAsk 从左栏消失；设置“已归档项目”显示名称、完整路径及 0/0 聊天计数 | 通过 |
| 恢复隔离 | 在设置恢复 Phase4FastAsk 后项目回到左栏，但没有抢占当时的主聊天位置 | 通过 |
| 无损移除 | 移除 Phase4FastAsk 后重新选择同一目录，项目重新绑定；工作区文件未删除 | 通过 |
| 历史聊天恢复 | 将含 1 条聊天的 hot100 移除后重新打开 `/Users/norten/Developer/leetcode/hot100`，原聊天标题、Markdown 内容和工具过程完整恢复 | 通过 |
| 重启持久化 | 退出并重启 Electron 后，hot100 仍为 1 条聊天、HammerTest 仍为 12 条活动聊天，Phase4FastAsk 仍是当前空项目；临时名称和置顶均已复原 | 通过 |

### 跨项目记忆与导出保存面板

设置的项目记忆页默认显示 Phase4FastAsk 名称、完整路径和“主聊天当前项目”。只在设置选择 HammerTest 后读取到 3 条项目记忆及其来源标题；返回聊天时主项目仍是 Phase4FastAsk，没有切换活动聊天或建立 BTW。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 自定义默认目录 | 通过系统目录面板选择 `/Users/norten/Developer/HammerTest/Phase13MemoryExports`，偏好按项目更新 | 通过 |
| 每次最终确认 | 自定义模式和项目地址模式的每次导出都打开 macOS 保存面板，并分别预定位到配置目录和 HammerTest 根目录 | 通过 |
| 取消零写入 | 首次自定义导出和项目地址导出均取消；对应目录没有生成额外文件 | 通过 |
| 确认导出 | 保存为 `Phase13MemoryExports/phase13-memory-export.json`，文件模式 `0600`、大小 2270 字节、格式 `hammercode-project-memory` v1，共 3 条记录 | 通过 |
| 偏好恢复 | 自定义模式切回项目地址；重启后界面仍显示项目地址选项，路径为当前查看项目完整路径 | 通过 |

测试过程中没有运行模型、工具命令或工作区写入 Agent；唯一新增验收产物是 `/Users/norten/Developer/HammerTest/Phase13MemoryExports/phase13-memory-export.json`，按在线测试约定保留供人工复核。项目名称、置顶、归档/移除状态和当前主工作区均已复原。自动测试覆盖 v3 → v4 迁移、生命周期原子阻断、聊天文件保留、排序和导出偏好；最终交付检查记录在同阶段状态中。

## HC-ONLINE-2026-08-30-05

- 时间：2026-08-30 16:57–17:02（Asia/Shanghai）
- 基线提交：`4cc7c7a`
- 正式界面：Electron 开发构建，通过 main/preload/renderer 与 macOS 原生打开面板完成操作；最终重新构建 Apple Silicon 目录包
- 模型：本轮为输入区与本地引用交互验收，没有发起模型请求
- 工作区：`/Users/norten/Developer/HammerTest/Phase4FastAsk`
- 凭据：本轮不读取、不检测也不传输模型凭据；界面、终端、测试输出和本报告均未展示、打印或复制 key

### 输入区、统一面板与原生选择

主输入框实际显示为双行正文区，底部单行依次保留左侧圆形加号、中间靠右的上下文圆环/模型/权限和右侧发送按钮。点击加号后，面板按 `/ 命令`、`@ 文件和文件夹`、`$ Skills` 顺序显示，并在固定高度内提供纵向滚动；Phase4FastAsk 只显示一个快捷文件，自动测试另行确认任何工作区最多显示 5 项。

| 场景 | 实际行为 | 结果 |
| --- | --- | --- |
| 命令入口 | 统一面板显示侧边聊天、模型、压缩上下文和 Skills，禁用状态与当前空聊天一致 | 通过 |
| 快捷文件 | 选择 `phase4-fast-ask.txt` 后形成浅蓝文件原子块，可整体移除 | 通过 |
| Skill | 选择 `pdf-review` 后形成 Skill 原子块，可整体移除，没有隐式执行或授权 | 通过 |
| 访达文件 | “在访达中选择”打开当前项目原生面板；选择 `phase4-fast-ask.txt` 后 renderer 只显示相对路径引用 | 通过 |
| 引用预览 | 点击文件原子块后右侧并排预览显示 `fast ask verified`，没有覆盖聊天区 | 通过 |
| 取消 | 再次打开原生面板并取消，输入区保持空白且没有文件或会话副作用 | 通过 |
| 文本补全回归 | 依次直接输入 `/`、`@`、`$`，分别出现命令、项目文件和 Skill 补全；清空后面板关闭 | 通过 |

本轮没有创建聊天、发送模型请求、执行 Agent 工具或修改 HammerTest 文件；验收结束时 Phase4FastAsk 仍为当前空项目，输入区无文本和原子块。最终 `npm run typecheck`、30 个测试文件共 179 项测试、`npm run build`、`npm run package:mac` 和生产依赖审计全部通过；目录包位于 `release/mac-arm64/HammerCode.app`，并已从包内 `app.asar/dist/renderer/index.html` 正常启动显示新输入区后关闭。未签名状态符合当前 Apple Silicon 本地演示阶段预期。

### 外部点击关闭补充验收

2026-08-30 19:17–19:19 以提交 `ed5ab2e` 为基线补充验证统一面板关闭行为。点击面板内的 `/ 命令` 标题后面板保持打开；点击主输入区或聊天正文下方空白区域后立即收起；重新打开后点击加号自身仍能关闭。重新打包后又从 `release/mac-arm64/HammerCode.app` 复测一次打开与空白区关闭，结果一致。全程没有改变输入文本、创建聊天、发送模型请求或修改工作区文件。

## HC-ONLINE-2026-08-30-06

- 时间：2026-08-30 23:16–23:17（Asia/Shanghai）
- 基线提交：`3a3c35f`
- 正式界面：Electron 开发构建，通过 main/preload/renderer 与正式 AgentRunner 请求链路完成
- 模型：Fast · `deepseek-v4-flash`，请求批准模式，思考开启
- 工作区：`/Users/norten/Developer/HammerTest/Phase4FastAsk`
- 凭据：沿用正式应用配置加载和脱敏边界；界面、终端、测试输出和本报告均未读取、展示、打印或复制 key

### 产品身份与运行事实

在 Phase4FastAsk 新建临时聊天，明确要求模型不调用工具，只根据本轮系统事实回答身份、模型、审批原因、工作区边界、预算和可用工具。真实 Fast 用时 5 秒、0 次工具调用完成，实际回答确认：

- 对外身份是 HammerCode 本地编程智能体，`deepseek-v4-flash` 只是 Fast 档位的本轮推理引擎。
- 请求批准模式下，只读和明确安全操作可自动执行，文件写入、删除和一般命令需逐次确认，硬安全边界不可绕过。
- 绑定工作区精确为 `/Users/norten/Developer/HammerTest/Phase4FastAsk`，不能访问工作区外路径。
- 本轮预算精确为 1/20 轮、0/100 次工具、0/1800 秒、32768 tokens 单次输出和 120000 tokens 上下文。
- 实际工具清单与请求一致，共 13 个：`update_plan`、`list_files`、`read_file`、`read_pdf`、`search_text`、`git_status`、`git_diff`、`write_file`、`edit_file`、`delete_file`、`run_python`、`run_command`、`spawn_subagents`。对于未提供的插件或模型权重细节，回答明确表示无法确认。

验收没有触发任何工具、审批、文件修改或命令执行。临时聊天已归档，Phase4FastAsk 活动列表恢复为空；工作区文件零变化。离线测试进一步覆盖 Strong/GLM、完全访问、模型名持久化、工具调用后的剩余预算、BTW 零工具、缺失事实、凭据隔离和压缩保留。最终严格类型检查、31 个测试文件共 186 项测试、生产构建、Apple Silicon 目录包与生产依赖审计全部通过。
