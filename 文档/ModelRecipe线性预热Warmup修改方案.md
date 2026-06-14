# 在 ModelRecipe.training 中加入线性预热（Linear Warmup）—— 修改方案

> 目标：让 LLM 可以在 `ModelRecipe.training` 中指定学习率线性预热（warmup），并使其真正在训练循环中生效。

---

## 0. 现状梳理（重要：发现一个"已定义但从未实现"的字段）

| 位置 | 现状 |
|---|---|
| `neo_cast/py/schemas/model_recipe_schema.json` → `training` | **没有任何 warmup 字段**，`additionalProperties: false` |
| `neo_cast/py/schemas/recipe_schema.json` → `training_strategy.scheduler` | 已有 `warmup_steps` (integer ≥0)，但**从未被训练代码读取** |
| `opencode/.../domains/tsf.ts` → `scheduler` Zod schema | 已有 `warmupSteps: z.number().int().min(0).default(0)`，**同样未被使用** |
| `neo_cast/py/model_recipe.py` `_compile_training()` | 编译时硬编码 `"scheduler": {"type": "none", "warmup_steps": 0}`，ModelRecipe 中无字段可编译 |
| `neo_cast/py/train.py` `_build_scheduler()` | 支持 `none/cosine/one_cycle/plateau`，**调度器按 epoch 粒度 step()**（每个 epoch 验证后调用一次 `scheduler.step()`），完全忽略 `warmup_steps` |
| `neo_cast/py/recipe_bridge.py` | Phase A/B bridge 强制要求 `scheduler.type == "none"` |
| `action_specs.py` (Python) vs `tsf.ts` (TS) | scheduler 的 `bridge_supported` 标记**两端不一致**（Python: cosine/one_cycle/plateau=False；TS: 全部=True）—— 属于既有 bug，建议顺带修正 |

**关键结论**：
1. `warmup_steps` 这个名字的语义是 **"按 epoch 计数"**（因为当前 scheduler.step() 是按 epoch 调用的，不是按 batch/iteration），命名容易让人误以为是 mini-batch step。
2. 真正要让 warmup 生效，**必须修改 `train.py` 的调度器构造逻辑**，schema 层面的字段目前是"摆设"。

---

## 1. 设计目标与范围

- 在 `ModelRecipe.training` 中新增一个简单、对 LLM 友好的字段，用于表达"前 N% 的训练 epoch 用线性预热提升学习率"。
- 编译为 `CandidateRecipe.training_strategy.scheduler.warmup_steps`（复用已存在的字段，赋予其真实语义并实现）。
- 在 `train.py` 中真正构造 warmup 调度器，且与现有 4 种 `scheduler.type`（`none/cosine/one_cycle/plateau`）组合可用。
- 保持向后兼容：旧 recipe（无 warmup 字段）行为完全不变（`warmup_steps=0` → 无预热，等价于现状）。

---

## 2. 关键设计决策

### 2.1 用 `warmup_ratio`（ModelRecipe 层）而不是直接暴露 epoch 数

`max_epochs` 取值范围很大（1-1000，bridge 冒烟通常只有 2 epoch），让 LLM 直接猜一个绝对 epoch 数容易出现"预热占满整个训练"的情况。因此：

- **ModelRecipe.training 新增**：`warmup_ratio: number, 范围 [0.0, 0.5], 默认 0.0`
  - 含义：用前 `round(warmup_ratio * max_epochs)` 个 epoch 做线性预热。
- **编译阶段**换算为 `CandidateRecipe.training_strategy.scheduler.warmup_steps`（epoch 数，整数），并钳制：
  ```python
  warmup_steps = round(warmup_ratio * max_epochs)
  warmup_steps = max(0, min(warmup_steps, max_epochs - 1))  # 至少留 1 个 epoch 给正式训练
  ```
- `recipe_schema.json` 中已有的 `warmup_steps` 字段保留原名（避免破坏已写好的 Zod/JSON Schema 与现有测试 fixture），但补充语义说明：**单位为 epoch，而非 mini-batch step**。

