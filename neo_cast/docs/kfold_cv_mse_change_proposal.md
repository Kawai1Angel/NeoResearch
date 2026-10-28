# Ratio-based Time-series K-Fold MSE Objective Proposal

## 1. Background and Goals

NeoCast currently ranks candidates and makes keep/discard decisions using val_avg_mse: mean MSE across configured horizon on the fixed validation split.

```text
val_avg_mse = mean(val_h{H}_mse for H in horizons)
```

This proposal changes the search objective to chronological K-Fold cv_avg_mse under these constraints:

- Preserve val_avg_mse separately; the metrics have distinct meanings.
- Do not use random K-Fold or leak future observations.
- Define folds as proportions of the visible interval to support different dataset lengths.
- Use cv_avg_mse only for candidate ranking and keep/discard.
- Train the final checkpoint on the original train split, using the original val split for early stopping and validation.
- Exclude ref_test from fold generation, normalization, training, early stopping, and candidate selection.
- Reuse train.py, WindowDataset, evaluation functions, and artifact contracts where possible.

## 2. Non-goals

The first version excludes:

- Random K-Fold and shuffled-time cross-validation.
- Sliding-window CV, parallel folds, and multiple seeds across multiple folds.
- Fold-model ensembles.
- Replacing the objective with cv_std_mse-based penalties such as mean + lambda * std.
- Silently reducing fold counts when data is insufficient.
- Selecting a fold checkpoint as the final checkpoint.

## 3. Final Execution Protocol

Each candidate follows this execution order:

```text
smoke test
    │
    ├── Failure: crash and stop
    │
    └── Success
          │
          ▼
Ratio-based expanding-window K-Fold
    │
    ├── Any fold fails: crash and stop
    │
    └── All succeed: generate cv_metrics.json
          │
          ▼
Train on the original train split and validate on the original val split
    │
    ├── Generate val_metrics.json
    ├── Save the final checkpoint
    └── Generate standard training_summary.json
          │
          ▼
Runner uses cv_avg_mse for keep/discard
```

CV precedes standard training to avoid spending another training budget after CV failure. Run standard training in a separate subprocess without fold overrides so its checkpoint and scaler follow the original train/val protocol.

## 4. Metric Definitions

### 4.1 Standard Validation Metric

Keep the current val_avg_mse definition and output location:

```text
val_avg_mse = mean_H(val_hH_mse)
```

It describes the final checkpoint on the original val split and no longer controls keep/discard.

### 4.2 Per-fold Metrics

Reuse existing validation to produce these metrics for each fold:

```text
fold_i_hH_mse
fold_i_avg_mse = mean_H(fold_i_hH_mse)
```

A fold subprocess may emit val_avg_mse because it evaluates that fold's validation interval. The parent must store it as a fold detail, never overwrite the final artifact's standard val_metrics.json with it.

### 4.3 CV Aggregation

```text
cv_avg_mse = mean_i(fold_i_avg_mse)
cv_std_mse = population_std_i(fold_i_avg_mse)
cv_hH_mse = mean_i(fold_i_hH_mse)
```

Use a macro-average across folds, giving each time interval equal weight. Validation proportions match; rounding may cause a one-row difference.

Candidate decision rule:

```python
improved = best_cv_avg_mse is None or cv_avg_mse < best_cv_avg_mse
```

cv_std_mse supports diagnostics and reflection only; it does not affect ranking.

## 5. Proportional Fold Generation

### 5.1 Visible Interval

CV uses only the union of the original train and val intervals:

```python
cv_start = BORDER_TRAIN[0]
cv_end = BORDER_VAL[1]
visible_rows = (cv_start, cv_end)
```

Required conditions:

```text
cv_end <= BORDER_TEST[0]
```

### 5.2 Defaults

```json
{
  "strategy": "expanding_window_ratio",
  "num_folds": 4,
  "initial_train_ratio": 0.6,
  "min_train_windows": 1,
  "min_eval_windows": 1
}
```

Compute each fold's validation fraction automatically:

```text
fold_val_ratio = (1 - initial_train_ratio) / num_folds
```

The defaults produce:

```text
Fold 0: train 0%–60%, val 60%–70%
Fold 1: train 0%–70%, val 70%–80%
Fold 2: train 0%–80%, val 80%–90%
Fold 3: train 0%–90%, val 90%–100%
```

All percentages refer to the visible train+val interval, rather than the full dataset.

### 5.3 Row Boundaries

Compute proportional boundaries directly to avoid accumulated rounding error. Force the final fold's val_end to visible_end:

```python
def build_ratio_folds(
    visible_rows: tuple[int, int],
    *,
    num_folds: int,
    initial_train_ratio: float,
) -> list[TimeSeriesFold]:
    visible_start, visible_end = visible_rows
    visible_length = visible_end - visible_start
    fold_val_ratio = (1.0 - initial_train_ratio) / num_folds
    folds = []

    for fold_index in range(num_folds):
        train_end_ratio = initial_train_ratio + fold_index * fold_val_ratio
        val_end_ratio = initial_train_ratio + (fold_index + 1) * fold_val_ratio

        train_end = visible_start + round(visible_length * train_end_ratio)
        val_start = train_end
        val_end = (
            visible_end
            if fold_index == num_folds - 1
            else visible_start + round(visible_length * val_end_ratio)
        )

        folds.append(
            TimeSeriesFold(
                fold_index=fold_index,
                train_rows=(visible_start, train_end),
                val_rows=(val_start, val_end),
            )
        )

    return folds
```

