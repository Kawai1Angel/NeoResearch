# Neo-cast input and output instructions

This document describes the actual input and output of the current `neo-cast` CLI version. The current version does not triangulate the output of "Small Model Assessment Indicators / Trained Network Parameters / Experimental Reports" but produces three types of products:

1. Designed small model specifications.
2. Small model assessment indicators
3. Trained model weights, inference artifact and experimental reports

## What's the input?

The current `neo-cast` input is divided into three layers.

### 1. Data input

Data input is complete `ETTh1.csv`:

```bash
node ./bin/neo-cast.js prepare-data --source /path/to/ETTh1.csv
```

The column order for CSV is fixed as:

```text
date,HUFL,HULL,MUFL,MULL,LUFL,LULL,OT
```

`prepare-data` cuts the complete data into:

- Angent Visible `train + val`
- Runner-only's `ref_test`

### 2. Design requirements input

Users input modelling needs in natural languages, such as:

```bash
node ./bin/neo-cast.js design \
  --requirement "small ETTh1 forecasting model, low MSE" \
  --mode companion \
  --max-candidates 1
```

This type of input is used to guide LLM or mock heuristic production of candidate model specifications.

### 3. Candidate Model Inputs

LLM or mock heuristic will generate a candidate model

```text
.neo-cast/current_candidate.json
```

It is not an arbitrary Python model code, but a restricted structure consisting mainly of:

- `model_family`
- `model_config`
- `train_config`
- `constraints`
- `hypothesis`

The only currently supported `model_family` is:

- `nlinear`
- `tiny_transformer`
- `patch_mlp`

In other words, the current `neo-cast` is not a freely generated network code, but an automatic selection of structures and super-parameters within a fixed model family.

## Interactive Mode Design

The current `neo-cast design` supports two main interactive modes:

- `socratic`
- `companion`

In addition, controls such as mock LLM, real LLM, skipping smoke, multi-candidates mandatory running etc. are supported.

### 1. Socratic Mode

`socratic` is the current default mode:

```bash
node ./bin/neo-cast.js design \
  --requirement "small ETTh1 forecasting model, low MSE" \
  --mode socratic
```

If run in an interactive terminal and `--yes` is not introduced, the CLI will ask a few questions of clarification:

- Model preferences: e.g. `transformer`/`nlinear`/`patch_mlp`
- Parameter budget: in million
- Delayed priority: `low`/ `medium`/ `high`
- Additional remarks

The CLI will then present the rearranged requirement follow-up and ask whether to proceed.

If the user confirms that it continues, the system consolidates the original needs and clarifications into a final requirement, which is then given to LLM or mock heuristic to generate candidate models.

If you are in a non-interactive environment, or if you enter `--yes`, you do not stop to ask questions, but rather use command line parameters and default values to construct requirement system.

### 2. Companion Mode

`companion` is the mode of interpretation by running:

```bash
node ./bin/neo-cast.js design \
  --requirement "compact forecasting model for ETTh1" \
  --mode companion \
  --max-candidates 3
```

This model does not start with multiple rounds of clarification, but begins directly with candidate generation and experimental operation.

Each round of output:

- How many rounds are we talking about?
- Candidate model from: mock / Anthropic / OpenAI-compatible / heular fallback
- candidate id
- model family
- hypothesis
- Key training configurations such as learning rate, watch size
- After training `val_avg_mse`
- Current round of decision-making: `keep`/`discard`/`crash`
- Current Best Run id and Artifact Path

If run in an interactive terminal, the user can enter:

```text
stop
```

The syntax of the current version is that after `stop` has been received, CLI will wait for the end of the current training cycle to stop its candidate and export the best results.

### 3. Mock LLM and True LLM

You can use mock mode when developing and testing:

```bash
node ./bin/neo-cast.js design \
  --requirement "use nlinear baseline" \
  --mode companion \
  --max-candidates 1 \
  --mock-llm
```

`--mock-llm` does not call external API, but uses local heuristic to generate candidate models. It is suitable for local smoke, e2e testing and no API key scenes.

Without `--mock-llm`, CLI will use real LLM according to configuration:

- Default programr: `anthropic`
- Optional programvider: `openai-compatible`

Anthropic path depends on:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

OpenAI -compatible path depends on:

```bash
export NEO_CAST_LLM_PROVIDER=openai-compatible
export NEO_CAST_LLM_BASE_URL=https://example.com/v1
export NEO_CAST_LLM_MODEL=your-model
export NEO_CAST_LLM_API_KEY="sk-..."
```

In the current code, if a real LLM call fails, candidate generation will fallbackback to heuristic candidate. That is, real LLM failure does not necessarily lead directly to the failure of the whole design command, but it affects candidate quality and interpretability.

