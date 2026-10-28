# Description of NeoResearch (neo-cast) use

> Version 0.1.0 2026-04-29

---

## I. WHAT IS THE SYSTEM?

**NeoResearch/neo-cast** is an autonomous time series prediction model construction tool. You describe demand in a natural language. It's done automatically:

1. **Design**: translation of needs into model architecture programmes (Recipe JSON) using LLM
2. **Training**: compiling Recipe for the PyTorch model and training on given data sets
3. **Assessment**: calculation of MSE/MAE on validation set/ reference test set
4. **Export**: Generate complete product packages (weights, codes of inference, MCP tools, assessment reports)
5. **Integrator**: keeping (keyp) or discarding (discard) based on results, into the next round

The whole process is represented by **Recipe DSL** (`recipe_schema_v1`) as the center centre that LLM does not write code directly, but fills out structured JSON and re-compiles it.

---

## II. Catalogue structure

```
neo_cast/
├── bin/neo-cast.js          ← CLI entrypoint
├── src/
│   ├── cli.js               ← Command routing
│   ├── llm.js               ← LLM candidate generation
│   ├── python-bridge.js     ← JS → Python subprocess bridge
│   ├── runtime.js           ← Python venv management
│   └── modes/
│       ├── socratic.js      ← Socratic interaction mode
│       └── companion.js     ← Companion interaction mode
├── py/
│   ├── prepare_tsf.py       ← Dataset preparation (frozen)
│   ├── train.py             ← Training loop
│   ├── runner.py experimental status machine
│   ├── renderer.py          ← Recipe → resolved_candidate
│   ├── validate.py          ← Schema validation and smoke gate
│   ├── Export of export.py zirconium package
│   ├── factory/
│   │   └── build_model.py   ← Recipe compiler (core)
│   ├── search/
│   │   └── mutate.py        ← Rule-based mutation
│   └── schemas/
│       └── recipe_schema.json
├── .neo-cast/               ← Automatically created runtime state directory
│   ├── current_candidate.json
│   ├── resolved_candidate.json
│   ├── runner_state.json
│   ├── results.tsv
│   ├── dataset/             ← Prepared datasets
│   ├── artifacts/ products per experiment
│   └── runtime/             ← Python venv
└── docs/
    ├── NeoResearch_usage.md   ← This document
    └── llm_reflection_agent_design.md
```

---

## III. Environmental requirements

| Dependency | Version Requirements | Annotations |
|---|---|---|
| Node.js | ≥ 20 | Run CLI and LLM calls |
| uv | Any Version | Manage Python venv |
| Python | ≥ 3.10 | Automatically created through uv without manual installation |
| GPU | Optional | CPU can run, training slows. |

---

## IV. Quick start

### 4.1 Current state of the environment (inbound)

The `neo_cast/` directory of this machine has been initialized,**the following are already in existence and need not be re-executed**:

```
.neo-cast/runtime/.venv/   ← Python 3.12 venv with all dependencies installed
.neo-cast/dataset/         ← ETTh1 visible and reference-test datasets
.neo-cast/runner_state.json ← Existing session with 13 experiment records
```

Validation environment:

```bash
cd neo_cast
node bin/neo-cast.js doctor
```

Expected output (current):
```
[FAIL] python3: Python 3.9.6 [runtime venv]   ← System Python is old, but the ready venv allows execution
[OK]   uv: Detected uv 0.10.8
[OK]   config: Resolved config is valid.
[OK]   runtime: Project runtime is ready at .neo-cast/runtime/.venv/bin/python
```

### 4.2 Configuration API Key

The current `~/.config/neo-cast/config.json` is configured to use aigcbest.top (OpenAI compatible interface) with only the key in shell:

```bash
export NEO_CAST_LLM_API_KEY="your-aigcbest-key"
```

Writing `~/.zshrc` is sustainable:

```bash
echo 'export NEO_CAST_LLM_API_KEY="your-key"' >> ~/.zshrc
```

