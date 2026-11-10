# Neo-research for TSF: Structure Design Document v3.1

> 2026-09-27 Update: User has requested to delete `direct_multi_horizon`. This action has been removed from the current scheme, registration form, plant and search entry, and its restoration/redefinition description in the old program is no longer applicable.

> Auto-research smart system for time series prediction - **Forecost Research Organizing System**
> Design reference: Karpathy autoresearch (2026), The AI Sciencelist (2024), AutoML-Zero, TimeRecipe (ICLR 2026)
> Data loading and evaluation protocols reference: [Time-Series-Library](https://github.com/thuml/Time-Series-Library) (thuml, 2024)]

---

## 1. System positioning and core propositions

### 1.1 Question Statement

The area of time series prediction (TSF) has developed a highly fragmented model ecology: Autoformer cuts into long sequences by decomposition and Auto-Correlation, PatchTST changes input by checking + channnel-indendence, iTransformer shifts modelling focus to paragate token; But the birth of every "small model" requires a lot of manual input from algorithm engineers — repeated design of network structures, fine-tuning strategies and running comparison experiments. This process**is highly repetitive, time-consuming and heavily dependent on expert experience.**

### 1.2 Core Claim

The neo-research system, by transforming the "design of a small TSF model" into an **self-implementable loop**, allows AI angent to continue to complete the following cycles in a strictly confined experimental environment:

1. Identification of problems and presentation of assumptions
2. Generate or modify model structures
3. Generate or modify training objectives and training strategies
4. Automatically run experiments and record results
5. Assessing whether change is effective
6. Keep valid changes and continue to overlap
7. Output replicable models, codes, reports and knowledge deposition

**The system's target is not a "chatting timer" assistant, but a Forest Research Operating System.**

### 1.3 system definition

**Neo-Research**is not a simple AutoML (no structured search space) or a purely LLM code agent (no auditable enforcement environment), but a closed** controlled research system that links "research assumptions - code change - experimental execution - results attributed - knowledge accumulation"**.

**Subjects of study**: Focus on small models**, i.e. customized time-series prediction models that meet constraints such as parameters volume, delay, visibility, training costs, etc., without seeking an unlimited magnification of the size of the parameters.

**Research products**:

- New model structure
- New loss group
- New Data Preprocessing/Performance Policy
- New training formulation (optimizer, Schedule, regular combination)
- New inference/distillation/integrated strategy
- Revertable Experiment Report
- Legacy of research memory (cross-mission experience)

---

## 2. Design target and system boundary

### 2.1 Design Target

| # | Objective | Content |
|---|------|------|
| 1 | **Automation** | Minimize the workload of algorithm engineers to manually modify models, switch loss and run ablation |
| 2 | **Binding** | All experiments are carried out under a fixed agreement and arbitrary circumvention of the evaluation is prohibited. |
| 3 | **Revertible** | Any "effective change" must be reversible, auditable and comparable. |
| 4 | **Small model priority** | Optimization targets include precision, parameter size, delay, stability and not a single pursuit of leaderboard |
| 5 | **Accumulated** | The system evolves into a repository of experience on what sort of time-series tasks, what structure/target is more effective |
| 6 | **Human synergies** | The person is responsible for defining the mission boundary, budget and research direction; Agent for HF testing and local innovation |

### 2.2 Non-target (phase I)

1. No open literature review, Agent
2. No Free Unlimited Code Generation
3. Do not focus on auto-writing papers
4. Not directly taking over production deployment
5. Focus not on covering all time-series tasks, focus first

### 2.3 Core Principles

**Principle I: Agreement first, intelligence later**
First the data protocol, the evaluation protocol, the budget agreement, the code agreement, then Agent's innovation within the bounds.

**Principle II: DSL/IR first, then change code freely**
The most critical engineering decision is: **Don't let Agent be free from the whole code warehouse at the start.**It would be more feasible to introduce intermediate expression (IR)/configuring DSL in the model, allowing Agent to search mainly in declarative space and upgrade a small number of high-value candidates to code level changes.

> **Phase 0 exception:** For the quickest verification of closed loops, MVP allows Agent to change freely only in `train.py`**single file**; It's not about letting go of the "freehouse change code."Starting with PHase 1, the new structure should in principle be exposed through registry/ DSL before being allowed to have a limited watch.

> **Phase calibration statement:** Phase 0 split into two sub-phases.`Phase 0a` validates only the autoresearch closed ring, allowing free experiment of `train.py` single files;`Phase 0b` starts freezing `CandidateRecipe v1` and baseline review, but can still use `train.py` as an executing carrier; It is only `Phase 1` that requires priority to be given to the selection of candidates through action registry and `build_model(candidate_recipe)`.

**Principle III: Multi-stage screening followed by a full assessment**
Candidates should progress through static checks → smoke runs → low-fidelity experiments → full validation → multiple-seed confirmation → blind-test promotion, rather than all starting full training immediately.

> **Phase 0 exception:** The complete system targets the workflow above. The MVP may use "edit `train.py` → direct full run → keep/discard" without first implementing a smoke harness, low-fidelity filters, or multiple-baseline scheduling.

**Principle IV: Maintaining effective increments before pursuing subversive innovations**
Natural bias of the system **delta-based research**: Only a few verifiable changes are proposed per round and valid watch is retained.

**Principle V: Precision is not the only goal**
Small model development requires multi-purpose optimization: `accuracy + params + latency + robustness + reproducibility`.

---

## 3. Overall structure

### 3.1 MVP file structure (autoresearch co-component)

```
neo_research_tsf/
├── prepare_tsf.py     ← Frozen: dataset loading, evaluation, and constants
├── train.py           ← Agent-editable: model architecture and training loop
├── program.md         ← Human-edited: research strategy and behavior policy
├── results.tsv        ← Experiment log; do not commit
└── run.log            ← Latest experiment output; do not commit
```

The role of the three documents is identical to that of autoresearch:

```
autoresearch          →  neo-research TSF
─────────────────────────────────────────
prepare.py            → prepare_tsf.py       (frozen layer)
train.py train.py (experiment level)
program.md program.md (Strategic Layer)
val_bpb               → val_avg_mse          (primary metric, scaled space)
```

### 3.2 complete system seven-layer structure (long-term objective)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Human Control Layer (Human Control Layer)                   │
│         Define tasks • Authorize search spaces • Approving promotions Freezing test sets • Roll-back termination       │
├─────────────────────────────────────────────────────────────────────┤
│                  Agent Organization Layer (intellectual hierarchy)               │
│       Research Manager + Diagnostic / Design / Coder / Runner /     │
│                        Analyst / Librarian                          │
├─────────────────────────────────────────────────────────────────────┤
│                    Search Space Layer (search space layer)                    │
│       CandidateRecipe DSL · action registry · loss DSL · trainer DSL │
├─────────────────────────────────────────────────────────────────────┤
│                   Protocol Layer (Research Protocol Layer)                         │
│       TaskSpec Quantification Boundary Assessment Indicator Parameters/Delaying/Budget Constraints               │
├─────────────────────────────────────────────────────────────────────┤
│                    Exchange Layer (Executive Level)                           │
│        Sandbox trainer Static Validator Artifact Store          │
├─────────────────────────────────────────────────────────────────────┤
│                   Evaluation Layer (assessment level)                           │
│        • Discrepancies in the diagnosis of errors.         │
├─────────────────────────────────────────────────────────────────────┤
│                     Memory Layer (research memory)                         │
│         Experimental spectrometry . Success/failure pattern Mission fingerprints . Patch diff champion     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 Core Module Division

The complete system consists of 12 core service modules:

| # | Modules | Core responsibilities |
|---|------|---------|
| 1 | **Task Manager** | Create tasks, validate protocols, generate task_id, manage life cycle |
| 2 | **Dataset Service** | Data loading, train/val/test cut-off, characterization, leak protection |
| 3 | **Diagnostic Service** | Dataset image, output TaskFingerprint |
| 4 | **Baseline Builder** | Automatically run baseline, generate baseline metrics, start output |
| 5 | **Search Space Registry** | Registering / registering / backbone / fund / head / trainer action, binding Agent to search the boundary |
| 6 | **Proposal Engine** | Generate candidate hypothesis +CandidateRecipe based on fingerprints and historical memory |
| 7 | **Patch Generator** | Convert recipe to an executable configuration or restricted template change (RecipeDelta/ CodePatch) |
| 8 | **Static Validator** | Check the watch legitimacy, interface compatibility, budget boundaries, ultra vires testing |
| 9 | **Experiment Runner** | Creation of containers, injection configurations, training assessment, collection |
| 10 | **Evaluator** | Harmonized indicator calculation, promotion determination, error anallysis |
| 11 | **Memory Service** | Preservation of experimental records, Patch lineage, recall for similar tasks |
| 12 | **Governance Service** | blind test protection, approval flow, segregation of privileges, audit log |

**Search Space Registry is one of the system's core lines** -- it determines what Agent can explore, which is key to the controlability of the entire system.

---

## 4. Study Protocol Layer (Protocol Layer)

### 4.1 TaskSpec Definition

Each research task must define a uniform `TaskSpec`:

```yaml
task_id: etth1_multivar_96_720
task_type: forecasting
forecast_mode: point          # point | probabilistic
series_type: multivariate
context_length: 512
prediction_lengths: [96, 192, 336, 720]

dataset:
  loader_id: etth1_tslib_v1
  target_cols: [HUFL, HULL, MUFL, MULL, LUFL, LULL, OT]  # Case 0 Default using Msetting: Forecasting all 7 variables
  known_future_covariates: []
  observed_past_covariates: []  # Only indicates additional past-only input;0 does not repeat statements with target_cols
  static_covariates: []

split:
  scheme: fixed_row_index
  train: [0, 8640]            # Perfectly consistent with TSL Dataset_ETT_hour
  val: [8640, 11520]
  test: [11520, 14400]        # Logical reference slip;Physically only Runner Visible
  test_exposure: promotion_only
  blind_test: phase5_service  # The real blind test is available at PHase 5 for independent service

evaluation:
  protocol: fixed_split
  metric_primary: val_avg_mse  # Calculate in StandardScaler Normalization Space
  metric_reference: ref_test_avg_mse
  seeds: [42]                  # MVP phase list seed;Phase 3+ extension up

constraints:
  max_params: 10_000_000       # Soft ceiling for 10M parameters
  max_training_seconds: 600
  max_gpu_hours_total: 100
  max_trials: 500
```

> **The syntax description of the field:** `target_cols` is a collection of endogenous variables to be predicted; They will also appear by default in the history window `x`.`observed_past_covariates` only indicates additional past-only input and cannot spell columns already in `target_cols` again.

### 4.2 time-series security principles

It must be enforced:

- All Normalization, Missing Values Filled, Statistical Qualification**Allow completion only on trackFold**
- Future invisibility prevents leaking to training samples.
- `val` is the only high frequency query decision signal for Agent
- `test` in the repository only as **Reference test**, defaulted to be queryed by Runner/ Human Gate only at the promotion node and Agent was not read directly
- Reference test has to be written **privileged protocol log**, not Agent readable `results.tsv`
- The real blind test tags and interfaces don't go into the warehouse. Phase 5 is exposed through independent services.

### 4.3 Three Level Assessment Protocol

It is suggested that the system should be divided into three layers, so as to avoid over-compatibility of a single certification set:

| Level | Name | Use scene | Query Frequency |
|------|------|---------|--------|
| L1 | Dev Validation | Daytime keep/discard decision-making | Every experiment. |
| L2 | Reference Test / Shadow Holdout | Promotion screening and external reference alignment | Every N keepep, queryed by Runner/Human and written to the Privileged log |
| L3 | Blind Test | Final campion confirmation | Phase 5 is available for promotion only |

---

## 5. Search space design (Sayer)

This is central to the system's success. Version 3.1 changes the candidate space from choosing a model family and its parameters to TimeRecipe-style **module-level recipe search**: agents select registered actions along a fixed pipeline, and runtime assembles them into a model, rather than first choosing PatchTST or iTransformer.

### 5.1 Canonical Recipe Pipeline

Neo-Cast's candidate model is uniform abstract:

```text
Input
  -> Preprocessing Action
  -> Embedding Action
  -> Backbone Action
  -> Fusion Action
  -> Prediction Head
  -> Post-processing Action
  -> Training Strategy
  -> Forecast
```

Of which `post_processing` is usually paired with `preprocessing`, e.g. reverse integration of information, decomposition trend/seasonal repositioning. The first stage allows `post_processing` to be used as an automatic derivative field without being exposed to Agent's direct search.

### 5.2 CandidateRecipe Schema

Candidates no longer use `model_family` as their primary key, but use recipe as their main key:

```json
{
  "recipe_id": "etth1_patch_mlp_tf_mse_v1",
  "recipe_version": "recipe_schema_v1",
  "preprocessing": {
    "actions": [
      {"type": "instance_norm", "affine": false},
      {"type": "series_decomposition", "method": "moving_average", "kernel_size": 25}
    ]
  },
  "embedding": {
    "type": "patch",
    "patch_len": 16,
    "stride": 8,
    "d_model": 128
  },
  "backbone": {
    "type": "mlp",
    "depth": 3,
    "hidden_dim": 256,
    "dropout": 0.1
  },
  "fusion": {
    "type": "temporal",
    "channel_mode": "independent"
  },
  "prediction_head": {
    "type": "linear",
    "output_distribution": "point",
    "share_across_horizons": false
  },
  "post_processing": {
    "type": "auto"
  },
  "training_strategy": {
    "loss": {"base": "mse", "horizon_weighting": "uniform"},
    "optimizer": {"type": "adamw", "lr": 0.001, "weight_decay": 0.0001},
    "scheduler": {"type": "cosine", "warmup_steps": 0},
    "regularization": {"dropout": 0.1, "grad_clip": 1.0},
    "budget": {"max_epochs": 5, "time_budget_s": 600}
  },
  "constraints": {
    "max_params": 10000000,
    "max_latency_ms": 50
  }
}
```

The core constraint of this schema is: Agent can only select the action and valid parameters that exist in registry;`build_model(candidate_recipe)` has Python-end responsibility for the assembly of PyTorch models, and candidates are prohibited from directly injecting any model code.

### 5.3 Preprocessing Action Space

Preprocessing handles scale drift, trends/seasonality, missing and input re-sampling. Initial registration:

| Action | Parameters | Apply bias |
|--------|------|---------|
| `none` | - | Keep original input as a necessary contrast |
| `instance_norm` | `affine`, `eps` | Distribution Shift is clearly, variable scale unstable |
| `series_decomposition` | `method`, `kernel_size` | Trend strong, long-term forecast, DLinear/Autoformer class bias |
| `seasonal_differencing` | `period`, `order` | Strong seasonal, low frequency trends |
| `missing_mask` | `mask_channel`, `fill_policy` | High rate of missing and need for visible missing hints |
| `sample_reweighting` | `scheme` | Horizon, difficult and more unusual. |

### 5.4 Embedding Action Space

Embedding decides how the sequence enters backbone. Initial registration:

| Action | Parameters | Corresponds to typical models |
|--------|------|-------------|
| `none` | - | NLinear / DLinear |
| `token` | `d_model`, `time_feature_mode` | Informer / Autoformer |
| `patch` | `patch_len`, `stride`, `d_model` | PatchTST |
| `invert` | `d_model` | iTransformer |
| `frequency` | `n_freq`, `complex_mode` | FITS / frequency MLP |
| `calendar` | `fields`, `embed_dim` | Tasks with visible timetamps or known future competitors; Phase 2+ relies on frozen data interface extensions |

### 5.5 Backbone Action Space

Backbone only expresses the main modelling algorithm and no longer binds the full paper model name. Initial registration:

| Action | Parameters | Core bias |
|--------|------|---------|
| `linear` | `shared`, `bias` | Global linear map, strong baseline |
| `mlp` | `depth`, `hidden_dim`, `activation` | Lightweight, low delay, suitable for size |
| `rnn` | `cell`, `hidden_dim`, `num_layers` | Visible Recursive State, suitable for multi/short variable horizon |
| `tcn` | `channels`, `kernel_size`, `dilation` | Local time series mode and low delay |
| `transformer` | `n_layers`, `n_heads`, `d_model` | Long dependence, strong seasonality, high variable relevance |
| `ssm` | `state_dim`, `depth` | Long context and linear complexity exploration |
| `mixer` | `temporal_mixing`, `channel_mixing` | Multiscale mixing, TimeMixer class bias |

### 5.6 Fusion Action Space

Fusion decides whether to give priority to modelling time or between variables. Initial registration:

| Action | Parameters | Annotations |
|--------|------|------|
| `temporal` | `channel_mode: independent/shared` | Model over time, fit for CI and PatchTST type structures |
| `feature` | `variate_token`, `cross_attention` | Model the variable dimensions first, suitable for a iTransformer type structure |
| `temporal_then_feature` | `gate`, `residual` | Time before variable, suitable for medium variable number tasks |
| `feature_then_temporal` | `gate`, `residual` | A variable before time, suitable for a strong variable-related task |
| `graph` | `adjacency_source`, `sparsity` | Transport/Sensor Spectrum Tasks |
| `gated_hybrid` | `gate_type` | Learning weight between the temporal and feature branches |

### 5.7 Prediction Head Space

Prediction head is responsible for mapping the last expression to horizon output:

| Head | Parameters | Apply scene |
|------|------|---------|
| `linear` | `share_across_horizons` | point forecast default head |
| `quantile` | `quantiles` | Probability prediction, P50/P90 scene |
| `gaussian` | `variance_floor` | Distributional projections and uncertainty estimates |
| `residual_correction` | `base_head`, `correction_dim` | Learning residual on the strong baseline |

### 5.8 Training Strategy Space

The training strategy goes into recipe instead of being scattered in the free code:

```text
TrainingStrategy =
  Optimizer
  + Scheduler
  + LossRecipe
  + Regularization
  + EarlyStopping
  + FidelityBudget
  + OptionalDistillation
```

Limited Syntax:

```text
Loss = alpha * BaseLoss + beta * HorizonLoss + gamma * Regularization + delta * Calibration

BaseLoss        in {MSE, MAE, Huber, Quantile}
HorizonLoss     in {uniform, front_heavy, tail_heavy, learned_static}
Regularization  in {none, smoothness, sparsity, decomposition_consistency}
Calibration     in {none, quantile_consistency, variance_penalty}
Optimizer       in {Adam, AdamW, SGD}
Scheduler       in {none, cosine, one_cycle, plateau}
Distillation    in {none, teacher_residual, ensemble_to_single}
```

> **Phase 0 exception:** MVP allows Agent to write a small number of ad-hoc loss and training cycles in `train.py` for the purpose of verifying closed rings; Starting with PHase 1, the candidate must be given priority as `CandidateRecipe` and starting with 2 a new action must first register to Grammar/ registry.

### 5.9 Dataset Profiler and Recide Prior

The core inspiration for TimeRecipe is that the validity of the module depends on data attributes. Neo-Cast needs to calculate `TaskFingerprint` before creating a candidate, including at least:

- Number of variables and series
- Lookback / horizon ratio
- Trend intensity, security strength, transtion / Shift indicator
- stationarity / scale stability
- cross-variable correlation
- Missing rate, frequency, sample length
- Training budget, parameters and delayed constraints

The initial use of rule-based prior to sort candidates; Medium-term training on experimental records for rank predictor.`tsf_profile_learned_memory_ranker_v1` is currently in a medium-term mode: task/domain memory, run metric, champion logs extract ZXXQ2Z feature, learn lightweight forecast weights and write longned construction into profile description; LightGBM is still available as a follow-up plug-in.

```text
TaskFingerprint + CandidateRecipe
  -> rule-based prior / rank predictor
  -> top-k recipes
  -> low-fidelity evaluation
  -> full evaluation
  -> memory update
```

Example afore:

- High `horizon_context_ratio`+tend Strong `series_decomposition`, `patch`, `temporal`, `linear/mlp` Priority
- High variables + cross-var coordination high `invert`, `feature`, `transformer/mlp` priority
- Seasonality Strong `token/frequency`, `transformer`, `calendar`
- Distribution Shift high `instance_norm` priority, but no-IN contrast must be maintained
- `none/patch` + `linear/mlp/tcn` + `linear head`

These rules are used only for sorting and interpretation and do not directly lock the search space.

### 5.10 Fingerprint Metric calculator

All `TaskFingerprint` indicators are by default calculated only on track split, and it is forbidden to read val/test label statistics. The output of the indicators is consolidated into `[0, 1]` and records the raw statistics used for audit purposes.

| Indicators | Initial calculator | Annotations |
|------|-------------|------|
| `trend_score` | STL / moving-average ratio | The higher it is, the stronger it is. |
| `seasonality_score` | dominant autocorrelation peak / periodogram peak | Higher means more cyclical. |
| `cross_var_corr_score` | value of non-reverse absolute values for arrays related to variables | Multiple variables depend on intensity |
| `distribution_shift_score` | Normalization distance of difference in window averages/variances | Calculate only in the track internal segment |
| `transition_score` | Change-point margin or first class differential abnormally peaked | Structural mutation intensity |
| `data_scale_stability` | Rolling std inverse indicators of stability | The higher the scale, the more stable it is. |
| `horizon_context_ratio` | `max(prediction_lengths) / context_length` | Can retain original values while providing Cripped score |

The first edition could be achieved with light inspiration and subsequently replaced by a more robust statistical test; The key is to calculate a fixed caliber, recoverable and non-spill.

---

## 6. Agent Organization Layer

The MVP phase uses**a single Agent+ fixed tool to call**; The complete system uses **1 master Agent + 5 tool-type agents**.

### 6.1 Control: Research Manager

Duties: Read mission specifications maintain global state determine the target of each study, assign sub-tasks, update the next search direction based on results

### 6.2 Diagnostic Agent

Responsibilities: structured diagnosis of data, output**mission fingerprints**, including:

- Number of series, frequency, missing rate, multiple variables
- Seasonal/trend/variability intensity
- context/horizon
- Data size and noise level
- Known future accompaniments

### 6.3 Design Agent

Duties: To present candidate scenarios based on mission fingerprints, to select the name of change and expected benefits.

Example of output:

```
- "Long horizon+tend strong, give priority to series_decomposition + Patch + technological custom + MLP"
- "Variables are high and relevant, priority is given to try Transformer/MLP"
- "Small data scene, priority lightweight backbone + strong regularization or distillation"
```

### 6.4 Coder Agent

Function: Convert CandidateRecipe from Design Agent to DSL Configuration Change/ Modular Parameter Changes/ Templateization Code Patch and run static checks, interface tests.

### 6.5 Runner Agent

Responsibilities: Submission of experiments, tracking status, capture anomalies, management of resource budgets, unified recording of experiments

### 6.6 Analyst Agent

Responsibility: Composed by the success or failure of experiments, comparing candidates to Campion, analysing whether it's "real up" or "seed luck", and compressing results into a consumptionable research memory for the next round.

### 6.7 Librarian / Memory Agent

Duties: Management of experimental spectrometry, similar mission retrievals, weighting of failure patterns and conversion of "experience" to structured rules.

---

## 7. Research cycle design

### 7.1 mission life cycle status machine

```text
CREATED
→ DIAGNOSING
→ BASELINING
→ READY
→ RESEARCHING
→ REVIEWING
→ PROMOTED
→ PAUSED / STOPPED / FAILED
```

### 7.2 experimental status machine

```text
QUEUED
VALIDATING (Static Validator)
→ RUNNING
→ SUCCEEDED / FAILED / INVALID
→ ARCHIVED
```

### 7.3 candidate for promotion status machine

```text
PROPOSED
→ PATCHED
→ VALIDATED       （static_valid）
→ SMOKE_PASS
→ LOW_FIDELITY_PASS
→ FULLY_EVALUATED
→ MULTI_SEED_PASS
→ ACCEPTED / REJECTED
```

### 7.4 Job Initialisation Process

```text
Create Task
→ Validate TaskSpec
→ Bind Dataset Version
→ Run diagnostics → Produce TaskFingerprint
Build Baselines run baseline studies
→ Create Initial Champion Set
→ Ready for Research
```

### 7.5 Single Wheel Research Service

```text
Load task context
→ Retrieve relevant memory
→ Generate CandidateRecipes
→ Validate recipes         （Static Validator）
→ Build patches / configs
→ Run smoke tests
→ Run low-fidelity experiments
→ Rank candidates
→ Run full validation for top-k
→ Multi-seed confirmation
→ Compare with champion
→ Accept / Reject
→ Update memory and lineage
```

### 7.6 Full Study Cycle Body (Main Cycle)

```
          ┌──────────────────────────────────────────┐
          │           SETTUP (a manual trigger)            │
          │  Build Branch Query Read File Quest Data Initialization tsv  │
          └──────────────────┬───────────────────────┘
                             │
                     First baseline run (Round 0)
                             │
          ┌──────────────────▼───────────────────────┐
          │           EXPERIMENT LOOP                  │
          │                                            │
          │  Make assumptions. Change train.py.       │
          │       ↓                                    │
          │  smoke run (quick checkcrash)                │
          │       ↓                                    │
          │  Low security experiment (less epoch / subset)               │
          │       ↓                                    │
          │  Full training.           │
          │       ↓                                    │
          │  ┌────┴────────────────────┐              │
          │  │ crash?                  │              │
          │  │  → tail run.log         │              │
          │  │  → Repair or mark crash and skip │              │
          │  └────┬────────────────────┘              │
          │       ↓                                    │
          │  val_avg_mse Improvements?                          │
          │  ├── YES-Keep-Champion Comparison        │
          │  └── NO Discard blancy reset to   │
          │                last_keep_commit             │
          │                ↓                           │
          │         Go back to "Assumption."                      │
          └──────────────────────────────────────────┘
                    (Advanced Ctrl+C not stop)
```

> **Diagram Description:** The figure above is the complete form of Phase 1+. Chase 0 MVP can omit smoke run, low-security filters and multiple baseline scheduling to directly execute "Replace `train.py` full run keep/discard " .

### 7.7 Round 0: baseline establishment

The system must first run a fixed set of baselines:

- Statistical baseline (average filling projection)
- Linear baseline (NLinear CI) ← Initial `train.py` implementation
- Light Depth Learning Baseline (MLP)
- Strong reference baseline (iTransformer or PatchTST)

The aim is not to get the best score, but rather to establish a minimum **mission, feasible training budget, error structure**.

> **Phase 0 Minimum Requirements: **MVP requires only that the initial NLinear CI version of `train.py` run through and form a keep/discard closed loop; The rest of the baseline can be pre-run by hand or delayed to Phase 1 and then incorporated into the Unified Movement Control.

### 7.8 Low security filter

Candidates first:

- Small epoch (1/5 standard number)
- Subset series (1/3 data)
- Shorten horizon (96, 720 only)
- Lower Hidden dim (1/2)
- Just seed

Candidates for low performance are directly phased out (saving GPU hours).

> **Achieving boundaries:** Low security screening is a recommended capability for Phase 1+ and not an optional accomplishment for Phase 0 MVP.

### 7.9 candidates Rule

A candidate can only be "reserved" if all of the following conditions are met:

1. `val_avg_mse` is better than current Campion
2. **Phase 0/1 default threshold:**
   - If `Δval = champion_val_avg_mse - candidate_val_avg_mse >= 0.003`, you can go directly to the keepp candidate
   - If `0.001 <= Δval < 0.003`, only if `Δparams_M <= 0.5` and `delta_loc <= 40`
   - If `Δval < 0.001`, discard by default unless code decreases by at least 20 LOC without increasing parameters.
3. **Phase 3+ Multiple Seed threshold:**
   - `mean(Δval) >= 0.005`
   - `std(val_avg_mse across seeds) <= 0.003`
4. Parameters/delayed in excess of budget; If the budget is exceeded, promotion is allowed only when Utility > 0
5. No data leak, no interface damage
6. I'll be back on my own.

> The above threshold is the default initial value, which can then be covered by `program.md` or task level heuristics.

### 7.10 Champion/ Challenger Mechanism

```text
AccuracyGain      = max(0, champion_val_avg_mse - candidate_val_avg_mse) / 0.01
ModelSizePenalty  = max(0, candidate_params_M - champion_params_M)
LatencyPenalty    = max(0, candidate_latency_ms - champion_latency_ms) / 10
VariancePenalty   = std_seed_val / 0.005
FailurePenalty    = failure_rate                      # crash / total_runs
ComplexityPenalty = max(0, delta_loc) / 50

Utility = 1.00 * AccuracyGain
        - 0.20 * ModelSizePenalty
        - 0.10 * LatencyPenalty
        - 0.30 * VariancePenalty
        - 2.00 * FailurePenalty
        - 0.05 * ComplexityPenalty
```

- **Phase 0-2:** Utility as sorting only with tie-breaker, not as a hard threshold
- **Phase 3+:** Utility > 0 for promotion comparison

The system naturally evolves in the direction of small and steady. While maintaining Pareto Front:

| Dimensions | Meaning |
|------|------|
| Precision Best | val_avg_mse Minimum |
| Delay best | The lowest delay in inference. |
| Arguments best | Minimum number of parameters |
| Integrated best | Utility highest rating |

> **Implementation progress:** NeoResearch Research Service adds candidate-level multi-seed summaries, 95% CI half-widths, and Pareto Frontier calculations to `research_report_markdown`. Pareto compares the primary metric mean with costs such as `resourceUsage.wallClockSec`. Results appear in Markdown's `Experiment Analysis` and artifact metadata (`evaluatedRunCount`, `multiSeedCandidateCount`, `paretoFrontierCount`), with summaries in Web Dashboard and TUI Cockpit. Candidate execution supports `seed-sweep` using `taskSpec.evaluation.seeds` or explicit seeds, recording each seed in the runner payload and `resourceUsage.seed` through the shared Web/TUI/CLI/HTTP interface. Probabilistic forecasting supports `forecastMode=probabilistic`, primary metrics `val_avg_pinball` / `val_avg_crps_approx`, and quantile-head pinball/approximate-CRPS/interval-coverage-and-width evaluation and reports. `blind_test` has NeoResearch stage, approval, query-limit, CLI/Web/TUI, and Neo-Cast sidecar HTTP contracts. Independently deployable `py/blind_test_sidecar.py` supports bearer tokens, query limits, and private audit JSONL. Actual private-data integration and long-term deployment remain Milestone 5 work.

> **Utility achieves calibration:** Current export will produce `Utility Ranking`, using the current campaign (if not best metrology) as reference to calculate anachronism gas and deduct parameters, delays, multi-seed squares and code complexity penalties; The result is written in Markdown and Artificial Metadata (`utilityCandidateCount`). Current Utility is first used for sorting and auditing, without directly overwhelming the Champion promotion policy.

### 7.11 Statistical calibration of indicators

In order for acceptance rules and Utility to be truly enforceable, the following observations must have a fixed calibre:

- `delta_loc`
  Defined as **changed LOC = added_lines + deleted_lines** submitted by the current candidate relative father on `train.py`;
  The statistics are based on `git diff --numstat <parent_commit> -- train.py` and do not look at the net increase.

- `candidate_latency_ms`
  Defined as the median number of 50 forward at **on the same hardware**, `device=batch GPU/CPU` fixed, `batch_size=1`, each horizon and warmup 10 times;
  If the current system is multiple horizon bundle, take an arithmetic average of each horizon latency.

- `failure_rate`
  Defined as the percentage of failures in task_id, Zranch and most recent 20 experiments**;
  Failures include: non-zero exit, OOM, NaN indicators, mismatches of interfaces and timeout killings.

- `std_seed_val`
  Defined as the standard difference of `val_avg_mse` on the agreed lid set for the same candidate; The current NeoResearch export has been able to do averages/standard deviations/best/worst summary for the same candidate many times, and runner can generate these runs automatically through `seed-sweep` as agreed.

- `params_M`
  `params_M` is the total number of bindle parameters if multiple horizon bundle (one model per horizon) is currently achieved;
  All parameter volume comparisons must be performed under **the same model calibre**, not directly compared with single horizon models.

---

## 8. Research memory system (Memory Layer)

This is one of the biggest differences between neo-research and normal AutoML**.

### 8.1 Memory Unit

Each experiment is structured:

```json
{
  "task_fingerprint": "etth1_multivar_512_96-720",
  "parent_recipe": "none_none_linear_temporal_linear_mse_v1",
  "candidate_recipe": "in_decomp_patch_mlp_temporal_linear_mse_v1",
  "hypothesis": "series_decomposition + patch embedding + temporal fusion can improve long-horizon trend fitting",
  "patch_diff": "--- train.py ... +++ train.py ...",
  "recipe_hash": "sha256:abc123",
  "metrics": {"val_avg_mse": 0.4213, "val_h720_mse": 0.4632},
  "resources": {"training_seconds": 412.3, "params_M": 2.14},
  "verdict": "accepted",
  "failure_tags": [],
  "analysis_summary": "decomposition + patch helped on long horizon with strong trend"
}
```

> **Segregation statement:** Agent readable research memory only saves `val_*`, resource consumption, failure labels and summary assumptions;`ref_test_*` must enter the Runner/Human Gate-held Privileged protection memory without entering the Agent context.

### 8.2 Three types of memory

**Short-term memory (Short-term)**
The context of the most recent rounds of experiments in the current mission is for Research Manager to decide on the next hypothesis. Prevents repetition of the test and allows Agent to repeat it.

**Task-level**
Which are valid under the same mandate and which are not. For example: "`series_decomposition + patch_len=16 + temporal fusion` valid on ETTh1, invalid `graph fusion`". Record what type of action, Loss, structure is not valid and which failure patterns are frequent.

**Cross-task Meta**
Relocation based on mission fingerprints, for example:

- Strong Season + Long Horizon `series_decomposition`/ `frequency` / `patch` Priority
- Multivariant + variable highly relevant `invert embedding` + `feature fusion` priority
- Small sample + Noise High and Light `mlp/tcn` backbone + Strong regularization or distillation priority
- HF data + latency binding `temporal fusion` + `mlp/tcn/linear` priority
- High-deficit scene.
- Small data scenes + distill priority

### 8.3 Experimental Spectrum (Lineage Tree)

Every recipe is not an isolated point, but a spectra tree:

```
none_none_linear_temporal_linear_mse_v1 (baseline)
├── none_patch_mlp_temporal_linear_mse_v1 [keep: -0.0163 val_mse]
│   ├── in_decomp_patch_mlp_temporal_linear_mse_v1 [keep: -0.0089]
│   │   └── in_decomp_patch_mixer_hybrid_linear_mse_v1 [discard: +0.0021]
│   └── none_patch_mlp_feature_linear_mse_v1 [discard: +0.0149, 8x params]
└── decomp_none_linear_temporal_linear_mse_v1 [discard: -0.0003, not worth added complexity]
```

---

## 9. Strictly restrained environment (Execution Layer)

### 9.1 Sandbox

Each experiment is carried out in a containment container, fixed:

- Python Version
- Dependency version (`pyproject.toml`/ `uv.lock`)
- CUDA Environment
- Data mounted directories (read-only); Agent side only mounts train/valrows)
- Read-only baseline code (`prepare_tsf.py`)
- Writeable Patch Directory (`train.py`)
- Agent container**unmounted** reference testrows / tags and Privileged protocol log

