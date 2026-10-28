# Neo-cast Retrofitable Road Map

> Objective: To transform the current local research closed loop into an installed CLI tool to support users in presenting time-series modelling needs, automatically designing small models, running experiments under fixed protocols and exporting replicable artifact.

---

## 1. Product definition

### 1.1. What's the real delivery for the first edition?

The first version of `neo-cast` is not a "generic AutoML platform" or an "automated model for any data set".
Its scope is limited by:

- Single task: `ETTh1`
- Fixed Data Protocol: Follow current `prepare_tsf.py`
- Fixed search primary metric: `val_avg_mse`
- Fixed editable face: `train.py`
- Fixed products: training results, model weights, loadable inference interfaces, final evaluation reports

First version of the main command target pattern:

```bash
neo-cast design
```

User experience target:

1. User input modelling needs
2. CLI Clarification of the necessary constraints through dialogue
3. The system does several rounds of candidate experiments under a fixed protocol.
4. System output best candidate for artifact and report

### 1.2.

The following competencies are explicitly excluded from the first edition:

- Multidata support
- More seed strict statistical validation
- Cross-mission research memory system
- Blind test online service
- Free generation of any Python code
- Automatically extract perfect `model.py` from any `train.py`

### 1.3 platform and version support

The first edition**only supports macOS and Linux**, not Windows (restricted by the difference between `uv` and shell behaviour, which is reserved for Phase 6+).

Minimum version requirements:

- Node.js**= 20** (ESM modular format)
- Python **>= 3.10**
- `uv` (latest stable version)
- macOS 12+ / Ubuntu 22.04+

### Full process (Quickstart) for 1.4 users from zero to the first artifact

The first version of the onboarding path must be clear, so that users are not "not aware of the next step."

```bash
# 1. Install CLI
npm install -g neo-cast

# 2. Configure API key (environmental variables or write user-level config)
export ANTHROPIC_API_KEY="sk-ant-..."
neo-cast config init        # Generate ~/. config/neo-cast/config.json

# 3. Check the environment (python3 / uv / API key/ network)
neo-cast doctor

# 4. Create project level Python runtime
mkdir my-tsf-project && cd my-tsf-project
neo-cast init-runtime       # Install torch etc. on. neo-cast/runtime/.venv

# 5. Preparing data (user has to download ETTh1.csv first)
# Download from: https://github.com/thuml/Time-Series-Library
neo-cast prepare-data --source ~/Downloads/ETTh1.csv

# 6. Start designing models.
neo-cast design                     # Default Socratic Mode
# Or: neo-cast design-mode companion-max-candidates 10

# 7. View after completion
ls .neo-cast/artifacts/run_*/
# → model.pt, metadata.json, mcp_server.py, inference.py, README.md, ...

# 8. Deployment usage
# Method I: human directness
cd .neo-cast/artifacts/run_<id>/
pip install -r requirements.txt
python example.py

# Mode II: as an agent tool (MCP)
python mcp_server.py        # stdio transport, waiting for MCP link
```

Each step is supported by a corresponding CLI command or document, and the user does not need to flip the source code.

---

## 2. Key product principles

### 2.1 Contract, subsequently anent

Sets the following 12 decimation, then automating Node.js dialogue layers and LLM:

1. Runtime condition (Runtime environment)
2. Source Layout control (source directory)
3. Artifact ABI control
4. Candidate condition (candidates structure)
5. Data Preparation condition
6. Workspace & Session Contraction
7. Crash Recovery processing (abnormal)
8. Test Exposure contraction
9. API Config regulation (keys and configuration)
10. Renderer condition (candidates training script)
11. IPC protocol contract (Python ↔ Node.js event stream)
12. Exit Code factor (sub-process exit code)

### 2.2 `val` is the search signal, and `ref_test` is the final reporting signal.

In the first edition:

- `val_avg_mse` is the only high frequency decision-making indicator
- `ref_test` is only implemented once on the final best candidate and into the final report.
- `ref_test` cannot be used as a search signal for each round of keep/discard

It's done to avoid the product process starting with a bad combination of test.

### 2.3 does not " ex post code extraction" instead of "restricted export"

Instead of extracting clean `model.py` from any LLM-generated `train.py` afterwards, the more stable approach is:

- Make a model interface that you can export first.
- Candidate models must follow this interface.
- `export.py` Generate a Delineation Package based on this interface

In other words, the ability to export comes from **constraints at design**, not later AST magic.

### 2.4 First do Validator/ smoke run, then auto-search multiple rounds

The easiest place for automatic code generation to fail is not "models are not smart enough" but:

- The code is illegal.
- Shape, no.
- The output format is wrong
- Training directcrash

So Validator and Smoke Harness must be in front of, not behind.

---

## 3. The overall structure behind the tightening

```
User CLI input
     │
     ▼
┌──────────────────────────────────────┐
│            Node.js CLI Layer             │
│  Clarification required │ Tasking │ LLM Call │ Output Presentation │
└──────────────────┬───────────────────┘
                   │ spawn Python
                   ▼
┌──────────────────────────────────────┐
│           Python Runtume Layer           │
│  prepare_tsf.py Fixed Data/Assessment Protocol   │
│  train.py candidate model implementation portal     │
│  runner.py keep/discard Status Machine │
│  validate.py Add, Static Check/Smoking  │
│  export.py Add, export │
└──────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│             Artifact Layer               │
│  model.pt / metadata.json / report.md │
│  inference.py / model_impl.py         │
└──────────────────────────────────────┘
```