> **No API Key debug**: with `--mock-llm` parameters, create candidates using in-house inspirational rules and be completely offline.

---

## V. Core Orders

### 5.1 `design` - Master Command

Start the complete design → training → evaluation → iteration loop.

```bash
node bin/neo-cast.js design \
  --requirement "..." \
  --mode socratic|companion \
  --max-candidates 3 \
  [--mock-llm] \
  [--use-reflection] \
  [--use-mutation] \
  [--stop-on-keep] \
  [--skip-smoke]
```

**Annotations to parameters**

| Parameters | Default | Annotations |
|---|---|---|
| `--requirement` | shall fill | Natural-language requirements in English |
| `--mode` | `socratic` | Interactive mode, see the following section |
| `--max-candidates` | `1` | Try a few candidates at the most. |
| `--mock-llm` | Off | Replace LLM with an inspirational rule. No API Key |
| `--use-reflection` | Off | Attempt > 1 |
| `--use-mutation` | Off | use rules instead of regenerated while attempt > 1 |
| `--stop-on-keep` | Off | An early halt after a round of keepingep; The default runs full of `--max-candidates` |
| `--skip-smoke` | Off | Skip smoke validation (accelerated debugging) |

**Two interactive modes**

| Mode | Behaviour |
|---|---|
| `socratic` (Socratic) | Collection of needs details (model preferences, parameter budgets, delayed requests) through question-and-answer sessions, confirmation and start training |
| `companion` (cognitive accompanying) | Start training immediately, print the decision-making process per round and enter `stop` early |

**Example description of needs**

```bash
# Lightweight linear baselines
--requirement "small nlinear baseline, parameter budget under 0.1M"

# Long Horizon scene
--requirement "A model that depends well on horizon 720,"

# Assign Structure
--requirement "patch mlp with multiscale embedding, hidden_dim around 128"

# Chinese Requirements
--requirement "Models suitable for multivariant predictions with high inter-channel relevance"
```

### 5.2 `runner` - Bottom Experiment Control

```bash
# View current optimal result and session status
node bin/neo-cast.js runner status

# Assessment of current best model on reference test set (one-time)
node bin/neo-cast.js runner ref-test

# Manually trigger one training (need current_candidate.json ready)
node bin/neo-cast.js runner run --description "manual baseline"

# Reinitiate session (cleansing of historical status, start a new search)
node bin/neo-cast.js runner init --force
```

### 5.3 `validate` - Program Validation

```bash
# Verify the validity of a Recipe JSON
node bin/neo-cast.js validate recipe /path/to/recipe.json

# Verify + Rapid smoke run (2 epoch, verify running)
node bin/neo-cast.js validate smoke

# Verify Data Set
node bin/neo-cast.js validate dataset .neo-cast/dataset_spec.json
```

### 5.4 Other commands

```bash
# Environmental diagnosis
node bin/neo-cast.js doctor

# View current configuration (sensitive information desensitization)
node bin/neo-cast.js config show

# Preparation of new data sets (when other data sets are first used)
node bin/neo-cast.js prepare-data --source /path/to/ETTh1.csv

# Initialize Python run-time (first time or when rebuilt)
node bin/neo-cast.js init-runtime
```

---

## VI. Typical use of scenes

### Scenario A: Quick debugging (no GPU, no API Key)

Validate whether the process is normal with `--mock-llm`+`FAST_E2E`, about 30 seconds per round:

```bash
cd neo_cast
export NEO_CAST_FAST_E2E=1  # Compress training to 2 epoch, accelerating validation

node bin/neo-cast.js design \
  --requirement "dlinear baseline for etth1" \
  --mode companion \
  --max-candidates 2 \
  --mock-llm
```

Expected output:
```
[requirement ]  dlinear baseline for etth1
[max rounds  ]  2

[Round 1     ]  trying recipe:none+linear
[source      ]  heuristic_mock
  Training…
[val_avg_mse ]  1.091770
[decision    ]  ✓ KEEP

design complete
[best model  ]  recipe:none+linear
[val_avg_mse ]  1.091770
```

