# neo_cast Code Interpretation

> NeoResearch - TSF Phase 0/ MVP - Implementation core for autonomous research intelligents oriented towards time series prediction

---

## I. Overall orientation

`neo_cast` is not a time-series prediction model library or an open AI assistant. Its location is:

> **Minimum Execution Nuclear (MVP) of Forest Research Operating System**

`autoresearch`, which is directly inspired by Karpathy, allows AI Agent to continuously modify model codes under strict constraints, run experiments, retain valid changes and discard invalid changes in order to create a closed circle of small models that are sustainable iterative.

Core difference point: autoresearch for LLM pre-training (val_bpb), neo_cast for time series multistep prediction (val_avg_mse).

---

## II. Overview of document structure

```
neo_cast/
├── prepare_tsf.py               ← Frozen data/evaluation protocol; agents cannot modify it
├── train.py                     ← Experiment layer: the only agent-editable file
├── runner.py                    ← Research-loop management helper
├── program.md                   ← Agent behavior policy
├── neo_research_tsf_architecture.md  ← Complete seven-layer architecture design
├── results.tsv                  ← Local experiment log; do not commit
├── pyproject.toml               ← Dependencies: numpy/pandas/sklearn/torch
└── Datasets (1)/ extra data set (not current ETTh1 default process)
```

The three core documents are identical to autoresearch:

| autoresearch | neo_cast | Role |
|---|---|---|
| `prepare.py` | `prepare_tsf.py` | Frozen layer; agents must not modify it |
| `train.py` | `train.py` | Experiment Layer, Agent |
| `program.md` | `program.md` | Strategy level, humans. |
| `val_bpb` | `val_avg_mse` | Main optimization indicator |

---

## III. `prepare_tsf.py`: Deep interpretation of the freeze

### 3.1 Core Fixed Constant

```python
DATASET       = "ETTh1"
NUM_CHANNELS  = 7          # HUFL, HULL, MUFL, MULL, LUFL, LULL, OT
INPUT_LEN     = 512        # Look-back window, Agent cannot be modified
HORIZONS      = (96, 192, 336, 720)   # Four projected lengths, synchronized assessment
TIME_BUDGET   = 600        # Maximum training time (sec) for a single experiment
PARAM_BUDGET  = 10_000_000 # Soft upper limit (10M)
SEED          = 42
```

### 3.2 data split (fully aligned with TSL)

```
Train: Line [0, 8640] 12 months x 30 days x 24 hours
val:       rows [8640, 11520) → Next four months; agent decision signal
ref_test:  rows [11520,14400) → Next four months; privileged runner/human access, unavailable to agents
```

This cut is fully consistent with the `Dataset_ETT_hour` of Time-Series-Library (thuml) to ensure that the results are matched with TSL papers.

### 3.3 Data Visibility Separator

This is one of the most important security mechanisms in the design:

```
ETTh1_visible.csv plain + val (line 11520), Agent visible
ETTh1_ref_test.csv  ← Test set (2880 rows), held only by the runner/human gate
```

`materialize_visible_splits()` is responsible for removing both files from the original ETTh1.csv to prevent Agent from reading test labels.

### 3.4 Standardization Protocol

Use `sklearn.StandardScaler`,**only fit** on trackFold and will be reused to val and ref_test in the same set of statistics:

```python
scaler.fit(feature_values[BORDER_TRAIN[0]:BORDER_TRAIN[1]])  # Train session only fit
scaled_values = scaler.transform(feature_values)              # Apply to All Visible Data
```

The assessment calculates MSE/MAE (not inverse transform) in **scaled space**, consistent with TSL default behaviour (`args.inverse=False`).

> **Why not use RevIN?** RevIN is an example-level dynamical integration that changes the status of integration when forward, and allows Agent to design a loss to require additional perception. Fixed StandardScaler allows Agent to focus on the architecture itself.

### 3.5 WindowDataset Achieved

```python
class WindowDataset(Dataset):
    # Each sample: x = values [start:start+INPUT_LEN], y = values [start+INPUT_LEN:start + INPUT_LEN +horizon]
    # context_start for Val Collection = BORDER_VAL [0] - INPUT_LEN (context allowed on track)
```

The val window extends the `INPUT_LEN` before it is scheduled, so that the first window of the val set can see data at the end of the track and match them to the TSL syntax.