---

## 4. Contracts to Freeze Before Implementation

### 4.1 Runtime Contract

Release 1 does not commit "to automatically bring Python running time when npm packages are installed".
The first edition was explicitly adopted:

- npm CLI + Current Python Environment
- Onboard `python3 >= 3.10`
- Onboard `uv`
- Python dependent on first run by CLI-led installation

That means:

- `npm install -g neo-cast` to install CLI
- `neo-cast doctor` to check the environment
- `neo-cast init-runtime` is responsible for creating local operating environments

This is more enforceable than a `postinstall` inspection alone.

### 4.2 Source Layout Contract

Avoids double-source drift.
Release 1 retains only one Python source directory, such as:

```text
neo-cast/
  bin/
  src/
  py/
    prepare_tsf.py
    train.py
    runner.py
    validate.py
    export.py
    pyproject.toml
```

Node.js always calls only the code under `py/` and no longer maintains a two-track structure for root directories.

### 4.3 Artifact ABI

The first edition of the uniform provision for each successful candidate to export**a complete, stand-alone collection of small model codes**:

```text
artifacts/run_<id>/
  ├── model.pt                ← Trained weights and minimal configuration
  ├── metadata.json           ← Structured metadata for the task, model, requirement provenance, and search trajectory
  ├── preprocess.json         ← Inference preprocessing contract: feature order, scaler statistics, and input space
  ├── model_impl.py           ← Model definition required for inference, without training code
  ├── inference.py            ← Common Python API for direct human use
  ├── mcp_server.py           ← MCP server launcher exposing the model as an agent tool
  ├── tool_schema.json        ← MCP tool input/output JSON Schema
  ├── eval_report.md          ← Validation and test evaluation report
  ├── README.md               ← Requirement-specific design and two usage methods
  ├── requirements.txt        ← Runtime dependencies such as torch>=2.2, numpy, and anthropic-mcp
  └── example.py              ← Minimal runnable example
```

field:

- `model.pt`: Save weight only and minimum necessary configuration
- `metadata.json`: ABI Core, detailed below
- `preprocess.json`: Save `feature_names`, `input_space`, `output_space`, `scaler_mean`, `scaler_std`
- `model_impl.py`: Include only model definitions for inference
- `inference.py`: Exposure Unified `load_model()`/ `predict()` Interface (Human Inference)
- `mcp_server.py`: expose the model through MCP for agent tool calls, using the official [`mcp>=1.0`](https://pypi.org/project/mcp/) Python SDK. The artifact's `requirements.txt` must include `mcp>=1.0`.
- `tool_schema.json`: input/ output schema and natural language description for MCP tool
- `eval_report.md`: Final result and reference baseline
- `README.md`: Readable demand tracer information for metadata.json, including quickstart
- `requirements.txt`: Run dependent, user can use `pip install -r requirements.txt`
- `example.py`: A minimum call sample to verify that artifact runs through

Key points:

- `metadata.json` is the ABI core, not `train.py` itself
- Artificial must be **self-inflicted** - take the entire directory, delete neo-cast, still inference
- After that, multiple model families were allowed to coexist as long as they followed the same export ABI.

Additional agreement:

- There are two input calibres that must be supported simultaneously:
  - `predict_normalized(history, horizon)`: Enter as Standard Space
  - `predict_raw(history, horizon)`: Enter as original numerical space, standardized by `inference.py` for reading `preprocess.json`
- `tool_schema.json` / `mcp_server.py` / `README.md` must clearly state which input calibre is currently exposed to external exposure
- The first version of the default external exposure **raw space** interface; Standardized space interfaces are maintained only as internal advanced interfaces

#### `metadata.json` field specification

```json
{
  "artifact_version": "v1",
  "task_id": "etth1",
  "model_family": "tiny_transformer",
  "model_impl_entry": "model_impl.py:build_model",
  "state_dict_layout": "per_horizon",
  "input_len": 512,
  "horizons": [96, 192, 336, 720],
  "num_channels": 7,
  "normalization_space": "standard_scaled",
  "feature_names": ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"],
  "preprocess_entry": "preprocess.json",

  "user_requirement": "Original user demand text (natural language)",
  "design_hypothesis": "LLM selects tiny_transformer because the user refers to long horizon+ seasonality",
  "exploration_log": [
    {
      "candidate_id": 1,
      "model_family": "nlinear",
      "model_config": {},
      "verdict": "keep",
      "val_avg_mse": 0.4521,
      "reason": "Baseline, initial best"
    },
    {
      "candidate_id": 2,
      "model_family": "tiny_transformer",
      "model_config": {"d_model": 64, "n_heads": 4, "n_layers": 2, "patch_size": 16, "dropout": 0.1},
      "verdict": "keep",
      "val_avg_mse": 0.4387,
      "reason": "Patch + improvement 0.013 on long horizon"
    }
  ],

  "val_metrics": {
    "val_avg_mse": 0.4387,
    "val_h96_mse": 0.391,
    "val_h720_mse": 0.482
  },
  "ref_test_metrics": {
    "ref_test_avg_mse": 0.4534,
    "ref_test_h96_mse": 0.398,
    "ref_test_h720_mse": 0.491
  }
}
```

Additional agreement:

- `artifact_version` for future ABI migration
- `model_impl_entry` specifies the structural entry when restoring the model
- `state_dict_layout` is specified as `single_model`, `per_horizon` or `shared_backbone`
- `normalization_space` specifies the space for `predict()` input output and avoids a calibration drift when deduced
- `feature_names` must be consistent with the order in `preprocess.json`, and it is forbidden to speculate on column sequences when inference
- `user_requirement` / `design_hypothesis` / `exploration_log` provides**demand traceability**, making artifact really "specific to a particular need"

#### Tool-call morphological norms (MCP server)

`mcp_server.py` uses [Model Context Protocol](https://modelcontextprotocol.io) to encapsulate the model as an agent tol. Release 1 exposed only one tool:

```python
# Register a tool after mcp_server.py starts
{
  "name": "etth1_forecast",
  "description": "Forecast ETTh1 multivariate time series. Input a 512-step history window of 7 channels, output predictions for the requested horizon.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "history": {
        "type": "array",
        "description": "Shape [512, 7] in raw ETTh1 feature space, ordered as feature_names in preprocess.json",
        "items": {"type": "array", "items": {"type": "number"}}
      },
      "horizon": {
        "type": "integer",
        "enum": [96, 192, 336, 720]
      }
    },
    "required": ["history", "horizon"]
  }
}
```

_Other Organiser

```bash
# Under artifact directory
python mcp_server.py        # Default stdio transport
python mcp_server.py --http # Optional HTTP transfer
```

Agent ends with a direct `tools/list` + `tools/call` call without additional glue code.`tool_schema.json` is a separate version of the above-mentioned schema file, which facilitates static reading by other clients.

### 4.4 Candidate Contract

LLM cannot directly output "any `train.py`".
The first edition tightens to an output of a structured candidate:

```json
{
  "hypothesis": "Small Patch + light self-attention better suited to ETTh1,
  “model_family”: “tiny_transformer”,
  “model_config”: {
    “d_model”: 64,
    “n_heads”: 4,
    “n_layers”: 2,
    “dropout”: 0.1
  },
  “train_config”: {
    “lr”: 0.001,
    “batch_size”: 32,
    “max_epochs”: 50
  }
}
```

Node.js writes candidate JSON to `<project>/.neo-cast/current_candidate.json`. Python's `renderer.py` reads, validates, and normalizes it into `<project>/.neo-cast/resolved_candidate.json`. Fixed `train.py` reads only `resolved_candidate.json` and dispatches to the appropriate model family. Node.js neither interprets model configuration semantics nor generates Python code.

#### Supported Model Family (`candidate_schema.json`)

The first edition supports only the following three restricted model communities, Validator and LLM, all of which must generate candidates within this range:

```json
{
  “model_families”: {
    “nlinear”: {
      "Description": "Channel-Independent NLinear, most linear baseline without additional model_config",
      “model_config”: {}
    },
    “tiny_transformer”: {
      "Description": "Soft Patch Transformer, CI Modelling, Patching Input + Multi-Elemental Attention"
      “model_config”: {
        “d_model”:    { “type”: “int”,   “choices”: [32, 64, 128] },
        “n_heads”:    { “type”: “int”,   “choices”: [2, 4, 8] },
        “n_layers”:   { “type”: “int”,   “choices”: [1, 2, 3, 4] },
        “patch_size”: { “type”: “int”,   “choices”: [8, 16, 32] },
        “dropout”:    { “type”: “float”, “choices”: [0.0, 0.1, 0.2] }
      }
    },
    “patch_mlp”: {
      "description": "Patch MLP-Mixer, CI Modeling, Patching MLP to make time dimensions"
      “model_config”: {
        “patch_size”:  { “type”: “int”,   “choices”: [8, 16, 32] },
        “stride”:      { “type”: “int”,   “choices”: [4, 8, 16] },
        “hidden_dim”:  { “type”: “int”,   “choices”: [64, 128, 256] },
        “dropout”:     { “type”: “float”, “choices”: [0.0, 0.1, 0.2] }
      }
    }
  },
  “train_config_schema”: {
    “lr”:         { “type”: “float”, “range”: [1e-4, 1e-2] },
    “batch_size”: { “type”: “int”,   “choices”: [16, 32, 64] },
    “max_epochs”: { “type”: “int”,   “range”: [10, 100] }
  }
}
```

Have agreed:
- `model_family` must be one of the three above, otherwise Validator simply refuses
- Field values in `model_config` must be inside the corresponding `choices` or `range`, otherwise Validator refuses
- `model_config` for `nlinear` must be an empty object `{}`
- Extending the new model family needs to be synchronized with `candidate_schema.json`, not allowing unregistered families to be used directly in candidate

#### Budget sources and default values

The first version considers the experimental budget as a question preset, not a magic number scattered across the scripts. Default source priority:

1. CLI flags (if achieved)
2. Project level config
3. Candidate `constraints` (only allowed to tighten, not relax the platform ceiling)
4. task preset default

ETTh1 Default for first edition:

- `PARAM_BUDGET = 1.0` (unit: million parents)
- `TIME_BUDGET = 1800` (unit: seconds, candidate full run)

`renderer.py` must write the final effective `param_budget_m`/ `time_budget_s` to `resolved_candidate.json`, followed by `validate.py`, `train.py` and `runner.py` all consume only resolved values without setting defaults.

### 4.5 Data Preparation Contract

Release 1 requires that data be prepared on the side of the user, and CLI provides a guide tool without auto downloading.

#### User Process

```bash
# 1. User downloads ETTh1.csv (source: Time-Series-Library dataset)
# 2. Initializing data
neo-cast prepare-data --source /path/to/ETTh1.csv

# Check for data readiness
neo-cast doctor
```

Internal `prepare-data` command calling `prepare_tsf.py --materialize-visible` to generate:
- `~/.cache/neo_research_tsf/dataset/ETT-small/ETTh1_visible.csv` (train+val, Agent visible)
- `~/.cache/neo_research_tsf/dataset/ETT-small/ETTh1_ref_test.csv` (test, only for CLI final evaluation)

#### Boundary agreement

- Data path supports environmental variable coverage: `NEO_TSF_DATA_ROOT`
- When `neo-cast design` is detected when data is not ready, give a clear hint and guide the execution of `prepare-data`
- Release 1 does not support user input of custom CSV, and if it is entered into a non-ETTh1 file, give friendly reporting of errors

### 4.6 Workspace & Session Contract

The first version needs to specify where all running-time states are, avoiding the spread of `config`, Candidate, `results.tsv` and artifact.

Default to:

- Project status directory: `<project>/.neo-cast/`
- Project level runtime: `<project>/.neo-cast/runtime/.venv`
- Project level session directory: `<project>/.neo-cast/sessions/<session_id>/`
- Project-level results table: `<project>/.neo-cast/results.tsv`
- Project level candidate file: `<project>/.neo-cast/current_candidate.json`
- Project level artifact directory: `<project>/.neo-cast/artifacts/run_<id>/`

Of which:

- User-level config still `~/.config/neo-cast/config.json`
- Project level config `<project>/.neo-cast/config.json`
- Python Bridge, Runner, Exporter all read and write only project-level status directories

The first version of `session_id` recommends:

- `YYYYMMDD-HHMMSS-<short_random>`

The benefits of doing so are:

- Remove the project directory to clean up the status of the item
- Different projects do not pollute each other
- `python-bridge` doesn't need to guess where the outcome document is.

### 4.7 Crash Recovery Contract

Crash is a common occurrence in the course of training (OOM, Shape Error, NaN loss, etc.). The first edition provides for a unified treatment strategy:

| Situation | Conditions for determination | Treatment |
|---|---|---|
| Smoke run crash | smoke run non-zero exit or timeout | Mark candidate as `invalid`, Skip, do not enter full run |
| Full run crash | Full run non-zero exit or timeout | Mark as `crash`, record to `results.tsv`, discard this workdir and keep the current best run pointer |
| NaN indicator | val_avg_mse = NaN in stdout | Equivalent crash processing |
| Beyond TIME_BUDGET | Runner detected timeout | Cut-off training with the best available checkpoint assessment, not considered a crash |

Retry policy:
- **Do not automatically try again**, Crash skips the current candidate directly after LLM proposes next candidate
- Suspended cycle after 3 crash, report to user and wait for command

Additional note:

- The first version of the term "roll back" is not `git reset`.
- "Roll Back" only means that the best pointer does not move forward, and candidate is currently discarded for workdir and temporary files
- `runner.py` maintains the current state of best through `best_run_id` or `best_artifact_path`, rather than relying on git history

### 4.8 Test Exposure Contract

The first version provides that:

- The normal experiment cycle only looks at validation
- `evaluate_ref_test()` call only for the final best candidate
- Ultimately, CLI output shows the test results
- The middle process doesn't pour `ref_test` back into the next search.

### 4.9 API Config Contract

The first version of the default achieves only one programr: `anthropic`.
But the configuration layer should be made provider-aware from the start to avoid `llm.js` being written dead in the back.

#### Segregation of key from configured duties

- Only environmental variables or systems are stored safely in the key
- Non-Sensitivity Profile
- Project configuration allows overwhelming user-level default configuration

The first version of the default agreement:

- `ANTHROPIC_API_KEY`
- Optional: `ANTHROPIC_BASE_URL`

#### Configure File Location

It is suggested that two layers of configuration be supported:

- User level: `~/.config/neo-cast/config.json`
- Project level: `<project>/.neo-cast/config.json`

#### Configure Priority

Harmonized:

1. CLI flags
2. Project level config
3. User-level config
4. Environmental variables
5. Default value

#### Proposed configuration for the first edition

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4",
    "base_url": null,
    "max_tokens": 4000,
    "temperature": 0.2,
    "timeout_seconds": 120
  }
}
```

#### Node.js side contract

`src/llm.js` should not read environment variables directly from all locations.
A more stable approach would be to:

- `src/config.js` Unified Parsing env/ user-level config/ project-level config/ CLI flags
- `src/llm.js` only consumes one already merged `resolvedConfig.llm`

#### CLI command proposal

In order to make the API configuration truly available, the first version of the proposal adds:

- `neo-cast doctor`
  Check `ANTHROPIC_API_KEY`, network connectivity, model configuration validity
- `neo-cast config init`
  Generate user-level default profile
- `neo-cast config show`
  Show current effective configuration, hide key

#### Secure borders

- API key does not write to project repository
- If `.neo-cast/config.json` contains sensitive fields, `.gitignore` must be added by default
- The CLI output configuration must be made available with the name of the key
- No complete header should be printed in the log

### 4.10 Renderer Contract (Program A: Dynamic Registration)

`renderer.py` does not generate new `train.py` files, but consolidates `current_candidate.json` into a stable `resolved_candidate.json` for fixed `train.py` reading and dispatch to the corresponding model family.

#### Contents structure

```text
py/
  train.py                   ← Fixed entrypoint; the LLM does not modify it
  renderer.py                ← Candidate validation and normalization
  candidate_schema.json
  families/
    __init__.py              ← Registry: FAMILY_REGISTRY = {"nlinear": ..., ...}
    nlinear.py               ← Implements build_model(model_config, input_len, horizon) -> nn.Module
    tiny_transformer.py
    patch_mlp.py
