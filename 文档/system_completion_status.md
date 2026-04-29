# NeoResearch 系统完成度评估

## 结论

当前 NeoResearch 已经是一个可运行的本地研究系统 alpha，不再只是概念、规划文档或 schema demo。

但它还不是可以直接公开 npm 发布、也不是可以生产部署的通用 Research OS。

当前完成度可以按三层来判断：

| 目标层级 | 完成度估计 | 判断 |
|---|---:|---|
| 本地 internal alpha | 75%-80% | 已经可以本机跑完整 NeoResearch-TSF 闭环 |
| npm alpha | 45%-55% | 功能底座够了，但发布工程还没完成 |
| production Research OS | 35%-45% | 架构雏形具备，但生产 runtime / 多 domain / governance 仍需补强 |

## 本地 internal alpha

完成度：约 75%-80%。

当前已经可以在本机跑通完整 NeoResearch-TSF 研究闭环：

1. 创建 research task；
2. 生成或 seed candidate；
3. prepare run；
4. 生成 runner plan artifact；
5. 入队到 local file runtime；
6. worker 执行 Neo-Cast；
7. 回写 metrics；
8. 回写 artifact；
9. 更新 champion；
10. 写入 memory；
11. Web Dashboard / TUI Cockpit 查看和操作主要对象。

这意味着当前系统已经具备可演示、可继续迭代、可内部实验的基础。

## npm alpha

完成度：约 45%-55%。

功能底座已经比较接近 alpha，但发布工程还没 ready。

主要原因：

- npm 包名还没有 NeoResearch 化；
- CLI bin 名仍然保留 OpenCode 语义；
- 关键 package 仍是 `private: true`；
- workspace 依赖仍是 `@opencode-ai/*`；
- `opencode` 和 `neo_cast` 的依赖关系还没有产品化；
- Neo-Cast runner 分发方式未确定；
- README / repository / license / attribution / help 文案还没 release hardening；
- 没有做 `npm pack --dry-run`；
- 没有在全新目录做 npm tarball 安装烟测。

因此当前不建议直接发布 npm。

## production Research OS

完成度：约 35%-45%。

当前系统已经有 Research OS 的结构雏形，但距离生产级还需要补：

- production durable queue；
- production object store；
- production metrics database；
- 长驻 worker supervisor；
- worker drain protocol；
- secret management；
- domain plugin installer；
- 多 domain 抽象；
- 更完整的 governance；
- 更强的 rank predictor；
- 多角色 Research Manager；
- 浏览器和 TUI 真实截图验收；
- production deployment 文档。

## 已完成的关键能力

### OpenCode fork 到 Research OS

`neo-research/opencode` 已经从通用 coding agent 方向改造成 NeoResearch OS 主体。

已经具备：

- CLI；
- TUI Cockpit；
- Web Dashboard；
- Server / Research API；
- session / event；
- research task；
- candidate；
- run；
- champion；
- artifact；
- memory；
- approval；
- governance；
- worker queue。

### TSF/Neo-Cast domain runner

`neo-research/neo_cast` 已经作为第一个 TSF domain runner。

它负责：

- TimeRecipe schema；
- recipe 解析；
- model build；
- train；
- validate；
- benchmark report；
- export；
- blind/ref test sidecar contract；
- JSONL runner events；
- artifact 输出。

### TimeRecipe 风格 candidate schema

candidate 已经从“选模型族 + 配模型参数”升级成更细的模块组合搜索空间。

当前可表达：

- preprocessing action；
- embedding action；
- backbone action；
- fusion action；
- prediction head；
- training strategy。

### Python runner phase2/native action

Neo-Cast Python runner 已经不只是接 schema。

它已经支持一批 phase2/native action 执行，包括：

- invert embedding；
- frequency embedding；
- rnn；
- ssm；
- mixer；
- feature fusion；
- graph / gated hybrid 等 fusion；
- quantile head；
- probabilistic metrics；
- quantile loss；
- scheduler / training strategy 扩展。

### Dataset profiler / diagnostic artifact

系统已经具备 dataset profile 入口。

支持从 train split 计算或持久化：

- row count；
- target count；
- missing rate；
- trend strength；
- seasonality strength；
- cross-variable correlation；
- distribution shift；
- profile warning。

并能把 profile 写成 diagnostic artifact。

### Web Dashboard / TUI Cockpit

Web Dashboard 和 TUI Cockpit 已经能覆盖主要 Research 操作。

包括：

- 创建 task；
- 查看 task detail；
- candidate 列表；
- per-candidate prepare；
- per-candidate execute；
- seed sweep；
- autonomous iteration；
- autonomous loop；
- artifact 查看；
- memory 查看；
- profile summary；
- approval/ref/blind gate 状态。

### Autonomous loop

当前已有 autonomous loop。

能力包括：