> 备选方案（已否决）：在 `recipe_schema.json` 层也直接暴露 `warmup_ratio`，省去换算。否决原因：`warmup_steps` 字段已经存在于 3 处 schema/类型定义并被多个 example/测试引用，复用成本最低；`warmup_ratio` 仅作为 ModelRecipe 这一层"更友好的旋钮"。

### 2.2 Warmup 作为「正交修饰符」，而非新的 scheduler 类型

不新增 `scheduler.type = "linear"`，而是让 `warmup_steps > 0` 可以叠加在**任意**现有 `type`（包括 `none`）之上：

| scheduler.type | warmup_steps = 0（现状） | warmup_steps > 0（新行为） |
|---|---|---|
| `none` | 全程恒定 LR | 前 N epoch 线性从 `start_factor * lr` 升到 `lr`，之后恒定 |
| `cosine` | `CosineAnnealingLR(T_max=max_epochs)` | 前 N epoch 线性升温，之后 `CosineAnnealingLR(T_max=max_epochs - N)` |
| `one_cycle` | `OneCycleLR(total_steps=max_epochs)`，自带 `pct_start=0.3` 内置预热 | `warmup_steps` 换算为 `pct_start = warmup_steps / max_epochs`（覆盖默认 0.3）|
| `plateau` | `ReduceLROnPlateau` | 前 N epoch 线性升温（手动维护 LR，不调用 plateau.step）；之后正常进入 `ReduceLROnPlateau` |

### 2.3 调度粒度维持 epoch（不改为按 batch step）

把 `scheduler.step()` 改成按 mini-batch 调用是一次较大的训练循环重构（影响所有 4 种 scheduler、日志、checkpoint 逻辑），超出本次"加 warmup"的范围，且：
- 当前训练预算很短（smoke=2 epoch，正式 run 受 `time_budget_s=600s` 限制，epoch 数通常个位数到几十），按 epoch 做线性预热已经足够实用。
- 如未来确有需要按 step 预热，可作为独立的后续改动（见第 7 节"潜在问题"）。

---

## 3. 具体修改清单

### 3.1 `neo_cast/py/schemas/model_recipe_schema.json`

在 `training.properties` 中新增：

```json
"warmup_ratio": {
  "type": "number",
  "minimum": 0.0,
  "maximum": 0.5,
  "default": 0.0,
  "description": "Fraction of max_epochs (rounded) used for linear LR warmup, from start_factor*lr to lr. 0 disables warmup."
}
```

无需加入 `required` 列表（保持可选、默认 0，向后兼容）。

### 3.2 `neo_cast/py/schemas/recipe_schema.json`

`training_strategy.scheduler.warmup_steps` 字段定义不变（已是 `integer, minimum: 0`），仅补充 `description` 说明单位为 epoch：

```json
"warmup_steps": {
  "type": "integer",
  "minimum": 0,
  "description": "Number of leading epochs used for linear LR warmup (epoch granularity, not mini-batch steps). Must be < training_strategy.budget.max_epochs."
}
```

> 是否要加跨字段校验 `warmup_steps < budget.max_epochs`？JSON Schema draft-07 做跨字段比较较繁琐（需要 `if/then` + 字段比较，原生不支持两数字段比较）。建议：**校验放在编译期 Python 代码和 TS 的 `validateTSFCandidate` 后置检查中**，schema 本身只做范围约束。

### 3.3 `opencode/packages/opencode/src/research/domains/tsf.ts`

1. `scheduler` Zod schema 增加注释，无需新增字段（`warmupSteps` 已存在）。
2. 在 `validateTSFCandidate`（或紧邻的后置校验函数）中增加：
   ```typescript
   if (scheduler.warmupSteps >= budget.maxEpochs) {
     issues.push("training_strategy.scheduler.warmupSteps must be less than budget.maxEpochs")
   }
   ```
3. **顺带修正**第 0 节提到的 `bridge_supported` 不一致问题：将 `cosine/one_cycle/plateau` 的 `bridgeSupported` 改为 `false`，与 Python `action_specs.py` 一致（避免 TS 层放行了 Python `recipe_bridge.py` 会拒绝的组合，造成"先校验通过、跑到 bridge 才报错"的体验问题）。