**Runner-only sidecar/service**:

- Accept only promoted paths or checkpoint references
- Hold private data mounted or access tokens for reference test
- Output written to privileged log (e. g. `promotion.tsv`) without returning to Agent workspace
- The Agent process does not have the token / socket /mount required for this interface to be called

### 9.2 Permission Control

Agent default cannot:

- Any Networking
- Install Any New Packages
- Access Test Tabs
- Modify Assessment Code (`prepare_tsf.py`)
- Modify Data Loading Protocol
- Call for reference test / blind test sidecar
- Skip Static Validator

### 9.3 Static Validator Refuse Condition

Static Validator checks the following conditions before each watch is executed, and either triggers are refused:

- Modify the evaluation protocol (relevant `prepare_tsf.py` logic)
- Modify data split logic
- Pass the upper limit of parameter (hard cap: 2 x `max_params`)
- Over-calculation budget (training time estimate exceeded ceiling)
- Use unregistered action or illegal action parameter combination
- Incompatibility of interfaces (input/output shape mismatches)

### 9.4 Level 3 code change mode

| Level | Name | Allow Operation | Risk | Phase of application |
|------|------|---------|------|--------|
| L0 | Single-file Research | Change only `train.py` to verify keep/discard closed loops | Medium | Phase 0a |
| L1 | Recipe Config Search | Change only the parameters of registered action (Patch size, depth, dropout, lr, Scheduler, lost watching)| Minimum | Phase 0b/1 |
| L2 | Registry Composition | Accomplishing, combining, backbone, favor, head, train)| Medium | Phase 1/2 |
| L3 | Template Patch | Add/modify an action (new custom block, new head, new loss complex) in restricted templates and require additional audit | Higher | Phase 3 |

