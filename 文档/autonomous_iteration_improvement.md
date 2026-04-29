# NeoResearch 自主迭代能力完善方案

> 针对问题：当前系统是"批次内迭代"，不具备真正的自主持续迭代能力。

---

## 一、问题诊断

### 当前迭代模型

```
用户执行: node bin/neo-cast.js design --max-candidates 5
            ↓
         for attempt = 1..5:
             生成候选 → 训练 → keep/discard
         exit()   ← 进程退出，等待人工重新执行
```

**三个关键缺口：**

| 缺口 | 具体表现 | 根因位置 |
|---|---|---|
| 无自适应停止 | N 是人工指定的固定数字，没有 plateau/收敛检测 | `cli.js:366` `maxCandidates` |
| 无跨调用续跑 | 进程退出后无任何机制自动重启，需人工重新执行 | CLI 无 daemon 模式 |
| 无探索多样性 | mock 路径总产出同一 linear 架构，实质无探索 | `mutate.py:26` 阈值硬编码 |

### 当前 `RunnerState` 已有但未被利用的字段

```python
# runner.py:55
@dataclass
class RunnerState:
    session_id:       str
    best_run_id:      str | None
    best_val_avg_mse: float | None
    keep_count:       int           # ← 可用于判断探索进展
    crash_streak:     int           # ← 可用于检测卡死
    candidate_counter: int          # ← 可用于全局预算控制
    initialized_at:   str
```

这些字段已经持久化到 `runner_state.json`，**跨进程调用可以读取**，是实现自主迭代的现成基础。

---

## 二、改造目标

```
目标模型:
  neo-cast design --requirement "..." --autonomous --time-budget 2h

            ↓ 启动后无需人工干预
         
         while not converged and not budget_exhausted:
             生成候选（LLM / reflection / mutation）
             训练 + 评估
             keep or discard
             check_stopping_conditions()
         
         输出最优模型报告，退出
```

---

## 三、需要改动的文件

| 文件 | 改动类型 | 核心改动 |
|---|---|---|
| `py/runner.py` | 修改 | `RunnerState` 新增时间和收敛字段 |
| `py/search/mutate.py` | 修改 | `MutationPolicy` 改为从数据集 baseline 相对计算阈值 |
| `src/cli.js` | 修改 | 新增 `--autonomous` 和 `--time-budget` flag，design loop 改为无限循环 + 停止条件检测 |
| `src/loop.js` | **新建** | 自主迭代循环核心逻辑（从 cli.js 抽出） |
| `src/python-bridge.js` | 修改 | 新增 `readRunnerState()` helper |

---

## 四、Step 1：扩展 RunnerState（`py/runner.py`）

新增三个字段用于自主停止判断：

```python
@dataclass
class RunnerState:
    session_id:        str
    best_run_id:       str | None
    best_val_avg_mse:  float | None
    keep_count:        int
    crash_streak:      int
    candidate_counter: int
    initialized_at:    str
    # --- 新增 ---
    session_started_at: str        # 本次 autonomous 会话开始时间（ISO）
    no_improve_streak:  int        # 连续未改善轮数（discard 次数）
    last_improve_at:    str | None # 上次 keep 的时间戳
```

**修改 `init_state()`：**

```python
def init_state(force: bool) -> RunnerState:
    state = RunnerState(
        session_id=_make_session_id(),
        best_run_id=None,
        best_val_avg_mse=None,
        keep_count=0,
        crash_streak=0,
        candidate_counter=0,
        initialized_at=_now_iso(),
        session_started_at=_now_iso(),  # 新增
        no_improve_streak=0,            # 新增
        last_improve_at=None,           # 新增
    )
    ...
```

**修改 `run_experiment()` 中的 keep/discard 逻辑：**

```python
# 当前：
improved = state.best_val_avg_mse is None or val_avg_mse < state.best_val_avg_mse

# 改为：
if improved:
    state.best_val_avg_mse = val_avg_mse
    state.best_run_id = run_id
    state.keep_count += 1
    state.crash_streak = 0
    state.no_improve_streak = 0       # 新增：重置
    state.last_improve_at = _now_iso() # 新增：记录时间
else:
    state.crash_streak = 0
    state.no_improve_streak += 1      # 新增：累加
```

---

## 五、Step 2：修复 MutationPolicy 阈值（`py/search/mutate.py`）

### 当前问题

```python
# 当前：固定阈值，与数据集无关
MutationPolicy(poor_val_mse=1.1, good_val_mse=0.9)
```