### 3.6 evaluate_val_tsf - primary metric definition

```python
def evaluate_val_tsf(model_or_models, device) -> dict:
    # Return: val_avg_mse, val_avg_mae, val_h
    # val_avg_mse = mean(val_h96_mse, val_h192_mse, val_h336_mse, val_h720_mse)
```

** `val_avg_mse` is the only decision signal for keep/discard.** Multihorizon on average prevents Agent from optimizing short-term projections at the expense of long (or vice versa).

### 3.7 query_ref_test - Runner-only Privileged Interface

```python
def query_ref_test(artifact_uri, task_id, promotion_token) -> dict:
    # MVP stage is only placeholders
    # Environmental variable NEO_TSF_PROMOTION_TOKEN is required to call
    # Agent process not available token, physically unable
```

It's the whole system. The MVP stage interface has been defined, but leave blank (`NotImplementedError`), to be followed by Runner sidecar.

---

## IV. `train.py`: Experimental deep resolution

### 4.1 baseline model: Channel-Independent NLinear

```python
class TSFModel(nn.Module):
    def __init__(self, input_len, horizon):
        self.linear = nn.Linear(input_len, horizon)

    def forward(self, x):          # x: [B, L, C]
        last_value = x[:, -1:, :]  # NLinear's demeanor technique: minus last value
        x = x - last_value
        # Channel-Independent: [B, L, C] → [B*C, L] → linear → [B*C, H] → [B, H, C]
        ...
        return pred + last_value   # Add it back (integrity + restoration)
```

This is DLinear/NLinear (AAAI 2023) CI realization. Each channel independent linear map is one of the strongest lightweights known in the TSF field.

** The current `train.py` is two more improvements than the "initial sample" in the architecture document:**
1. Add `early stopping` (`PATIENCE=7`)
2. Save the best weight with `copy.deepcopy` (cleaner than `torch.save` to `/tmp`)

### 4.2 Multi Horizon Parallel Training

```python
models    = {h: TSFModel(INPUT_LEN, h).to(device) for h in HORIZONS}
optimizers = {h: torch.optim.Adam(...) for h in HORIZONS}
train_loaders = {h: make_dataloader("train", h, ...) for h in HORIZONS}
```

Each horizon maintains a stand-alone model + optimizer + data stream in the same epoch cycle**rotational training**. Skipping after some horizon early stop until all horizon stops or exceeds `TIME_BUDGET`.

### 4.3 output format (fixed for grep resolution)

```
---
val_avg_mse:      1.057427
val_h96_mse:      0.665714   val_h96_mae:     0.618...
training_seconds: 17.5
peak_vram_mb:     0.0
num_params_M:     0.69
```

Format fixes are core design options, and both `runner.py` and `program.md` rely on this format for automatic resolution.

### 4.4 Agent 's freedom of change

Agent** can only modify `train.py`** but has complete freedom in this document:

| Changeable content | Example: |
|---|---|
| Model structure | Change Transformer / MLP / TCN / SSM |
| Channel strategy | CI → CD: model cross-channel dependencies |
| Patch Design | patch_size=16/32, stride=8/16 |
| Loss functions | MSE → MAE / Huber / quantile |
| Optimizer | Adam → AdamW / SGD |
| Learning rate | cosine warmup/decay |
| Data enhancement | For the training set only |

**Non-changeable:** Any of the elements in `prepare_tsf.py`, data cut, evaluation protocol.

---

## V. `runner.py`: Experimental cycle management

### 5.1 status machine design

Runner's core is a `RunnerState` structure:

```python
@dataclass
class RunnerState:
    repo_root: str
    branch: str
    last_keep_commit: str        # Rollback anchor for keep/discard
    best_val_avg_mse: float      # Current best score
    keep_count: int              # Cumulative number of keepeps
    promotion_interval: int      # How often keep triggers promotion check
    initialized_at: float
```

`.neo_runner_state.json` is persistent, and cross-calls are consistent.

### 5.2 3 sub-commands

```bash
python runner.py init                             # Initialization and results.tsv
python runner.py run --description "baseline"     # Conduct an experiment.
python runner.py status                           # View Current Status
```

### 5.3 keep/discard Logic