### 3.4 `neo_cast/py/model_recipe.py` — `_compile_training()`

```python
def _compile_training(training: dict[str, Any]) -> dict[str, Any]:
    max_epochs = _positive_int(training.get("max_epochs"), 10)
    warmup_ratio = float(training.get("warmup_ratio", 0.0))
    warmup_steps = round(warmup_ratio * max_epochs)
    warmup_steps = max(0, min(warmup_steps, max_epochs - 1))

    return {
        "loss": {"base": training["loss"], "horizon_weighting": "uniform"},
        "optimizer": {
            "type": training["optimizer"],
            "lr": float(training["learning_rate"]),
            "weight_decay": float(training.get("weight_decay", 0.0)),
        },
        "scheduler": {"type": "none", "warmup_steps": warmup_steps},
        "regularization": {
            "dropout": 0.1,
            "grad_clip": float(training.get("grad_clip", 1.0)),
        },
        "budget": {
            "max_epochs": max_epochs,
            "time_budget_s": _positive_int(training.get("time_budget_s"), 600),
            "batch_size": _positive_int(training.get("batch_size"), 32),
            "patience": _positive_int(training.get("patience"), 5),
            "seed": _positive_int(training.get("seed"), 42),
        },
    }
```

> 注意：`scheduler.type` 仍默认编译为 `"none"`（与现状一致，ModelRecipe 目前不暴露 `scheduler.type` 选择）。`warmup_steps > 0` + `type="none"` 是本次新增的合法组合，需要 `train.py` 支持（见 3.6）。

### 3.5 `neo_cast/py/registry/action_specs.py`

不新增 action 类型。建议新增一个独立的校验函数（供 `recipe_bridge.py` 和单元测试复用）：

```python
def validate_scheduler_warmup(training_strategy: dict[str, Any]) -> list[str]:
    errors = []
    scheduler = training_strategy.get("scheduler", {})
    warmup_steps = scheduler.get("warmup_steps", 0)
    max_epochs = training_strategy.get("budget", {}).get("max_epochs", 1)
    if warmup_steps and warmup_steps >= max_epochs:
        errors.append("scheduler.warmup_steps must be < budget.max_epochs")
    return errors
```

### 3.6 `neo_cast/py/train.py` —— 核心实现

这是唯一让 warmup **真正生效**的地方。当前 `_build_scheduler` 直接 `return` 单个 PyTorch scheduler；`ReduceLROnPlateau` 不是 `_LRScheduler` 子类，不能直接用 `SequentialLR` 组合，因此需要一个自定义包装类。

```python
class _LinearWarmupWrapper:
    """前 warmup_epochs 个 epoch 内线性升温 LR；之后委托给 base_scheduler（可为 None）。"""

    def __init__(self, optimizer, warmup_epochs: int, base_scheduler, start_factor: float = 0.1):
        self._optimizer = optimizer
        self._warmup_epochs = warmup_epochs
        self._base_scheduler = base_scheduler
        self._start_factor = start_factor
        self._base_lrs = [group["lr"] for group in optimizer.param_groups]
        self._epoch = 0
        self._apply_warmup_lr()

    def _apply_warmup_lr(self) -> None:
        progress = min(self._epoch / max(self._warmup_epochs, 1), 1.0)
        factor = self._start_factor + (1.0 - self._start_factor) * progress
        for group, base_lr in zip(self._optimizer.param_groups, self._base_lrs):
            group["lr"] = base_lr * factor

    def step(self, val_loss: float | None = None) -> None:
        self._epoch += 1
        if self._epoch <= self._warmup_epochs:
            self._apply_warmup_lr()
            return
        if self._base_scheduler is None:
            return
        if isinstance(self._base_scheduler, torch.optim.lr_scheduler.ReduceLROnPlateau):
            self._base_scheduler.step(val_loss)
        else:
            self._base_scheduler.step()


def _build_scheduler(optimizer, candidate, *, max_epochs: int):
    strategy = _recipe_training_strategy(candidate)
    scheduler_cfg = strategy.get("scheduler", {})
    scheduler_type = scheduler_cfg.get("type", "none")
    warmup_steps = int(scheduler_cfg.get("warmup_steps", 0))
    warmup_steps = max(0, min(warmup_steps, max(max_epochs - 1, 0)))

    remaining_epochs = max(max_epochs - warmup_steps, 1)

    base_scheduler = None
    if scheduler_type == "cosine":
        base_scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=remaining_epochs)
    elif scheduler_type == "one_cycle":
        max_lr = max(float(group["lr"]) for group in optimizer.param_groups)
        pct_start = (warmup_steps / max_epochs) if warmup_steps else 0.3
        return torch.optim.lr_scheduler.OneCycleLR(
            optimizer, max_lr=max_lr, total_steps=max(max_epochs, 1), pct_start=pct_start,
        )  # one_cycle 自带预热，warmup_steps 直接映射为 pct_start，不再走 wrapper
    elif scheduler_type == "plateau":
        base_scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
            optimizer, mode="min",
            factor=float(scheduler_cfg.get("factor", 0.5)),
            patience=int(scheduler_cfg.get("patience", 1)),
        )
    elif scheduler_type not in {None, "none"}:
        raise ValueError(f"Unsupported scheduler: {scheduler_type}")

    if warmup_steps > 0:
        return _LinearWarmupWrapper(optimizer, warmup_steps, base_scheduler)
    return base_scheduler
```