### scene B: Real LLM search (with API Key)

```bash
cd neo_cast
export NEO_CAST_LLM_API_KEY="your-key"

node bin/neo-cast.js design \
  --requirement "patch transformer for etth1, focus on reducing h720 MSE" \
  --mode companion \
  --max-candidates 5 \
  --use-reflection
```

At the end of each round, print:
```
design_attempt=2
candidate_source=anthropic
candidate_family=recipe:patch+transformer
candidate_id=recipe_patch_transformer_etth1_h720
runner_status=keep
runner_val_avg_mse=0.842310
```

### Scenario C: Socratic model (when needs are not clear)

```bash
node bin/neo-cast.js design \
  --requirement "I need a predictive ETTh1 model." \
  --mode socratic \
  --max-candidates 3
```

There will be an interactive question-and-answer session at the end:
```
Model preference (transformer / dlinear / tcn / nbeats / timesnet / patch_mlp, blank to skip): transformer
Parameter budget in millions (blank for default):
Latency priority (low / medium / high, blank for default): medium
Any extra notes? (blank to Skip): long horizon 720 steady

Proceed? [Y/n]: Y
[Design cycle begins without interaction]
```

Skip Interactive (CI scene):

```bash
node bin/neo-cast.js design \
  --requirement "efficient ETTh1 model" \
  --mode socratic \
  --model-preference transformer \
  --latency-priority medium \
  --yes \
  --max-candidates 3
```

### Scene D: View and evaluate historical experiments

```bash
# Check all the lab records.
node bin/neo-cast.js runner status

# Evaluate optimal models on reference test sets (limited number of calls only)
node bin/neo-cast.js runner ref-test

# View assessment reports
open -a Typora .neo-cast/artifacts/run_20260429-010200-hbrp/eval_report.md
```

---

## VII. Output products

Each successful training in `.neo-cast/artifacts/run_<run_id>/` generates **17 files**:

```
run_20260429-010200-hbrp/
├── model.pt               ← PyTorch weights: one state dict per horizon
├── model_impl.py          ← Independently importable model class
├── inference.py           ← Inference wrapper: load_model / predict API
├── example.py             ← Quick inference example
├── mcp_server.py          ← MCP tool server for AI agents
├── tool_schema.json       ← MCP tool JSON Schema
├── eval_report.md         ← Validation/reference-test MSE and MAE report
├── val_metrics.json       ← Machine-readable validation metrics
├── training_summary.json  ← Architecture summary: backbone, parameters, training time
├── preprocess.json        ← StandardScaler mean and variance
├── metadata.json          ← Complete metadata
├── model_spec.json        ← Model specification for deployment validation
├── patch_bundle.json      ← Recipe patch bundle for experiment reproduction
├── resolved_candidate.json ← Fully resolved candidate configuration
├── README.md              ← Artifact instructions
├── requirements.txt       ← Python dependencies
└── ref_test_metrics.json  ← Reference-test metrics, when evaluated
```

**Example of current best product** (`run_20260429-010200-hbrp`):

```
Model: Linear + none embedding (NLinear baseline)
Parameters: 0.69 M
Training time: 5.3 seconds

Validation set (standard_scaled space):
  avg  MSE=1.092  MAE=0.709
  h96  MSE=0.691  MAE=0.566
  h720 MSE=1.510  MAE=0.853

Reference Test Set:
  avg  MSE=0.438  MAE=0.444
  h96  MSE=0.404  MAE=0.419
  h720 MSE=0.471  MAE=0.479
```

### Use inference interfaces

```python
# Run example scripts directly
python .neo-cast/artifacts/run_20260429-010200-hbrp/example.py

# Call in your own code
from inference import load_model, predict

model = load_model("model.pt", "preprocess.json")
# History: Shape [512, 7], recent 512 step, 7 channel, original (unintegrated) value
predictions = predict(model, history, horizon=96)
# predictions: shape [96, 7]
```

### Start MCP Tool Server