```python
if val_avg_mse < state.best_val_avg_mse:
    # keepep: Update last_keep_commit, add keep_count
    state.last_keep_commit = current_commit_full
    state.best_val_avg_mse = val_avg_mse
else:
    # discard：git reset --hard last_keep_commit
    run_git(["reset", "--hard", state.last_keep_commit])
```

The semantics of **discard are crucial:** Not just to restore the content of the `train.py` file, but to make it really go back to `last_keep_commit`, subjected committee disappear from branch history.

### 5.4 security check

Runner will check:

1. The current lanch corresponds to the one recorded in the state
2. No unsubmitted tracked changes
3. If cwd is not repo root, you need a visible `--allow-nonroot-repo` to allow the execution of `git reset`

These checks prevent runners from mismanaging guit history under the wrong context.

### 5.5 Log Resolution

```python
def parse_summary(log_text: str) -> dict:
    # Parsing stdout output in fixed format
    # Attention: val_avg_mse, val_h96_mse, val_h720_mse, num_params_M
```

If the resolution does not include `val_avg_mse`, automatically determine it as a crash and record `NA` and roll back.

---

## VI. `program.md`: Agent behavioural protocol

### 6.1 Three Distinctions

- **Content of human responsibility:** Define tasks, set up `program.md`, approve promotions
- **Agent is responsible for:** Hypothetical, modified `train.py`, running experiments, recording results, keep/discard
- **Runner/Gate responsible content:** reference test query, `promotion.tsv` written

### 6.2 experimental cycle (core protocol)

```
LOOP FOREVER:
1. Check Current Commit
2. Presentation of a research hypothesis
3. Modify train.py
4. git commit
5. uv run train.py > run.log 2>&1
6. grep "^val_avg_mse:\|^num_params_M:\|^WARNING" run.log
7. If grep is empty til run.log
8. Add result to results.tsv
9. Lower val_avg_mse → keep; otherwise → discard (`git reset --hard`).
10. Keep PROMOTION_INTERVAL trigger reference test (writing promotion.tsv)
```

### 6.3 Research Direction Priority

**Priority exploration:**
- Switch the channel strategy from CI → CD.
- Patching(patch_size=16/32, stride=8/16)
- Decomposition of trends (moving avertage + reduction)
- MLP-Mixer Replace Attention
- FFT frequency domain auxiliary feature

**Follow-up exploration:**
- Cross horizon share backbone + each head
- Multiscale branch integration
- Asymmetric loss
- Distillation based on Foundation Model

### 6.4 Simplicity Standard (inherited from autoresearch)

| Situation | Decision-making |
|---|---|
| val_avg_mse significantly improved, simple code | Must keep |
| val_avg_mse flatten, simpler code | Keep it down. |
| val_avg_mse minor improvement with a large number of complex codes added | discard |
| Increase in the number of participants > 5M and improve < 0.010 | discard |

---

## VII. `neo_research_tsf_architecture.md`: Long-term seven-layer structure

This document describes the evolution blueprint from MVP to full Forest Research Operating System.

### 7.1 7th floor structure

```
Human Control Layer       ← Human-defined boundaries and promotion approvals
Agent Organization Layer Research Manager + 5 Agent
Search Space Layer        ← Model/loss/data-transformation/training-strategy DSL
Protocol Layer            ← TaskSpec, evaluation protocol, and budget constraints
Execution Layer           ← Sandbox、Static Validator、Artifact Store
Evaluation Layer Multistage screening, promotion determination, error diagnosis
Memory Layer              ← Experiment lineage, failure patterns, and cross-task meta-memory
```

### Core difference between 7.2 and AutoML

Normal AutoML: Structured search space + Automotivation.
neo-research:

1. **Research memory** - Per experiment assumptions/conclusions sink into experience, cross-mission migration
2. **Multi-Target Champion** - Precision + Parameter Volume + Delay + Stability Combined Rating (`Utility`)
3. **Human synergy** - Code for the definition of human beings, Agent performs high frequency tests
4. **Controlled search** - First Config Search (L1)

### 7.3 Three Level Assessment Protocol

| Level | Name | Frequency | Visibility |
|---|---|---|---|
| L1 | Dev Validation(val) | Every experiment. | Agent Visible |
| L2 | Reference Test | Every N keep decisions | Privileged runner/human access |
| L3 | Blind Test | Final only | Phase 5 Independent Service |

### 7.4 Utility Rating Formula