linear baseline 的 val_avg_mse=1.0918，低于 `poor_val_mse=1.1`，mutation 认为"不够差"，不切换架构。导致所有轮都是同一 linear 模型。

### 修改方案：相对阈值

```python
@dataclass(frozen=True)
class MutationPolicy:
    max_hidden_dim: int = 256
    min_hidden_dim: int = 32
    max_depth:      int = 4
    min_lr:         float = 1e-4
    max_lr:         float = 3e-3
    # 改为相对于 baseline 的比例阈值，而非绝对值
    poor_rel_threshold:  float = 1.05   # 比 baseline 差超过 5% → 切架构
    good_rel_threshold:  float = 0.95   # 比 baseline 好超过 5% → 认为收敛
    baseline_val_mse:    float | None = None  # 从外部注入


def make_policy_from_state(state_dict: dict) -> MutationPolicy:
    """从 runner_state.json 读取 baseline 构造相对阈值 policy。"""
    best = state_dict.get("best_val_avg_mse")
    if best is None:
        return MutationPolicy()
    return MutationPolicy(
        baseline_val_mse=float(best),
        poor_rel_threshold=1.05,
        good_rel_threshold=0.95,
    )
```

**修改 `_mutation_steps()` 中的阈值判断：**

```python
def _get_thresholds(policy: MutationPolicy) -> tuple[float, float]:
    if policy.baseline_val_mse is not None:
        poor = policy.baseline_val_mse * policy.poor_rel_threshold
        good = policy.baseline_val_mse * policy.good_rel_threshold
    else:
        poor = 1.1  # 没有 baseline 时的兜底绝对值
        good = 0.9
    return poor, good

def _mutation_steps(recipe, metrics, policy):
    val_avg_mse = _metric(metrics, "val_avg_mse")
    poor_threshold, good_threshold = _get_thresholds(policy)

    # 把所有 policy.poor_val_mse 替换为 poor_threshold
    # 把所有 policy.good_val_mse 替换为 good_threshold
    ...
```

**在 `mutate_recipe()` 入口处接受 state_path 参数：**

```python
def mutate_recipe(recipe, metrics=None, *, policy=None, index=1, state_path=None):
    if policy is None and state_path is not None:
        import json
        try:
            state = json.loads(Path(state_path).read_text())
            policy = make_policy_from_state(state)
        except Exception:
            policy = MutationPolicy()
    policy = policy or MutationPolicy()
    ...
```

**在 CLI 调用时注入 state_path：**

```python
# mutate.py main() 新增参数
parser.add_argument("--state-path", default=None,
                    help="runner_state.json path for relative threshold calculation")
```

---

## 六、Step 3：新建 `src/loop.js`（自主迭代核心）

将 design loop 的核心逻辑从 `cli.js` 抽出，封装为可配置的自主迭代器。

### 6a. 停止条件检测

```js
/**
 * 判断是否应该停止迭代。
 * @returns {{ stop: boolean, reason: string }}
 */
function checkStoppingConditions(state, options) {
  const {
    timeBudgetMs,        // 总时间预算（ms）
    maxNoImprove,        // 连续未改善次数上限
    maxCandidates,       // 最大候选数（Infinity = 无限）
    minImprovement,      // 最小改善幅度（相对值，如 0.001）
    sessionStartMs,      // session 开始时间戳
  } = options;

  // 1. 时间预算耗尽
  if (timeBudgetMs && Date.now() - sessionStartMs > timeBudgetMs) {
    return { stop: true, reason: "time_budget_exhausted" };
  }

  // 2. 候选数上限（非 autonomous 模式的兜底）
  if (state.candidate_counter >= maxCandidates) {
    return { stop: true, reason: "max_candidates_reached" };
  }

  // 3. 连续未改善次数过多（plateau 检测）
  if (maxNoImprove && state.no_improve_streak >= maxNoImprove) {
    return { stop: true, reason: `no_improve_plateau:${state.no_improve_streak}_rounds` };
  }

  // 4. 连续崩溃（系统故障）
  if (state.crash_streak >= 5) {
    return { stop: true, reason: "crash_streak_exceeded" };
  }

  return { stop: false, reason: null };
}
```

### 6b. 自主迭代主循环