---

## 10. Module Interfaces

The following interface is described as a "logical interface", followed by Python service class, gRPC or RRT.

### 10.1 Task Manager Interface

```python
def create_task(task_spec: TaskSpec) -> TaskRecord
def get_task(task_id: str) -> TaskRecord
def update_task_status(task_id: str, status: TaskStatus) -> None
```

### 10.2 Dataset Service Interface

```python
def load_dataset(task_id: str) -> DatasetBundle
def build_splits(task_spec: TaskSpec) -> SplitBundle
def materialize_features(split_bundle: SplitBundle,
                         transform_spec: TransformSpec) -> FeatureBundle
```

### 10.3 Diagnostic Service Interface

```python
def diagnose_task(dataset_bundle: DatasetBundle,
                  task_spec: TaskSpec) -> TaskFingerprint
```

### 10.4 Baseline Builder Interface

```python
def run_baselines(task_id: str,
                  baseline_set: list[str]) -> list[ExperimentRecord]

def select_initial_champion(records: list[ExperimentRecord]) -> ChampionRecord
```

### 10.5 Proposal Engine Interface

```python
def generate_proposals(task_id: str,
                       fingerprint: TaskFingerprint,
                       champion: ChampionRecord,
                       memory_context: MemoryContext,
                       budget: BudgetSpec,
                       k: int) -> list[Proposal]
```