```
Utility = 1.00 * AccuracyGain
        - 0.20 * ModelSizePenalty
        - 0.10 * LatencyPenalty
        - 0.30 * VariancePenalty
        - 2.00 * FailurePenalty
        - 0.05 * ComplexityPenalty
```

The system has evolved naturally in the direction of "small but steady" and there are clear trade-off quantifications between precision enhancement and code complexity, and increased nuclei.

---

## VIII. Data flows and call relationships

```
ETTh1.csv (Human Supply)
    │
    ▼
prepare_tsf.py::materialize_visible_splits()
    ├── ETTh1_visible.csv (train+val, 11520 rows) → Agent-visible
    └── ETTh1_ref_test.csv (test, 2880 rows) → Runner-only
              │
              ▼
prepare_tsf.py::_load_visible_bundle()
    → StandardScaler（fit on train）→ VisibleDataBundle
              │
              ▼
WindowDataset("train"/"val", horizon)
    → DataLoader → (x:[B,512,7], y:[B,H,7])
              │
              ▼
train.py::TSFModel (Agent freely modified)
    Training cycle (within TIME_BUDGET)
    → evaluate_val_tsf() → val_avg_mse, val_h{H}_mse/mae
              │
              ▼
Stdout Fixed Format
    │
    ├── runner.py::parse_summary() keep/discard/crash Decision-making
    └── Agent direct grep run.log
```

---

## IX. CURRENT STATUS AND LIMITATIONS

### 9.1 can do it right now.

- ETTh1 Full local closed loop for multivariant predictions
- The agent proposes a hypothesis → edits `train.py` → runs the experiment → records results → keeps/discards.
- Minimum Runner Tool Chain (init/run/status)

### Known Simplified 9.2 MVP

| Functions | MVP Status | Full system objective |
|---|---|---|
| Smoke run | None | Phase 1+ |
| Static Validator | None | Phase 1+ |
| Multiple Seed Authentication | None (seed=42 alone) | Phase 3+ |
| Research on memory systems | None | Phase 3+ |
| reference test evaluator | Interface in position, NotImplementedError | Phase 1+ |
| Multiple data sets | ETTh1 only | Phase 1+ |
| Model Registration / DSL | None (direct change of code) | Phase 2+ |

### 9.3 critical design trade-offs

1. **Why is Agent changing the code instead of DSL?**
   The primary objective of Phase 0 is to verify the feasibility of a closed ring, and DSL was introduced too early to increase friction. Phase 1 should begin to absorb gradually to Registry + DSL and prevent Agent from completely out of control.

2. **Why use val instead of test as a keep/discard signal?**
   Prevents leak from the test set, and also prevents Agent from making noises that fit the test set. Val is the only valid high frequency query signal.

3. **Why more horizon average?**
   Prevent Agent from sacrificing long-term (h=720) exclusively to optimize short-term (h=96). The multiple horizon average is a fairer and more comprehensive optimization target.

---

## X. Quick start

```bash
# 1. Installation Dependence
uv sync

# 2. Preparing data (original ETTh1.csv required)
uv run prepare_tsf.py --materialize-visible --source-csv /path/to/ETTh1.csv

# 3. Validate data ready
uv run prepare_tsf.py

# 4. Run once, baseline
uv run train.py

# 5. Initialize runner and start looping
python runner.py init
python runner.py run --description "baseline: NLinear CI + early_stop"
python runner.py status
```

Dataset download: ETTh1.csv from the directory of `dataset/ETT-small/` [Time-Series-Library](https://github.com/thuml/Time-Series-Library).

---

## XI. COMPARATION WITH RELEVANT WORK

| Dimensions | autoresearch | TSL | neo_cast |
|---|---|---|---|
| Objective | LLM Pre-training Optimization | TSF Model benchmark | TSF Autonomous Research Cycle |
| Agent Role | Change train.py | None | Change train.py |
| Data cut | Fixed token flow | Parameteric border | Alignment with TSL, Fixed |
| primary metric | val_bpb | MSE/MAE | val_avg_mse(scaled) |
| Training budget | 5 min | Unlimited | 10 min |
| Test set protection | No such concept | No quarantine | Level 3 assessment quarantine. |
| Parameter Constraint | VRAM Soft Limit | None | 10M Parameter Soft Limit |
| Memory system | None | None | Designed to be, MVP not achieved |
