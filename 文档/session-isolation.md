# Research session 隔离

所有研究任务均使用独立工作区（不再依据旧任务的 isolation 标记回退到共享目录）：
- 一个根 session 只绑定一个研究任务，重复绑定在数据库事务中拒绝。
- operation 的活动租约按 taskID 互斥；不同任务可并行，同一任务的重复请求仍按幂等键复用。
- 数据准备以及 smoke/full/ref_test/blind_test 使用 .neo-research/workspaces/<taskID> 作为 cwd 和 NEO_CAST_PROJECT_ROOT；各自拥有 dataset、runner_state、candidate 和 artifacts。Python 环境、运行器代码仍可共享。
- 自定义 candidate/artifact 输出路径必须处于任务目录内。
- TUI 在创建请求中携带当前模型，服务端保存在 metadata.sessionModel；其他 session 修改全局最近模型不会改变已绑定任务。旧任务首次调用 session 模型时绑定。
- 更新 taskspec 保留服务端管理的隔离标记和模型绑定。

兼容边界：没有搬迁历史任务的实验文件。无 isolation 标记的旧任务在后续新实验中也使用自己的工作区，需要在该工作区重新准备数据；不会自动继承共享目录的 runner 状态或权重。历史日志与产物仍可读取。任务间仍共享机器的 CPU/GPU、模型提供商限流和项目级只读配置，隔离不等于独享算力。

数据画像及定量分析只读取任务源文件或经 SHA-256 校验的任务工作区训练文件；校验绑定源文件、训练文件与 dataset_spec。旧训练文件没有 provenance 时回退到任务源文件前缀并记录警告，不读取运行器包目录中的同名数据。画像保存 taskID、workspaceRoot、sourceFingerprint 和 profileFingerprint。

训练曲线按 CV 折、预测长度及 standard 阶段分组，并在各组内按 epoch 排序和采样。反思使用最新运行（包括失败或 invalid），优先保留原始 error 事件及 stderr；历史失败可从执行日志恢复实际报错。

回归覆盖：真实异步 HTTP 路由下的不同任务并发与独立取消、同任务重复请求与冲突、不同 horizon 的数据目录互不覆盖、spec 更新保留模型与目录绑定、根 session 重复绑定拒绝、输出越界拒绝。