```js
async function runAutonomousLoop(requirementBundle, resolvedConfig, options) {
  const {
    projectRoot,
    taskContext,
    timeBudgetMs,
    maxNoImprove = 8,
    maxCandidates = Infinity,
    mockLlm = false,
    useReflection = false,
    useMutation = false,
    skipSmoke = false,
    onRoundComplete,    // callback: (attempt, row) => void
  } = options;

  const sessionStartMs = Date.now();
  let attempt = 0;
  let history = loadResults(projectRoot);
  let previousRow = null;

  console.log(`[loop] autonomous iteration started`);
  console.log(`[loop] time_budget=${timeBudgetMs ? Math.round(timeBudgetMs/60000) + 'min' : 'unlimited'}`);
  console.log(`[loop] max_no_improve=${maxNoImprove}`);

  while (true) {
    attempt += 1;

    // --- 停止条件检测（每轮开始前）---
    const state = readRunnerState(projectRoot);  // 从 python-bridge 读最新状态
    const { stop, reason } = checkStoppingConditions(state, {
      timeBudgetMs,
      maxNoImprove,
      maxCandidates,
      sessionStartMs,
    });
    if (stop) {
      console.log(`[loop] stopping: ${reason}`);
      break;
    }

    // --- 生成候选 ---
    let result;
    if (attempt > 1 && useReflection) {
      const { reflectAndPropose } = require("./reflect");
      result = await reflectAndPropose(
        requirementBundle.requirementText, history, previousRow,
        resolvedConfig, { projectRoot, mockLlm, taskContext, attempt }
      );
    }
    if (!result && attempt > 1 && useMutation) {
      try {
        const candidate = await mutateCandidate(projectRoot, {
          metricsPath: latestValMetricsPath(projectRoot, previousRow),
          index: attempt - 1,
          statePath: path.join(projectRoot, ".neo-cast", "runner_state.json"),
        });
        result = { candidate, source: "mutation_policy" };
      } catch (_) {}
    }
    if (!result) {
      result = await generateCandidate(
        requirementBundle.requirementText, history, resolvedConfig,
        { attempt, mockLlm, taskContext }
      );
    }

    // --- 训练 ---
    writeCurrentCandidate(projectRoot, result.candidate);
    console.log(`[loop] attempt=${attempt} source=${result.source} family=${describeCandidateFamily(result.candidate)}`);

    const exitCode = await runRunner(projectRoot, result.candidate.hypothesis || `attempt ${attempt}`, { skipSmoke });
    history = loadResults(projectRoot);
    previousRow = getLatestSessionRow(projectRoot);

    if (onRoundComplete) onRoundComplete(attempt, previousRow);

    // 硬崩溃立即退出
    if (exitCode > 1) {
      console.log(`[loop] hard failure at attempt ${attempt}, exiting`);
      break;
    }
  }

  return getBestSessionRow(projectRoot);
}

module.exports = { runAutonomousLoop, checkStoppingConditions };
```

---

## 七、Step 4：`src/cli.js` 接入 autonomous 模式

### 7a. 新增 flags

```
--autonomous            启用自主迭代模式（无固定轮次上限，靠停止条件终止）
--time-budget <Nh|Nm>   总时间预算，如 2h / 90m / 3600s
--max-no-improve <N>    连续 N 轮未改善后停止（默认 8）
```

### 7b. `handleDesign()` 分支

```js
async function handleDesign(positionals, rawFlags) {
  // ... 前置检查 ...

  const isAutonomous = Boolean(rawFlags["autonomous"]);

  if (isAutonomous) {
    // --- 自主模式 ---
    const timeBudgetMs = parseTimeBudget(rawFlags["time-budget"]);   // "2h" → ms
    const maxNoImprove = Number(rawFlags["max-no-improve"] || 8);

    const { runAutonomousLoop } = require("./loop");
    const bestRow = await runAutonomousLoop(requirementBundle, configResult.resolved, {
      projectRoot,
      taskContext,
      timeBudgetMs,
      maxNoImprove,
      maxCandidates: Infinity,
      mockLlm: Boolean(rawFlags["mock-llm"]),
      useReflection: Boolean(rawFlags["use-reflection"]),
      useMutation: Boolean(rawFlags["use-mutation"]),
      skipSmoke: Boolean(rawFlags["skip-smoke"]),
      onRoundComplete: (attempt, row) => {
        if (mode === "companion") printCompanionResult(row);
      },
    });

    printFinalSummary(bestRow);
    return 0;

  } else {
    // --- 原有批次模式（保持不变）---
    const maxCandidates = Number(rawFlags["max-candidates"] || 1);
    // ... 原有 for loop ...
  }
}
```

### 7c. 时间预算解析工具

```js
function parseTimeBudget(raw) {
  if (!raw || raw === true) return null;
  const s = String(raw).trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)(h|m|min|s|sec)?$/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  const unit = match[2] || "s";
  if (unit === "h") return n * 3600_000;
  if (unit === "m" || unit === "min") return n * 60_000;
  return n * 1_000;
}
```