Each `Proposal` must contain: `hypothesis`, `target_actions`, `candidate_recipe`, `expected_gain`, `risk_level`, `est_cost`.

### 10.6 Patch Generator Interface

```python
def build_patch(proposal: Proposal,
                base_recipe: CandidateRecipe) -> PatchBundle
```

`PatchBundle` includes: `recipe_delta`, `compiled_model_delta`, `code_patch_text`, `validation_manifest`.

### 10.7 Static Validator Interface

```python
def validate_patch(task_spec: TaskSpec,
                   patch_bundle: PatchBundle,
                   budget: BudgetSpec) -> ValidationResult
# ValidationResult: passed: bool, violations: list[str], warnings: list[str]
```

### 10.8 Experiment Runner Interface

```python
def run_experiment(task_id: str,
                   experiment_spec: ExperimentSpec) -> ExperimentRecord

def run_multi_seed(task_id: str,
                   experiment_spec: ExperimentSpec,
                   seeds: list[int]) -> list[ExperimentRecord]
```

### 10.9 Evaluator Interface

```python
def evaluate_candidate(challenger: CandidateRecord,
                       champion: ChampionRecord,
                       promote_rule: PromoteRule) -> PromotionDecision

def generate_analysis(experiment_records: list[ExperimentRecord]) -> AnalysisReport
```

### 10.10 Memory Service Interface

```python
def write_memory(memory_item: MemoryItem) -> None

def retrieve_similar_tasks(fingerprint: TaskFingerprint,
                           top_k: int = 5) -> list[MemoryItem]

def retrieve_failure_patterns(task_id: str,
                              action_name: str) -> list[FailurePattern]
```

---

## 11. Core Data Structure (Core Data Structures)

### 11.1 TaskSpec

```python
from dataclasses import dataclass
from typing import Literal, Optional

@dataclass
class DatasetSpec:
    loader_id: str
    target_cols: list[str]
    known_future_covariates: list[str]
    observed_past_covariates: list[str]   # excludes cols already listed in target_cols
    static_covariates: list[str]

@dataclass
class TaskSpec:
    task_id: str
    name: str
    task_type: Literal["forecasting"]
    forecast_mode: Literal["point", "probabilistic"]
    series_type: Literal["univariate", "multivariate"]
    context_length: int
    prediction_lengths: list[int]
    dataset_spec: DatasetSpec
    split_spec: "SplitSpec"
    eval_spec: "EvalSpec"
    budget_spec: "BudgetSpec"
    search_space_spec: "SearchSpaceSpec"
```

### 11.2 SplitSpec

```python
@dataclass
class SplitSpec:
    scheme: Literal["fixed_row_index", "rolling_origin"]
    train: tuple[int, int]
    val: tuple[int, int]
    test: tuple[int, int] | None
    test_exposure: Literal["promotion_only", "hidden"]
    blind_test: Literal["none", "phase5_service"]
    rolling_windows: Optional[int] = None
```

### 11.3 EvalSpec

```python
@dataclass
class EvalSpec:
    protocol: Literal["fixed_split", "rolling_origin"]
    metrics: list[str]
    primary_metric: str
    reference_metric: str | None
    agent_visible_metrics: list[str]
    privileged_metric_names: list[str]
    seeds: list[int]
    promote_threshold: float | None
    use_shadow_holdout: bool
    use_blind_test: bool
```

### 11.4 BudgetSpec

```python
@dataclass
class BudgetSpec:
    max_trials: int
    max_gpu_hours: float
    max_params: int
    max_latency_ms: float
    max_peak_mem_mb: int
```

### 11.5 SearchSpaceSpec

```python
@dataclass
class SearchSpaceSpec:
    preprocessing_actions: list["ActionSpec"]
    embedding_actions: list["ActionSpec"]
    backbone_actions: list["ActionSpec"]
    fusion_actions: list["ActionSpec"]
    prediction_heads: list["ActionSpec"]
    training_strategies: list["ActionSpec"]
    loss_ops: list["ActionSpec"]
    patch_mode: Literal["config_only", "registry_only", "template_patch"]
```

### 11.5.1 ActionSpec

`ActionSpec` is the basis on which Static Validator can really work. Each action must state parameters: schema, shape conformity, adjacent action compatibility and budget estimate.

```python
@dataclass
class ShapeSpec:
    layout: Literal["BLC", "BCL", "BNC", "BHD", "custom"]
    rank: int
    semantic_axes: list[str]  # e.g. ["batch", "time", "channel"]

@dataclass
class ActionSpec:
    name: str
    kind: Literal["preprocessing", "embedding", "backbone", "fusion", "head", "postprocessing", "trainer", "loss"]
    param_schema: dict
    default_params: dict
    input_shape: ShapeSpec | None
    output_shape: ShapeSpec | None
    compatible_prev: list[str]
    compatible_next: list[str]
    requires_fields: list[str]      # e.g. ["time_features", "known_future_covariates"]
    phase_min: Literal["phase0b", "phase1", "phase2", "phase3"]
    estimate_params_fn: str | None
    estimate_latency_fn: str | None
```