```bash
python .neo-cast/artifacts/run_20260429-010200-hbrp/mcp_server.py
# Exposure forecast (history, horizon) tool
# AI Agent can be called by MCP protocol
```

---

## VIII. Fixed protocol parameters (non-modifiable)

The following parameters are solidified in `py/prepare_tsf.py` and all experiments are shared to ensure comparability of the experiments:

| Parameters | Value | Annotations |
|---|---|---|
| `INPUT_LEN` | **512** | Enter window length (time steps) |
| `HORIZONS` | **96 / 192 / 336 / 720** | 4 forecast length, average MSE as primary metric |
| `NUM_CHANNELS` | **7** | ETTh1 Channels (HUFL/HULL/MUFL/MULL/LUFL/LULL/OT) |
| `SEED` | **42** | Global Random Feeds |
| `TIME_BUDGET` | **600 s** | Maximum time per training (10 minutes) |
| `PARAM_BUDGET` | **1,000,000** | A soft upper limit (1M) |
| Data Split | train [0, 8640) / val [8640, 11520) / ref_test [11520, 14400) | We're going to do it in time, not randomly. |
| Normalization | StandardScaler | val/test with the same scaler |

---

## ix. Recipe action space

The LLM generated candidate must meet `recipe_schema_v1` and support the following combinations:

### Pregressing (multiple actions available)

| type | Parameters | Annotations |
|---|---|---|
| `none` | — | No pre-treatment |
| `instance_norm` | `affine`, `eps` | Quote Harmonization |
| `series_decomposition` | `method="moving_average"`, `kernel_size` | Trends/seasonal breakdown |
| `seasonal_differencing` | `period`, `order` | Seasonal differential |
| `missing_mask` | `mask_channel`, `fill_policy` | Missing value mask |
| `sample_reweighting` | `scheme` | Sample weighting |

### Embedding

| type | Annotations |
|---|---|
| `none` | Do not embed, send directly backbone |
| `patch` | Fixed Patch Split + Linear Projection |
| `multiscale_patch` | Multiscale watch branch + cross-scale integration;`num_blocks` control processing depth |
| `invert` | iTransformer style: variable-by-variate, channel token; Transformer path does not use variable location encoding |
| `frequency` | FFT frequency domain feature |
| `calendar` | Time characteristics (hours/week/month) |

### Backbone (10 species)

| type | Apply scene |
|---|---|
| `linear` | Maximum light baseline |
| `mlp` | Local identity learning |
| `transformer` | Global attention, long sequences. |
| `rnn` (gru/lstm) | Sequence modelling, status. |
| `dlinear` | Trends/seasonal decomposition linear projections |
| `tcn` | Cyclops, local-medium-range dependence |
| `nbeats` | Residual retrospective predictor block |
| `timesnet` | FFT cycle modelling + 2D volume |
| `ssm` | State spatial model |
| `mixer` | MLP-Mixer Time series version |

### Fusion

| type | Annotations |
|---|---|
| `temporal` (independent/shared) | Time dimension integration, independent/shared channels |
| `feature` | Characteristic dimension integration |
| `temporal_then_feature` | Time after feature. |
| `feature_then_temporal` | Characteristics before time |
| `graph` | Learn the volume of adjacent arrays |
| `gated_hybrid` | Mixing of door controls |

### Prediction Head

`direct_multi_horizon` deleted; The old configuration verification failed to generate a new candidate using the supported head.

| type | Annotations |
|---|---|
| `linear` | Linear heads for dot prediction |
| `quantile` | Rating projection (uncertainty) |
| `gaussian` | Gausse Distribution Output |
| `residual_correction` | Disability correction header |

---

## X. Experimental management

### View History

```bash
# Console Summary
node bin/neo-cast.js runner status

# Full results table (TSV format)
cat .neo-cast/results.tsv | column -t

# Analyse with Python
python3 -c "
import pandas as pd
df = pd.read_csv('.neo-cast/results.tsv', sep='\t')
print(df[['candidate_id','val_avg_mse','val_h96_mse','val_h720_mse','params_M','status']].to_string())
"
```

