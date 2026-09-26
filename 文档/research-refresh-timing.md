# 研究界面刷新与运行时计时

## 刷新规则

- Intent、DataAnalysis、HypoPlanner、Reflection 的流式文本及 part 更新仅修改本地显示，不触发全局状态查询。
- 阶段完成、任务/候选/审批变化及操作完成仍会请求状态刷新。多个请求合并，刷新批次最多每秒一次，末尾更新不会被连续事件无限推迟。
- 同一界面、服务地址、工作目录、任务及接口的在途状态读取共享一个 Promise。不同任务不会共用结果；修改操作不合并。
- `/research/llm` 脱离实验刷新信号，每 60 秒检查一次，并缓存成功结果 30 秒。配置变更显示最多滞后一个刷新周期；它不改变实际研究模型选择。
- 卸载界面时取消刷新计时器。原有任务历史轮询与 SSE 恢复机制保留。

## 计时日志

应用日志新增 `service=runtime.timing`，按操作记录 `status=started` 和
`completed/failed/canceled`。同一次操作用 `timingID` 配对，包含墙钟
`startedAt/finishedAt` 和单调时钟计算的 `durationMs`。按需带有
`taskID/sessionID/messageID/callID/tool/agent`，不记录提示词、工具参数、输出或密钥。

| phase | 用途 |
| --- | --- |
| `research.session` | 将研究 task 与子 session 对齐 |
| `tool.plugin.before/after` | 插件钩子等待 |
| `tool.execute` | 工具包装层总耗时 |
| `tool.body` | 工具业务实现 |
| `tool.truncate` | 输出截断/存档 |
| `hypothesis.evidence.read/parse` | 假设校验证据文件读取与解析 |
| `read.instructions/sample/bytes/lines/warm` | Read 工具的指令加载、采样、读取及预热 |
| `session.stream.first_event` | 流消费者首次收到事件；不等于首 token |
| `session.stream.consume` | 消费整个流，包含工具和本地处理，不能当作纯 LLM 时间 |
| `session.snapshot.initial/step_start/step_finish/patch` | Git 快照与差异处理 |
| `session.finish_step` | 完成一个模型步骤的本地处理 |
| `session.cleanup` | 流结束/失败后的最终清理 |

`session.finish_step` 另带 `sinceLastOutputMs`，表示最后收到 text-end、
reasoning-end 或 tool-result 到收到 finish-step 的间隔。它包含等待和调度，
不能直接归因于模型服务。父子 phase 有重叠，分析时按区间去重，不能直接相加。
只有 started 而没有终态表示仍在执行或进程中断；普通失败和取消会记录终态。

可在应用日志中用 `rg 'service=runtime.timing'` 筛选，再按 sessionID/messageID/callID
关联会话数据库和 `.neo-research/logs/<taskID>/events.jsonl` 的阶段记录。

## 生效范围

这些是源码修改。已启动且没有启用热重载的应用进程继续使用旧代码；重启应用后
新计时与刷新规则才生效。不要为了加载改动直接终止正在进行的研究；先按应用的
暂停/恢复流程安排切换。

## 验证记录

- `bun run typecheck` 通过。
- 刷新合并与计时单测：6 项通过，覆盖连续事件、并发读取、缓存到期、失败和取消。
- 流式刷新界面集成测试通过：连续文本更新不增加任务/LLM 查询，完成事件增加一次任务查询。
- 会话处理、Read 工具和界面数据测试：100 项通过、1 项失败；完整界面测试另有 8 项失败。
- 用 HEAD 版本的界面与数据辅助模块创建临时对照副本，9 项失败均复现，涉及既有文案/流程预期及数据集匹配；临时副本已删除。
- 测试使用 `bun test --timeout 30000`，避免挂载盘冷启动触发默认 5 秒超时。
