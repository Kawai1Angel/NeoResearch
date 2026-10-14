# neo-cast

> NeoResearch-TSF: Building a Model Factory for Time Series Forecasting via Autonomous Research Agents

`neo-cast` is the current MVP runtime for NeoResearch-TSF. It turns a prepared time-series forecasting task into a repeatable model-design loop: propose a small model candidate, validate it with time-ordered cross-validation, train the final checkpoint, export an artifact, and run a final reference-test report.

The default task is **ETTh1 multivariate forecasting**, but dataset loading now goes through a standard `dataset.v1` contract for numeric multivariate CSVs. The system is still intentionally narrow: fixed validation metric, bounded recipe action space, contiguous split protocol, and a project-local CLI workflow.

## What It Does

Current capabilities:

- Prepare standardized `train + val` and runner-only `ref_test` splits from a numeric CSV.
- Create a structured `task_spec.v1` Task DSL contract from the prepared dataset contract.
- Generate module-level CandidateRecipe specs from a natural-language requirement.
- Persist user corrections as Human Feedback Memory and inject them into later design prompts.
- Pause model-design execution behind a persisted human checkpoint when `--require-approval` is used.
- Support both mock design and Anthropic-backed design.
- Validate candidates with JSON Schema and a smoke run.
- Train native recipe-factory models or legacy model-family candidates on the prepared dataset.
- Record `research_trace.v1` decision evidence so exported reports can explain why a model was tried.
- Track session results under `.neo-cast/results.tsv`.
- Export a self-contained artifact directory with weights, metadata, inference code, MCP server code, and reports.
- Run final `ref_test` evaluation on the best frozen artifact.

Current Model Recipe DSL and native factory action space:

- ModelDesigner now emits `model_recipe.v2`, compiled into typed `recipe_schema_v3`. Explicit legacy `model_recipe.v1` / `recipe_schema_v2` inputs remain supported with their original semantics.
- V3 adds real `diagonal_ssm`, `timesblock_encoder`, and CPU-reference Mamba-1, explicit sequence readout, bounded two-branch composition, and content-addressed experiment reuse. Each horizon remains independently trained. See the [v3 contract and limitations](docs/recipe_runtime_v3_contract.md).

- Preprocessing: `none`, `instance_norm`, `series_decomposition`.
- Embedding: `none`, `patch`, `multiscale_patch`.
- Backbone: `linear`, `mlp`, `transformer`, `temporal_conv` (compiled to TCN), `dlinear`, `nbeats`, `timesnet_lite`, `rnn`, `gated_depthwise_conv`, `mixer`.
- Fusion/head: temporal fusion with `independent` or residual `shared` channel mixing, plus linear point forecast head.
- Training: `mse` / `mae` / `huber`, `adam` / `adamw` / `sgd`, optional cosine scheduler.

The raw-sequence backbones (`dlinear`, `tcn`, `nbeats`, `timesnet_lite`) require `embedding.type="none"`. `timesnet_lite` is paper-derived, not a full TimesNet reproduction; `gated_depthwise_conv` is not an SSM. Historical proxy results must not be attributed to the full paper architectures.

Legacy `recipe_schema_v1` recipes and checkpoints are rejected: migrate recipes and retrain under runtime semantics revision 2. New design proposals should prefer `model_recipe.v1`. See [runtime v2 contract](docs/recipe_runtime_v2_contract.md) for latent/head boundaries, explicit centering, original missing masks, train-only graphs and removed fields.

The main optimization signal is `cv_avg_mse`, computed by four expanding-window folds over the original train+val visible range. `cv_std_mse` reports temporal stability, while `val_avg_mse` remains the final checkpoint's original validation-split diagnostic. `ref_test` is reserved for final reporting and never participates in folds or candidate selection.

For details on design modes, model-family constraints, and whether a candidate runs for minutes or epochs, see [NEO_CAST_MODES.md](./NEO_CAST_MODES.md).

## Repository Layout