---

## 八、Step 5：`src/python-bridge.js` 新增 `readRunnerState`

```js
function readRunnerState(projectRoot = process.cwd()) {
  const paths = getProjectPaths(projectRoot);
  if (!fs.existsSync(paths.runnerStatePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.runnerStatePath, "utf8"));
  } catch (_) {
    return null;
  }
}

// mutateCandidate 同时接受 statePath 参数，传给 mutate.py
function mutateCandidate(projectRoot, options = {}) {
  const args = [...];
  if (options.statePath) {
    args.push("--state-path", options.statePath);  // 新增
  }
  ...
}
```

---

## 九、完整数据流（自主模式）

```
neo-cast design --requirement "..." --autonomous --time-budget 2h --use-reflection

  初始化 session（runner_state.json）
  │
  └─ while True:
       │
       ├─ readRunnerState() → {candidate_counter, no_improve_streak, ...}
       │
       ├─ checkStoppingConditions():
       │     time_budget_exhausted?   → break
       │     no_improve_streak >= 8?  → break "plateau"
       │     crash_streak >= 5?       → break "system_failure"
       │
       ├─ 生成候选:
       │     attempt=1      → generateCandidate (LLM)
       │     attempt>1 + reflection → reflectAndPropose
       │                                 ├─ loadArtifactData (training_curves.json)
       │                                 └─ LLM 分析 → 新 recipe
       │     reflection 失败 → mutateCandidate (relative threshold policy)
       │
       ├─ runRunner():
       │     renderer.py → train.py → epoch_end events → training_curves.json
       │     keep:    no_improve_streak=0, last_improve_at=now
       │     discard: no_improve_streak++
       │
       └─ loop continue
  │
  └─ 打印最终报告（best run, val_avg_mse, artifact path）
```

---

## 十、停止条件的参数建议

| 参数 | 推荐值 | 说明 |
|---|---|---|
| `--time-budget` | `2h`（GPU）/ `4h`（CPU） | 总时间预算，最核心的约束 |
| `--max-no-improve` | `6`~`10` | 连续多少轮 discard 后认为 plateau |
| crash_streak 上限 | `5`（代码写死） | 系统故障自动退出 |

**停止原因分类：**

```
time_budget_exhausted  → 正常完成，输出最优模型
no_improve_plateau     → 搜索收敛，局部最优
crash_streak_exceeded  → 系统故障，需要人工排查
```

---

## 十一、Printout 格式（自主模式进度显示）

```
[loop] autonomous iteration started
[loop] time_budget=120min  max_no_improve=8

[attempt  1] source=anthropic         family=recipe:none+linear        val_avg_mse=1.0918  → KEEP   ✓ new best
[attempt  2] source=llm_reflection    family=recipe:patch+transformer  val_avg_mse=0.8842  → KEEP   ✓ new best
[attempt  3] source=llm_reflection    family=recipe:patch+mlp          val_avg_mse=0.9103  → DISCARD  (no_improve=1)
[attempt  4] source=mutation_policy   family=recipe:invert+rnn         val_avg_mse=0.8791  → KEEP   ✓ new best
[attempt  5] source=llm_reflection    family=recipe:freq+mixer         val_avg_mse=0.9012  → DISCARD  (no_improve=1)
...
[attempt 18] source=llm_reflection    family=recipe:patch+transformer  val_avg_mse=0.8812  → DISCARD  (no_improve=6)
[attempt 19] source=llm_reflection    family=recipe:multiscale+mlp     val_avg_mse=0.8934  → DISCARD  (no_improve=7)
[attempt 20] source=mutation_policy   family=recipe:none+dlinear       val_avg_mse=0.9001  → DISCARD  (no_improve=8)

[loop] stopping: no_improve_plateau:8_rounds
[loop] total_time=94min  total_attempts=20  keep_count=3

═══════════════════════════════════════
 BEST MODEL
 run_id:       20260430-143022-xxxx
 backbone:     rnn (gru)
 embedding:    invert
 val_avg_mse:  0.8791
 ref_test pending: run `neo-cast runner ref-test`
 artifact:     .neo-cast/artifacts/run_20260430-143022-xxxx/
═══════════════════════════════════════
```

---

## 十二、与现有功能的兼容性

**改动不影响现有功能：**

