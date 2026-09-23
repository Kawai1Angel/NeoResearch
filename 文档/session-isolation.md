# Research session 隔离

新建研究任务默认使用 taskSpec.metadata.executionIsolation = "task"：
- 一个根 session 只绑定一个研究任务，重复绑定在数据库事务中拒绝。
- operation 的活动租约按 taskID 互斥；不同任务可并行，同一任务的重复请求仍按幂等键复用。
- 数据准备以及 smoke/full/ref_test/blind_test 使用 .neo-research/workspaces/<taskID> 作为 cwd 和 NEO_CAST_PROJECT_ROOT；各自拥有 dataset、runner_state、candidate 和 artifacts。Python 环境、运行器代码仍可共享。
- 自定义 candidate/artifact 输出路径必须处于任务目录内。
- TUI 在创建请求中携带当前模型，服务端保存在 metadata.sessionModel；其他 session 修改全局最近模型不会改变已绑定任务。旧任务首次调用 session 模型时绑定。
- 更新 taskspec 保留服务端管理的隔离标记和模型绑定。

兼容边界：本次没有搬迁历史任务的实验文件。没有 isolation 标记的任务继续使用旧执行路径和项目级工作区互斥；需要并发的独立研究应新建任务。这样避免旧 runner 状态、已保存计划和模型权重路径失效。任务间仍共享机器的 CPU/GPU、模型提供商限流和项目级只读配置，隔离不等于独享算力。

回归覆盖：真实异步 HTTP 路由下的不同任务并发与独立取消、同任务重复请求与冲突、不同 horizon 的数据目录互不覆盖、spec 更新保留模型与目录绑定、根 session 重复绑定拒绝、输出越界拒绝。
