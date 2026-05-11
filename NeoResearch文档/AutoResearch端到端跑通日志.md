# AutoResearch 端到端跑通日志（ETTh1 · mock LLM · 2026-05-09）

> 本日志同步 `系统Review-AutoResearch端到端验证.md` 的 §5 验证矩阵
> 跑通模式：legacy CLI（`node neo_cast/bin/neo-cast.js design --autonomous --mock-llm`）
> 数据集：内置 ETTh1（`.neo-cast/dataset/etth1_visible.csv` 11521 行 + `etth1_ref_test.csv` 2881 行）

---

## 1. 执行命令

### 步骤 ① 健康检查
```bash
node neo_cast/bin/neo-cast.js doctor
```
结果：
```
[OK] python3: Python 3.12.13 [runtime venv]
[OK] uv: 0.10.8
[FAIL] openai_compatible_api_key: not set        ← 已知，使用 --mock-llm 兜底
[OK] config: valid
[OK] runtime: ready
```

### 步骤 ② 单候选 smoke
```bash
node neo_cast/bin/neo-cast.js design \
  --requirement "small TSF baseline for ETTh1 with input_len 512 and 4 horizons" \
  --mode companion --max-candidates 1 --mock-llm
```
- 候选：`recipe_lineartinyforecaster`（NLinear, 0.05M params）
- 总耗时 ~12 s（smoke 7s + full 4s）
- val_avg_mse = **0.6727**（h96 only）
- decision = **KEEP** → 新 champion

### 步骤 ③ 自主 3 候选
```bash
node neo_cast/bin/neo-cast.js design \
  --requirement "small TSF baseline for ETTh1 with 4 horizons 96 192 336 720, prefer dlinear or patch_mlp under 1M params" \
  --autonomous --max-candidates 3 --max-no-improve 5 \
  --time-budget 30m --mock-llm --use-mutation
```
- R1 → DLinear（heuristic_mock）→ val_avg_mse=0.6868 → DISCARD
- R2 → TCN（mutation_policy）→ val_avg_mse=1.3685 → DISCARD（**timeout @ 624 s** — 4 horizon × 5 epoch 撑满预算）
- R3 → NBEATS（mutation_policy）→ smoke OK，full **param_budget_exceeded（2.30M > 1.0M）** → CRASH → `LOOP:STOP_REASON=hard_failure:3`

总用时：12 min 12 s。

---

## 2. results.tsv 增量

| # | run_id | family | val_avg_mse | params_M | status | is_best |
|---|---|---|---|---|---|---|
| 5 | 20260510-121748-hbrp | recipe_factory(linear) | 0.6727 | 0.05 | **keep** | 0 ← P0-4 ✅ |
| 6 | 20260510-121823-hbrp | recipe_factory(dlinear) | 0.6868 | 0.10 | discard | 0 |
| 7 | 20260510-123024-hbrp | recipe_factory(tcn-mut) | 1.3685 | 0.03 | discard | 0 |
| 8 | crash_8 | recipe_factory(nbeats-mut) | NA | NA | crash | 0 |

`runner_state.json`：
```json
{
  "best_run_id": "20260510-121748-hbrp",
  "best_val_avg_mse": 0.672723,
  "candidate_counter": 8,
  "crash_streak": 1,
  "keep_count": 2,
  "no_improve_streak": 2,
  "session_id": "20260429-010658-238a"
}
```

---

## 3. Champion 产物完整性

`/Users/chengmingyue/.../neo-research/.neo-cast/artifacts/run_20260510-121748-hbrp/` 17 个文件：
```
README.md  eval_report.md  example.py  inference.py  mcp_server.py
metadata.json  model_impl.py  model_spec.json  model.pt  patch_bundle.json
preprocess.json  requirements.txt  research_trace.json  resolved_candidate.json
tool_schema.json  training_curves.json  training_summary.json  val_metrics.json
```

`val_metrics.json`：
```json
{"val_avg_mae": 0.5559, "val_avg_mse": 0.6727,
 "val_h96_mae": 0.5559, "val_h96_mse": 0.6727}
```