`_step_scheduler` 需要兼容新包装类：

```python
def _step_scheduler(scheduler, val_loss: float) -> None:
    if scheduler is None:
        return
    if isinstance(scheduler, _LinearWarmupWrapper):
        scheduler.step(val_loss)
    elif isinstance(scheduler, torch.optim.lr_scheduler.ReduceLROnPlateau):
        scheduler.step(val_loss)
    else:
        scheduler.step()
```

调用处 `if schedulers[horizon] is not None:` 不需要变化（`_build_scheduler` 在 `warmup_steps=0 且 type=none` 时仍返回 `None`，与现状一致）。

### 3.7 `renderer.py`

**无需修改**。`scheduler` 配置作为 `training_strategy` 的一部分随整个 `recipe` 一起透传到 `resolved_candidate.recipe.training_strategy.scheduler`，`train.py` 通过 `_recipe_training_strategy()` 直接读取。

### 3.8 `neo_cast/py/recipe_bridge.py`

当前规则：`scheduler.type != "none"` → 拒绝。

需要决定 **warmup 是否在 Phase A/B bridge 上可用**：

- **建议**：维持 bridge 限制为 `scheduler.type == "none" AND scheduler.warmup_steps == 0`。
  理由：bridge 的设计目标是"最简单、最快、最确定性"的冒烟验证（2 epoch），引入 warmup 会让 2-epoch 冒烟里 1 个 epoch 都在升温，偏离真实训练曲线，且收益很小。
  ```python
  scheduler_type = training_strategy.get("scheduler", {}).get("type", "none")
  warmup_steps = training_strategy.get("scheduler", {}).get("warmup_steps", 0)
  if scheduler_type != "none" or warmup_steps:
      errors.append("Phase A/B bridge only supports scheduler.type='none' with warmup_steps=0")
  ```
- 由于 ModelRecipe 编译后 `scheduler.type` 始终为 `"none"`，只要同时把 `warmup_ratio` 在 bridge 阶段强制视为 0（或在 `_compile_training` 中：若目标 phase 为 bridge，则忽略 `warmup_ratio`），即可保证 bridge 候选始终满足新规则。具体由调用 `_compile_training` 时是否已知目标 phase 决定——如果编译时不知道 phase，则把"是否允许 warmup"的裁剪放在 `recipe_bridge.py` 的过滤逻辑里（已在做类似事情）。

### 3.9 `neo_cast/py/search/mutate.py`

`_default_training_strategy()`（第 100 行附近）当前写死 `"scheduler": {"type": "none", "warmup_steps": 0}`，**无需改动**（默认仍是无预热，符合"新字段默认关闭"的兼容性要求）。如果希望变异搜索（mutation search）也能探索 warmup，可以后续单独加一个 mutation operator，但**不在本次范围内**。

---

## 4. 示例文件更新

### 4.1 `neo_cast/py/schemas/model_recipe.example.json`