```

#### Contracts for each family module

```python
# py/families/tiny_transformer.py
import torch.nn as nn

def build_model(model_config: dict, input_len: int, horizon: int) -> nn.Module:
    """
    Builds a model from model_config of candidate.
    A forward (x: [B, input_len, 7]) -> [B, Horizon, 7] must be returned to nn.Module.
    """
    ...

# Each family simultaneously export a FAMILY_SPEC
FAMILY_SPEC = {
    "name": "tiny_transformer",
    "model_impl_template": "families/tiny_transformer.py",  # Copy export.py to model_impl.py
    "state_dict_layout": "per_horizon",
}
```

#### Dispatch process for `train.py`

```python
# Fixed train.py pseudocode
candidate = json.load(open(".neo-cast/resolved_candidate.json"))

family_module = FAMILY_REGISTRY[candidate["model_family"]]
models = {
    h: family_module.build_model(candidate["model_config"], INPUT_LEN, h).to(device)
    for h in HORIZONS
}
# ...use candidate["train_config "] to set lr/ batch_size/ max_epochs
```

Key points:

- This is**Program A (dynamic registration)**, not code generation
- LLM never writes Python code, candidate JSON
- Expand the new model family = Add `py/families/<name>.py`+ Update `candidate_schema.json`
- The function of `renderer.py` is " Verify + Normalize + Generate a stable run-time configuration", not code generation
- `export.py` Duplicate `py/families/<model_family>.py` as an artifact `model_impl.py`, matching `model_impl_entry: "model_impl.py:build_model"` in `metadata.json` to restore the model independently

### 4.11 IPC Production Contract (stdout flow)

The Python subprocesse reports events in stdout by **NDJSON (one JSON object per row)**, Node.js by line.

#### Event type

```jsonl
{"event":"stage_start","stage":"smoke","candidate_id":3}
{"event":"smoke_pass","elapsed_s":42.1}
{"event":"stage_start","stage":"full","candidate_id":3}
{"event":"epoch_end","horizon":96,"epoch":1,"val_loss":0.512}
{"event":"epoch_end","horizon":96,"epoch":2,"val_loss":0.478}
{"event":"horizon_done","horizon":96,"best_val_loss":0.391}
{"event":"eval_done","val_avg_mse":0.4387,"val_h96_mse":0.391,"val_h720_mse":0.482}
{"event":"artifact_ready","artifact_dir":"/abs/path/.neo-cast/artifacts/run_<id>"}
{"event":"done","status":"success"}
```

Error path:

```jsonl
{"event":"error","kind":"shape_mismatch","message":"expected [B,96,7] got [B,96,1]","candidate_id":3}
{"event":"done","status":"crash"}
```

#### A promise.

- Each line must be valid JSON, no cross-lines allowed (Node.js divided by `\n`)
- Non-event output (e. g. Python warning / torch noise) always go stderr, not stdout
- `done` must be the last event
- Companion mode only consumes `stage_start`/ `epoch_end`/ `horizon_done`/ `eval_done`/ `error`
- Socratic mode only consumes `done`+`artifact_ready`+`error`

### 4.12 Exit Code Contract

All Python subprocesses (`train.py` / `validate.py` / `renderer.py` / `export.py`) must follow a uniform exit code:

| Code | Meaning | Typical Trigger |
|---|---|---|
| 0 | Success | Normal end, `done: success` printed |
| 1 | Crash training | OOM, NaN loss, Shape Mismatch, Forward anomaly |
| 2 | Candidate schema illegal | Validator refuses to enter the training. |
| 3 | smoke run failed | Smoke stage did not export a valid `smoke_eval_done`/ `eval_done` event |
| 4 | Environment is missing | Data not materialize, model family not registered |
| 124 | Timeout | Continue unix `timeout` engagement |

Node.js side is based on exit code for branching:

```javascript
switch (exitCode) {
  case 0:   return "success";
  case 1:   return "crash";       // Remember results.tsv, discard workdir
  case 2:   return "invalid";     // Do not count crash_count, allow LLM to recreate
  case 3:   return "smoke_fail";  // Also invalid
  case 4:   return "env_error";   // Abort, prompt user to run doctor
  case 124: return "timeout";     // Equals Crash
  default:  return "unknown";
}
```

---

## 5. Rescheduled phase.

### Phase 0: Base Reconstructing and Capt. Landing

**Target:** The existing warehouse will be converted into a follow-up CLI core that can be stabilized for deployment.

**To be done:**

- Concentrate Python source code to a single `py/` directory
- Complement `metadata.json` Code
- Clarify artifact directory structure
- Clear `.neo-cast/` directory structure
- Clarify `runner.py` duties in CLI products
- Write the trigger boundary of `ref_test` to death

**Documents to land:**

- `py/prepare_tsf.py`
- `py/train.py`
- `py/runner.py`
- `py/renderer.py` (new: candidate JSON → resolved_candidate.json)
- `py/export.py`
- `py/candidate_schema.json` (fields and extract limits for the three model family)
- `py/ARTIFACT_SPEC.md` or embedded in README/ROADMAP
- `.neo-cast/README.md` or embedded directory instruction in README/ROADMAP

**Milestone acceptance:**

- [ ] Python side only has one source code.
- [ ] Stable generation of `artifacts/run_<id>/` after successful training
- [ ] `metadata.json` field is stable and can be read by an external program
- [ ] `.neo-cast/` directory layout fixed, bridge/runner/export shared the same path
- [ ] `ref_test` is only implemented at the final export stage

---

### Case 1: Runtime and CLI shell

**Target:** Make the npm installation and local operating environment truly closed.

**Node.js technology warehouse (selected):**

```json
{
  "type": "module",
  "engines": { "node": ">=20" },
  "dependencies": {
    "commander": "^12",                  // CLI frame (light)
    "@inquirer/prompts": "^5",           // Interactive questions (Socratic clarification)
    "@anthropic-ai/sdk": "^0.30",        // Official LLM SDK
    "picocolors": "^1"                   // Very light color output
  }
}
```

Have agreed:
- Modular format: **ESM** (`"type": "module"`)
- `.js`, visible tape suffix for file suffix
- Do not include TypeScript (avoid compilation steps in the first edition)
- No oclif / yargs / chalk (heavy alternatives, first version not required)

**New document structure:**

```text
neo-cast/
  package.json
  bin/neo-cast.js
  src/cli.js
  src/config.js
  src/doctor.js
  src/runtime.js
  py/