Requirements:

- `num_folds >= 2`.
- `0 < initial_train_ratio < 1`.
- Training intervals expand monotonically.
- Validation intervals are chronological, contiguous, and nonoverlapping.
- The final validation end equals visible_end exactly.

### 5.4 Valid Windows

Validation may use the training tail as lookback, but every prediction target must fall entirely within fold validation:

```text
required_train_length = input_len + max_horizon + min_train_windows - 1
required_val_length = max_horizon + min_eval_windows - 1
```

Validate all folds before training. If any fold is invalid, report dataset length, fold boundaries, and minimum requirements. Do not silently reduce fold counts.

## 6. Minimal Implementation Changes

### 6.1 Add py/cv_train.py

Wrap the existing train.py with an orchestrator that:

1. Reads the visible interval from the original task specification.
2. Generates and validates proportional folds.
3. Starts an independent train.py subprocess for each fold.
4. Parses eval_done and artifact events from each subprocess.
5. Aggregates and writes cv_metrics.json.
6. Runs standard train.py once without split overrides.
7. Attaches cv_metrics.json to the standard-training artifact.
8. Emits unified runner events containing both val_* and cv_* metrics.

Separate subprocesses reuse module-level BORDER_TRAIN, BORDER_VAL, and _VISIBLE_BUNDLE while isolating scalers, models, optimizer, scheduler, and early-stopping state between folds.

### 6.2 Controlled Split Overrides in prepare_tsf.py

Only CV subprocesses set:

```text
NEO_CAST_TRAIN_ROWS=0:6000
NEO_CAST_VAL_ROWS=6000:7000
NEO_CAST_CV_FOLD_INDEX=0
```

Add strict parsing and validation in prepare_tsf.py:

- Require train and val overrides together.
- Restrict overrides to the original visible train+val interval.
- Never include ref_test.
- `train_end <= val_start`.
- Require nonempty integer ranges.

Explicitly remove these variables from the standard-training subprocess environment so the final checkpoint uses the original splits.

### 6.3 Runner Changes

When CV is enabled, switch full training from train.py to cv_train.py; smoke still uses train.py.

Add to RunnerState:

```python
best_cv_avg_mse: float | None = None
```

After standard training, read separately:

```python
val_avg_mse = float(val_metrics["val_avg_mse"])
cv_avg_mse = float(cv_metrics["cv_avg_mse"])
```

Compare only cv_avg_mse for keep/discard. Legacy sessions without best_cv_avg_mse remain readable, but enabling CV starts a new session so validation champions and CV champions are not mixed.

### 6.4 Results and Display

Add to results.tsv:

```text
cv_avg_mse
cv_std_mse
```

Keep val_avg_mse; calculate is_best from cv_avg_mse.

Node sessions, Companion output, reflection, and LLM context should show:

- cv_avg_mse: primary metric.
- cv_std_mse: stability across time intervals.
- val_avg_mse: the final checkpoint's original-split validation metric.
- Fold details for analyzing temporal drift.

Move metric-dependent mutation thresholds from val_avg_mse to cv_avg_mse. Do not alias the field names or state fields.

## 7. Artifact Contract

The final artifact is based on standard train/val training:

```text
artifacts/run_<run_id>/
├── model.pt                 # Final checkpoint trained on the original train split
├── candidate.json
├── preprocess.json          # Scaler/preprocessing fitted on the original train split
├── training_summary.json    # Standard training summary
├── val_metrics.json         # Original validation split metrics
└── cv_metrics.json          # K-Fold aggregates and details
```

Temporary fold artifacts do not join the final checkpoint set. On success, copy only metrics and necessary logs; temporary lifecycle cleanup may remove fold checkpoints. On failure, retain fold indices, exit codes, and log locations for diagnosis.

Suggested cv_metrics.json format:

```json
{
  "schema_version": "cv_metrics.v1",
  "protocol": {
    "strategy": "expanding_window_ratio",
    "protocol_id": "expanding_window_ratio_k4_train60_v1",
    "num_folds": 4,
    "initial_train_ratio": 0.6,
    "fold_val_ratio": 0.1,
    "visible_rows": [0, 10000],
    "input_len": 336,
    "horizons": [96, 192, 336, 720]
  },
  "cv_avg_mse": 0.4478,
  "cv_std_mse": 0.0131,
  "cv_avg_mae": 0.5012,
  "cv_h96_mse": 0.3914,
  "cv_h192_mse": 0.4218,
  "cv_h336_mse": 0.4582,
  "cv_h720_mse": 0.5198,
  "folds": [
    {
      "fold_index": 0,
      "train_rows": [0, 6000],
      "val_rows": [6000, 7000],
      "val_avg_mse": 0.4612
    }
  ]
}
```