```text
neo_cast/
  runner-manifest.json       # runner.v1 protocol consumed by NeoResearch
  bin/
    neo-cast.js              # CLI entrypoint
  src/
    cli.js                   # command routing
    config.js                # API/config resolution
    doctor.js                # environment checks
    llm.js                   # Anthropic + mock candidate generation
    python-bridge.js         # Node -> Python runner bridge
    runtime.js               # project-local Python runtime
    modes/                   # socratic / companion design modes
  py/
    dataset_contract.py      # dataset.v1 spec and path contract
    prepare_tsf.py           # standardized data and eval harness
    renderer.py              # candidate -> resolved_candidate
    validate.py              # schema validation + smoke gate
    train.py                 # candidate-driven training entrypoint
    runner.py                # session state, keep/discard, ref-test
    export.py                # artifact package exporter
    factory/                 # native CandidateRecipe -> PyTorch model builder
    families/                # supported model families
    registry/                # recipe action registry and compatibility checks
    search/                  # bounded recipe mutation policy
    schemas/                 # candidate, recipe, dataset, task spec, research trace, and metadata schemas
  test/
    e2e.test.js              # CLI-level end-to-end tests
    python-unit.test.js      # Node wrapper for Python unit tests
  py/tests/
    test_recipe_factory.py   # native recipe_factory unit tests
    test_export_contract.py  # artifact horizon contract tests
```

The Python runtime source is now under `py/`. The Node CLI always calls scripts from that directory.
`runner-manifest.json` is the integration contract consumed by NeoResearch. It maps runner stages
(`smoke`, `run`, `ref_test`, `blind_test`) to the Python scripts and arguments that implement them.

## Requirements

- Node.js `>= 20`
- Python `>= 3.10`
- `uv`
- macOS or Linux
- Optional: `ANTHROPIC_API_KEY` or OpenAI-compatible relay key for real LLM-backed design

For local development, install Node dependencies first:

```bash
npm install
```

Python dependencies are installed into the project runtime by:

```bash
node ./bin/neo-cast.js init-runtime
```

After global npm installation, replace `node ./bin/neo-cast.js` with `neo-cast`.

## Quickstart

From the repository root:

```bash
cd /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo_cast
npm install
node ./bin/neo-cast.js init-runtime
```

Prepare ETTh1:

```bash
node ./bin/neo-cast.js prepare-data \
  --source "datasets (1)/ETTh1.csv" \
  --force
```

Run one mock design loop:

```bash
node ./bin/neo-cast.js design \
  --requirement "small ETTh1 forecasting model, low MSE, compact parameters" \
  --mode companion \
  --max-candidates 1 \
  --mock-llm \
  --skip-smoke
```

Run final reference-test evaluation for the current best run:

```bash
node ./bin/neo-cast.js runner ref-test
```

Run the test suite:

```bash
npm test
```

The current suite covers CLI e2e flows plus Python unit tests for `recipe_factory`, artifact export contracts, and mutation policy.

## CLI Commands

```bash
node ./bin/neo-cast.js --version
node ./bin/neo-cast.js help
node ./bin/neo-cast.js doctor
node ./bin/neo-cast.js config init
node ./bin/neo-cast.js config show
node ./bin/neo-cast.js init-runtime
node ./bin/neo-cast.js prepare-data --source /path/to/data.csv
node ./bin/neo-cast.js task-spec init --from-dataset .neo-cast/dataset_spec.json
node ./bin/neo-cast.js task-spec validate .neo-cast/task_spec.json
node ./bin/neo-cast.js checkpoint status
node ./bin/neo-cast.js checkpoint approve model_design --note "approved for training"
node ./bin/neo-cast.js correction add --scope data_schema --field temperature_forecast --correction "available only at prediction time"
node ./bin/neo-cast.js correction list
node ./bin/neo-cast.js validate candidate /path/to/candidate.json
node ./bin/neo-cast.js validate recipe /path/to/recipe.json
node ./bin/neo-cast.js validate model-recipe /path/to/model_recipe.json
node ./bin/neo-cast.js validate dataset /path/to/dataset_spec.json
node ./bin/neo-cast.js validate task-spec /path/to/task_spec.json
node ./bin/neo-cast.js validate research-trace /path/to/research_trace.json
node ./bin/neo-cast.js validate user-corrections .neo-cast/user_corrections.json
node ./bin/neo-cast.js validate metadata /path/to/metadata.json
node ./bin/neo-cast.js validate smoke
node ./bin/neo-cast.js runner init --force
node ./bin/neo-cast.js runner run --description "experiment"
node ./bin/neo-cast.js runner ref-test
node ./bin/neo-cast.js runner status
node ./bin/neo-cast.js design --requirement "..." --mode socratic
node ./bin/neo-cast.js design --requirement "..." --mode companion
```

Human checkpoint flow:

```bash
node ./bin/neo-cast.js design \
  --requirement "compact ETTh1 baseline" \
  --mode companion \
  --max-candidates 1 \
  --mock-llm \
  --require-approval

node ./bin/neo-cast.js checkpoint status
node ./bin/neo-cast.js checkpoint approve model_design --note "model plan accepted"
node ./bin/neo-cast.js runner run --description "approved model design"
```

