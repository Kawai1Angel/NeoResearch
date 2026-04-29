# Neo-Research TSF Program

## Setup

1. Agree on a run tag, for example `apr21-etth1`.
2. Create a fresh research branch: `git checkout -b neo-research/<tag>`.
3. Read the in-scope files:
   - `prepare_tsf.py` — fixed constants, split boundaries, dataloaders, evaluation
   - `train.py` — the only file you are allowed to modify
   - `program.md` — the behavior protocol
4. Verify visible data exists under `~/.cache/neo_research_tsf/dataset/ETT-small/`:
   - `ETTh1_visible.csv`
   - `ETTh1_ref_test.csv` is runner-only and should not be read by the agent
5. If `ETTh1_visible.csv` does not exist, ask the human/runner to materialize it:
   - `uv run prepare_tsf.py --materialize-visible --source-csv /path/to/ETTh1.csv`
6. Initialize `results.tsv` with the header row only:

```tsv
commit	val_avg_mse	val_h96_mse	val_h720_mse	params_M	status	description
```

7. `promotion.tsv` is privileged and must not be read by the agent.
8. Record `last_keep_commit` as the current baseline commit, then start the loop.

Optional local helper:

```bash
python runner.py init
python runner.py run --description "baseline"
python runner.py status
```

## Rules

You may:
- Modify `train.py`
- Run `uv run train.py`
- Read `run.log`
- Append results to `results.tsv`

You may not:
- Modify `prepare_tsf.py`
- Read or write `promotion.tsv`
- Query reference test directly
- Install new packages
- Change the evaluation contract

## Goal

Minimize `val_avg_mse` on the validation split.

Secondary preferences:
- Simpler code is better when gains are small
- Lower parameter count is better when accuracy is comparable
- Avoid brittle hacks

## Output Contract

The training script prints a summary like:

```text
---
val_avg_mse:      0.437600
val_h96_mse:      0.391200   val_h96_mae:     0.402100
val_h192_mse:     0.423500   val_h192_mae:    0.427800
val_h336_mse:     0.453800   val_h336_mae:    0.451200
val_h720_mse:     0.481900   val_h720_mae:    0.479400
training_seconds: 587.2
total_seconds:    612.4
peak_vram_mb:     4210.3
num_params_M:     2.14
```

Extract the result with:

```bash
grep "^val_avg_mse:\|^num_params_M:\|^WARNING" run.log
```

## Logging

Append every finished experiment to `results.tsv` using tab separation.

- `commit`: short git hash
- `val_avg_mse`: main decision metric
- `val_h96_mse`, `val_h720_mse`: representative short/long horizons
- `params_M`: total parameter count across all horizon models
- `status`: `keep`, `discard`, or `crash`
- `description`: one-line summary of the idea

If a run crashes:
- set metric columns to `NA`
- set `status` to `crash`
- briefly describe the failure

## Loop

LOOP FOREVER:

1. Inspect the current commit and branch.
2. Propose one concrete experimental change to `train.py`.
3. Commit the change.
4. Run the experiment:

```bash
uv run train.py > run.log 2>&1
```

5. Read the result summary:

```bash
grep "^val_avg_mse:\|^num_params_M:\|^WARNING" run.log
```

6. If grep is empty, inspect the crash:

```bash
tail -n 50 run.log
```

7. Log the run in `results.tsv`.
8. Decision:
   - If `val_avg_mse` improved, keep the commit and update `last_keep_commit`.
   - If `val_avg_mse` is equal or worse, discard it by moving the research branch `HEAD` back to `last_keep_commit`.
9. After every `PROMOTION_INTERVAL` keeps (default 5), let the runner/human perform one privileged reference-test query. That result must go only to `promotion.tsv`.

## Research Directions

Try these first:
- CI to CD strategy changes
- patching (`patch_size=16/32`, `stride=8/16`)
- trend / remainder decomposition
- MLP-style temporal mixing
- frequency-domain auxiliary features

Try these later:
- shared backbone with horizon-specific heads
- multi-scale branches
- asymmetric losses
- teacher-student distillation

## Simplicity Criterion

- A tiny improvement with much more complexity is usually not worth keeping.
- An equal result with simpler code is a win.
- A parameter increase larger than 5M with negligible gain is usually not worth keeping.
