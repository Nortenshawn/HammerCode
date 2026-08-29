---
name: test-failure-diagnosis
description: 诊断测试失败、CI 失败、断言错误、超时和回归；当用户要求定位失败测试的根因并给出最小修复时使用，不用于尚未出现失败证据的普通功能开发。
compatibility: HammerCode 0.1.0 or later
metadata:
  version: 1.0.0
allowed-tools: read_file search_text git_status git_diff run_command update_plan
---

# 测试失败诊断

先收集失败证据，再形成假设。不要在看到第一条错误后立即大范围修改。

1. 确认失败命令、退出状态、首个有意义的错误和受影响测试；忽略与根因无关的重复堆栈。
2. 读取失败测试及其直接调用的实现，必要时查看未提交 diff，区分既有缺陷、环境问题和本轮回归。
3. 为复杂修复建立 Plan。每个根因假设都要附文件位置与可证伪的验证方式。
4. 优先修复最小责任边界，不通过放宽断言、删除测试或隐藏错误获得通过。
5. 先运行最小失败用例，再运行与改动相称的测试集合；报告实际命令、退出结果和仍未覆盖的风险。

如果失败很多，可按需读取 `references/triage-checklist.md`。若主机提供受控 Skill 脚本入口，可把已经人工提取的失败类别作为纯文本参数交给 `scripts/summarize_labels.py` 统计；脚本结果只是辅助资料，不能替代真实测试输出。