The checkpoint state is persisted in `.neo-cast/approval_state.json`. Runner execution checks the current candidate hash before training, so a stale approval does not silently approve a different model design.

Human Feedback Memory:

```bash
node ./bin/neo-cast.js correction add \
  --scope split_policy \
  --correction "data must be split in chronological order only"

node ./bin/neo-cast.js correction add \
  --scope data_schema \
  --field holiday_flag \
  --correction "should be treated as known future covariate"

node ./bin/neo-cast.js correction list
```

Corrections are persisted in `.neo-cast/user_corrections.json`. Active corrections are added to model-design and reflection task context as authoritative user constraints.

Generate a bounded next recipe from a previous recipe and validation metrics:

```bash
python py/search/mutate.py \
  --recipe .neo-cast/current_candidate.json \
  --metrics .neo-cast/artifacts/run_<run_id>/val_metrics.json \
  --output .neo-cast/mutated_candidate.json
```

`design` supports:

- `--mode socratic`
- `--mode companion`
- `--max-candidates N`
- `--mock-llm`
- `--skip-smoke`
- `--use-mutation`
- `--force-all-candidates`

With `--use-mutation`, round 1 is generated by the LLM or mock designer, and later rounds mutate the previous recipe with the local policy in `py/search/mutate.py`. Use `--force-all-candidates` when you want mutation rounds to continue even after a kept candidate.

## API Configuration

Secrets stay in environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Non-secret config is resolved from:

- user config: `~/.config/neo-cast/config.json`
- project config: `.neo-cast/config.json`
- CLI flags

Create and inspect config:

```bash
node ./bin/neo-cast.js config init
node ./bin/neo-cast.js config show
```

If no LLM API key is configured, `doctor` reports the missing key as a warning instead of blocking local checks. Use `design --mock-llm`, or set `NEO_CAST_USE_MOCK=1` in your shell / `.env.local`, to run the offline heuristic candidate factory for alpha demos. The default non-mock path uses `src/llm.js` and the Anthropic SDK.

### GLM5 / OpenAI-Compatible Relay

`neo-cast` also supports OpenAI-compatible ChatCompletions relays. For the GLM5 relay shown in the project notes, use:

```bash
export OPENAI_API_KEY="sk-..."
node ./bin/neo-cast.js design \
  --provider openai-compatible \
  --base-url "https://api2.aigcbest.top/v1" \
  --model "glm-5" \
  --requirement "design a compact Transformer-like ETTh1 forecasting model with low validation MSE" \
  --mode companion \
  --max-candidates 1
```

Equivalent environment variables:

```bash
export NEO_CAST_LLM_PROVIDER=openai-compatible
export NEO_CAST_LLM_BASE_URL=https://api2.aigcbest.top/v1
export NEO_CAST_LLM_MODEL=glm-5
export OPENAI_API_KEY="sk-..."
```

For relay keys, `NEO_CAST_LLM_API_KEY`, `OPENAI_API_KEY`, or `AIGCBEST_API_KEY` are accepted. Do not commit these keys to the repository.

## Input Contract

`neo-cast` supports the legacy `dataset.v1` feature contract and the role-aware `dataset.v2` contract. `prepare-data` materializes:

```text
.neo-cast/dataset/
  dataset_spec.json
  <task_id>_visible.csv
  <task_id>_ref_test.csv
```

Source CSV column names have leading and trailing whitespace removed before inference and validation; internal spaces are preserved (for example, ` Generation forecast` becomes `Generation forecast`). Names that collide after trimming are rejected. The source file is unchanged, and prepared splits and contracts use the trimmed names.

The default input is still a full `ETTh1.csv` with these columns:

```text
date,HUFL,HULL,MUFL,MULL,LUFL,LULL,OT
```

Default ETTh1 task settings:

- Dataset/task id: `etth1`
- Channels: `7`
- Input length: `512`
- Horizons: `96 / 192 / 336 / 720`
- Train rows: `[0, 8640)`
- Validation rows: `[8640, 11520)`
- Reference-test rows: `[11520, 14400)`

If the source CSV has more than `14400` rows, `prepare-data` keeps the first `14400` canonical rows.

For another numeric multivariate CSV, pass an explicit dataset contract at load time:

```bash
node ./bin/neo-cast.js prepare-data \
  --source /path/to/data.csv \
  --task-id my_domain \
  --timestamp-col date \
  --feature-cols f1,f2,f3 \
  --input-len 96 \
  --horizons 24,48 \
  --missing-strategy forward_fill \
  --frequency auto \
  --train-rows 0:10000 \
  --val-rows 10000:12000 \
  --ref-test-rows 12000:14000 \
  --force
```

