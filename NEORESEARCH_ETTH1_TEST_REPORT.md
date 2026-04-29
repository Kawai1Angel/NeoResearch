# NeoResearch ETTh1 Test Report

测试日期：2026-04-29  
测试数据集：`/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/datasets/ETTh1.csv`  
测试目录：`/tmp/neo-research-etth1-test.oOYsiD`

## 结论

当前 NeoResearch 可以在本地跑通 ETTh1 的最小 TSF smoke 闭环：构建 CLI、检查环境、初始化 workspace、创建 TSF research task、生成 baseline candidates、审批候选、准备 run plan、通过本地 worker 调用 Neo-Cast runner 执行 smoke，并导出 research report。

本次测试没有跑完整长训练或 ref_test，只验证了低成本 smoke 路径。发现两个需要修复/明确文档化的问题：源码包 `bin/neo-research` wrapper 在当前 Node v25 + `type: module` 下会报 ESM `require` 错误；另外 `research prepare` 会创建 queued run，占用 `maxParallel=1`，此后直接执行 `research run` 会触发预算门，正确路径是用 `research worker-once` 消费已排队任务。

## 环境

- macOS arm64 本机 build target：`neo-research-darwin-arm64`
- NeoResearch version：`0.1.0-alpha.0`
- Bun：通过 `/Users/chengmingyue/.bun/bin/bun` 显式调用
- Python：`Python 3.9.6`
- Neo-Cast root：`/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research/neo_cast`

`neo-research doctor --format json` 结果：

- `NEO_CAST_ROOT`: ok
- `python`: ok
- `python-imports`: ok, `numpy+torch import ok`
- `smoke-runner`: ok

## 执行项

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| `bun test test/release-boundary.test.ts` | 通过 | 5 pass, 0 fail, 42 assertions |
| `bun run build` | 通过 | 生成 `dist/neo-research-darwin-arm64/bin/neo-research`，build smoke `--version` 通过 |
| `npm pack --dry-run --json` | 通过 | tarball 549 files，约 1.98 MB，未包含 Neo-Cast 大目录或数据集 |
| `doctor` | 通过 | Neo-Cast、Python、numpy/torch、runner help 均正常 |
| Neo-Cast `prepare_tsf.py --materialize-visible` | 通过 | 成功生成 visible/ref_test split 和 profile |
| `neo-research init` | 通过 | 创建 `.neo-research` workspace |
| `research create` | 通过 | 创建 task `rtsk_dd6d397e3001OylIDHXzK4iIsS` |
| `research seed` | 通过 | 生成 3 个 baseline candidate 和对应 approvals |
| `research approve` | 通过 | 批准 linear baseline candidate |
| `research prepare --stage smoke` | 通过 | 生成 queued run 和 runner plan |
| `research worker-once` | 通过 | 调用 Neo-Cast runner 执行 smoke |
| `research export` | 通过 | 导出 Markdown research report |
| `dashboard --help` / `cockpit --help` | 通过 | 命令入口存在且帮助信息可显示 |

## 数据集检查

Neo-Cast materialize 输出：

- 原始行数：17420
- visible rows：11520
- ref_test rows：2880
- input length：96
- horizon：24
- feature columns：`HUFL,HULL,MUFL,MULL,LUFL,LULL,OT`
- missing：0
- inferred frequency：`h`
- irregular ratio：0.0
- timestamp：无重复、单调递增

生成文件：

- `/tmp/neo-research-etth1-test.oOYsiD/.neo-cast/dataset/etth1_visible.csv`
- `/tmp/neo-research-etth1-test.oOYsiD/.neo-cast/dataset/etth1_ref_test.csv`
- `/tmp/neo-research-etth1-test.oOYsiD/.neo-cast/dataset/dataset_spec.json`
- `/tmp/neo-research-etth1-test.oOYsiD/.neo-cast/dataset/etth1_profile.json`

## Smoke Run 结果

任务：`ETTh1-Smoke-Test`  
候选：`tsf_linear_raw_baseline`  
run：`rrun_dd6d405b4001BbuAoz3UwSVIc8`  
状态：`succeeded`

指标：

- `val_avg_mse`: 0.40668538731908926
- `val_avg_mae`: 0.4251065173701393
- `val_h24_mse`: 0.40668538731908926
- `val_h24_mae`: 0.4251065173701393

训练摘要：

- backbone：`linear`
- embedding：`none`
- params：0.002328M
- training seconds：0.786386
- total seconds：0.796896

主要产物：

- `/tmp/neo-research-etth1-test.oOYsiD/.neo-cast/artifacts/run_20260429-012221-hbrp/model.pt`
- `/tmp/neo-research-etth1-test.oOYsiD/.neo-cast/artifacts/run_20260429-012221-hbrp/val_metrics.json`
- `/tmp/neo-research-etth1-test.oOYsiD/.neo-cast/artifacts/run_20260429-012221-hbrp/training_summary.json`
- `/tmp/neo-research-etth1-test.oOYsiD/export/rtsk_dd6d397e3001OylIDHXzK4iIsS/research-report.md`

## 发现的问题

### 1. 源码包 bin wrapper 在 Node v25 下不可执行

命令：

```bash
bin/neo-research doctor --format json
```

失败信息：

```text
ReferenceError: require is not defined in ES module scope
```

原因判断：`package.json` 声明了 `"type": "module"`，而 `bin/neo-research` 是 extensionless CommonJS wrapper，Node v25 会按 ESM 解析。构建后的 native binary 可正常运行，但 npm 安装后的 wrapper 可能受 Node 版本影响。

建议：将 wrapper 改成 ESM 写法，或改为 `.cjs` 入口并在 `bin` 中指向该文件，随后增加真实 `npm install -g` smoke test。

### 2. `prepare` 后直接 `run` 容易触发预算门

现象：

```text
ResearchBudgetExceededError
Run budget exhausted: used 1 of max 1.
```

原因判断：`research prepare` 已创建 queued run，并占用 `maxParallel=1`。随后执行 `research run` 会尝试创建另一个 run，因此被预算控制拒绝。使用 `research worker-once` 执行 queued job 后 smoke 成功。

建议：文档中明确两条路径：

- 直接路径：`research run <task> <candidate>`
- 分步路径：`research prepare <task> <candidate>` 后接 `research worker-once`

同时考虑让 CLI 在该场景下给出更明确的提示。

## 后续建议

1. 修复 `bin/neo-research` wrapper 的 ESM/CommonJS 兼容问题。
2. 为 `prepare -> worker-once` 和 `run` 两种执行路径补充 README 示例。
3. 增加集成测试覆盖 ETTh1 最小闭环：`init -> create -> seed -> approve -> prepare -> worker-once -> status -> export`。
4. 后续再跑一次 `stage=run` 或 `ref_test`，验证完整训练和参考测试链路，不只停留在 smoke。