- heuristic frontier；
- mutation；
- candidate proposal；
- profile-aware ranking；
- memory-aware ranking；
- budget stop；
- approval stop；
- memory 回写；
- autonomous loop artifact。

但它还不是完整的多角色 Research Manager。

### Governance

当前已有基础 governance。

包括：

- candidate approval；
- domain action approval；
- ref test approval；
- blind test approval；
- budget approval；
- stage promotion gate；
- shadow holdout gate；
- blind/ref query limit；
- governance log artifact。

### Local worker runtime

当前已经有本地 file runtime。

包括：

- `ResearchQueueDriver`；
- `FileResearchQueueDriver`；
- `ArtifactStoreDriver`；
- `FileArtifactStoreDriver`；
- `MetricsStoreDriver`；
- `FileMetricsStoreDriver`；
- `createFileResearchRuntime(...)`；
- `runResearchWorkerOnce(...)`；
- `executeSubprocessResearchJob(...)`；
- `research worker-once`；
- `research worker-loop`。

`prepareRun` 已经会生成 plan artifact 并入队。

worker 执行后会回写：

- run status；
- metrics；
- resource usage；
- runner artifact；
- runner execution log；
- champion；
- memory。

## 最近验证结果

最近一轮验证结果：

- OpenCode research / CLI / TUI 目标测试：102 pass；
- Web Dashboard helper 测试：16 pass；
- OpenCode typecheck：通过；
- App typecheck：通过；
- Neo-Cast Python 测试：57 tests OK；
- E2E 脚本 `bash -n`：通过；
- E2E smoke dry-run：通过。

这些验证说明当前本地 alpha 闭环是可运行的。

## 主要缺口

### 1. 还不能直接 npm 发布

当前仍存在：

- package name 未改；
- bin name 未改；
- `private: true`；
- workspace dependency 发布策略未定；
- Neo-Cast runner 分发方式未定；
- README / repository / license / attribution 未 release 化；
- 未做 npm pack 安装烟测。

### 2. 双目录依赖还没产品化

当前系统依赖：

- `neo-research/opencode`
- `neo-research/neo_cast`

这两个目录职责合理，但连接方式还偏开发态。

还需要：

- runner discovery；
- `NEO_CAST_ROOT`；
- domain manifest；
- version contract；
- domain plugin registry；
- runner doctor；
- packaging strategy。

### 3. Neo-Cast runner 还不是正式 domain plugin

当前 Neo-Cast 已经承担 TSF runner 角色，但还没有正式成为可安装的 domain plugin。

需要补：

- `pyproject.toml`；
- runner version；
- domain manifest；
- stable entrypoint；
- self-test；
- artifact contract；
- schema compatibility contract。

### 4. Production runtime backend 还没有

当前 runtime 是 local file runtime。

生产环境还需要：

- durable queue；
- lease expiry recovery；
- object store；
- metrics DB；
- worker heartbeat monitor；
- dead-letter queue；
- retry observability；
- worker supervisor。

### 5. Agent 自主研究还不是完整多角色体系

当前已有 autonomous loop，但更像：

- heuristic frontier；
- mutation；
- ranking；
- execution；
- memory update。

还不是完整的：

- Diagnostic；
- Design；
- Coder；
- Runner；
- Analyst；
- Librarian；
- Research Manager。

### 6. Rank predictor 仍偏 heuristic

当前 ranking 已结合：

- dataset profile；
- run memory；
- benchmark memory；
- domain heuristics。

但还不是训练过的 rank predictor，也没有完整的 meta-learning loop。

### 7. Web/TUI 没有真实截图验收

当前已经跑了 helper tests 和 render tests，但还没有完整真实浏览器/TUI 截图验收。

仍需验证：

- dashboard 页面真实运行；
- cockpit 页面真实运行；
- candidate actions 交互；
- worker status 展示；
- artifact/memory/profile 视图；
- responsive layout；
- 文本溢出和 UI overlap。

## 当前系统定位

当前 NeoResearch 的最准确定位是：

> 可运行的本地 Research OS internal alpha。

不是：

- 纯规划文档；
- schema demo；
- 单纯 OpenCode 参考实现；
- 可直接 npm 发布的产品；
- 可生产部署的 Research OS。

## 下一步建议

建议按优先级推进：

1. release hardening；
2. runner discovery；
3. Neo-Cast domain manifest；
4. npm alpha packaging；
5. Web/TUI 真实截图验收；
6. long-running worker supervisor；
7. production queue/object store/metrics backend；
8. 多角色 Research Manager；
9. 多 domain plugin abstraction。

## 一句话总结

NeoResearch 当前已经具备完整本地研究闭环，完成度足以作为 internal alpha 继续研发和演示；但距离 npm alpha 还需要发布工程，距离 production Research OS 还需要生产 runtime、多 domain plugin、治理和自主研究能力的系统化增强。
