# Neo-cast Workstream Description

This paper describes the current actual workflow of `neo-cast` CLI: from data preparation, candidate model generation, validation, training, evaluation, screening, to final export of artifact and ref-test reports.

The current version can be read as follows:

```text
Prepare a standardized time-series prediction mission
  - > Generate small models based on natural language needs
  ->Certify candidate to run
  - > Train and evaluate.
  According to val_avg_mse keep/discard
  - ♪ Exportable inference ♪
  The best thing to do is runner-only ref-test
```

## Overview

The main `neo-cast` workflow is organized around the `.neo-cast/` work directory:

```text
source CSV
  -> prepare-data
  -> .neo-cast/dataset_spec.json
  -> .neo-cast/dataset/<task_id>_visible.csv
  -> .neo-cast/dataset/<task_id>_ref_test.csv

natural-language requirement
  -> design mode
  -> LLM / mock heuristic
  -> .neo-cast/current_candidate.json
  -> renderer
  -> .neo-cast/resolved_candidate.json

resolved candidate
  -> smoke validation
  -> full training
  -> validation metrics
  -> runner keep/discard
  -> .neo-cast/results.tsv
  -> .neo-cast/artifacts/run_<run_id>/

best artifact
  -> runner ref-test
  -> ref_test_metrics.json
  -> updated metadata.json / eval_report.md
```

## 0. Initialization of the environment

After entering the `neo_cast/` directory, install Node dependent on:

```bash
npm install
```

Initialised project level:

```bash
node ./bin/neo-cast.js init-runtime
```

The command will create within the project:

```text
.neo-cast/runtime/.venv/
.neo-cast/runtime/.uv-cache/
```

After all Python backend scripts are used by default:

```text
.neo-cast/runtime/.venv/bin/python
```

The environment can be checked with the following command:

```bash
node ./bin/neo-cast.js doctor
```

`doctor` will check:

- Python runtime
- `uv`
- LLM API key
- whether config is legal
- Whether `.neo-cast/runtime/.venv` exists

If only a local mock demonstration, no real API key can continue with `--mock-llm`.

## 1. Data preparation phase

Currently `neo-cast` uses `dataset.v1` data compacts. The default task is still ETTh1, but now `prepare-data` already supports the use of parameters to describe generic multivariate CSV.

Default ETTh1 Example:

```bash
node ./bin/neo-cast.js prepare-data \
  --source "datasets (1)/ETTh1.csv" \
  --force
```

Custom CSV Example:

```bash
node ./bin/neo-cast.js prepare-data \
  --source /path/to/data.csv \
  --task-id custom_task \
  --timestamp-col date \
  --feature-cols value_a,value_b,value_c \
  --input-len 96 \
  --horizons 24,48 \
  --train-rows 0:1000 \
  --val-rows 1000:1200 \
  --ref-test-rows 1200:1400 \
  --force
```

Data preparation will generate:

```text
.neo-cast/dataset_spec.json
.neo-cast/dataset/dataset_spec.json
.neo-cast/dataset/<task_id>_visible.csv
.neo-cast/dataset/<task_id>_ref_test.csv
.neo-cast/dataset/<task_id>_profile.json
```

Of which:

- `visible.csv` contains track + val, can be read by training and validation process
- `ref_test.csv` is the data used by runner-only final evaluation
- `dataset_spec.json` records tag id, feature column, input length, horizons, split border, standardization protocol
- `profile.json` basis for recording data lines, feature columns, timetamp frequency, irregular radio etc.

The core limitations of the current loader:

- The feature column must be a numerical column
- Timetamps must be decipherable, monotonous and non-duplicable
- Split must be continuous: `train -> val -> ref_test`
- Current training using row-based window
- The current data cleansing capacity is still limited and should not be considered as a direct available input for any dirty CSV

## 2. Design entrance: `neo-cast design`

Users present modelling needs in natural languages:

```bash
node ./bin/neo-cast.js design \
  --requirement "small forecasting model, low MSE, compact parameters" \
  --mode companion \
  --max-candidates 3 \
  --mock-llm
```

`design` is the main organization command, which is responsible for:

1. Read UserRequirement
2. Read `.neo-cast/dataset_spec.json` as tasktext
3. Collapse requirements according to interactive mode
4. Call LLM or mock heuristic generation candidate
5. Write candidate to `.neo-cast/current_candidate.json`
6. Call Python Runner for validation, training and export
7. Depending on the outcome, it's decided to continue with the next round.

## 3. Interactive Mode

The current `design` supports two models:

```text
socratic
companion
```

### Socratic Mode

`socratic` is default mode:

```bash
node ./bin/neo-cast.js design \
  --requirement "small model for long horizon forecasting" \
  --mode socratic
```

In an interactive terminal, the system asks a few clarifications:

- Model preferences
- Arguments volume budget
- Delay priority
- Additional remarks

Generates a requirement decision and allows the user to confirm whether or not it continues.