### 4. Designing how the cycle works

The internal process for one time `design` is:

```text
User review
  - >scratic/companion to sort out needs
  ♪ Generate candidate JSON
  neo-cast/current_candidate.json
  neo-cast/resolved_candidate.json
  -> validate smoke
  -> full train
  -> export artifact
  Update neo-cast/results.tsv
  - > Output Current Best Results
```

By default:

- `--max-candidates` Default is `1`
- If a round results `keep` and does not pass into `--force-all-candidates`, design will stop early.
- If one round results `discard`, CLI will continue to try the next candidate until it reaches `--max-candidates`.
- If serious failure occurs, CLI will stop the current design loop

If you want to run all the candidates, you can use:

```bash
node ./bin/neo-cast.js design \
  --requirement "compare compact model variants" \
  --mode companion \
  --max-candidates 5 \
  --force-all-candidates
```

### 5. Smoke and Training Control

Default that each candidate will pass first by smoke gate:

```text
candidate schema validation
  -> renderer
  -> short smoke training
  -> smoke evaluation
```

Smoke will only get into full training after adoption.

Skip smoke:

```bash
node ./bin/neo-cast.js design \
  --requirement "use nlinear baseline" \
  --mode companion \
  --mock-llm \
  --skip-smoke
```

`--skip-smoke` can speed up debugging, but it reduces the intensity of security checks before candidates enter full train.

### 6. Positioning of the current interactive mode

The current interactive mode is closer to the "restricted automatic study cycle" instead of general chat AutoML:

- User gives a natural language target
- CLI works only on fixed ETTh1 tasks
- Model space limited to three registered families
- LLM only creates structured JSON
- Python backend for validation, training, evaluation, export
- `val_avg_mse`. It's a search signal.
- `ref_test` only for final best reporting use

Therefore, the interactive focus of the current version is not on hand-written models for users, but rather to describe preferences in natural languages and then the system automatically presents, trains and filters small models within fixed protocols.

## What's the output?

The main output is under the `.neo-cast/` directory.

### 1. Small model design results

The candidate model and the analysed candidate model are saved as follows:

```text
.neo-cast/current_candidate.json
.neo-cast/resolved_candidate.json
```

`current_candidate.json` is the original candidate specification, and `resolved_candidate.json` is a training configuration that has been standardized by renderer.

### 2. Experimental indicators

The whole experiment results are stored in:

```text
.neo-cast/results.tsv
```

Key fields include:

- `val_avg_mse`
- `val_h96_mse`
- `val_h720_mse`
- `params_M`
- `status`: `keep` / `discard` / `crash`
- `is_best`

Of which `val_avg_mse` is the current primary search indicator, `ref_test` is used only for final reporting.

### 3. Trained model parameters

Each successful training will generate:

```text
.neo-cast/artifacts/run_<run_id>/model.pt
```

`model.pt` saves trained PyTorch weights containing:

- `run_id`
- Candidate Configuration
- `model_family`
- `state_dict` for each horizon

### 4. Full artifact package

Each successful run will export a complete artifact directory:

```text
.neo-cast/artifacts/run_<run_id>/
  model.pt
  metadata.json
  val_metrics.json
  ref_test_metrics.json
  training_summary.json
  preprocess.json
  model_impl.py
  inference.py
  mcp_server.py
  tool_schema.json
  eval_report.md
  README.md
  example.py
  requirements.txt
```

This catalogue is the main product of external delivery in the current version.

### 5. Experimental report

The pilot report is in two main forms:

- `eval_report.md`: Readable Markdown report
- `metadata.json`: Structured report for machine reading

The report includes:

- Model family
- candidate id
- run id
- Arguments
- Training is time-consuming
- validation indicator
- ref-test indicator
- List of documents

## Input output during inference

`inference.py`, which is exported, provides a reasoned interface.

Login input:

- `history`: Shape as `[512, 7]`
- `horizon`: `96 / 192 / 336 / 720`

Delineation output:

- Shape for `[horizon, 7]` projection array

The current `predict_raw()` receives and standardizes the raw-space input, but the output is still `standard_scaled` space without inversion transport back to original numerical space. This name is prone to misunderstanding and subsequent productization suggests adding `predict_raw_inverse()` or returning `predict_raw()` to original numerical space.

## Summary of the sentence

Current `neo-cast` input is:

```text
ETTh1.csv + Natural language modelling needs + restricted candidate model JSON
```

The current output for `neo-cast` is:

```text
Small model design specifications + assessment indicators + trained model weights + reasonable analysis + experimental report
```
