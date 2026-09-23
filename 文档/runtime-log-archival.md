# 运行日志存档

本次改动针对 NeoResearch 研究流水线及 Neo-Cast Python 子进程。新日志从更新后的程序启动起生效；不会补回旧运行已覆盖或删除的内容。

## 路径

路径相对于研究任务所在的 workspace；独立 CLI 日志相对于 Neo-Cast project root。

| 路径 | 内容 |
| --- | --- |
| `.neo-research/logs/<taskID>/events.jsonl` | 带 taskID 的 research 总线事件、Agent 输出及工具事件、阶段生命周期、部分 LLM 降级原因 |
| `.neo-research/logs/<taskID>/prepare-<attemptID>.jsonl` | 数据准备命令、stdout、stderr、退出或失败记录 |
| `.neo-research/runner-progress/<taskID>/<runID>.jsonl` | runner 启动、实时 stdout/stderr、退出记录 |
| `.neo-research/runner-executions/<taskID>/<runID>.json` | runner 完成后的执行汇总及解析记录 |
| `.neo-research/artifact-versions/<taskID>/<versionID>/...` | 意图、数据准备、画像、数据分析、假设规划、发布报告等易覆盖文件的历史副本 |
| `.neo-cast/logs/<timestamp>-<uuid>.jsonl` | 独立 CLI 每次 Python 子进程的命令、stdout/stderr、耗时、退出码及超时/取消/启动失败 |

JSONL 一行一个 JSON。stdout/stderr 在研究侧使用 `line`，独立 CLI 使用原始输出块 `text`。日志不写入进程环境变量或 provider 配置。

## 时序与排查

阶段事件使用 `research.phase.started/completed/failed/canceled`，相同 `attemptID` 配对，结束记录包含 `durationMs`。覆盖意图、准备、画像、分析、检索、假设、NAS、执行、验证、反思、发布及完整流水线；父子阶段时间有重叠，不能直接相加作为总耗时。

研究事件和子进程输出在回调返回前追加写盘，runner 在启动时即注册进度文件，取消或异常也保留此前输出。进程被强制杀死时可能只有开始事件而没有结束事件；这表示执行中断或状态待核实，不能推断为完成。逐条写入没有执行 fsync，不保证断电情况下最后几条记录的持久性。

历史副本使用唯一目录，artifact URI 指向副本，metadata 保留 `sourceURI` 和 `sha256`。工作目录中的常用报告路径仍可更新。CV fold 临时产物标记 `ephemeral`，不登记为长期目录引用；各 fold 指标与输出继续保留在 runner 日志中，正式模型产物按原流程保存。旧版本已登记且被清理的 CV 临时目录不再阻断恢复。

最终 bundle/model package 的 `trace/` 携带导出时已有的任务日志、runner 进度、执行汇总和报告历史副本。它是导出时的快照，不含导出完成之后的事件。独立 CLI 日志仍保存在对应 project root。

这不是所有底层库及网络请求的逐字节追踪：未发布为 research 事件的内部操作仍依赖原有 session/应用日志。现有 SQLite 会话存储和历史迁移机制保持原样。本次未手工修改用户的旧数据库。

## 研究会话模型选择

研究会话优先读取 TUI 保存到 `model.json` 的最近模型选择，再校验 provider/model 是否已注册；没有 TUI 选择时才使用研究配置。研究配置的旧模型名称失效时，可使用同一 provider 下应用当前可用的默认模型。显式选择失效会报告具体 provider/model，不悄悄替换。`research.model.selected` 事件记录研究配置推导的名称及最终使用的名称，便于核对显示与执行。