### 11.6 TaskFingerprint

```python
@dataclass
class TaskFingerprint:
    freq: str
    n_series: int
    n_channels: int
    missing_ratio: float
    seasonality_score: float
    trend_score: float
    volatility_score: float
    intermittency_score: float
    cross_var_corr_score: float
    transition_score: float
    distribution_shift_score: float
    covariate_availability_score: float
    horizon_context_ratio: float
    data_scale_stability: float
```

### 11.7 CandidateRecipe

```python
@dataclass
class CandidateRecipe:
    recipe_id: str
    recipe_version: str
    preprocessing: dict
    embedding: dict
    backbone: dict
    fusion: dict
    prediction_head: dict
    post_processing: dict   # {"type": "auto"} allowed; runtime expands derived steps
    training_strategy: dict
    constraints: dict
    rationale: str
    estimated_params: int
```

### 11.8 ModelSpec

`ModelSpec` is the operational model specification compiled by Runtime from `CandidateRecipe` and used mainly by Runner, Evaluator and Artifact Store.

```python
@dataclass
class ModelSpec:
    recipe_id: str
    compiled_modules: dict
    input_shape: tuple[int, ...]
    output_shape: tuple[int, ...]
    train_objective: dict
    inference_policy: dict
    estimated_params: int
```

### 11.9 Proposal

```python
@dataclass
class Proposal:
    proposal_id: str
    parent_recipe_id: str
    hypothesis: str
    target_actions: list[str]
    change_type: Literal["recipe", "loss", "trainer", "inference", "template_patch"]
    candidate_recipe: CandidateRecipe
    expected_gain: str
    risk_level: Literal["low", "medium", "high"]
    est_gpu_hours: float
    est_params_delta: int
```

### 11.10 PatchBundle

```python
@dataclass
class PatchBundle:
    proposal_id: str
    recipe_delta: dict
    compiled_model_delta: dict
    code_patch_text: str | None
    manifest: dict
```

### 11.11 ExperimentSpec

```python
@dataclass
class ExperimentSpec:
    experiment_id: str
    task_id: str
    stage: Literal["smoke", "low_fidelity", "full", "multi_seed"]
    parent_recipe_id: str
    candidate_recipe: CandidateRecipe
    model_spec: ModelSpec
    transform_spec: dict
    trainer_spec: dict
    eval_spec: EvalSpec
    seed: int
```

### 11.12 ExperimentRecord

```python
@dataclass
class ExperimentRecord:
    experiment_id: str
    task_id: str
    recipe_id: str
    status: Literal["queued", "running", "succeeded", "failed", "invalid"]
    agent_metrics: dict
    privileged_metrics_ref: str | None   # e.g. promotion_id / URI into privileged store
    resource_usage: dict
    artifacts: dict
    logs_uri: str
    error_message: str | None
```

### 11.13 ChampionRecord

```python
@dataclass
class ChampionRecord:
    recipe_id: str
    task_id: str
    candidate_recipe: CandidateRecipe
    model_spec: ModelSpec
    agent_aggregate_metrics: dict
    privileged_promotion_ref: str | None
    resource_profile: dict
    lineage_root: str
    accepted_at: str
```

### 11.14 PromotionDecision

```python
@dataclass
class PromotionDecision:
    promote: bool
    reason: str
    metric_delta: dict
    complexity_delta: dict
    stability_delta: dict
    violates_budget: bool
```

### 11.15 MemoryItem

```python
@dataclass
class MemoryItem:
    memory_id: str
    task_id: str
    fingerprint_summary: dict
    recipe_summary: dict
    hypothesis: str
    patch_summary: dict
    outcome: Literal["accepted", "rejected", "failed"]
    agent_gain_summary: dict
    privileged_gain_ref: str | None
    failure_tags: list[str]
    lesson: str
```

> **Segregation:** `EvalSpec` can only state which indicators belong to the Privileged domain;`privileged_*_ref` in running state records can only save opaque identifiers (e. g. `promotion_id`, object storage URI, Metrics DB) and cannot directly embed `ref_test_*` values; Agent context only consumes `agent_*` fields.

### 11.16 Supporting Records

Follow-up of assistive types used at interface level can be refined to stand-alone schema; Version 1 requires at least the following minimum definition to avoid an interface remaining only in placeholders.

```python
@dataclass
class TaskRecord:
    task_id: str
    status: str
    task_spec: TaskSpec
    created_at: str

TaskStatus = Literal["created", "diagnosing", "baselining", "ready", "researching", "reviewing", "promoted", "paused", "stopped", "failed"]

@dataclass
class DatasetBundle:
    dataset_id: str
    train_ref: str
    val_ref: str
    metadata: dict

@dataclass
class SplitBundle:
    train: object
    val: object
    test_ref: str | None

@dataclass
class TransformSpec:
    recipe_id: str
    preprocessing: dict
    feature_fields: list[str]

@dataclass
class FeatureBundle:
    train_features_ref: str
    val_features_ref: str
    metadata: dict

@dataclass
class MemoryContext:
    similar_memories: list[MemoryItem]
    recent_task_memories: list[MemoryItem]
    failure_patterns: list["FailurePattern"]

@dataclass
class ValidationResult:
    passed: bool
    violations: list[str]
    warnings: list[str]

@dataclass
class CandidateRecord:
    candidate_recipe: CandidateRecipe
    model_spec: ModelSpec
    experiment_records: list[ExperimentRecord]
    aggregate_metrics: dict

@dataclass
class PromoteRule:
    primary_metric: str
    min_delta: float
    max_params: int
    max_latency_ms: float

@dataclass
class FailurePattern:
    action_name: str
    failure_tags: list[str]
    count: int
    lesson: str

@dataclass
class AnalysisReport:
    summary: str
    metric_breakdown: dict
    failure_analysis: dict
    next_suggestions: list[str]
```

---

## 12. Recommendations on the structure of the directory

Full system directory layout:

```text
neo_research/
  configs/
    tasks/              ← TaskSpec YAML files
    search_spaces/      ← SearchSpaceSpec YAML
    recipes/            ← CandidateRecipe YAML / JSON
    baselines/          ← Baseline recipe configurations
  core/
    task_manager.py
    orchestrator.py
    state_machine.py
  datasets/
    loaders/
    splitters/
    transforms/
  diagnostics/
    fingerprint.py
    statistics.py
  registry/
    preprocessing/
    embeddings/
    backbones/
    fusions/
    heads/
    losses/
    trainers/
    postprocessing/
  factory/
    build_model.py      ← CandidateRecipe -> ModelSpec / nn.Module
    shape_inference.py
  proposals/
    proposal_engine.py
    heuristics.py
    llm_planner.py
  patching/
    patch_generator.py
    validators.py       ← Static Validator implementation
  execution/
    runner.py
    sandbox.py
    scheduler.py
  evaluation/
    metrics.py
    promotion.py        ← PromotionDecision logic
    analysis.py
  memory/
    memory_store.py
    retriever.py
    lineage.py
  governance/
    permissions.py
    audit.py
    blind_test.py
  api/
    service.py
    schemas.py
  ui/
    dashboard/
```

Chase 0a only needs: `prepare_tsf.py`, `train.py`, `program.md`. Chase 0b starts supplementing `configs/recipes/` with the smallest `CandidateRecipe` schema; Other directories are filled gradually with the evolution of the system.

---

## 13. MVP Implementation Layer: File Structure and Interface

### 13.1 Freezing Layer: `prepare_tsf.py`

`prepare_tsf.py` is the experiment's unshakeable foundation, which achieves a direct reference to Time-Series-Library data loading and assessment logic.** This document can never be modified.

**Fixed constant:**

```python
import os
# ─── Dataset ──────────────────────────────────────────────────────────────────
DATASET        = "ETTh1"
DATA_PATH      = "ETTh1.csv"
# Data Root Directory: Preset local CSV by Human/Runner outside the Agent container;Chase 0 does not rely on Agent network downloads
DATA_ROOT      = os.path.expanduser("~/.cache/neo_research_tsf/dataset/ETT-small/")
NUM_CHANNELS   = 7             # ETTh1 for 7 variables (HUFL/HULL/.../OT)

# ─── Time Window ────────────────────────────────────────────────────────────────
INPUT_LEN      = 512           # Look-back window (agent not modified)
HORIZONS       = [96, 192, 336, 720]   # All horizon and evaluation at the same time

# ─── ETTh1 data set to cut the boundary (hard code, fully consistent with TSL Dataset_ETT_hour)────────
# Train: Line [0, 8640] 12 months x 30 days x 24 hours
# val:   rows [8640,  11520) → Next 4 months
# test:  rows [11520, 14400) → Next 4 months
BORDER_TRAIN   = (0,                    12 * 30 * 24)                        # (0, 8640)
BORDER_VAL     = (12 * 30 * 24,         12 * 30 * 24 + 4 * 30 * 24)         # (8640, 11520)
BORDER_TEST    = (12 * 30 * 24 + 4 * 30 * 24, 12 * 30 * 24 + 8 * 30 * 24)  # (11520, 14400)

# ─── Budgeting ────────────────────────────────────────────────────────────────
TIME_BUDGET    = 600           # Maximum duration of one-time experimental training, seconds (10 minutes)

# ─── Soft limits on the size of parameters ──────────────────────────────────────────────────────────
PARAM_BUDGET   = 10_000_000    # 10M parameter soft cap (overwrite in log WARNING without mandatory suspension)

# ─── Random Feeds ────────────────────────────────────────────────────────────────
SEED           = 42
```

**Standardisation Agreement (TSL Consistency):**

Full TSL standardization: **sklearn `StandardScaler`, only fit in the training session and revert to the same track statistics**. Achieving two visible domains above:

- Agent workspace only physical `train + val` line
- Runner sidecar privately owned `reference test` row and reuses the same scaler

The evaluation does not involve inversion transport (calculated MSE/MAE in scaled space) and is consistent with TSL default behaviour (`args.inverse=False`).

```python
from sklearn.preprocessing import StandardScaler

scaler = StandardScaler()
train_raw = df_visible[BORDER_TRAIN[0]:BORDER_TRAIN[1]].values   # shape: [8640, 7]
scaler.fit(train_raw)          # fit only track segment

# Agent Visible: only train/valrows transform
visible_scaled = scaler.transform(df_visible.values)            # shape: [11520, 7]

# Runner sidecar private: reuse same scaler for reference testrows
# ref_test_scaled = scaler.transform(df_ref_test.values)        # shape: [2880, 7]
```

> **Why not use RevIN?** RevIN for instance dynamical integration during Forward will affect the way in which angent designs loss (agent needs to know if it is anti-consolidation). The fixed use of static StandardScaler allows angent to focus on the model structure itself, while the results are directly comparable with the baseline figures published by TSL.

