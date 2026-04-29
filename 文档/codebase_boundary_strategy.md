# NeoResearch 代码边界与双目录依赖策略

## 结论

当前 NeoResearch 代码依赖两个目录：

- `neo-research/opencode`
- `neo-research/neo_cast`

这两个目录都需要继续修改，但不建议把它们硬合并成一个目录。

更合理的方向是：

> 保留双目录边界，把当前的“OpenCode fork + Neo-Cast runner”依赖关系产品化，升级成稳定的 Research OS + Domain Runner 契约。

## 当前职责边界

### `opencode`

`neo-research/opencode` 是 NeoResearch OS 主体。

它负责：

- CLI；
- TUI Cockpit；
- Web Dashboard；
- Server / API；
- session / event；
- research task；
- candidate；
- run；
- champion；
- artifact；
- memory；
- approval / governance；
- worker queue；
- `research worker-once`；
- `research worker-loop`；
- domain runner 调度。

它本质上是基于 OpenCode fork 改造出来的 Research OS shell。

### `neo_cast`

`neo-research/neo_cast` 是第一个 domain runner。

它负责：

- TSF 实验执行；
- TimeRecipe schema；
- candidate recipe 解析；
- preprocessing / embedding / backbone / fusion / prediction head / training strategy；
- Python model build；
- train / validate / ref-test / blind-test；
- artifact 生成；
- export；
- benchmark report；
- TSF runner JSONL event 输出。

它本质上是 NeoResearch 的第一个内置 domain plugin / runner。

## 为什么不建议硬合并

如果把 `opencode` 和 `neo_cast` 硬合并，会带来几个问题：

1. Research OS 和 TSF domain 的边界会变模糊。
2. 后续很难接入第二个 domain，例如 tabular、LLM eval、vision、RL、bio 等。
3. npm 发布时会把 Python runner、Web/TUI/Server、CLI 全混在一个不可拆分的包里。
4. 研究任务生命周期和具体实验执行逻辑会耦合过深。
5. NeoResearch 会变成“TSF 专用工具”，而不是通用 Research OS。

因此更好的方式不是合并，而是把两者之间的契约稳定下来。

## 当前依赖关系的问题

当前两个目录虽然职责不同，但依赖关系还偏开发态：

- `opencode` 侧需要知道 Neo-Cast runner 的路径；
- 默认运行依赖 sibling directory；
- `--neo-cast-root` 等配置还没有产品化；
- npm 包发布时不会自动包含或安装 `neo_cast`；
- `neo_cast` 还没有独立 runner package / plugin manifest；
- Python runner 版本和 OpenCode-side DomainRunPlan 版本还没有正式兼容协议；
- 用户需要理解两个目录才能跑完整 NeoResearch-TSF 实验。

这对本地研发可以接受，但对 npm 发布或外部用户安装不够。

## 是否需要修改两个目录

需要。

但修改目标不是合并，而是分别完成各自的 release hardening。

## `opencode` 侧需要修改什么

`neo-research/opencode` 需要从 OpenCode fork 进一步 release 化为 NeoResearch OS。

建议修改：

- 包名；
- CLI bin 名；
- help 文案；
- README；
- repository；
- issue URL；
- config path；
- 默认 Research Dashboard / Cockpit 入口；
- 默认 runner discovery 逻辑；
- `--neo-cast-root`；
- `NEO_CAST_ROOT`；
- local runner registry；
- domain plugin registry；
- `research init` 或 `research domain install`；
- npm 发布配置；
- workspace dependency 发布策略。

特别是 runner discovery 需要产品化。

当前可以支持几种方式：

1. 显式参数：

```bash
neo-research research create --neo-cast-root /path/to/neo_cast
```

2. 环境变量：

```bash
NEO_CAST_ROOT=/path/to/neo_cast neo-research research worker-once
```

3. 默认内置路径：

```text
<installed-package>/runners/neo_cast
```

4. domain registry：

```bash
neo-research domain list
neo-research domain install tsf
neo-research domain doctor tsf
```

## `neo_cast` 侧需要修改什么

`neo-research/neo_cast` 需要从本地 Python 项目升级成稳定 domain runner。

建议修改：

