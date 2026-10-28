# neo-cast Usage Guide

The current default generates `model_recipe.v2` and executes `recipe_schema_v3`. It adds diagonal SSM, TimesBlock encoder, Mamba-1, and constrained two-branch compositions; older inputs remain compatible. See [v3 implementation](docs/recipe_runtime_v3_contract.md) for versions, deduplication, and CPU/CUDA boundaries. Older examples below remain executable but do not cover every new capability.

> **neo-cast** is a CLI: describe your time-series forecasting requirements and it designs and trains candidates, then exports deployable artifacts (weights, MCP tools, inference code, and evaluation reports).

---

## Contents

1. [Installation](#1-installation)
2. [Configure API Keys](#2-configure-api-keys)
3. [Initialize the Project Environment](#3-initialize-the-project-environment)
4. [Two Interaction Modes](#4-two-interaction-modes)
5. [Inputs](#5-inputs)
6. [Hyperparameter Reference](#6-hyperparameter-reference)
7. [Outputs](#7-outputs)
8. [Common Commands](#8-common-commands)

---

## 1. Installation

### Option A: Global npm installation (recommended for users)

```bash
npm install -g neo-cast
```

After installation, `neo-cast` is available from any directory.

### Option B: Install from source (recommended for developers)

```bash
# Download and extract the source archive first
cd /path/to/NeoResearch/neo_cast
npm install
npm link          # Register neo-cast globally; source changes take effect immediately
```

> See `DEVELOPMENT.md` for VS Code and inspector debugging.

---

## 2. Configure API Keys

neo-cast generates candidate configurations with an LLM and supports two API types.

### Option A: Anthropic Claude (default)

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Alternatively, copy the template into a project-root `.env` file:

```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

Persistent user configuration (applies to all projects):

```bash
neo-cast config init          # Generate ~/.config/neo-cast/config.json
```

Edit this file:

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "temperature": 0.3
  }
}
```

### Option B: OpenAI-compatible endpoints (AIGCBEST, local vLLM, etc.)

```bash
export NEO_CAST_LLM_API_KEY="your-key"
```

User configuration:

```json
{
  "llm": {
    "provider": "openai-compatible",
    "base_url": "https://api.aigcbest.top/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 1024,
    "temperature": 0.3
  }
}
```

### No API key (development)

Pass `--mock-llm` or set `NEO_CAST_USE_MOCK=1` to generate candidates offline with built-in heuristics. Without an LLM API key, `doctor` warns and suggests mock fallback, allowing the local alpha demo to proceed:

```bash
neo-cast design --requirement "test model" --mock-llm
NEO_CAST_USE_MOCK=1 neo-cast design --requirement "test model"
```

Verify the configuration:

```bash
neo-cast doctor
# Example successful output:
# [OK] python3: Python 3.12.x [runtime venv]
# [OK] uv: Detected uv 0.x.x
# [OK] anthropic_api_key: ANTHROPIC_API_KEY is set.
# [OK] config: Resolved config is valid.
# [OK] runtime: Project runtime is ready at ...
```

---

## 3. Initialize the Project Environment

**Run once per project directory.** In your working directory, rather than the neo-cast source directory, run:

```bash
# 1. Create the Python runtime in .neo-cast/runtime/.venv
neo-cast init-runtime

# 2. Prepare the dataset (requires ETTh1.csv)
#    Download: https://github.com/thuml/Time-Series-Library -> dataset/ETT-small/ETTh1.csv
neo-cast prepare-data --source /path/to/ETTh1.csv

# 3. Generate a structured research task contract (Task DSL)
neo-cast task-spec init --from-dataset .neo-cast/dataset_spec.json
neo-cast task-spec validate .neo-cast/task_spec.json

# 4. Verify the environment
neo-cast doctor
```

This creates `.neo-cast/` in the working directory; subsequent experiment artifacts are stored there.
Each exported training artifact includes `research_trace.json`. In addition, `.neo-cast/research_trace.jsonl`
records the rationale, expected effects, and verification plans for key research decisions.

ModelDesigner generates a high-level `model_recipe.v1` with `model_name / input / architecture / training / constraints`.
Runtime compiles it to `recipe_schema_v2`, then performs smoke validation, training, evaluation, and export. Older recipes/checkpoints require migration and retraining; runtime semantics revision is 2. See the [v2 contract](docs/recipe_runtime_v2_contract.md).

Enable a human checkpoint to gate runtime on approval of the model design:

```bash
neo-cast design \
  --requirement "use a compact baseline" \
  --mode companion \
  --max-candidates 1 \
  --mock-llm \
  --require-approval

neo-cast checkpoint status
neo-cast checkpoint approve model_design --note "Approve this model design"
neo-cast runner run --description "approved model design"
```

Approval is saved to `.neo-cast/approval_state.json`. While `model_design` is pending or rejected,
the runner refuses to start training.

Record corrections in Human Feedback Memory so they persist beyond the chat:

```bash
neo-cast correction add \
  --scope data_schema \
  --field temperature_forecast \
  --correction "available only at prediction time"

neo-cast correction add \
  --scope split_policy \
  --correction "data must be split in chronological order only"

neo-cast correction list
```

These records are stored in `.neo-cast/user_corrections.json`. Subsequent `design` and reflection runs inject active corrections
into task context as authoritative user constraints.

---

## 4. Two Interaction Modes

### Mode 1: Socratic

**Use when:** requirements are unclear and constraints need clarification before training.

**Workflow:** neo-cast gathers requirements conversationally, then trains candidates automatically after confirmation.

```bash
neo-cast design \
  --requirement "I need an accurate ETTh1 forecasting model" \
  --mode socratic \
  --max-candidates 5
```

**Example terminal interaction:**

```
Model preference (transformer / nlinear / patch_mlp, blank to skip): transformer
Parameter budget in millions (blank for default):
Latency priority (low / medium / high, blank for default): medium
Any extra notes? (blank to skip): Stable long-horizon forecasts

Proceed with:
  Base requirement: I need an accurate ETTh1 forecasting model
  Model preference: transformer
  ...
Proceed? [Y/n]: Y

[Design loop starts; no further interaction required]
```

**Skip interaction for CI/scripts:** provide every detail through flags:

```bash
neo-cast design \
  --requirement "efficient ETTh1 model" \
  --mode socratic \
  --model-preference transformer \
  --latency-priority medium \
  --yes \
  --max-candidates 5
```

---

### Mode 2: Companion

**Use when:** requirements are clear and you want live design decisions and training progress, with the option to stop.

**Workflow:** training starts immediately. Each round prints the hypothesis, training settings, and validation results; enter `stop` between rounds to end early.

```bash
neo-cast design \
  --requirement "transformer based model for ETTh1" \
  --mode companion \
  --max-candidates 5
```

**Example terminal output:**

```
┌────────────────────────────┐
│  neo-cast companion mode   │
└────────────────────────────┘
[requirement ]  transformer based model for ETTh1
[max rounds  ]  5
  I will explain each decision as we go. Type "stop" to end early.

[Round 1     ]  trying TINY_TRANSFORMER
[hypothesis  ]  Patch transformer: captures temporal patterns with multi-head attention over patched windows.
[source      ]  Claude API
[lr          ]  0.001
[batch_size  ]  32
  Training…

[val_avg_mse ]  0.412847
[decision    ]  ✓ KEEP
[note        ]  new best — artifact saved

[Round 2     ]  trying PATCH_MLP
...

┌────────────────────────────┐
│  design complete           │
└────────────────────────────┘
[best model  ]  tiny_transformer
[val_avg_mse ]  0.412847
[run_id      ]  20260425-143022-abc123
[artifact    ]  .neo-cast/artifacts/run_20260425-143022-abc123/

  Run inference:  python .neo-cast/artifacts/run_.../example.py
  Start MCP tool: python .neo-cast/artifacts/run_.../mcp_server.py
```

**Stop interactively:** enter `stop` and press Enter between rounds; the system exits when the current round finishes.

---

### Mode Comparison

| Dimension | Socratic | Companion |
|---|---|---|
| Interaction before starting | Yes: gather requirements | No: start immediately |
| Interaction during execution | No | Yes: enter `stop` |
| Best for | Unclear requirements | Clear requirements and observing progress |
| Scripts/CI | With `--yes` | Built-in noninteractive output |

---

## 5. Inputs

### Required

| Input | Description |
|---|---|
| `--requirement "..."` | Natural-language requirements in English |
| ETTh1.csv | Import once through `prepare-data`; reused automatically |

### Optional Parameters

| Parameter | Default | Description |
|---|---|---|
| `--mode` | `socratic` | Interaction mode: `socratic` or `companion` |
| `--max-candidates` | `1` | Maximum candidates to try |
| `--mock-llm` | Off | Generate candidates heuristically without an API key |
| `--skip-smoke` | Off | Skip smoke validation for faster debugging |
| `--latency-priority` | `medium` | `low` / `medium` / `high` |
| `--notes` | — | Extra constraints appended to requirements |

### Example Requirements

```bash
# Lightweight linear baseline
--requirement "small nlinear baseline, parameter budget under 0.1M"

# Long-horizon forecasting
--requirement "a model that performs well on horizon 720, transformer preferred"

# Low-latency inference
--requirement "patch mlp model optimized for low inference latency"
```

---

## 6. Hyperparameter Reference

Hyperparameters have three layers: **fixed task constants**(hardcoded),**training hyperparameters**(LLM-generated and constrainable through requirements), and**model hyperparameters** (specific to each family).

---

### 6.1 Fixed Task Constants (`prepare_tsf.py`)

| Constant | Value | Description |
|---|---|---|
| `INPUT_LEN` | **512** | Input window length in time steps |
| `HORIZONS` | **96 / 192 / 336 / 720** | Train all four horizons and average results |
| `NUM_CHANNELS` | **7** | ETTh1 channels: HUFL/HULL/MUFL/MULL/LUFL/LULL/OT |
| `SEED` | **42** | Global random seed |
| `TIME_BUDGET` | **600 s** | Maximum wall-clock training time (10 minutes) |
| `PARAM_BUDGET` | **1,000,000** | Soft parameter limit (1M parameters) |
| Dataset split | train [0, 8640) / val [8640, 11520) / ref_test [11520, 14400) | Time-step indices without shuffling |
| Normalization | `StandardScaler` fitted on training data | Validation/test use training mean and variance |

---

### 6.2 Training Hyperparameters (`train_config`, LLM-generated)

The LLM specifies the candidate JSON's `train_config`, which `renderer.py` parses.

| Hyperparameter | Type | Range | Default | Description |
|---|---|---|---|---|
| `lr` | float | (0, 1.0] | `0.001` | Adam learning rate |
| `batch_size` | int | [1, 512] | `32` | Mini-batch size |
| `max_epochs` | int | [1, 1000] | `100` | Maximum epochs; early stopping may terminate sooner |
| `patience` | int | [1, 100] | **7** | Consecutive epochs without val_loss improvement |
| `weight_decay` | float | [0, 1.0] | **0.0** | L2 regularization coefficient |
| `seed` | int | [0, 2147483647] | **42** | Experiment random seed |

> `patience`, `weight_decay`, and `seed` are optional; `renderer.py` supplies defaults when omitted by the LLM.

**Smoke configuration** (automatically reduced for quick candidate validation):

| Parameter | Smoke value | Description |
|---|---|---|
| horizon | 96 | Run only the shortest horizon |
| batch_size | 16 | Forced smaller batch |
| max_epochs | 2 | Run two epochs only |
| timeout | 60 s | Timeout means FAIL |

---

### 6.3 Model Hyperparameters (`model_config`, by family)

#### nlinear — Channel-independent Linear Mapping

The lightest baseline, with `INPUT_LEN × HORIZON × NUM_CHANNELS` parameters.

| Hyperparameter | Type | Default | Description |
|---|---|---|---|
| `residual` | bool | `true` | Subtract the last time step before linear mapping, as in NLinear; strongly recommended |

Implementation: independent `nn.Linear(512, horizon)` per channel, with no cross-channel parameter sharing.

---

#### tiny_transformer — Patch Transformer

Split the input into nonoverlapping patches, embed tokens, pass through a Transformer Encoder, then apply GlobalAvgPool and a linear prediction head.

| Hyperparameter | Type | Range | Recommended | Description |
|---|---|---|---|---|
| `d_model` | int | [8, 1024] | 32 / 64 / 128 | Transformer hidden dimension; **must be divisible by n_heads** |
| `n_heads` | int | [1, 32] | 4 | Attention heads; requires `d_model % n_heads == 0` |
| `n_layers` | int | [1, 24] | 1 / 2 / 3 | Encoder layers |
| `patch_size` | int | [2, 512] | 8 / 16 / 32 | Patch length and stride; no overlap |
| `dropout` | float | [0.0, 0.9] | 0.0 / 0.1 | Dropout on FFN and Attention |
| `ffn_mult` | float | [1.0, 16.0] | **4.0** | Optional FFN hidden multiplier (`d_model × ffn_mult`) |

**Constraints:**
- `d_model % n_heads == 0`; otherwise validation fails.
- `patch_size <= INPUT_LEN` (at most 512).
- Stride equals patch_size (nonoverlapping).

**Parameter estimate** (one horizon model):
```
num_patches = 1 + (512 - patch_size) // patch_size
patch_embed: patch_size × d_model
pos_embed: num_patches × d_model
encoder × n_layers: ~4 × d_model²
head: d_model × horizon
```

---

#### patch_mlp — Patch MLP-Mixer

Embed input patches, apply n MixerBlock (LayerNorm, two-layer MLP, residual), then GlobalAvgPool and linear prediction.

| Hyperparameter | Type | Range | Recommended | Description |
|---|---|---|---|---|
| `patch_size` | int | [2, 512] | 8 / 16 / 32 | Patch length |
| `stride` | int | [1, 512] | Usually patch_size / 2 | Sliding stride; **must not exceed patch_size** |
| `hidden_dim` | int | [8, 4096] | 64 / 128 / 256 | MLP hidden dimension; FFN expands to twice this width |
| `n_layers` | int | [1, 24] | 1 / 2 / 3 | MixerBlock count |
| `dropout` | float | [0.0, 0.9] | 0.0 / 0.1 | Dropout rate |

**Constraints:**
- `stride <= patch_size`; otherwise validation fails.
- `patch_size <= INPUT_LEN`

---

### 6.4 Resource Constraints (`constraints`, optional)

Describe constraints in natural language; the LLM fills the candidate's `constraints` field.

| Field | Type | Limit | Description |
|---|---|---|---|
| `params_max_million` | float | 1.0 M | Soft parameter limit; no automatic error, but guides the LLM |
| `time_budget_seconds` | int | 600 s | Training time limit; exceeding it terminates training |
| `latency_priority` | string | — | `low` / `medium` / `high`; influences architecture selection |

---

### 6.5 Control Hyperparameters through Requirements

Describe constraints in `--requirement`; the LLM converts them into configuration:

```bash
# Prefer lightweight models
neo-cast design --requirement "a model under 0.1M params, nlinear preferred"

# Specify architecture details
neo-cast design --requirement "tiny transformer, d_model=64, 2 layers, patch_size=16"

# Resource constraints
neo-cast design --requirement "fast inference (latency_priority=high), training budget 5 minutes"

# Multiple objectives
neo-cast design --requirement "patch mlp, hidden_dim around 128, good on horizon 720"
```

---

## 7. Outputs

Each successful `design` run creates a complete **ten-file** package in `.neo-cast/artifacts/run_<run_id>/`:

```
run_20260425-143022-abc123/
├── model.pt              # PyTorch weights
├── metadata.json         # Complete experiment metadata: candidate, training configuration, evaluation
├── model_impl.py         # Standalone model class
├── inference.py          # Inference wrapper: load_model / predict API
├── mcp_server.py         # MCP tool server for AI agents
├── tool_schema.json      # MCP tool JSON Schema
├── eval_report.md        # MSE/MAE by horizon and baseline comparison
├── README.md             # Artifact usage instructions
├── requirements.txt      # Python dependencies
└── example.py            # Quick inference example
```

### Use the Outputs

**Run inference directly:**

```bash
python .neo-cast/artifacts/run_<id>/example.py
# Input: random 512-step history across seven channels
# Output: forecasts for horizon 96/192/336/720
```

**Use as an AI agent tool through MCP:**

```bash
python .neo-cast/artifacts/run_<id>/mcp_server.py
# Expose forecast(history, horizon)
# history: floating-point array [512][7]
# horizon: 96 | 192 | 336 | 720
# Returns: predictions [horizon][7]
```

**View the evaluation report:**

```bash
open -a Typora .neo-cast/artifacts/run_<id>/eval_report.md
# Includes MSE/MAE by horizon and comparison against nlinear
```

**View experiment history:**

```bash
neo-cast runner status
# Print historical records from results.tsv
```

**Evaluate the reference test set:**

```bash
neo-cast runner ref-test
# Evaluate the best model on ref_test, time steps 11520-14400
# Append results to eval_report.md
```

### Result File

`.neo-cast/results.tsv` records each training summary:

| Column | Description |
|---|---|
| `run_id` | Unique run ID |
| `candidate_id` | LLM-generated candidate ID |
| `model_family` | nlinear / tiny_transformer / patch_mlp |
| `val_avg_mse` | Mean validation MSE over four horizon |
| `status` | `keep` / `discard` / `crash` |
| `is_best` | `1` means best so far |

---

## 8. Common Commands

```bash
# Check the environment
neo-cast doctor

# Initialize the runtime once
neo-cast init-runtime

# Import the dataset once
neo-cast prepare-data --source /path/to/ETTh1.csv

# Socratic: clarify requirements, then train five rounds automatically
neo-cast design \
  --requirement "long horizon transformer for ETTh1" \
  --mode socratic \
  --max-candidates 5

# Companion: start immediately with live narration, at most three rounds
neo-cast design \
  --requirement "efficient patch mlp model" \
  --mode companion \
  --max-candidates 3

# Mock mode without an API key for debugging
neo-cast design \
  --requirement "test" \
  --mode companion \
  --max-candidates 2 \
  --mock-llm

# View the best result
neo-cast runner status

# Evaluate the reference test set
neo-cast runner ref-test

# Inspect generated artifacts
ls .neo-cast/artifacts/

# View the current configuration
neo-cast config show
```