### Current experimental state (2026-04-29)

```
session: 20260429-010149
Number of experiments: 13 (including this session)
Number of keepp: 1
Current Best: val_avg_mse = 1.0918 (linear+none, 0.69M parameter)
Best run_id: 20260429-010200-hbrp
```

> **Note: Both historical experiments have produced the same linear architecture using the inspirational rule of `--mock-llm`. The real LLM will be used before the structure diversity becomes available.

### Start a new search round

If you want to empty the current session to restart:

```bash
node bin/neo-cast.js runner init --force
# After running properly the design command
```

The old artifices will not be deleted, and results.tsv will be re-initiated.

---

## XI. CURRENT ISSUES

**Q: Only 1 keep, all the others are discard. Is it normal?**

A: Normal. In `--use-mutation` mode, the `poor_val_mse=1.1` threshold of the custom will make the linear structure look "OK" and not automatically switch to a more complex architecture. Solutions:
1. Default not `--stop-on-keep` to run all rounds
2. Add `--use-reflection` to enable LLM reflection
3. Specify the desired structure in `--requirement` (e. g. "transformer base")

**: val_avg_mse is much higher than the reference.**

MSE of the A:val set (time step 8640-11520) is not directly comparable to the original value, calculated under a unified space for StandardScaler. MSE of the ref_test set is closer to the literature value (the best current ref_test avg MSE=0.438).

**Q: How do you run on your own data set?**

A:
```bash
# Replace with your CSV file; timestamp and feature columns are required
node bin/neo-cast.js prepare-data \
  --source /path/to/your_data.csv \
  --task-id mytask \
  --feature-cols col1,col2,col3 \
  --timestamp-col timestamp \
  --force
```

**Q: What is `--use-reflection`?**

A: LLM Reflection Agent analyses the ross curve and per-horizon indicators after each training, generating the next candidate with a chain of inference. The design document is available in `docs/llm_reflection_agent_design.md`.

**Q: How to repeat an experiment?**

A: `resolved_candidate.json` in each artifact directory contains complete model configuration and training parameters (intended random seeds seed=42):

```bash
cp .neo-cast/artifacts/run_20260429-010200-hbrp/resolved_candidate.json \
   .neo-cast/current_candidate.json
node bin/neo-cast.js runner run --description "reproduce" --skip-smoke
```

---

## XII. Order sped-up forms

```bash
# ── Environment ──────────────────────────────────────────────────
node bin/neo-cast.js doctor                    # Environmental diagnosis
node bin/neo-cast.js config show               # View Configuration
node bin/neo-cast.js init-runtime              # Initialize Python venv

# ── Design search (main stream)────────────────────────────────────
# mock mode (no API Key, referred to)
export NEO_CAST_FAST_E2E=1
node bin/neo-cast.js design \
  --requirement "dlinear baseline" \
  --mode companion --max-candidates 2 --mock-llm

# Real LLM search
export NEO_CAST_LLM_API_KEY="your-key"
node bin/neo-cast.js design \
  --requirement "patch transformer, focus on h720" \
  --mode companion --max-candidates 5 --use-reflection

# ── Experimental management ──────────────────────────────────────────────
node bin/neo-cast.js runner status             # Current Best & Session Information
node bin/neo-cast.js runner ref-test           # Reference test set assessment (limited number)
node bin/neo-cast.js runner init --force       # Reset Session

# ── Verify ──────────────────────────────────────────────────
node bin/neo-cast.js validate recipe /path/to/recipe.json
node bin/neo-cast.js validate smoke            # smoke gate

# ── Product View ──────────────────────────────────────────────
ls .neo-cast/artifacts/                        # All run
open -a Typora .neo-cast/artifacts/run_<id>/eval_report.md
python .neo-cast/artifacts/run_<id>/example.py  # Examples of running inference
python .neo-cast/artifacts/run_<id>/mcp_server.py  # Start MCP service
```