**Agent Visible Data Loading Interface (`make_dataloader`):**

```python
def make_dataloader(split: str, horizon: int, batch_size: int,
                    shuffle: bool = None) -> DataLoader:
    """
    split: "train" | "val"
    horizon: predict the number of steps to be taken from the HORIZONS list

    Each sample:
      x: Tensor[INPUT_LEN, NUM_CHANNELS]     ← Scaled historical observations
      y: Tensor [horizon, NUM_CHANNELS] predicted target (scaled)

    Note:
    - val collection shuffle=False (fixed order)
    - Train collection graph=True by default
    - Chase 0a does not return time
    - Before PHase 1, Agent should not privately read the original CSV hidden time fields in `train.py`
    - `calendar` embedding requires Phase 2+ to return x_mark/ y_mark by freezing a visible interface or know
    """
```

> **Segregation request:** `prepare_tsf.py` for Agent only export `train/val` loader. If this is achieved as a local function, reference / blind test loader must also be located in a private directory that Runner sidecar or Agent cannot mount and cannot be `train.py` import.

> **Simplified difference with TSL: **TSL's `__getitem__` is also returned to `(seq_x, seq_y, seq_x_mark, seq_y_mark)` to support trackformer decoder's Teacher forcing. Neo-research TSF simplified to `(x, y)`, removes `label_len` and time stamp features. This makes it easier for angent to write a model; If subsequent time stamp features are indeed required, Human/Runner should expand the visible interface in the freeze layer instead of allowing `train.py` to read the original CSV or rebuild hidden fields privately.

**Agent Visible Assessment Function (primary metric definition):**

```python
@torch.no_grad()
def evaluate_val_tsf(model_or_models, device) -> dict:
    """
    Evaluate all HORIZONS only on val split.

    Calculating MSE and MAE in SCALED SPACE (after StandardScaler integration),
    Consistent with the metric() function of TSL exp_long_term_forecasting.py.

    model_or_models：
      - If dict {horizon: Moder}, evaluate it separately by horizon
      - If a single nn.Module, evaluate all horizon using the same model

    returns dict, keep including:
      " val_avg_mse " - Multihorizon Average MSE (primary metric)
      " val_avg_mae " - Multihorizon Average MAE
      "val_h{H}_mse" — MSE for each horizon
      "val_h{H}_mae" — MAE for each horizon
    """
```

**Runner-only Privileged Interface:**

```python
def query_ref_test(artifact_uri: str, task_id: str, promotion_token: str) -> dict:
    """
    An interface called by Runner/Human Gate.

    - Read independent reference test data or services
    - returns ref_test_* indicator
    - Result written to Privileged project log, not exposed to Agent process
    """

def query_blind_test(artifact_uri: str, task_id: str, promotion_token: str) -> dict:
    """
    External blind-test sidecar interface called by Runner/Human Gate.

    - Call for private services through NEO_TSF_BLIND_TEST_URL/ NEO_TSF_BLIND_TEST_TOKEN
    - Only artifact_uri, task_id, promotion_token are passed in the warehouse
    - returns blind_test_* indicator;Private labels and ratings are closed to Agent Visible Repository
    """
```

Standard `train.py` call:

```python
# keep/discard by: Val Set
val_results = evaluate_val_tsf(models, device=device)

# Only in the process phase, called by Runner/Human Gate outside the Agent process:
# ref_test_results = query_ref_test(artifact_uri, task_id, promotion_token)
```

**Default Summary sample (Agent visible for grep resolution, fixed format):**

```
---
val_avg_mse:      0.437600
val_h96_mse:      0.391200   val_h96_mae:      0.402100
val_h192_mse:     0.423500   val_h192_mae:     0.427800
val_h336_mse:     0.453800   val_h336_mae:     0.451200
val_h720_mse:     0.481900   val_h720_mae:     0.479400
training_seconds: 587.2
total_seconds:    612.4
peak_vram_mb:     4210.3
num_params_M:     2.14
```

**Runner-side protocol log sample (not printed by `train.py`, Agent default invisible):**

```text
ref_test_avg_mse: 0.454800
ref_test_h96_mse: 0.397100   ref_test_h96_mae: 0.413200
...
```

> **Why not output by default?** `val_avg_mse` is the only keep/discard decision signal. Open `test` only for promotion nodes by Runner/Human Gate to align with the released TSL results; The real blind test moves further back to independent service.

---

### 13.2 Experimental Layer: `train.py`

**Agent range of freedom in Chase 0/MVP:**

`train.py` is an agent**the only document that can be modified**.

**Model structure (freedom in single document):**
- Type of network: Transformer, MLP, TCN, CNN, SSM, linear models, hybrid structures, etc.
- Depth and width: layers, hidden dimensions, heads of focus
- Channel Policy: Channel-Independent (CI) or Channel-Dependent (CD)
- Patch Design: Patch size, stride, use overlap
- Location Encoding, Normalization Positions, Activation Functions, Disable Connection Method

**Training strategy (freedom in single documents):**
- Loss function: MSE, MAE, Huber, Bit Number Loss, Custom Group (Phase 0 only); Chase 2+ Receivable to Grammar/registry)
- Optimizers: Adam, AdamW, SSD, Any variant
- Learning rate and schedule: cosine, linear warmup/warmdown etc.
- Batch size, training epoch number (within TIME_BUDGET)
- Dropout, Regular
- Data enhancement (training set only, not modified for validation/test set)

**Model interface engagement:**

```
x: FloatTensor [B, INPUT_LEN, NUM_CHANNELS] History window, scaled
y: FloatTensor [B, Horizon, NUM_CHANNELS] Projection target, scaled

pred = model(x)   # → [B, horizon, NUM_CHANNELS]
```

** `train.py` Initial baseline (NLinear CI):**

```python
"""
neo-research TSF training script. Agent edits ONLY this file.
Usage: uv run train.py
"""
from prepare_tsf import (
    INPUT_LEN, HORIZONS, NUM_CHANNELS, TIME_BUDGET, PARAM_BUDGET, SEED,
    make_dataloader, evaluate_val_tsf,
)
import torch
import torch.nn.functional as F
import time

# ─── Superparameters (agent can directly modify these and all below)───────────────────────────
BATCH_SIZE  = 32
LR          = 1e-3
MAX_EPOCHS  = 100      # Run as many epochs inside TIME_BUDGET;Suggestion

# ─── Model definition ──────────────────────────────────────────────────────────────────
class TSFModel(torch.nn.Module):
    """
    Baseline: Channel-Independent per-channel linear（NLinear-style）。
    Each channel independent linear map is the simplest effective baseline for TSF fields.
    Reference: DLinear / NLinear (AAAI 2023).
    """
    def __init__(self, input_len: int, horizon: int):
        super().__init__()
        self.linear = torch.nn.Linear(input_len, horizon)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, L, C]  →  [B, H, C]
        B, L, C = x.shape
        x = x.permute(0, 2, 1).reshape(B * C, L)     # [B*C, L]
        out = self.linear(x)                           # [B*C, H]
        return out.reshape(B, C, -1).permute(0, 2, 1)  # [B, H, C]

# ─── Training cycle ──────────────────────────────────────────────────────────────────
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
torch.manual_seed(SEED)
t_start = time.time()

models = {h: TSFModel(INPUT_LEN, h).to(device) for h in HORIZONS}
optimizers = {h: torch.optim.Adam(models[h].parameters(), lr=LR) for h in HORIZONS}

for horizon in HORIZONS:
    train_loader = make_dataloader("train", horizon, BATCH_SIZE, shuffle=True)
    val_loader   = make_dataloader("val",   horizon, BATCH_SIZE, shuffle=False)
    model, opt   = models[horizon], optimizers[horizon]

    best_val_loss = float("inf")
    patience_counter = 0
    PATIENCE = 7  # Early stomping data (reference TSL default)

    for epoch in range(MAX_EPOCHS):
        if time.time() - t_start >= TIME_BUDGET:
            break

        model.train()
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            loss = F.mse_loss(model(x), y)
            opt.zero_grad(); loss.backward(); opt.step()

        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for x, y in val_loader:
                val_loss += F.mse_loss(model(x.to(device)), y.to(device)).item()
        val_loss /= len(val_loader)

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
            torch.save(model.state_dict(), f"/tmp/neo_tsf_best_h{horizon}.pt")
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                break

    model.load_state_dict(torch.load(f"/tmp/neo_tsf_best_h{horizon}.pt"))
    model.eval()

# ─── Evaluation ──────────────────────────────────────────────────────────────────────
t_train_end = time.time()
val_results = evaluate_val_tsf(models, device=device)

# ─── Summary output (fixed format for grep resolution)─────────────────────────────────────
training_seconds = t_train_end - t_start
total_seconds    = time.time() - t_start
num_params = sum(p.numel() for m in models.values() for p in m.parameters())

print("---")
print(f"val_avg_mse:      {val_results['val_avg_mse']:.6f}")
for h in HORIZONS:
    print(f"val_h{h}_mse:     {val_results[f'val_h{h}_mse']:.6f}   "
          f"val_h{h}_mae:     {val_results[f'val_h{h}_mae']:.6f}")
print(f"training_seconds: {training_seconds:.1f}")
print(f"total_seconds:    {total_seconds:.1f}")
print(f"peak_vram_mb:     {(torch.cuda.max_memory_allocated() / 1024 / 1024) if torch.cuda.is_available() else 0.0:.1f}")
print(f"num_params_M:     {num_params / 1e6:.2f}")
if num_params > PARAM_BUDGET:
    print(f"WARNING: num_params ({num_params/1e6:.1f}M) exceeds PARAM_BUDGET ({PARAM_BUDGET/1e6:.0f}M)")
```

---

### 13.3 Policy Layer: `program.md`

`program.md` is **AGent Behavior Agreement,** prepared by the Human Researcher and iteratively.

**Setup Phase:**

```markdown
## Setup

1. **According to experiments tag**: e. g. `apr21-etth1`.Create branch `neo-research/<tag>`.
2. ** Read context documents**:
   - `prepare_tsf.py` - Knowledge of fixed constants, data splits, evaluation protocols
   - `train.py` - Know baseline model and current experimental starting point
   - `results.tsv` - Knowledge of historical experimental trajectory (Agent Visible Indicator only)
3. ** Confirm data readiness**: check whether the data set has been downloaded to `~/.cache/neo_research_tsf/`
4. ** Initialized results.tsv **: written in header line
5. ** Initialization of promotion.tsv**: held by Runner/Human Gate;Agent does not read
6. **Records `last_keep_commit`**: initialized into current base line group;Every time a keeper is successfully updated
7. ** Start the experimental cycle after confirmation**
```

**Experimental cycle (core protocol):**