`training_summary.json`（关键摘要）：
```json
{"backbone": "linear", "num_params_M": 0.049, "training_seconds": 2.6,
 "training_prediction": "point_forecast"}
```

✅ 推理、bundle、metadata、reproducibility（gitSHA / lockHash / datasetSHA / preprocessSHA via P2-8 已写入 metadata.json）齐备。

---

## 4. 验证清单（对照 §5 矩阵）

| # | 检查 | 状态 | 备注 |
|---|---|---|---|
| 1 | doctor 通过 | ⚠ | LLM key 缺失为 FAIL（应改为 WARN，对应 R-1） |
| 2 | dataset 分割 60/20/20 valid | ✅ | etth1_visible 11520 + etth1_ref_test 2880 |
| 3 | mock loop 1 round | ✅ | NLinear, val_avg_mse=0.6727 |
| 4 | mock autonomous 3 rounds | ⚠ | 3 round 完成 1 keep 2 discard 1 crash；R3 crash 后 loop 终止 |
| 5 | results.tsv 完整性 | ✅ | 4 新行，**全部 is_best=0**（P0-4 验证通过） |
| 6 | runner_state 一致 | ✅ | best_run_id=新 champion，candidate_counter 累计正确 |
| 7 | artifact 完整 | ✅ | 17 个文件包含 model.pt / val_metrics / metadata |
| 8 | export bundle | 未测试 | 需要 cockpit `/export bundle` 路径，CLI 未跑 |

---

## 5. 实跑发现的新问题（补丁到 Review）

### N-1 [P1] champion 比较跨 horizon 数量不公平
**现象**：
- Champion（NLinear baseline mock）只跑 **h96 一个 horizon**，val_avg_mse=0.6727。
- R1（DLinear）也只跑 h96，0.6868，DISCARD（合理）。
- R2（TCN mutation）跑了 **完整 4 个 horizon**（96/192/336/720），avg=1.3685，DISCARD（**不合理** — 1.3685 是 4 horizon 平均，跟 0.6727 的单 horizon 不可比）。

**根因**：
- mock_llm heuristic 候选生成时，`baseline_recipes` 里的 NLinear/DLinear 仅声明 `horizons: [96]`。
- mutation_policy 产出的候选会读 `taskSpec.horizons` 全 4 个。
- runner 不会校验"候选的 horizon 集合 ⊇ task.objective.horizons"。

**修复方向**：
- `validate.py smoke` 在 resolve 前校验候选 horizons 与 task spec 的差集，缺失就拒绝。
- mock heuristic 的 NLinear baseline 默认补齐 4 horizon。
- champion 比较前要求 horizon 完全对齐（不对齐则 `championStandoff`）。

**修复状态（2026-05-10）**：✅ 已修复。
- `model_recipe.v1` 的 `input` 现在支持 `prediction_horizons`，mock/LLM 生成候选会携带完整任务 horizon 列表。
- `renderer.py` 会把 `prediction_horizons` 写入 resolved candidate 的 `task.horizons`；未声明时仍兼容旧的单 horizon `prediction_horizon`。
- `validate.py smoke` 在训练前校验 resolved candidate 是否覆盖当前数据集要求的 horizons，缺失会拒绝候选。
- `runner.py` 比较 champion 前会读取 per-horizon metric 签名；旧 champion 与当前候选 horizon 不一致时开启新的可比集合，并打印 `runner_champion_standoff=...`。
- `src/session.js` 的 legacy summary 会优先尊重 `runner_state.best_run_id`，避免旧的单 horizon 低分继续被扫表逻辑误选为 best。

### N-2 [P1] 单次 hard_failure 即终止 loop，过激
**现象**：R3 因 `param_budget_exceeded` 触发 exitCode>1，loop 立刻 `STOP_REASON=hard_failure:3`，但本 loop 还允许跑 8 次 no-improve。