If you use `--yes` or are in a non-interactive environment, you do not stop to ask questions, but rather construct the summy with command line parameters and default values.

### Companion Mode

`companion` is the mode of interpretation by running:

```bash
node ./bin/neo-cast.js design \
  --requirement "compact transformer-like model" \
  --mode companion \
  --max-candidates 3
```

It begins directly with the preparation and training of candidates and is exported in each round:

- candidate id
- model family
- hypothesis
- Candidate Source: mock / Anthropic / OpenAI-compatible / heular fallback
- Key training parameters
- Current round `val_avg_mse`
- keep/discard/crash Results
- Current Best Artifact Path

interactive terminal to enter:

```text
stop
```

The current semantic is that after `stop` has been received, the next candidate will be stopped when the current training cycle is over.

## 4. Candidate Model Generation

Candidate generation is the responsibility of `src/llm.js`.

There are currently three types of sources:

- `--mock-llm`: Use local heuristic without calling external API
- Anthropic: Default real LLM projecter
- OpenAI -compatible: support GLM/ play/ vLLM compatible ChatCompletions interface

The candidate model is not any Python code, but structured.

```text
.neo-cast/current_candidate.json
```

Core fields include:

```json
{
  "schema_version": "candidate.v1",
  "candidate_id": "cand_xxx",
  "hypothesis": "...",
  "model_family": "nlinear",
  "model_config": {},
  "train_config": {
    "lr": 0.001,
    "batch_size": 32,
    "max_epochs": 8,
    "patience": 4,
    "seed": 42
  },
  "constraints": {
    "params_max_million": 1.0,
    "time_budget_seconds": 600,
    "latency_priority": "medium"
  }
}
```

Current supported model family:

- `nlinear`
- `tiny_transformer`
- `patch_mlp`

The boundaries of this step are clear: LLM is responsible only for presenting candidate structures and cross-references, not writing training codes directly or creating any model document.

## 5. Candidate Parsing and Authentication

Runner will give `renderer.py` to the candidate first:

```text
.neo-cast/current_candidate.json
  -> py/renderer.py
  -> .neo-cast/resolved_candidate.json
```

`resolved_candidate.json` will complete the candidate with a stable operating configuration, including:

- candidate id
- model family
- model config
- train config
- constraints
- smoke config
- Current dataset task information: `task_id`, `input_len`, `horizons`, `num_channels`

If there is no `--skip-smoke`, runner will continue smoke date:

```text
candidate schema validation
  -> renderer
  -> short smoke training
  -> smoke evaluation
```

The goal of smoke is not to get good indicators, but to find out as soon as possible:

- JSON schema is illegal
- Model Configuration Invalid
- tensor Shape Error
- The training entrance has collapsed.
- Parameters are clearly over-budgeted

Skip smoke:

```bash
node ./bin/neo-cast.js design \
  --requirement "use nlinear baseline" \
  --mode companion \
  --mock-llm \
  --skip-smoke
```

## 6. Training and validation

Full training is carried out by `py/train.py`.

The training process builds models and dataloader according to horizon, respectively:

```text
horizon 96
horizon 192
horizon 336
horizon 720
```

If a custom task is performed, horizon from `dataset_spec.json`.

Training in data-processing logic:

- Read track + val from `<task_id>_visible.csv`
- StandardScaler
- Train / Val is in the field-scaled space training and assessment
- `x: [input_len, num_channels]`
- Target is `y: [horizon, num_channels]`.

The training process will output NDJSON events, such as:

```text
stage_start
epoch_end
horizon_done
eval_done
artifact_ready
done
```

A run directory is generated after the training:

```text
.neo-cast/artifacts/run_<run_id>/
```

The training phase begins with:

```text
model.pt
val_metrics.json
training_summary.json
resolved_candidate.json
preprocess.json
```

Where `model.pt` saves PyTorch weight and candidate payload.

## 7. Runner Decision Making: keep / Discard / crash

`py/runner.py` is the experimental status machine.

It maintains:

```text
.neo-cast/runner_state.json
.neo-cast/results.tsv
```

After each candidate training, runner reads `val_avg_mse` and compares it to the current best:

```text
If val_avg_mse is lower - > keep
Or else - Discard
If authentication, training or export failed - >crash / invalid / smoke_fail
```

Records of `results.tsv`:

- `session_id`
- `run_id`
- `candidate_id`
- `model_family`
- `val_avg_mse`
- `val_h96_mse`
- `val_h720_mse`
- `params_M`
- `status`
- `is_best`
- `timestamp`

The current main search indicators are:

```text
val_avg_mse
```

`ref_test` does not participate in the search, only for final reporting.

By default, `design` will stop early if a round produces new best and does not pass into `--force-all-candidates`. If you want to force a full run, you can use:

```bash
node ./bin/neo-cast.js design \
  --requirement "compare compact model variants" \
  --mode companion \
  --max-candidates 5 \
  --force-all-candidates
```

## 8. Artifact Export

After the training is successful, Runner will call `py/export.py` to complete the run directory as deliverables.