在 `training` 中加入：
```json
"training": {
  "loss": "mse",
  "optimizer": "adamw",
  "learning_rate": 0.001,
  "batch_size": 64,
  "max_epochs": 8,
  "time_budget_s": 600,
  "patience": 4,
  "seed": 42,
  "warmup_ratio": 0.25
}
```
（`warmup_ratio=0.25` × `max_epochs=8` → `warmup_steps=2`）

### 4.2 `neo_cast/py/schemas/recipe.example.json` 等 7 个 recipe example

这些是 `CandidateRecipe` 层示例，`scheduler.warmup_steps` 字段已存在（值为 0），**保持不变**即可，无需逐一更新（field 已合法）。可选：挑 1-2 个非 bridge 示例（如 `recipe_native.example.json`）演示 `warmup_steps > 0 + type=cosine` 的组合，便于测试覆盖。

---

## 5. LLM Prompt / 文档更新

`opencode/packages/opencode/src/research/llm-proposal.ts` 中：
- 第 386 行附近的字段说明列表，补充：
  ```
  training_strategy.scheduler.warmup_steps: int ≥ 0, must be < budget.max_epochs (epoch granularity, linear LR warmup)
  ```
- 如果 ModelRecipe 层 prompt（高层 DSL 生成）也列出了 `training` 字段清单，需要加上 `warmup_ratio: number in [0, 0.5], default 0`。

并更新 `文档/ModelRecipe体系说明.md` 中 `training` 字段表格，加入 `warmup_ratio` 一行。

---

## 6. 受影响的测试

| 文件 | 需要的改动 |
|---|---|
| `neo_cast/py/tests/test_train_execution.py` | 新增用例：`scheduler={"type":"none","warmup_steps":1}, max_epochs=3` 验证前 1 epoch LR 被线性缩放、第 2 epoch 起恢复基准 LR；`scheduler={"type":"cosine","warmup_steps":1}` 验证 wrapper → cosine 切换 |
| `neo_cast/py/tests/test_recipe_factory.py` | 若覆盖 `_compile_training`，新增 `warmup_ratio` → `warmup_steps` 换算用例（含边界：`warmup_ratio=0.5, max_epochs=2` → `warmup_steps` 钳制为 1） |
| `neo_cast/py/tests/test_mutate.py` | 确认默认 `_default_training_strategy()` 仍返回 `warmup_steps=0`，无回归 |
| `opencode/.../test/research/tsf-domain.test.ts` | 新增校验用例：`warmupSteps >= maxEpochs` → 报错；`bridgeSupported` 修正后的 scheduler 组合校验 |
| `opencode/.../test/research/llm-proposal.test.ts` | 若涉及 `pruneCandidateSpec` 默认值填充，确认 `scheduler.warmupSteps` 默认 0 时仍正常通过 |
| `opencode/.../test/research/service.test.ts`、`model-designer-agent.test.ts` | 仅在它们直接断言 scheduler 字段时需要检查，预计无需改动 |

---

## 7. 潜在问题与风险

1. **粒度语义混淆**：`warmup_steps` 字段名暗示"step"（常见于 HuggingFace 等按 mini-batch 计的预热），但本系统按 epoch step 调度器。务必在 schema `description` 和 prompt 中明确标注"epoch 粒度"，否则 LLM 可能填入类似 `500`（典型 NLP 预热步数）这种远超 `max_epochs` 的值，导致被钳制为 `max_epochs - 1`、产生"全程都在预热"的非预期行为。

2. **`one_cycle` 与显式 warmup 的语义重叠**：`OneCycleLR` 自带 `pct_start`（默认 0.3）实现预热+退火。若同时允许用户设置 `warmup_steps` 又用于 `one_cycle`，两套"预热"概念容易混淆。本方案选择把 `warmup_steps` 映射为 `pct_start`，**覆盖默认值**——需要在文档中明确说明"对 one_cycle 而言，warmup_ratio 等价于 pct_start，而非额外叠加的预热阶段"。