**位置**：`neo_cast/src/loop.js:305-309`
```js
if (exitCode > 1) {
  stoppedReason = `hard_failure:${exitCode}`;
  console.log(`LOOP:HARD_FAIL=${attempt}`);
  break;
}
```

**修复方向**：
- `param_budget_exceeded` 这种**候选级失败**应该写入 results.tsv（已写）+ 累计 `crash_streak`，不是 hard_failure。
- 真正的 hard_failure 应保留给"runtime 损坏 / venv 不可用 / 数据集丢失"等系统级错误。
- 区分 `runner.py` exitCode：1 = candidate failed（继续），2+ = system failed（停止）。Python 端目前都用 exit code 2，需要细分。

**修复状态（2026-05-10）**：✅ 已修复。
- `runner.py` 将 schema/validation 类候选失败、`param_budget_exceeded`、`smoke_fail/full_fail` 映射为 exit code `1`，Node autonomous loop 会继续下一轮。
- 这些失败仍会写入 `results.tsv`，并继续累计 `crash_streak`，便于后续由 `crash_streak_exceeded` 做有节制的停止。
- 系统级失败（如 artifact 写失败等）仍保留 `>1` 退出码，继续触发 hard failure。

### N-3 [P2] mock_llm 候选与 mutation 候选耗时差 100×
- mock NLinear baseline：2.6 s（h96 only）
- mutation TCN：624 s（4 horizons + 5 epoch + early-stop）
- 差异主要源于 N-1 的 horizon 集合差异。修 N-1 后会自然消除。

### N-4 [P2] 没有 reflection 兜底
`--mock-llm` 路径不会走 reflect_and_propose（reflection 需 LLM）。`--use-reflection` 与 `--mock-llm` 同时打开时静默退化为 mutation_policy，没有任何提示。

---

## 6. 修复验证（2026-05-10）

新增/更新的回归覆盖：
- `test/llm-prompt.test.js`：mock heuristic candidate 保留完整 `prediction_horizons`。
- `py/tests/test_model_recipe_dsl.py`：ModelRecipe schema/renderer 支持多 horizon；smoke horizon 校验能发现缺失 horizon。
- `py/tests/test_runner_curves.py`：候选级 full train 失败返回 continue-safe exit code；旧单 horizon champion 不会直接压掉新 full horizon 候选。
- `test/session.test.js`：legacy summary 尊重 `runner_state.best_run_id`。

已跑验证，均通过：
```bash
cd neo_cast && node --test test/llm-prompt.test.js test/session.test.js
cd neo_cast && python3 -m unittest py.tests.test_model_recipe_dsl py.tests.test_runner_curves
cd neo_cast && npm test
cd neo_cast && node ./bin/neo-cast.js validate recipe py/schemas/recipe_native.example.json
```

---

## 7. 跑通结论

✅ **核心 loop 可跑** — smoke gate / full train / mutation policy / champion 切换 / artifact bundle / reproducibility seal 都能产出，P0/P1/P2 修复确认有效。

⚠ **剩余不优雅点** — UI 端三个 B-bug 不修则 cockpit 路径无法跑通同样的实验；reflection mock 兜底（N-4）仍需后续补提示或 mock reflection。

🔜 **下一步建议**：
1. 修 B-1/B-2/B-3（让 cockpit 可观察）
2. 加 e2e_autonomous_loop.test.ts（本日志即为人工版，需固化为自动测试）
3. 用真实 LLM key（Anthropic 或 GLM）跑一次同样的 3 候选 loop，对照 mock 结果
4. 补 N-4：`--mock-llm --use-reflection` 退化时给出显式提示

---

## 8. 复现命令一行版

```bash
cd /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research && \
node neo_cast/bin/neo-cast.js design \
  --requirement "small TSF baseline for ETTh1 4 horizons under 1M params" \
  --autonomous --max-candidates 3 --max-no-improve 5 \
  --time-budget 30m --mock-llm --use-mutation
```

会从已有 session 继续累计；要重置则 `rm -rf .neo-cast/runner_state.json .neo-cast/results.tsv` 后再跑。