```

**Suggested order:**

- `neo-cast --version`
- `neo-cast doctor`
- `neo-cast config init`
- `neo-cast config show`
- `neo-cast init-runtime`
- `neo-cast prepare-data --source /path/to/ETTh1.csv`
- `neo-cast design`

**Run-time policy:**

- `doctor` check `python3`, `uv`, CUDA usability, Anthropic API Key, LLM configuration
- `init-runtime` Default to create a project-level operating environment at `<project>/.neo-cast/runtime/.venv`
- `design` If you find runtime not ready, prompt first to execute `init-runtime`
- `python-bridge` by default using an interpreter in `<project>/.neo-cast/runtime/.venv`; Back to System `python3` if missing

**Milestone acceptance:**

- [ ] `npm install -g neo-cast && neo-cast --version` Normal
- [ ] `neo-cast doctor` can clearly tell users what's missing.
- [ ] `neo-cast config init/show` correctly generates and displays dissensitized configurations
- [ ] `neo-cast init-runtime` completes Python dependent installation

---

### Chase 2: Python Export and Final Assessment

**Target:** Upgrade the word "trainable" to "deliverable".

#### 2.1 `train.py`

Save after training:

- Weighted Files
- Minimum Configuration
- The result is...
- Candidate ID

stdout only output NDJSON events, such as:

```jsonl
{"event":"artifact_ready","artifact_dir":"/abs/path/<project>/.neo-cast/artifacts/run_1710000000"}
{"event":"eval_done","val_avg_mse":0.438700}
{"event":"done","status":"success"}
```

`artifact_dir` here must be an absolute path at the project level and cannot rely on the current shell cwd. To output the text of the summary to be seen, you should go stderr or format it after Node.js has received the event.

#### 2.2 `prepare_tsf.py`

Add a final assessment interface:

```python
def evaluate_ref_test(final_models: dict, device: torch.device) -> dict:
    ...