Derive protocol_id from every comparability factor: strategy, fold count, initial training ratio, horizons, input length, and window rules. Do not compare candidates with different protocols directly.

## 8. Error Handling

Any of these conditions fails the entire candidate evaluation:

- Invalid fold boundaries or insufficient windows.
- A nonzero fold subprocess exit code.
- Missing eval_done or artifact events from any fold.
- Missing, NaN, or infinite required metrics.
- Completed fold count differs from configuration.
- Any fold accesses ref_test.
- Standard train/val training fails.

Do not omit failed folds and average the rest: failure on difficult intervals could otherwise produce an artificially favorable score.

## 9. File Changes

### Required Changes

- `py/cv_train.py`
  - Add proportional fold generation, validation, subprocess scheduling, aggregation, and standard-training orchestration.
- `py/prepare_tsf.py`
  - Add controlled train/val boundary overrides.
- `py/runner.py`
  - Read cv_avg_mse, add state fields, and switch keep/discard.
- `py/search/mutate.py`
  - Switch metric-driven mutation to cv_avg_mse.
- `src/session.js`
  - Determine session champions from cv_avg_mse.
- `src/loop.js`,`src/output.js`,`src/reflect.js`,`src/llm.js`
  - Display and describe CV metrics separately.
- `py/schemas/metadata_schema.json`
  - Add a strict CV-metrics metadata structure.

### Tests and Documentation

- `py/tests/test_cv_train.py`
- Existing prepare_tsf split/scaler test modules.
- py/tests/test_runner_curves.py or dedicated runner CV tests.
- Node session, loop, and output tests.
- Primary-metric descriptions in README, usage, and architecture documents.

## 10. Test Plan

### 10.1 Fold Generation

- Correct proportional boundaries for lengths such as 10,000 and 12,347 rows.
- Final validation ends exactly at the visible-interval boundary.
- Training expands monotonically; validation intervals are contiguous and nonoverlapping.
- Explicit errors for invalid ratios, fold counts, and insufficient windows.
- No fold accesses ref_test.

### 10.2 Leakage

Use data with clearly different training/validation distributions to verify each scaler fits only that fold's training rows.

Verify lookback may use the training tail while every forecast target remains inside fold validation.

### 10.3 Training Isolation

- Fresh model, optimizer, scheduler, and early-stopping state per fold.
- Reproducible behavior under the same seed rule.
- No fold override in standard training.
- Final model.pt and preprocess.json come from standard train/val, rather than the final fold.

### 10.4 Aggregation

- Correct cv_avg_mse, cv_std_mse, and per-horizon averages.
- Fold metrics never overwrite the parent's val_metrics.json.
- NaN, Inf, missing metrics, or fold failure fail the whole evaluation.

### 10.5 Runner and Compatibility

- Lower cv_avg_mse means keep; equal or higher means discard.
- Discard even when val_avg_mse decreases if cv_avg_mse increases.
- Do not compare distinct protocol_id values directly.
- Read old state without treating a legacy validation champion as a CV champion.
- Preserve smoke behavior and standard-training artifact compatibility.

After implementation, run:

```bash
cd neo_cast
npm test
node ./bin/neo-cast.js validate recipe py/schemas/recipe_native.example.json
```

## 11. Implementation Stages

### Stage One: CV Executor and Data Boundaries

Implement pure fold-generation/validation functions, split overrides, and cv_train.py subprocess orchestration. Generate cv_metrics.json first without switching the runner objective yet.

Acceptance: correct fold ratios, no leakage, and correct final-checkpoint provenance.

### Stage Two: Switch the Primary Metric

Add runner state/results fields and switch keep/discard, session champion, and mutation to cv_avg_mse. Keep val_avg_mse as a diagnostic for the standard checkpoint.

Acceptance: reverse the rankings of val_avg_mse and cv_avg_mse in a test and verify decisions strictly follow CV.

### Stage Three: Schema, Output, and Documentation

Complete metadata schemas, exports, LLM prompts, reflection, CLI display, and usage documentation; freeze cv_metrics.v1 and protocol_id semantics.

Acceptance: Python, Node, artifacts, and documentation agree on the two distinct metric meanings.

## 12. Performance and Later Optimization

Each candidate requires approximately K+1 full training runs: about five at the default K=4. Protocol correctness takes priority in version one.

If this cost is excessive, later add staged evaluation:

```text
screening: the most recent fold with a small budget; ineligible for champion selection
full_cv: all K folds; eligible for champion selection
standard: original train/val training to generate the final checkpoint
```

Every champion contender must complete the same full-CV protocol. Never compare screening scores with cv_avg_mse.

## 13. Recommended Defaults

- CV strategy: expanding window.
- folds:4.
- Initial training fraction: 60%.
- Validation per fold: divide the remaining 40% evenly.
- Gap: 0; add configurable gaps later for delayed label availability.
- Fold seed: use the candidate's same base seed, rather than seed + fold_index.
- Aggregation: macro-average across folds.
- Dispersion: population standard deviation, reported only.
- Small datasets: fail before training rather than silently change the protocol.
- Checkpoint: always the standard original train/val training result.
- Champion: determined only by cv_avg_mse.