```markdown
## Experimental cycle

LOOP FOREVER:

1. View the current guit status (where it is)
2. Present a research assumption (what to modify, why might it be effective)
3. Modify `train.py`
4. It's a good idea, right?
5. Run experiments: `uv run train.py > run.log 2>&1`
6. Read results:
   `grep "^val_avg_mse:\|^num_params_M:\|^WARNING" run.log`
7. If grep is empty, crash: read `tail -50 run.log` and try repair
8. Record results to results.tsv (do not submit git)
9. Decision-making (based on val_avg_mse):
   - val_avg_mse** Reduce** keep, retain and update `last_keep_commit=$(git rev-parse HEAD)`
   - Unchanged or higher val_avg_mse → discard. The experiment branch `HEAD` must actually return to `last_keep_commit`.
     (Special: `git reset --hard <last_keep_commit>` for research lanch and workstream clean)
     If there are other changes that have not been submitted, the automatic cycle is stopped and handed over to Human;Do not only restore `train.py` content while retaining the reprojected committee as the current `HEAD`
10. If `PROMOTION_INTERVAL` (default 5) is cumulative, a reference test is triggered by Runner/Human Gate;
    This result is written only to `promotion.tsv` and does not refill the Agent context
11. Back to step 1.
```

**TSF exclusive research orientation tips:**

```markdown
## Research orientation reference (in order of priority)

Precedence:
- Channel-Independent (CI)Channel-Dependent (CD) policy transition
  (CI) Independent projection per channel;CD Visible Modell Channel Dependence, e. g. iTransformer)
- Patch Chemical Input (Patch size = 16/32, stride = 8/16, reference PatchTST)
- Decomposition of trends: decompose sequences into trend(moving input) + remainder, modeling separately
  (Refer to DLinear decomposition in TSL)
- Replace Attention with MLP-Mixer (more efficient calculation, seq_len significant long-term returns)
- Frequency domain characteristics: FFT coefficient as aided input (temporal domain feature concat)

Secondary exploration:
- Cross-horizon Parameter Sharing: Single Model + Different pred_len program head
- Multiscale time-series feature integration (different watch size parallel brancy, final concat)
- Asymmetric Los: Differential penalties for errors in the top/down row
- Distinction: iTransformer for teacher, little MLP for student

## Simplicity criterion (inheritance from autoresearch)

- Raise 0.005 val_avg_mse but add a new 80 line complex code: it is not worth preserving
- Raise 0.005 val_avg_mse and delete code: Always keep
- Raised to 0, but the code is simpler: keep (simplified victory)
- Increase in the number of participants by more than 5M and raise < 0.010 val_avg_mse: do not retain

## Model scale penalty rules

When the val_avg_mse improvement Δ and parameter increase ΔP satisfy:
  Δ / (ΔP / 1e6) < 0.005
  (i.e., inadequate improvement of 0.005 MSE per 1M parameter)
→ Treat the change as not worthwhile and recommend discard.
```

---

## 14. Log file design (Tab separated, no git submitted)

### 14.1 `results.tsv` (Agent Visible)

```
commit	recipe_id	parent_recipe_id	recipe_hash	stage	seed	val_avg_mse	val_h96_mse	val_h720_mse	params_M	status	failure_tags	description
a1b2c3d	none_none_linear_temporal_linear_mse_v1	NA	sha256:aaa	full	42	0.437600	0.391200	0.481900	2.14	keep	[]	baseline: NLinear CI + early_stop p=7
b2c3d4e	none_patch_mlp_temporal_linear_mse_v1	none_none_linear_temporal_linear_mse_v1	sha256:bbb	full	42	0.421300	0.378400	0.463200	2.14	keep	[]	patch CI: patch=16 stride=8
c3d4e5f	none_token_transformer_feature_linear_mse_v1	none_patch_mlp_temporal_linear_mse_v1	sha256:ccc	full	42	0.443100	0.401200	0.485000	8.30	discard	[]	4-layer Transformer CD: worse+8x params
d4e5f6g	none_token_transformer_feature_linear_mse_v2	none_patch_mlp_temporal_linear_mse_v1	sha256:ddd	full	42	NA	NA	NA	NA	crash	["oom"]	OOM with full-attn bs=256
```

Column description:
- `recipe_id` / `parent_recipe_id` / `recipe_hash`: track recide spectrum and recoverable configuration
- `stage`:`smoke` / `low_fidelity` / `full` / `multi_seed`
- `seed`: Current Experiment Random Feed
- `val_avg_mse`:**primary metric**, sole basis for decision-making (val collection, scaled space)
- `val_h96_mse` / `val_h720_mse`: short-term and long-term horizon representation to allow observation of bias
- `params_M`: Total number of parameters for all horizon models (millions)
- `status`:`keep` / `discard` / `crash`
- `failure_tags`: Structure failed tags such as `oom`, `nan`, `timeout`, `shape_mismatch`
- When `status=crash`, the value column should write `NA` and filter before any sorting, aggregation, comparison

### 14.2 `promotion.tsv` (privileged log, only Runner/Human Gate visible)

```
commit	ref_test_avg_mse	ref_test_h96_mse	ref_test_h720_mse	latency_ms	promotion_note
b2c3d4e	0.439500	0.383200	0.489700	2.8	first promotion check passed
```

- `promotion.tsv` does not enter the Agent context and does not act as input for the next scenario
- Agent can only see `results.tsv`
- `promotion.tsv` is just a logical example; Physically should be stored in an Agent unmounted private directory, object storage or Metrics DB, not an Agent workspace

> **Sanity check:** Compare baseline (NLinear CI, INPUT_LEN=512) `ref_test_h96_mse` with the TSL paper's NLinear result on ETTh1 H=96 (approximately 0.386). Differences in `INPUT_LEN=512`, evaluating multiple horizon together, time budgets, and early stopping mean this checks only obvious split/normalization errors, rather than strict leaderboard alignment. Enable a separate TSL-compatible baseline mode for exact alignment.

---

## 15. Time-series forecasting exclusive capability

### 15.1 multi-task type support

| Task Type | Description |
|---------|------|
| univariate forecasting | Single variable, standard M4/M5 scene |
| multivariate forecasting | Multivariate Combined Forecast, ETT/Weather/Traffic |
| exogenous forecasting | Contains known future accompaniment variables (e.g. calendar features) |
| point forecasting | Point Forecast, MSE/MAE Assessment |
| probabilistic forecasting | Distribution projection, CRPS/Pinball assessment |

> ProbTS has made it clear that different horizon and point/distributional settings significantly change the model preference, and systems cannot be designed to focus solely on a single long-term point forecast.

### 15.2 Job fingerprinting

It is recommended that each task be automatically drawn:

- seasonality period
- autocorrelation signature
- Intermittentity
- trend strength
- change points
- missing ratio
- covariate availability
- target scale stability
- horizon/context ratio

### 15.3 multi-dimensional error diagnosis

Analyst Agent, in addition to looking at aggregate metric:

- Each horizon error (whether or not)
- Bucket error by series (whether or not to concentrate in a class)
- Peak segment error (whether or not to perform during high-volatility periods)
- Holidays/unusual day errors
- Training for instability (multiepoch variance)

---

## 16. Human Convergence Mechanism (Human Control Layer)

The system is not a substitute for researchers. It's a way to free people from the "replicate debugging".

### 16.1 is responsible.

- Define Tasks (TaskSpec)
- Freezing data protocols and assessment agreements
- Authorize search space extensions (from L1 to L2/L3)
- Set the research target and iterative direction (formulate/modify `program.md`)
- Audit final selection to decide whether or not to advance
- Occasionally rewrite `train.py` baseline, reset search starting point

### 16.2Agent.

- HF tests (suppression per round, code changes, running experiments, recording of results)
- Automatic attribution of success or failure
- Patch (delta-based, keep/discard loop)
- Failed Summary and Knowledge Deposition
- candidates and Recommendations

### 16.3 suggests keeping artificial gates

| The gate. | Trigger Time |
|-----|---------|
| New Task Set | When New TaskSpec |
| Searchspace Extension | When L1L L2/L3 |
| Shadow Holding Query | Every N past keepep |
| Blind Test promotion | Final Champion Candidates |
| Merge Codes to Main | End of full experimental cycle |

### 16.4 Audit and Rollback

**Audit log**: Each candidate is recorded: who proposed, changed what, which version was changed, which experiments ran away, why promotions/rejections, whether manual approvals were triggered.

**Rollback mechanism**: any campaign must support:
- Scroll back to the parent version
- One-key rerun confirmed.
- One Key Export Patch Diff

---

## 17. Key design comparisons

### Difference between 17.1 and autoresearch

| Dimensions | autoresearch(LLM pretraining) | neo-research TSF |
|------|--------------------------------|-----------------|
| Task Type | Language model pre-training | Time series multistep projections |
| Data size | Billions of dollars. | Tens of thousands of time series samples. |
| Training time budget | 300s (5 minutes) | 600s (10 minutes) |
| primary metric | val_bpb (lower, better) | val_avg_mse (lower, scaled space) |
| Assessment dimensions | Single-language modelling indicators | Multiple horizon (96/192/336/720 average) |
| Model Type | GPT-style decoder | Any structure (Linear/Attn/TCN/SSM etc.) |
| Additional constraints | VRAM Soft Limit | Parameter weight soft bounds + VRAM soft bounds |
| Channel Design | Not applicable | CI vs CD is core freedom |
| loss Design | Fixed cross-entropy | Chase 0 can be freely assembled in a single document; Phase 2+ bound by lossgrammar |
| early stopping | None (fixed time button) | Time buildt + val early starting |
| Baseline | nanochat GPT | TSL NLinear (validable with paper numbers) |

### 17.2 docking instructions with Times-Series-Library

`prepare_tsf.py` of neo-research TSF uses the TSL realization logic directly in the data layer** to ensure that:

- **The cut-off borders are fully consistent:** the train/val/test boundary of ETTH1 is identical to the `border1s`/`border2s` hard-coding value in `Dataset_ETT_hour` and has the prerequisite for alignment with the TSL release **reference alignment**.
- **StandardScaler behaviour is consistent:** fit on track only, and re-use the same group of `reference test` statistics on `train/val` visible in Agent with Runner ' s private `reference test`; The assessment is consistent with TSL 's `exp_long_term_forecasting.py` default behaviour (`args.inverse=False`) at scaled space (not inverse transport).
- **Data Access Compatibility:** Default presets local CSV (`~/.cache/neo_research_tsf/dataset/ETT-small/ETTh1.csv`) by Human/Runner; Automatic downloads should be completed at the prestage/setup step outside the Agent container, instead of being obtained by Phase 0 Agent in the Experimental Ring Intranet.

**Simplification difference with TSL (intentionally):**
- Remove `label_len` (decoder tracker input) so that angent writes a simpler encoder-only model
- Remove `seq_x_mark`/`seq_y_mark` (time stamp feature); If follow-up is required, the freeze interface should be upgraded instead of requesting `train.py` to restore itself
- Remove `args` global configuration object to top level constant, angent cannot bypass fixed settings by changing args