```

Requests:

- Only call at the final export or visible program
- Do not enter the routine keep/discard cycle

#### 2.3 `export.py`

Do not do "extract model classes from any script" to create complete artifact directories based on restricted model templates:

- `model.pt` (weight)
- `preprocess.json` (characterized order + scaler statistics + input output space)
- `model_impl.py` (rendering from model family template)
- `inference.py` (Uniform Interface)
- `mcp_server.py` (MCP protocolserver, exposed `forecast` tool)
- `tool_schema.json` (MCP tool scheme)
- `metadata.json` (including user_requirement/ design_hypothesis/ exploration_log)
- `eval_report.md` (val + test result)
- `README.md` (demand + two ways to use: direct access/ MCP tool)
- `requirements.txt` (torch, numpy and MCP dependent)
- `example.py` (minimal call sample)

**Milestone acceptance:**

- [ ] Each successful run has a complete inventory (11 full files)
- [ ] `model.pt + metadata.json` Sufficient Recovery Model
- [ ] `preprocess.json + inference.py` enough to handle raw input and finish the inference
- [ ] `inference.py` is independent load and reasoned
- [ ] `python mcp_server.py` can be activated by MCP channel normal list/call
- [ ] `user_requirement`/ `exploration_log` fields in `metadata.json` are not empty
- [ ] Artifact directory can still run independently (`pip install -r requirements.txt && python example.py`) after leaving the Neo-cast repository
- [ ] Final `eval_report.md` corresponds to the true value

---

### Chase 3: Validator and Minimal Autosearch

**Target:** Prior to LLM, replace the protection chain "to generate a candidate - > check - > smoke detection - > formal training".

**New document:**

```text
py/
  renderer.py          ← candidate JSON → resolved_candidate.json
  validate.py          ← Schema validation and smoke run
  candidate_schema.json  ← Fields and value constraints for three model families