- 增加 `pyproject.toml`；
- 增加 runner version；
- 增加 domain manifest；
- 增加稳定 CLI entrypoint；
- 增加 `neo-cast doctor` 或 `python -m neo_cast doctor`；
- 明确 recipe schema version；
- 明确 metadata schema version；
- 明确 artifact contract；
- 明确 JSONL event contract；
- 明确 DomainRunPlan 兼容版本；
- 提供 smoke self-test；
- 提供最小 example dataset / mock dataset；
- 支持被 npm 包内置；
- 支持作为独立 Python package 安装；
- 支持作为 NeoResearch domain plugin 安装。

## 推荐目录结构

短期可以继续保持：

```text
neo-research/
  opencode/   # Research OS shell
  neo_cast/   # TSF domain runner
```

中期可以演化成：

```text
neo-research/
  apps/
    cli/
    web/
    tui/
  packages/
    research-core/
    research-runtime/
    research-sdk/
  domains/
    tsf-neo-cast/
```

但不建议现在立刻大规模搬目录。

当前更务实的做法是先稳定契约，再考虑重组目录。

## 短期策略

短期 internal alpha 可以保持双目录。

要求：

- 文档明确 `opencode` 是 Research OS 主体；
- 文档明确 `neo_cast` 是 TSF domain runner；
- 所有端到端实验都从 `opencode` 发起；
- `opencode` 通过配置定位 `neo_cast`；
- worker 使用 DomainRunPlan 调用 Neo-Cast；
- 不让用户手动拼内部路径。

## npm alpha 策略

如果准备 npm alpha，建议采用以下方式之一。

### 方案 A：npm 包内置 Neo-Cast runner

发布包内包含：

```text
node package
  bin/neo-research
  runners/neo_cast
```

优点：

- 用户安装后直接可用；
- onboarding 简单；
- TSF demo 容易跑通。

缺点：

- npm 包会变大；
- Python 依赖仍需安装；
- Node package 和 Python runner 的版本绑定较强。

### 方案 B：npm 包只发布 Research OS，Neo-Cast 独立安装

用户流程：

```bash
npm install -g @neo-research/cli
neo-research domain install tsf
neo-research domain doctor tsf
```

优点：

- 架构干净；
- 多 domain 扩展自然；
- npm 包更轻。

缺点：

- 第一版实现复杂度更高；
- 需要 domain plugin installer；
- 需要更完善的 runner registry。

### 方案 C：内部 alpha 继续双目录，正式发布前再插件化

用户流程暂时是：

```bash
git clone <repo>
cd neo-research/opencode
neo-research research create --neo-cast-root ../neo_cast
```

优点：

- 最快；
- 适合继续研发；
- 不阻塞核心 Research OS 功能。

缺点：

- 不适合广泛 npm 发布；
- 外部用户容易困惑；
- 安装体验不完整。

## 长期架构目标

长期目标应该是通用 Research OS。

核心抽象包括：

- `ResearchDomain`
- `TaskSpec`
- `CandidateSpec`
- `Evaluator`
- `Runner`
- `ArtifactExporter`
- `MemoryStore`
- `GovernancePolicy`
- `DomainPlugin`

TSF/Neo-Cast 是第一个内置 domain plugin，而不是唯一能力。

## 推荐决策

当前建议：

1. 继续保留 `opencode` 和 `neo_cast` 双目录。
2. 不做硬合并。
3. 短期把两者之间的契约补清楚。
4. `opencode` 负责 Research OS。
5. `neo_cast` 负责 TSF runner。
6. npm alpha 前，至少完成 runner discovery 和 packaging 策略。
7. 长期把 `neo_cast` 抽成正式 domain plugin。

## 当前判断

当前双目录结构不是问题，问题是依赖关系还没有产品化。

更准确地说：

> 当前 NeoResearch 已经形成了 Research OS + TSF runner 的雏形，但 `opencode` 和 `neo_cast` 之间还需要稳定的 runner discovery、domain manifest、version contract 和发布策略。

所以答案是：

> 需要修改两个目录，但不要合并两个目录。应该把 `opencode` 改成 NeoResearch OS，把 `neo_cast` 改成稳定 TSF domain runner，并通过明确契约连接二者。