> **According to calibre: **neo-research TSF and TSL are consistent in data splitting and standardization, but have been simplified in experimental agreements such as `INPUT_LEN=512`, multihorizon round of assessments, time-budget binding. So the figure here is **Reference-comparable**, not strict leaderboard apples-to-apples. If you want to make a strict comparison at the dissertation level, you should rerun TSL baseline under the same window / horizon / Buildt setting.

---

## 18. Implementation of the road map and milestones

### Milestone 0: Base base (2 ~3 week)

**Target:** Best to verify whether "Agent is really able to form an effective closed ring"

Delivery:
- [x] Achieve `prepare_tsf.py` (ETTh1/ TSL split border / StandardScaler / make_dataloader / evaluate_val_tsf)
- [x] Achieved `train.py` baseline (NLinear CI+ early starting)
- [x] Make `program.md` first edition (setup + experimental cycle protocol)
- [ ] **Sanity check:** A human or runner queries `ref_test_h96_mse` once to check for obvious deviation from TSL NLinear ETTh1 H=96. Exact alignment requires a separate TSL-compatible baseline mode.
- [x] Validation angent to read program.md and complete the first autonomous experiment (enable by keeping or discard, authenticating closed loop to run)
- [x] TaskSpec/ EvalSpec/ BudgetSpec data structure definition completed
- [x] Phase 0b: CandidateRecipe v1 schema definition completed, overwrite `none + linear + temporal + linear head` baseline first
- [x] Capable of recording baseline results, initial output

### Milestone 1: Recipe restricted study closed loop (3 ~4 week)

**Target:** Candidates are upgraded from "model family + parameter" to "modular action combination", starting with controllable small model structure autonomous design capability

Delivery:
- [x] Introduction of an action registry: creating / embedding / backbone / fusion / head / trainer (NeoResearch domain registry + Neo-Cast Python action categories)
- [x] Fulfill `build_model(candidate_recipe)` by recapitulating PyTorch models (`neo_cast/py/factory/build_model.py`)
- [x] Supports CandidateRecipe DSL configuration changes (L1/L2 code change mode)
- [x] Proposal Engine v1 + recipe config search
- [x] Static Validator
- [x] Dataset programr v1: Variables, horizon/context, Trend, security, Shift, Cross-var coordination
- [x] Rule-based reprieve v1, sorted with TaskFingerprint
- [x] Low-field + Full water stream
- [x] Support multi-data switching (Neo-Cast `prepare_tsf.py --dataset-preset` has access to `ettm1` fixed TSL minute split, and `weather`/`traffic` TSL Custom 70/10/20 split; Keep the visible row Range custom entry)
- [x] Improvement of the experimental record (auto-generated spectroscopy tree); Report export written to Candidate Lineage root/edge and metadata)
- [x] Automatically generate candidate, automatically filter and promote, and output challenger/champion comparison reports (currently heuristic/frontier+memory/ranker+report)

### Milestone 2: TimeRecipe style modular search (4 ~6 week)

**Target:** Expand the Neo-Cast autonomous exploration of space to allow systems to search on modular-level combinations instead of switching between a few complete models

Delivery:
- [x] Registry Composition Search(L2)
- [x] ModelSpec / PatchBundle / Lineage complete (Neo-Cast export description set `model_spec.json` and `patch_bundle.json`; NeoResearch report written to Candidate Lineage root/edge and metadata)
- [x] Accessing `instance_norm`, `series_decomposition`, `seasonal_differencing`, `missing_mask`, `sample_reweighting`
- [x] Embedding access to `none`, `patch`, `multiscale_patch`, `invert`, `frequency`, `calendar`
- [x] Backbone access to `linear`, `mlp`, `rnn`, `dlinear`, `tcn`, `nbeats`, `timesnet`, `ssm`, `mixer`, `transformer`
- [x] Fusion access to `temporal`, `feature`, `temporal_then_feature`, `feature_then_temporal`, `graph`, `gated_hybrid`
- [x] predation head access `linear`, `quantile`, `gaussian`, `residual_correction`
- [x] Loss grammar DSL(BaseLoss + HorizonLoss + Regularization + Calibration)
- [x] Support horizon policy
- [x] Add a distillation objective: executable teacher-policy distillation mixes supervised loss with `last_value` / `moving_average` teachers. A foundation-model teacher may be added later through a teacher-provider extension.
- [x] Enables small model structural innovation at the level of action registry, creates recipe spectrum trees (current spectra based on parentCandidateID + report lineage and adds PatchBundle/ ModelSpec to artifact)

### Milestone 3: multiseed + Champion/Challenger + research memory (4 week)

**Target:** Upgrade from a "single test system" to a "research system that can be statistically validated"

Delivery:
- [x] Aggregate multiple-seed runs and support automatic seed sweeps: mean/std/ci95/best/worst across runs of one candidate. `seed-sweep` uses task evaluation seeds and records `resourceUsage.seed`.
- [x] Realization of Pareto Front maintenance (export analysis + Dashboard/Cockpit metadata summary)
- [x] Achieve Shadow Holdout Approval Gate (`governance.requireShadowHoldout` / `requireBlindHoldout` must approve `shadow_holdout` before `ref_test` starts)
- [x] Fulfill base reference/shadow/blind query restricted stream gate (`governance.refTestQueryLimit` / `referenceTestQueryLimit` / `blindTestQueryLimit`, post-budget application)
- [x] Achievement of Utility ratings (comprehensive accuracy/parameters/delayedness/multi-seed variance/code complexity); Currently used for reporting sorting and auditing, not directly overcrowding promotion)
- [x] Memory Service v1 + similar mission recall
- [x] Can sort CandidateRecipe based on historical experience

### Milestone 4: Multi-task membrane memory (3 ~4 week)

**Target:** Upgrade from "automated test machines" to "research systems with accumulated experience."

Delivery:
- [x] achieve task fingerprint automatic extraction
- [x] Achieve a similar task search
- [x] Achieving cross-mission experience migration
- [x] Achieving cross-mission heuristics libraries
- [x] accumulation of benchmark records, training lightweight rank predictors as training-free recommender (currently no new dependence-weight longer); LightGBM Replaceable)

### Milestone 5: Governance and Blindness (3 - 4 Week)

**Target:** The research process is officially controlled and credible at the scientific level

Delivery:
- [ ] The realization of external blind test services (private labelling segregation, independent sidecar, formal query restrictions and auditing); NeoResearch `blind_test` status, approval date, query-limit Gate, CLI/Web/TUI access, API status expression, Neo-Cast Runner HTTP deployment template and `py/blind_test_sidecar.py` deployable service templates are currently completed; Not yet connected to real private blind data and long run deployment)
- [x] Achieve basic research audit log + approval stream (candidate/ref_test/shadow_holdout/budget/protocol/domain_action)
- [x] Supports the probability prediction task type (NeoResearch `TSFTaskSpec.forecastMode=probabilistic` optional `val_avg_pinball`/`val_avg_crps_approx`); Neo-Cast Runner for quantile head output pinball, CRS approximation, central interval coverage/width and displayed in the report report)
- [x] Automatic generation of complete studies (task/candidate/run/champion/memory + multi-seed/Pareto/Utility analysis)

### Milestone 6 (P2 Extension)

- [ ] Template Patch (L3 code change mode)
- [x] Distillation mode complete support (recipe scheme / action registry / NeoResearch runner payload / Neo-Cast track loss supported `loss.base=distillation`, `supervised_weight`, `teacher_weight`, teacher policy)
- [ ] Multi-mission migration

### Recommended division of research and development

| Orientation | Responsible modules |
|------|---------|
| **Algorithmic orientation** | action registry,baseline recipes,loss registry,promotion rules,error analysis |
| **Platform orientation** | experiment runner,sandbox,scheduler,artifact store,metrics db |
| **Agent Direction** | recipe proposal,patch generation,memory retrieval,analysis summarization |
| **Direction of governance** | permissions,blind test,audit,approval workflow |

### Recommended MVP technology route

Step 1: Make a ** single task, `train.py` single file, Phase 0a closed loop that can keep/discard**.
Step 2: Freeze **CandidateRecipe v1 + baseline recipe**, return the valid experiment of Phase 0a to recipe records.
Step 3: Upgrade the model structure search to **action registry control**, prioritizing TimeRecipe coverage / embedding / backbone / membership / head.
Step four: Introduction of loss search, dataset profiler, recipe Prior and memory migration.

That would minimize the problem of getting into "Agent, smart but completely uncontrollable" at the start of the project.

---

## 19. Indicators of success

### 19.1 Research Effects

- Average val_avg_mse increase relative to baseline
- Pareto improvements on how many data sets
- Top-1 / top-3 CandidateRecipe hit rate (are candidates really keeping)

### 19.2 Research Efficiency

- Number of test wheels required for each effective improvement
- GPU hours per effective improvement
- Conversion rate of candidates for promotion (recall rate for low-prevalence screening)

### 19.3 Project Reliability

- Experimental pass rate
- Training failure rate (crash + OOM percentage)
- Patch Rollback Rate
- blind test number of leaks

### 19.4 Knowledge Accumulation

- Number of reusable heuristics (e. g. "More Seasonal Data Patch Effective")
- A similar mission migration success rate
- Failure mode coverage (know if the trap is captured by memory system)

---

## 20. Summary of Design Philosophy

The technical nature of neo-research TSF is not "to make a big model that can write time series codes", but:

**Advanced an automated system for the implementation of a small, sustainable iterative model under strict agreement.**

Its core competitiveness comes from four things:

1. **Controlled search space** — `train.py` can change architecture, loss, and optimizer, but this remains local search within one file. Introduce a DSL/registry in stages, then progressively permit patch-level innovation to expand capabilities from a reliable base.

2. **Repeatable experimental closed loop** - `val_avg_mse` (val collection scaled space multiple horizon average) is the only basis for keep/discard. Most horizon avoids, on average, anent specializing in the optimization of short-term and long-term sacrifice (or vice versa). Failure is reversible: Discard, the `HEAD` of the experimental branch should actually go back to `last_keep_commit` and record skipping.

3. **Multi-Target Champion mechanism** - Systems naturally evolve in a "small but steady" direction. Precision is not the only target: `accuracy + params + latency + robustness + reproducibility`. Evaluation costs are low enough: one experiment per 10 minute, one night running ~50. This is the economic basis of the system.

4. **Cross-mission research memory** — Every failure, every success, is deposited into the next wave of a priori knowledge. When experience is accumulated enough, the system provides more insight than a single algorithm engineer into what sort of time-series tasks and what structure/targets are more effective. It's the biggest difference with normal AutoML.

**The role of human beings is not taken away, but from "the person who writes the model code" to "the person who defines the rules and constraints of research."** The most valuable human contribution is: design of `prepare_tsf.py` (fixed what), design of `program.md` (agent how); occasional rewriting of the baseline of `train.py` (replacement of search starting point); approval of promotions (crossing of borders).