If `--feature-cols` is omitted for a non-ETTh1 task, numeric columns except the timestamp column are inferred. If row ranges are omitted for a non-ETTh1 task, `prepare-data` uses contiguous 60/20/20 splits when the dataset is long enough.

Use `dataset.v2` whenever targets and exogenous variables have different roles:

```bash
node ./bin/neo-cast.js prepare-data \
  --source /path/to/wind.csv \
  --target-cols real_power \
  --observed-past-covariates wind_speed,temperature
```

Only targets and observed-past covariates are supported. Nonempty known-future or static covariate configurations fail with `UNSUPPORTED_COVARIATE` before materialization or training. Existing artifacts with these capabilities require retraining. Forecasts, losses, metrics, and inverse transforms remain target-only. `--feature-cols` remains available for `dataset.v1` compatibility and cannot be combined with `--target-cols`.

Missing values and timestamps:

- Default missing strategy is `forward_fill`; alternatives are `reject`, `drop`, `mean_fill`, and `linear_interpolate`.
- `prepare-data` profiles timestamp frequency, duplicate timestamps, monotonic order, and irregular interval ratio.
- Exact duplicate source rows are removed before splitting, with removal counts recorded in the profile's `duplicate_action`. Conflicting timestamp duplicates still fail. Explicit row ranges refer to deduplicated rows; `--split-ratios 7,1,2` computes boundaries from the deduplicated row count.
- Irregular timestamps are allowed by default with a warning because the current trainer still uses row-based windows; use `--reject-irregular` to fail fast.
- The profile is written to `.neo-cast/dataset/<task_id>_profile.json` and copied into exported `preprocess.json`.

You can override the project-local data root with:

```bash
export NEO_TSF_DATA_ROOT=/your/data/root
```

## Runtime State

Project-local runtime and session state live under:

```text
.neo-cast/
  runtime/
    .venv/
    .uv-cache/
  dataset/
    dataset_spec.json
    <task_id>_visible.csv
    <task_id>_ref_test.csv
  current_candidate.json
  resolved_candidate.json
  runner_state.json
  results.tsv
  artifacts/
```

`runner.py` no longer uses git reset for discard. It records candidate outcomes and keeps the best run pointer in `.neo-cast/runner_state.json`.

## Artifact Output

Successful runs export an artifact directory:

```text
.neo-cast/artifacts/run_<id>/
  model.pt
  metadata.json
  preprocess.json
  model_impl.py
  inference.py
  mcp_server.py
  tool_schema.json
  eval_report.md
  README.md
  requirements.txt
  example.py
  resolved_candidate.json
  val_metrics.json
  training_summary.json
  ref_test_metrics.json      # appears after runner ref-test
```

`inference.py` exposes:

- `load_model()`
- `predict_normalized(...)`
- `predict_raw(...)`

`mcp_server.py` exposes a generic MCP `forecast` tool for the prepared dataset. The file is generated, but MCP client `tools/list` and `tools/call` integration still needs a dedicated end-to-end verification pass.

## Developer Commands

Direct Python entrypoints still work, but use `py/` paths:

```bash
./.neo-cast/runtime/.venv/bin/python py/prepare_tsf.py
./.neo-cast/runtime/.venv/bin/python py/validate.py smoke
./.neo-cast/runtime/.venv/bin/python py/runner.py status
./.neo-cast/runtime/.venv/bin/python py/runner.py ref-test
```

Prefer CLI commands for normal use because they select the project runtime automatically.

## Current Status

Current completion level is around MVP-plus:

- Core Python loop: implemented
- CLI shell: implemented
- Mock design path: implemented and tested
- `ref_test` evaluator: implemented
- Artifact export: implemented
- Standardized dataset loading: implemented for numeric multivariate CSVs
- E2E test: implemented
- Global npm publish/install flow: not fully validated
- Real Anthropic end-to-end design run: not yet validated in this workspace
- MCP client integration: generated server exists, full client test pending
- Broad benchmark-grade multi-dataset support: partial, not yet benchmark-validated

## What To Work On Next

The shortest path to a release-ready version is:

1. Validate `npm install -g neo-cast`.
2. Run one real `ANTHROPIC_API_KEY` backed `neo-cast design`.
3. Test exported `mcp_server.py` with a real MCP client.
4. Add a release smoke command that runs `doctor`, mock design, and `runner ref-test`.
5. Keep `README.md` and `ROADMAP.md` aligned as contracts evolve.