3. **`ReduceLROnPlateau` 不是 `_LRScheduler`**：无法用 PyTorch 内置 `SequentialLR`/`ChainedScheduler` 组合，必须手写 `_LinearWarmupWrapper`。需要保证 `_step_scheduler` 中的 `isinstance` 分支顺序正确（`_LinearWarmupWrapper` 检查必须在 `ReduceLROnPlateau` 检查之前，否则会被误判）。

4. **极小 `max_epochs` 下的边界行为**：smoke 阶段 `max_epochs=2`。`warmup_steps = max(0, min(round(ratio*2), 1))`：
   - `ratio<0.25` → `warmup_steps=0`（无预热）
   - `ratio>=0.25` → `warmup_steps=1`（一半训练在预热，且 cosine 的 `T_max=remaining_epochs=1`，退火曲线几乎退化为常数）
   这种"几乎全是预热"的极端情况在短训练里很常见，需要在测试中显式覆盖，避免出现除零（`remaining_epochs` 已用 `max(..., 1)` 兜底）或 NaN 学习率。

5. **Bridge 一致性**：3.8 节提到的 bridge 限制需要 Python（`recipe_bridge.py`）与 TS（`tsf.ts` 校验/`bridgeSupported` 标记）两端同步更新，否则会出现"TS 层放行、Python bridge 运行时报错"的体验问题——这也是顺带修复既有不一致 bug 的好时机。

6. **断点续训 / checkpoint 恢复**：如果未来支持训练中断后恢复（当前看起来是一次性 600s 训练循环，应该不涉及），`_LinearWarmupWrapper` 的内部状态（`self._epoch`）需要参与 checkpoint 的保存/恢复。当前架构下风险较低，但落地时应确认 `train.py` 是否存在任何形式的断点续训路径。

7. **Schema 版本号**：本次改动是**新增可选字段 + 默认值**，不破坏现有 `model_recipe.v1` / `recipe_schema_v1` 文档的合法性，因此**不需要**升级 `schema_version` 常量。但建议在 CHANGELOG / 迁移说明中记录此次新增字段，方便未来排查"为什么旧 recipe 没有 warmup 字段也能跑"。

8. **`_compile_training` 的 phase 感知问题（见 3.8）**：当前 `_compile_training(training)` 函数签名不感知目标 phase（bridge vs 完整 recipe），如果要在编译期就裁剪掉 bridge 候选的 warmup，需要新增参数（如 `target_phase` 或 `is_bridge: bool`），这会改变函数签名并影响所有调用方——需要逐一确认调用点。**替代方案**（推荐）：编译期始终按 `warmup_ratio` 计算 `warmup_steps`，把"bridge 不允许 warmup"的裁剪完全交给 `recipe_bridge.py` 的过滤/拒绝逻辑（已是现状的职责划分），避免改动 `_compile_training` 签名。

---

## 8. 实施步骤 Checklist

- [ ] `model_recipe_schema.json`：`training.warmup_ratio` (number, 0.0-0.5, default 0.0)
- [ ] `recipe_schema.json`：补充 `scheduler.warmup_steps` 的 `description`（epoch 粒度说明）
- [ ] `tsf.ts`：scheduler 校验增加 `warmupSteps < budget.maxEpochs`；修正 `bridgeSupported` 与 `action_specs.py` 一致
- [ ] `model_recipe.py`：`_compile_training` 增加 `warmup_ratio → warmup_steps` 换算 + 钳制
- [ ] `action_specs.py`：新增 `validate_scheduler_warmup()`
- [ ] `train.py`：实现 `_LinearWarmupWrapper`，重写 `_build_scheduler`/`_step_scheduler`
- [ ] `recipe_bridge.py`：bridge 拒绝 `warmup_steps > 0`
- [ ] `model_recipe.example.json`：示例加入 `warmup_ratio: 0.25`
- [ ] `llm-proposal.ts` prompt 字段说明更新
- [ ] `文档/ModelRecipe体系说明.md`：`training` 字段表格补充 `warmup_ratio`
- [ ] 单元测试：`test_train_execution.py`、`test_recipe_factory.py`、`tsf-domain.test.ts` 新增用例
- [ ] 回归：现有 `recipe.example.json` 等（`warmup_steps=0`）确认行为与改动前一致
