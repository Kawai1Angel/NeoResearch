# TUI 历史研究恢复：实现与验证记录

日期：2026-09-22。

对应设计：[历史会话恢复实施方案](NeoResearch_TUI历史会话恢复实施方案_20260922.md)。本记录区分已接入的功能和仍需保守处理的恢复场景，不将定向测试通过等同于设计文档的完整故障矩阵验收。

## 使用方式

- 首页或 Cockpit 点击“历史研究”，也可用命令面板或 `/history`。支持标题/ID 搜索、下一页、返回首页和键盘选择。
- 选中后按 `taskID` 单独加载研究；超过最近 30 条的任务也可打开。`/task select <完整ID>` 同样支持直接打开。
- 打开页面只加载任务、已有聊天、IntentAgent 问答、实验、审批、产物及事件摘要。聊天绑定在首次发送时建立；已有绑定重复使用，删除后下次发送创建替代聊天。
- 顶栏按恢复状态显示“查看运行”“查看问题 / 审批”“继续研究”“检查状态”“查看原因”或“查看结果”。`/resume` 执行相同动作。
- 运行中的研究连接原 operation。离开页面属于 detach；`/abort`、Esc 等显式取消才停止操作。
- `/append` 显式设置新周期预算；界面显示迭代数及对应的运行额度，创建周期后再点击继续。普通恢复不会给已完成研究追加预算。
- 普通 Switch session 仍打开对话。列表中的 `Ctrl+R` 打开关联研究；同一根会话关联多任务时先选择，子会话沿完整祖先链查找。

## 已接入的服务端保护

1. 增量迁移增加聊天绑定、修订号以及 operation、cycle、phase execution、event、runner workspace lock 表。保留既有任务、session、run 和 artifact。
2. 操作收据持久化；客户端的一次动作携带独立幂等键，网络重试复用。完成后重发同一键返回旧收据，不再次执行；同键异参冲突。
3. 数据库唯一约束保护活动 task 和共享项目工作区；服务内直接执行的 runner 另按规范化工作目录加锁。内存只保存本进程控制器与等待句柄。
4. `resume-state` 是只读视图。`resume` 检查项目归属、revision、已有操作、未确认运行和阻塞项。审批决定仍由已有服务端检查点逻辑执行。
5. 废除单凭五分钟超时将 run 标失败的启动行为。Linux 使用主机、boot ID、PID start ticks 判断旧 owner；runner 还核对整个进程组，不能仅因父进程结束就重试。
6. 原子落盘的执行日志携带 task/run/candidate 与 run-plan 摘要。明确旧 owner 已退出时，可核对并补登记该结果，复用执行记录而不再调用训练命令。run 产物按原 run、kind、URI 幂等登记。
7. 无有效结果且原 runner 进程组已确认结束的训练尝试保留失败/中断历史；之后的新运行可记录 `retry_of`。ref-test/blind-test 在结果不明时不自动重试。
8. 搜索周期保存策略、已使用迭代数、连续失败数和执行耗时。恢复不会重新套用请求中的满额预算。无改进计数沿用当前周期的历史指标；新周期按显式动作建立。
9. 状态与轻量事件通过同一数据库事务/触发器提交，客户端按递增 cursor 补拉并去重。旧任务没有事件时展示既有状态，不伪造过去的事件。
10. 任务切换时按 taskID 隔离请求结果、聊天和事件；最近任务和尚未确认的操作请求键作为 TUI 偏好保存。

API：`GET /research/history`、`GET /research/tasks/:taskID/resume-state`、`POST /research/tasks/:taskID/resume`、`POST /research/tasks/:taskID/cycles`、`GET /research/tasks/:taskID/events`、`POST /research/tasks/:taskID/chat`、`GET /research/sessions/:sessionID/tasks`。已有 tasks 数组接口保留。`resume` 和 `cycles` 要求 `expectedRevision`、`requestKey`；旧长操作接口使用 `Idempotency-Key`。

## 当前恢复边界

- 不支持训练 epoch/优化器状态或半截 LLM token 流恢复。
- 不根据租约超时抢占执行。无法证明旧进程身份/结束状态时保持阻塞；非 Linux 主机、缺执行身份的旧 run、无法确认的外部副作用均按此处理。
- 发布阶段中断而缺完整确认依据时保持阻塞，不推测发布已经完成或自动重放受限测试。
- 完整执行日志尚未原子落盘的情况，不能宣称已经支持任意 runner 输出的自动补登记。仍需按可验证的执行身份、结果及实际资源占用进行核对。
- 独立文件队列 worker 尚未统一接入本次数据库 runner 锁，因此不宣称所有外部 worker 都已具备跨入口互斥。
- 阶段记录与旧 workflow 在同一写入事务中维护；本次没有全面改写各 Agent 的阶段恢复器，也没有用新表完全替代所有旧 workflow 读取。
- 当前输入摘要覆盖任务数据/协议配置及数据文件路径、大小、修改时间；尚未实现任意大小数据集的全文件内容指纹。
- 未知历史执行时长且存在时间预算时，拒绝将其默认为零消耗。所有历史计费 token、训练资源和复杂发布断点的迁移仍需单独完善。
- 原方案的全部故障注入验收矩阵尚未完整覆盖，尤其是训练完成前后每个提交窗口、跨主机执行接管和发布侧外部副作用。

## 验证

测试使用临时工作区和离线替身；真实重启测试启动独立 Bun 子进程、关闭/重开 SQLite，并执行 SIGKILL，检查锁和终态收据不会导致重复执行。

从 `opencode/packages/opencode` 执行：

| 命令 | 结果 |
| --- | --- |
| `bun typecheck` | 通过 |
| `bun test test/research/recovery.test.ts test/research/recovery-restart.test.ts test/research/operation.test.ts test/server/research-operation.test.ts --timeout 30000` | 15 通过，0 失败；包括真实进程重启、旧数据库迁移、并发聊天绑定/删除重建、终态重放、修订号冲突、周期预算及祖先链 |
| `bun test test/cli/tui/research-cockpit-render.test.tsx --test-name-pattern 'historical' --timeout 30000` | 3 通过；包括页外任务、持久化聊天、只读报告预览、不存在任务不跳到最近任务 |
| `bun test test/cli/tui/research-cockpit-data.test.ts test/cli/tui/research-cockpit-render.test.tsx --timeout 30000` | 137 通过，6 失败 |
| `bun test test/research/service.test.ts test/server/research-routes.test.ts --timeout 30000` | 83 通过，19 失败 |
| `git diff --check` | 通过 |

6 项 TUI 失败均在独立的 `8b2436d` HEAD 工作区复现：候选位置展示、chat-only 侧栏、Socratic onboarding、Companion onboarding、Socratic slot-fill onboarding、命令面板切换任务后的旧展示断言。

服务/API 两次完整回归的 19 项失败名称集合一致，集中于旧 baseline 数量、测试替身缺少执行契约证明，以及由此产生的 champion/memory/run 断言。其中 baseline 元数据、baseline 幂等两项也在独立 HEAD 工作区复现。未将完整服务/API 套件报告为通过。

规格变更测试已改为显式创建新周期并重新完成意图确认；该定向测试通过。旧的“启动时按超时将 run 标失败”测试已改为验证 run 保持原状态；新恢复测试验证其进入需要核对状态。

兼容性：迁移为增量迁移，启动时自动应用。旧二进制不理解新执行锁，不应与新版同时操作同一数据库/runner 工作区。本次未修改 Neo-Cast Python runner 协议，因此未运行 `neo_cast/npm test`。