```

**Minimal order of implementation:**

1. Generate structured
2. Schema Verify
3. Normalize to run-time configuration (`resolved_candidate.json`)
4. smoke run (see definition below)
5. full validation run
6. keep/discard
7. `ref_test` for final best candidate only

**Smoke run definition:**

Smoke run is the biggest collection of full runrs, designed to intercept "necessarily crash" candidates in advance and does not serve as a basis for precision assessment.

The first version of the smoke run uses a fixed policy:
- Run only**2 epoch**
- **horizon=96** (shortest horizon, quickest result)
- Watch size fixed to `16` (small memory friendly)
- Timeout limit: ** 60 sec.

Standard adopted by smoke run:
- There's no abnormal exit from training.
- Output at least one `smoke_eval_done` or `eval_done` event in which `val_h96_mse` is not NaN
- No more than `2 × PARAM_BUDGET`

smoke run**does not act as** keep/discard basis, does not enter results.tsv, only as a door control for pass/fail.

**validator needs to cover:**

- Required Fields
- Is the model family legal?
- Legitimacy of Parameter Budget
- Output Shape Matches `[B, horizon, 7]`
- stdout NDJSON event stream match protocol

**Milestone acceptance:**

- [ ] Illegal candidate will be rejected before training.
- [ ] Smoke run can pre-empt most shape/runtime errors
- [ ] keep/discard Logic continues to be available
- [ ] Workdir and artifact directories can be located and cleaned at each run

---

### Chase 4: Node.js dialogue stream and LLM call

**Target:** Clear the main path of User Needs - > Candidate Configuration - > Experiment Cycle - > Final Delivery.

**New document structure:**

```text
src/
  cli.js
  config.js
  session.js
  llm.js
  python-bridge.js
  output.js
  modes/
    socratic.js
    companion.js
py/
  renderer.py        ← New: candidate JSON → resolved_candidate.json
```

> `codegen.js` removed from JS side. Candidate `renderer.py` is done on Python side by integration logic, and Node.js is only responsible for writing files of candidate JSON and triggering Python.

#### 4.1 `design` command flags

```bash
neo-cast design                         # Default Socratic Mode
neo-cast design --mode companion        # Cognitive Accompaniment Mode
neo-cast design --max-candidates 10     # Try maximum N candidate (default 10)
neo-cast design --mode companion --max-candidates 5
```

The user can always enter `stop` to interrupt the cycle and exit after CLI output of the current optimal result.

#### 4.2 Loop Stop Conditions

The first version uses the following cessation logic, which is checked in order of priority:

| Conditions | Trigger | Annotations |
|---|---|---|
| User Input `stop` | Anytime. | Stop immediately and output the best for now. |
| `max_candidates` ceiling reached | Every round | Default 10, overwrite by flag |
| Continuous 3 Crash | Every round | Pause and report until user command |
| All candidates are equal. Discard (continuous 5) | Every round | Keep or quit after prompting users to adjust their needs |

Without self-inclusion judgement (e.g. "continuous improvement < threshold stops"), the first edition is not worth introducing this complexity.

#### Tightening 4.3 LLM

LLM does not write any Python file directly.
The functions of the first edition are limited to:

- Clarify Needs (socratic mode)
- Generate structured JSON (must be within `candidate_schema.json`)
- Give scenario statement (`hypothesis` field)
- Explain why keep / Discard (companion mode)

`llm.js` consumption uniform `resolvedConfig.llm`, does not call point unread env:

```javascript
// llm.js accepts the merged configuration and does not read process.env directly
export async function generateCandidate(requirement, history, resolvedConfig) {
  const { provider, model, base_url, max_tokens, temperature } = resolvedConfig.llm;
  // ...
}
```

#### 4.4 Two Interactive Modes

`socratic` (default):

1. Up to 5 rounds of clarification (data characteristics, resource constraints, modelling preferences)
2. Show a summary of needs, user confirmation
3. `max_candidates` wheel
4. Unified output results at the end, without interruption

`companion`:

1. Immediately after collection of needs (no steps to confirm)
2. Print per round before experiment: assumptions, expected improvements, selection of reasons
3. Training for real-time pope key log lines
4. Printing after each round of experiments: results, keep/discard decisions and rationale
5. Users can enter `stop`/ `why`/ `next` at any time

#### 4.5 Python Bridge Duty

The Node.js side is organized only and does not contain any model or training logic:

1. Write Candidate JSON to `<project>/.neo-cast/current_candidate.json`
2. Spawn `uv run py/renderer.py` → generate `resolved_candidate.json`.
3. Spawn `uv run py/validate.py`
4. spawn `uv run py/runner.py run` → full training
5. Parsing stdout NDJSON event stream
6. Read results in `<project>/.neo-cast/artifacts/run_<id>/`

**Milestone acceptance:**

- [ ] `neo-cast design` / `neo-cast design --mode companion` can initiate dialogue
- [ chuckles ] LLM is exporting legally candidate, Validator can reject the illegal candidate.
- [ ] `renderer.py` can transform the consolidation of Candidate JSON into a stable `resolved_candidate.json`
- [ ] Python backend energy consumption candidate and returns the structured results
- [ ] Both modes of interaction run through a full cycle
- [ ] `stop` command correctly interrupts and output the current optimal result

---

### Phase 5: result integration and final productization

**Target:** Intermediate products are organized into direct user-consumptionable outputs.

Each successful design output:

```text
artifacts/run_<id>/
  model.pt
  metadata.json
  model_impl.py
  inference.py
  eval_report.md