- `--max-candidates` 批次模式完全保留，不改变行为
- `--autonomous` 是新的独立分支
- `RunnerState` 新增字段有默认值，旧的 `runner_state.json` 能正常 load（`dataclass` 构造补默认值）
- `mutate.py` 的 `--state-path` 是可选参数，不传时行为与当前完全相同
- `MutationPolicy` 的相对阈值只在 `baseline_val_mse` 有值时生效，`None` 时 fallback 原有绝对值

---

## 十三、验证方法

### 验证 1：停止条件单元测试

```js
// 在 test/ 目录新增 test/loop.test.js
const { checkStoppingConditions } = require("../src/loop");

test("stops when time budget exhausted", () => {
  const state = { candidate_counter: 3, no_improve_streak: 2, crash_streak: 0 };
  const opts = { timeBudgetMs: 1000, sessionStartMs: Date.now() - 2000, maxNoImprove: 8 };
  const { stop, reason } = checkStoppingConditions(state, opts);
  assert.ok(stop);
  assert.equal(reason, "time_budget_exhausted");
});

test("stops on plateau", () => {
  const state = { candidate_counter: 10, no_improve_streak: 8, crash_streak: 0 };
  const opts = { timeBudgetMs: null, sessionStartMs: Date.now(), maxNoImprove: 8, maxCandidates: Infinity };
  const { stop, reason } = checkStoppingConditions(state, opts);
  assert.ok(stop);
  assert.match(reason, /no_improve_plateau/);
});
```

### 验证 2：Mock 模式端到端（无 GPU）

```bash
cd neo_cast
export NEO_CAST_FAST_E2E=1

# 验证 plateau 停止（mock 模式下 8 轮相同模型后停止）
node bin/neo-cast.js design \
  --requirement "test autonomous loop" \
  --mode companion \
  --autonomous \
  --time-budget 30m \
  --max-no-improve 4 \
  --mock-llm

# 期望：
# - 跑 ~5 轮（1 keep + 4 discard）后打印 "stopping: no_improve_plateau:4_rounds"
# - 不需要人工干预
# - 进程自动退出，exitCode=0
```

### 验证 3：mutation 相对阈值

```bash
# 先跑一次建立 baseline
node bin/neo-cast.js runner run --description "baseline" --skip-smoke

# 验证 mutate.py 使用相对阈值
cd py && python -c "
from search.mutate import mutate_recipe, make_policy_from_state
import json

recipe = json.load(open('../.neo-cast/current_candidate.json'))
state = json.load(open('../.neo-cast/runner_state.json'))
policy = make_policy_from_state(state)
print('baseline:', state['best_val_avg_mse'])
print('poor threshold:', state['best_val_avg_mse'] * policy.poor_rel_threshold)
print('good threshold:', state['best_val_avg_mse'] * policy.good_rel_threshold)

metrics = {'val_avg_mse': state['best_val_avg_mse'], 'status': 'discard'}
mutated = mutate_recipe(recipe, metrics, policy=policy, index=1)
print('mutated backbone:', mutated['backbone']['type'])  # 应该切换架构，不再是 linear
"
```

### 验证 4：真实 LLM autonomous 跑（有 API Key）

```bash
export NEO_CAST_LLM_API_KEY="your-key"

node bin/neo-cast.js design \
  --requirement "optimize ETTh1 forecasting, reduce h720 MSE" \
  --mode companion \
  --autonomous \
  --time-budget 1h \
  --max-no-improve 6 \
  --use-reflection

# 期望：
# - 持续运行直到时间预算或 plateau
# - 每轮架构不同（LLM reflection 驱动）
# - 最终打印最优模型报告
```

---

## 十四、实现优先级

| 优先级 | 改动 | 工作量 | 价值 |
|---|---|---|---|
| P0 | mutation 相对阈值（`mutate.py`） | 30 min | 立刻解决探索多样性问题 |
| P0 | `RunnerState` 新增字段（`runner.py`） | 20 min | 为停止条件提供数据基础 |
| P1 | `loop.js` + 停止条件检测 | 2h | 核心功能 |
| P1 | `cli.js` `--autonomous` 分支 | 1h | 用户入口 |
| P2 | `python-bridge.js` `readRunnerState` | 30 min | 辅助 |
| P2 | 单元测试 `loop.test.js` | 1h | 正确性保证 |
| P3 | Printout 格式美化 | 30 min | 体验 |

**最快可以验证 autonomous 迭代的路径：**

先实现 P0（mutation 相对阈值），配合已有的 `--max-candidates` + `--force-all-candidates`，**不需要新建文件**就能看到架构多样性。真正的 daemon 循环（P1）是更长远的目标。