The complete catalogue is structured as follows:

```text
.neo-cast/artifacts/run_<run_id>/
  model.pt
  metadata.json
  val_metrics.json
  training_summary.json
  preprocess.json
  resolved_candidate.json
  model_impl.py
  inference.py
  mcp_server.py
  tool_schema.json
  eval_report.md
  README.md
  example.py
  requirements.txt
```

Meaning of documents:

- `model.pt`: trained model weight and candidate payload
- `metadata.json`: Structured metadata, including task, model family, indicators, list of documents
- `val_metrics.json`: Validation of set indicators
- `training_summary.json`: time-consuming training, parameters, visible storage, etc.
- `preprocess.json`: Characteristic order, standardized average variance, input length, horizons
- `model_impl.py`: Model definition for this model family
- `inference.py`: Python API for loading models and inference
- `mcp_server.py`: expose the model to MCP tool
- `tool_schema.json`: input schema for MCP tool
- `eval_report.md`: Readable Experiment Report
- `example.py`: Minimum deduction sample
- `requirements.txt`:artifact dependent

This is the main output of `neo-cast`.

## 9. Finalref-test

Run when there is a best run:

```bash
node ./bin/neo-cast.js runner ref-test
```

Or specify run:

```bash
node ./bin/neo-cast.js runner ref-test --run-id <run_id>
```

The current ref-test path has been verified mainly by default ETTh1 workflow. Although data preparation and training already supports `dataset.v1` custom task, runner's call ref-test still has a default ETTh1 assumption; Customizes the ref-test of task as a path that needs further validation and correction.

The logic of ref-test is:

```text
Read best artifact
  - > Temporary Settings Runner-only Protection token
  - Load ref_test split
  - ♪ Evaluate all horizons
  - Write ref_test_metrics.json
  Re-export metadata.json/ eval_report.md
```

Output file:

```text
.neo-cast/artifacts/run_<run_id>/ref_test_metrics.json
.neo-cast/artifacts/run_<run_id>/metadata.json
.neo-cast/artifacts/run_<run_id>/eval_report.md
```

The design principles are:

- `val` for search
- `ref_test` only for final report
- `ref_test` does not participate in keep/discard

This avoids repeated test integration during automatic search.

## 10. ELECTION AND DISAPPEARANCE

Exported artifact can run directly:

```bash
cd .neo-cast/artifacts/run_<run_id>/
python example.py
```

You can also start as MCP tool:

```bash
python mcp_server.py
```

Logic entry at `inference.py`:

```python
from inference import load_model, predict_raw

bundle = load_model()
prediction = predict_raw(bundle, history, horizon)
```

Enter:

```text
history: [input_len, num_channels]
horizon: Some horizon declared in dataset_spec.json
```

Output:

```text
[horizon, num_channels]
```

Note: The current `predict_raw()` sends the raw input standardized back into the model, but the output is still a standard-scaled space projection for the model. Follow-up should be supplemented with inverse transport or explicit output space if it is to be used for real operations.

## 11. Key boundary of the current workflow

The current `neo-cast` is no longer a pure ETTh1-only hard encoding process, but it is still restricted MVP:

- Supporting CSV only
- Model space limited to three registered families
- LLM can only generate candidate JSON and cannot write any model code
- Training protocol is still supervisory
- The main search indicator is still `val_avg_mse`.
- `results.tsv` still retains such legacy columns as `val_h96_mse`/ `val_h720_mse`; The full indicator for custom horizons should look at `val_metrics.json` in artifact
- The default ETTh1 ref-test path is available; Self-defined ref-test needs to be further marketed
- Multiple dataset statistical testing, multi-seed search, efficiency indicator search have not yet become the main process
- MCP server generated, but the real MCP integration still needs to be independently validated

The current workflow is therefore best suited to:

- Local demonstration small model auto-design closed loop
- Coulddate scheme / verification
- Limited model search for fixed or standardized CSV tasks
- Basic for subsequent TimeRecipe module level action space

It is not appropriate to state directly that:

- Found LTSF General Campion
- Any AutoML is supported
- Arbitrary data and arbitrary job types are already being processed

## 12. Shortest runable path

Shortest path for local mock presentations:

```bash
cd /path/to/NeoResearch/neo_cast

npm install

node ./bin/neo-cast.js init-runtime

node ./bin/neo-cast.js prepare-data \
  --source "datasets (1)/ETTh1.csv" \
  --force

node ./bin/neo-cast.js design \
  --requirement "small ETTh1 forecasting model, low MSE, compact parameters" \
  --mode companion \
  --max-candidates 1 \
  --mock-llm \
  --skip-smoke

node ./bin/neo-cast.js runner ref-test
```

_Other Organiser

```bash
node ./bin/neo-cast.js runner status
cat .neo-cast/results.tsv
ls .neo-cast/artifacts/
```

Best run final product in:

```text
.neo-cast/artifacts/run_<best_run_id>/
```