```

CLI presentation:

- Summary of tasks
- Best candidate statement
- The result is...
- Final `ref_test` results
- Artifact Path

**Milestone acceptance:**

- [ ] User can find artifact directly from CLI output
- [ ] `eval_report.md` readable and reproduced
- [ ] `inference.py` can run away from the training code

---

## 6. Repositioning `runner.py`

The current `runner.py` can no longer simply be considered as "not moving at all".
In the CLI product, it should be condensed into an internal component with a clear mandate:

- Read Current Candidate
- Execution run
- Record keep/discard
- Manage `results.tsv`
- Manage the current best run
- Manage project level workdir life cycle

It no longer assumes these responsibilities:

- Direct dialogue with users
- Direct control of LLM
- Manage npm runtime

Also, since CLI may run under any item directory, `git reset --hard` cannot be used as the default rollback mechanism.
The strategy for a more stable version of the first edition should be:

- Each run under a stand-alone work directory
- keep/discard is managed mainly through artifact and result sheet management
- guit as a development aid tool only, not as an essential precondition for end-user products

---

## 7. Realistic progression order

The recommended order differs from the original `npm -> Python -> LLM -> output`:

```text
Phase 0  →  Phase 1  →  Phase 2  →  Phase 3  →  Phase 4  →  Phase 5
contract    runtime     artifact    validator    dialogue     product
```

The reason is simple:

- No, runtime. CLI's just an empty shell.
- Without ABI, output cannot be stabilized.
- No, validator, LLM automation is very weak.
- The dialogue level should be based on a stable implementation of the kernel.

---

## 8. Suggested cuts in the first edition

In order to improve the success rate of Release 1, it is recommended that proactive reductions be made:

- Do not do `npm postinstall`, take care of everything. Just `doctor + init-runtime`.
- Do not do "Clean clean model code from any `train.py`"
- Do not do "teest set results for each round"
- Do not do any model family free generation.

The first edition supports 2 to the restricted model communities of 3, for example:

- `nlinear`
- `tiny_transformer`
- `patch_mlp`

As long as this link runs, it's easier to expand the family back then.

---

## 9. `results.tsv` New schema

Disable the old `run_id` (consistent with the name of the artifact directory) key from an old schema based on guit part:

```tsv
session_id	run_id	candidate_id	model_family	val_avg_mse	val_h96_mse	val_h720_mse	params_M	status	is_best	timestamp
20260424-103000-a1b2	20260424-103022-a1b2	1	nlinear	0.452100	0.398200	0.498700	0.07	keep	0	2026-04-24T10:32:18
20260424-103000-a1b2	20260424-103201-c3d4	2	tiny_transformer	0.438700	0.391200	0.481900	0.34	keep	1	2026-04-24T10:38:42
20260424-103000-a1b2	20260424-103805-e5f6	3	tiny_transformer	NA	NA	NA	NA	crash	0	2026-04-24T10:39:01
20260424-103000-a1b2	20260424-103820-g7h8	4	patch_mlp	0.441500	0.394800	0.484200	0.21	discard	0	2026-04-24T10:45:11
```

The fields state:

- `session_id`: This `design` session main key, is used to isolate different sessions best run
- `run_id`: Consistency with `artifacts/run_<id>/` directory name, main external stabilization key
- `candidate_id`: Candidate serial number (1-based) for this session
- `is_best`: whether this is the best run; only one row per `session_id` has `is_best=1`.
- `status` ∈ `{keep, discard, crash, invalid, smoke_fail}`, aligned with the Exit Code Contract.
- `NA` for the indicator column of Crash rows, filtered automatically when participating in `is_best` calculations

`runner.py` locates the best current artifact path through `(session_id, is_best)` and no longer uses `last_keep_commit`.

---

## 10. Test Policy

Release 1**does not seek high coverage**, but must have a minimum credible validation set to avoid a three-fold fall:

### 10.1 Python Unit Test (pytest)

```text
py/tests/
  test_families.py        ← Each family's build_model and forward-shape tests
  test_renderer.py        ← Boundary cases for schema acceptance/rejection
  test_runner.py          ← Keep/discard state machine
  test_export.py          ← Artifact directory completeness and metadata schema
```

Minimum requirements:
- Three family `forward(x: [2, 512, 7], horizon=96) -> [2, 96, 7]`s must be confirmed.
- `validate_candidate` must return the illegal field clearly

### 10.2 Node.js unit test (node:test)

Do not include Jest/Vitest, use the Node built-in `node:test`:

```text
test/
  cli.test.js             ← Commander parsing and flag defaults
  config.test.js          ← User/project configuration merge precedence
  ipc.test.js             ← NDJSON event stream parsing
```

### 10.3 End-to-end smoke test

Release 1 only requests **1 E2E**: run through the full design loop with mock LLM (returning to fixed candidate) and assert that the artifice directory is complete.

```text
test/e2e/
  smoke.test.js           ← Fixture data and mock LLM; completes within five minutes
  fixtures/
    mock_llm_responses.json
    mini_etth1.csv        ← A 100-row ETTh1 subset for faster tests
```

The CI runs this E2E to ensure that the main path is not degraded.

---

## 11. One conclusion:

This route is feasible, but it must be changed from "vision drive" to "contract drive".
The first edition of `neo-cast` is not about making the most chatting agent, but about starting with one:

**The TSF small model design CLI can be installed, run, exportable, reproduced and not easily collapsed by automatic code.**
