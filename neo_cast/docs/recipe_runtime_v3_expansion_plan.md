# ModelRecipe: Real Sequence Encoder, Search to Reweight and Controlled Changes

> Update: `direct_multi_horizon` forecast header removed; Only historical programmes are documented below. The current point forecast uses `linear`, and multiple horizon training is still supported.
> Date: 2026-09-23
> Status: Main functions implemented; Actual contracts, receiving and inspection boundaries and unrealized items are shown in [v3 Implementation Note] (recipe_runtime_v3_contract.md). The original design objectives are retained below and their description is not considered to be directly accepted or approved.
> Baseline: [v2 Run-time contract] (recipe_runtime_v2_contract.md) and [last round of amended records] (recipe_runtime_semantic_correction_plan.md).
> User confirmation: New `diagonal_ssm`, `timesblock_encoder`, `mamba`; No new original TimesNet; This round does not achieve cross-H share.

## 1. Objectives and scope

This round goes further from "configuration and implementation consistent" to "real model mechanisms, reliable identity searches, searchable model combinations". Keeps v2 repaired data segregation, missing mask, probability output, graph source and verification of artifact.

### 1.1 Inclusion

1. Configure standardization, known equivalent rules, re-examining tests prior to implementation and behavioral similar diagnosis.
2. A encoder/adapter/head interface with an axial syntax, as well as the configuration of the width of the space.
3. Real `diagonal_ssm`, TimesBlock encoder, Mamba-1 encoder.
4. Limited double branch, configured decomposition branch, historical timescale and predictive step.
5. Schema, registry, compiler, mutation, hinting, training, export and execution simultaneous.
6. Training validation for mechanism testing, reference alignment and replicability.

### 1.2 explicitly do not do

- The original TimesNet complete projection model and its thesis indicators are reproduced.
- Cross H shared encoder, joint training or shared checkpoint. It's still an independent set of models, optimizers and training status for each H.
- Mamba-2/3, pre-trained language model access, any depth DAG or any modular arrangement.
- Future/static coordinate variable recovery, original data cleansing process packaged and exported.
- Proof of mathematical equivalents for any two models with probe similarity.
- Rename existing `gated_depthwise_conv`, `timesnet_lite` as a new model.

2026-09-27 correction: `direct_multi_horizon` has been deleted as requested by the user and the old candidate does not move to other head. The previous description of it was no longer currently available.

## 2. Current baseline achievement and location to be changed

| Status | Current round |
| --- | --- |
| `model_recipe.v1` compiled to `recipe_schema_v2` | Introduction of visible new versions and migration without changing semantics silently under the old version |
| Encoder Unified Compression to `[B,C,min(T,64)]` | (a) Extending the expression with axial expressions; Pooling must be visible |
| `temporal/shared` and `feature_mlp` have declared equal prices | New search portals are consolidated, old input migration and source records maintained |
| Manifest has a summary of parameters, but no behaviour | Add standardized configuration identity, training on experimental identification and diagnosis probe |
| OpenCode has a text message based on candidate content | Retain the hints and add authority to enforce access for re-checking |
| fixed to `Linear(T,H)` | The new version supports two independent, restricted configurations of encoder/head |
| hybrid time date eventually aggregated to the last weight | Add a visible saving date for the time axis, without reinterpreting old fields |
| MultiH Modelling, Training and Exporting for H-Pile | (a) To remain unchanged; New interface does not automatically include shared parameters |

Main existing entrances: `py/model_recipe.py`, `py/factory/build_model.py`, `py/registry/action_specs.py`, `py/search/mutate.py`, `py/execution_contract.py`, `py/train.py`, `py/export.py`, `src/candidate-utils.js` and TSF domain, proposal and research service for OpenCode.

## 3. Search for identity and weight

### 3.1 Separate logs for three identities

| Identity | Contents | Purpose |
| --- | --- | --- |
| `architecture_id` | Normalize effective model configuration, algorithmic versions, axes/connections/sharing relationships, adapter, input output specifications | To judge whether the same structure is in place; Do not include name, description, candidate ID, random feed |
| `experiment_id` | Structure identity, data and column sequence summary, fold/split, filling/scaling protocol,loss, optimizer, dispatch, budget, feed, H, backend after precision resolution | To determine whether the same training experiment was conducted and whether the results could be reused. |
| `behavior_probe` | Fixed probe protocol, initialization/weight identification, output and input gradient summary, comparative distance | Suspected invalid fields and similar candidates found; Can't stand alone as a basis for skipping. |

Model identity must be visible when input Shape changes T, C, target column and H. External resources such as graph cannot only record the path, but also a summary of content and column order.

Do not confuse architecture identity with experiment identity: executions with different seeds, losses, learning rates, or training budgets must remain distinct and allowed.

### 3.2 Configuration Normalization Rules

- (a) Validate first and then complete the stated default values; Unknown, illegal and non-applicable fields report errors and do not hide mistakes by deleting them.
- Deletes the name, description and profile used only for display purposes and calculates identity so that the original proposal remains complete.
- Sort objects only; Cannot sort a sequenced array such as preprocessing, branching, channel etc.
- Move verified `temporal/channel_mode=shared` to `feature_mlp` and retain the version of the migration rule; The new generator only produces the latter.
- No-op is assigned to the standard default for training, e.g. uniform reporting; No unauthorized exchange of algorithm sequences or folding of training modules.
- (a) Python is the authoritative achievement of normative results; Node/OpenCode calls Bridge to acquire identity, avoiding inconsistencies in the achievement of independence at three ends. Use cross-golden fixtures for acceptance.
- Parameters Shape, summary of the module list is evidence only and is not sufficient to determine an equivalent value for execution. Equivalence skips must come from normative or tested white list rules.

### 3.3 Execute Entry and Restore

Inspections are performed at the LLM protocol, customisation and uniform portal for manual submission of transfer training, which cannot be done by mere reminder.

1. Verify and compile configurations to generate structured identities.
2. The data, budget, backend and running protocols are analyzed to generate experimental identities.
3. Positioning of experimental identity atoms within the same research field to prevent and repeat training.
4. `completed` and re-use the results and record the source when it is complete and protocol matches; No new independent experiment is forged.
5. `running` does not start repeatedly; Defunct occupancy should be subject to lease/restoration rules.
6. `failed` is not permanently banned. Distinguishing configuration failed, environment failed, training failed, allowing the restoration of the environment to be retried and maintenance of attempt records.

The event is not counted as new performance evidence, nor does it directly add to plateau's failure count. Set a limited number of re-proposals and end the round with "no new candidates" after exhaustion, avoiding unlimited repetition.

### Boundary of 3.4 behavior probe

Use multiple sets of certainty input: constant, pulse, cycle, random, missing mask and single variable disturbances. Records probe version, dtype, Device, initialization method and tolerance differences.

- `eval` mode is used to duplicate forwards;`train` model tests have been developed for training mechanisms such as dropout.
- The output/gravity similarity only generates diagnostic alarms and does not automatically repeat the training scores.
- Fixed seed does not ensure that different modules are constructed in the same order of parameters; Only consistent values are required for the alignment test of a clearly removable map.
- The validity test specifies the structure, gradient, training behaviour or resource constraint evidence by field and cannot require all fields to change an eval output once.

## 4. Model interface: limited type, not any DAG

### 4.1 for Type

| Type | Shape | Semantic |
| --- | --- | --- |
| `channel_latent` | `[B,C,D]` | One vector per variable, compatible with existing head |
| `sequence_latent` | `[B,T,D]` | Variables are embedded into the sequence of character dimensions, and D cannot be considered a variable number |
| `channel_sequence` | `[B,C,T,D]` | Keep both variable axes and historical time axes |
| `forecast` | Point is `[B,H,C_target]` | Final projections;quantile/Gaussian uses an already visible output contract |

The module states the type of input/output, axle, width, whether to change the length of time, mixed variables, mask usage and resource constraints. Compiler validity of connection and re-validation of sape while running.

The new encoder default only handles the history window T and does not extend to T+H within the backbone; Eventually, the head has a forecast map. No primary TimesNet is available for this round, so there is no need to add a new raw projection portal to it.

### 4.2 First adapter and head path

- `channel_sequence -> channel_latent`: Visible `last` or `mean` history read out and then use the existing head.
- `sequence_latent -> channel_latent`: Visible pooling, which produces `C_target × D_head` elements with a trained projection; Do not use reshape to impersonate variable decoding.
- The above reading is carried out after the historical sequence has been integrated with the head of the security; The first version does not support any patch/unpatch combinations, and the length difference is rejected.
- Each head of the predicted step integration produces the same `[B,H,C_target]` first, then integrates; Unable to change history date to predict step.
- (a) `latent_dim` and daapter output width configuration, which is included in the parameters budget; Moves the `min(T,64)` behaviour of the used recipe.
- All new encoders must verify an effective path to the target. Joint embedding consumption mask differentiates between target, auxiliary variable and mask. Mask cannot be used as a projection target.

This round of new encoders first provides the `[B,T,D]` path for joint and the `[B,C,T,D]` path for channel-indexent; The latter can be reused as a shared time encoder. The layout and whether or not to share must be clearly stated. Uncompatible fusion/embedding group rejected before training.

## 5. Three new encoders

### 5.1 `diagonal_ssm`

Positioning: A real-real diagonal linear status space module, which does not declare complete S4/S4D and is not known as Mamba.

Minimal mechanisms:

- Consistency parameters `A = -exp(A_log)`, step long `delta` to ensure that each fixed parameter state is converted into a form of contraction.
- The first version uses explicit ZOH dispersion: `A_bar = exp(delta*A)`, `B_bar = expm1(delta*A)/A * B` and stabilization calculations in small quantities.
- Resume `s_t = A_bar*s_(t-1) + B_bar*u_t`, output `y_t = C*s_t + D_skip*u_t` to match the input/output projection.
- (a) State dimension separated from channel dimensions;`state_dim` really changes the state grid and parameters.
- Fixed support for a discrete method count that is not yet available.

First active parameters: `d_model`, `state_dim`, `depth`, module `dropout`; Initialization and step-long borders are fixed and the version is recorded, not all of them initially added to the search.

PyTorch scan with reference to support for CPU and plain PyTorch data; Whether acceleration is a follow-up performance optimization may not be replaced by volume proxy. The stable transfer is not equal to absolute stability of the entire network and still requires a gradient tailoring and long sequence value test.

Acceptance: matching stepwise/full/chunked state recurrence; impulse responses; gradients for A/B/C and step size; real graph changes for different state_dim; finite long-sequence values; no state leakage between independent windows.

### 5.2 `timesblock_encoder`

Scope: retain the true TimesBlock core mechanism as a TimesNet-derived encoder, without the official forecasting path's T→T+H extension or use of the `timesnet` name.

Pipeline: select nonzero FFT frequencies → periodic 2D rearrangement → multiscale Inception 2D convolution → return to historical time → amplitude-weighted aggregation → residual and layer normalization. See [official TimesNet code](https://github.com/thuml/Time-Series-Library/blob/main/models/TimesNet.py).

Initial parameters: `d_model`, `d_ff`, `depth`, `top_k`, `num_kernels`, module `dropout`.

Key design decisions:

- By default, the selection cycle of a sample avoids changes in the prediction of one sample along with other samples; This is a clear difference from the official catch-cycle selection, and must be entered into the realization label.
- Do not use `batch_shared` as the first search switch; The alignment test is based on the official block-by-sample execution.
- Excludes DC; Static verification of `top_k <= floor(T/2)`, not silent cropping configuration while running.
- Constant/full-zero sequence use certainty non-zero frequency Tie-break; Short sequences, non-integration padding, multiple frequency maps need to be clear and recapable for the same cycle.
- The first version retains the aggregate items corresponding to the top-k frequency and does not automatically combine the same periodic change of weight syntax.
- To prohibit reading labels or complete data sets based only on input history request cycles; The FFT selected frequency index is not legible, but the selected range value and volume path should have a gradient.

Receiving and inspection: Synthetic cycle recovery, single-sampling output consistent with different battage components, 2D reshape/padding round trip, volume and band gradient, sample-by-sampling alignment of shared weights. Not a complete TimesNet indicator.

### 5.3 `mamba`

Positioning: Mamba-1 block encoder;variant fixed and recorded as `mamba1` without achieving a vague generic Mamba count.

Keeps the input projection, cause and effect conv, enter related delta/B/C, self-active scan, sskip, door control and output projection. Outer layer residual/norm stacking by visible fixation. Reference [Mamba-1 Official Block](https://github.com/state-spaces/mamba/blob/main/mamba_ssm/modules/mamba_simple.py) and [paper](https://arxiv.org/abs/2312.00752).

Initial parameters: `d_model`, `d_state`, `d_conv`, `expand`, `depth`, outer layer module `dropout`;`dt_rank` starts with a fixed rule to parse and record the active value, avoiding additional invalid search dimensions.

Back-end policy:

- `torch_reference` must be available to run in the CPU module test. Compatibility of official Mamba-1 calculations and initialization rules; The diagonal SSM input ZOH cannot be used directly to replace Mamba's scan.
- `cuda_optimized` is an optional backend, which only connects to a fixed upstream version and is validated with a weight removable, forward and gradient alignment.
- Visibility request does not use backend Times Capability error; Auto-selection only selects a validated backend with the same mathematical mechanism and fixes actual selection before training.
- Autoback to `gated_depthwise_conv` or `diagonal_ssm` is not allowed. The acceleration backend is not a new structure, and the environment and backend versions are experimental identities.
- The default test cannot require the installation of a CUDA extension; Not dependent on installation at the current programme stage. Individually maintain the optional dependency and doctor capability tests at the time of implementation.
- Retain delta initialization and special parameter precision, water-decay processing; Universal initializers shall not overwrite these restrictions.

Receiving and inspection: Pre-reference/gravity alignment, completeness in line with step/section (including volume caches and SSM state), parameter changes when entering changes, causality, status reset, short sequences and long series limited values. The accelerated acceptance mark was not validated without CUDA and cannot be declared completed.

## 6. Controlled model combinations

### 6.1 combined syntax boundary

The first of these allows only three top layers: `single`, `parallel_two_branch`, and `decomposition_two_branch`. Each branch is limited to an embedding encoder encoder adapter ahead path and does not allow branches to be nested again.

Two defaults do not share parameters; No new configuration for any branch parameters will be added during this cycle. The total number of parameters is measured by the actual unique parameter and consists of an adapter, agate, two head. Limiting the maximum number of layers, serial size and budget beyond pre-training reporting.

### 6.2 decomposition

- Moveting avertage gets the pend, residual = input-trend; Two can independently select the registered encoder/head.
- The first version is added to the projection space and limits the point output; It is prohibited to add directly a Gaussian variance or quantile to the undefined probability distribution.
- Permit validated combinations such as linear for the trend and SSM/TimesBlock/Mamba for the residual.
- Decomposition is used only for numerical history, regardless of missing markings; As a condition of independence, mask is sent to each branch.
- Integration is the responsibility of a unified outer layer, with only one reverse change in the final projection; Repeated reverse transformations are prohibited.
- Refuses to repeat decomposition with the module that contains the internal decomposition. The old wrapper moves to the equivalent trend-linear/residual path, and it cannot be assumed that all new branches are equal to the values of the old model.

### 6.3 Integration Semantics

- `latent_gate`: Two latents of the same axial syntax, integrated after declared width projection.
- `history_time_gate`: Two have the same history as T, producing a time-by-time weight; It is not permitted to pool before claiming time-scale integration.
- `forecast_step_gate`: Two have produced the same H and target column, with weights generated by historical signs and lead index; Could not use a real future label.
- The two weighted hybrids are unified to `g*z1 + (1-g)*z2`. If residual is available, the object must be clearly added and the vague Boolean field should not be used.
- The first version restricts prediction-space compositions to point outputs; latent/history fusion may feed an existing compatible probabilistic head.
- The old hybrid time gate retains its old identity or visible migration name and cannot be automatically interpreted as a new history/forecast date.

## 7. Schema, version and artifact

Use `model_recipe.v2` → `recipe_schema_v3`, with `runtime_semantics_revision=3`. These proposed version values must be implemented consistently across Python, Node, OpenCode, and export.

- (a) The new structure uses strict discriminated union, `additionalProperties: false`; Different encoder accepts only true application parameters.
- Only v3 is generated by a new version of the default; Provides a visible v1/v2 configuration migration, output migration report fixed values with old behavioral behaviour, and silent upgrading has saved the experiment.
- Do not automatically map old `ssm`/ `timesnet` names to new real modules; The old proxy migrates to the original light name according to the known version, while the unknown version rejects speculation.
- The old checkpoint does not rephrase the version; A new combination, a new encoder, is needed.already contains a v2 export package that is still used in its old environment without covering its code or weight.
- The new manual contains type connections, adapter, valid parameters, shared relationships, module realization versions, physical backends, structured identities and experimental identities; Keeps a summary of the parameter diagram with the graph data source.
- CV protocol incorporates a new semantic version, the old one is not mixed. Each H still preserves its weights and indicators independently, which can be organized in a bookle but not shared on behalf of it.
- Export to copy/package the necessary local modules and declare that you can rely on the backend. Reference backend self-inclusion inference should not accidentally expand the effect CUDA.
- External `history`, `missing_mask` and point/quantile/Gaussian output contracts do not change silently due to internal type expansion.

## 8. Execute Batch and Change Droppoints

| Batch | Delivery | Main landing points | Quit Conditions |
| --- | --- | --- | --- |
| P1 Reliable search identity | Normalization, identities, persistent deduplication, events, and recovery | New `py/recipe_identity.py`, bridge, candidate-utils, mutation, OpenCode proposal/service | Deduplicate defaults/aliases; do not merge distinct seeds/losses/budgets; pass concurrency/recovery tests |
| P2 Type and Version | New schema, expression type, adapter, configuration migration, climate | schemas,model_recipe,registry; New `py/factory/representations.py`, `adapters.py` | (a) Old semantic migration; Failure before illegal connection training; CPU Export to and from |
| P3 Real Encoder | diagonal SSM → TimesBlock → Mamba-1 | New `py/factory/encoders/`; Actory, registry, doctor, optional | (c) The respective mechanisms/gravity/reference alignment; Lack of capacity to explicitly reject |
| P4 Controlled Group | Double branch, decomposition, history/predict steps | New combination module, compiler, head, budget check, status | (b) Non-embracing, non-hidden sharing; Gate, mask, regularization and probability limit test passed. |
| P5 Integrated acceptance and inspection | Cross-end consistency, search cycle, training and export, validation reports | train/cv/export,execution_contract,prompts,examples,tests,docs | Each proven/unverified evidence is clear and the research cycle does not duplicate evidence |

P1 can be used before v2, P2 introduces v3 and expands the identity protocol and adds a standardized version. Each batch is synchronized with the relevant tests and not all of them are postponed to P5. Adds a logic module and does not continue to plug all realizations into `build_model.py`.

OpenCode-related schema/prompt/service files are subject to their children 's project AGENTS.md before implementation; The sub-project code will not be modified at this stage of the programme.

## 9. Validation matrix and acceptance standards

### 9.1 Automation Test

1. Schema/registry/compiler: Add new actions, illegal parameters, type connections, old configuration migration and three-end gold fixtures.
2. Mechanisms: State increment, TimesBlock cycle and 2D volume, Mamba action, Gate weight, branch gradient, field validity.
3. Data isolation: masks must reach targets; fit graphs, imputation, and scaling within each fold. New modules must not read validation or ref-test labels.
4. Heavy: name change cannot be bypassed;seed/loss is not the same structure. Failures may be repeated;(a) Be executed only once; Missing artifact is not reused; The budget is exhausted.
5. Training and export: point/quantile/Gaussian legitimate single branch path for three encoders, point two branches, preservation of load rounding, independence per H weight.
6. Resources: CPU back-end reference available; Visibility is not available for CUDA requests to report errors;adapter/branch/gate parameters are budgeted; There is no hidden downgrading.

Reuse existing test entrypoints and add dedicated identity, typed-composition, and encoder tests. Run `neo_cast`'s full `npm test` and Python unittest suite; run relevant OpenCode research tests and typecheck, and report the full research-suite results.

Before implementation, reconfirm the two previous research-suite failures: missing `quantitative.json` and the plateau 25/7 mismatch. If P1 changes plateau/counters, test the new semantics and investigate related failures rather than dismissing new regressions as preexisting.

### 9.2 numeric and experimental validation

- Upstream reference codes are fixed at the time of implementation and record licences/sources. The variable `main` cannot be used as a long-term duplicate.
- Start small FP32 forward/gradient comparisons with `atol=1e-5, rtol=1e-4`. Investigate failures rather than silently relaxing tolerances. Record separate tolerances and reasons for long sequences and mixed precision.
- Layer one: synthetic tasks and short CPU training verify finite losses/gradients; they do not establish better forecasting performance.
- Second level: continuation of ETTh1 training zone, holdout, at least three seed; Fixed input windows, sampling, optimizers and updated budgets, reporting on the amount of parameters, time-consuming and memory.
- Compare linear, two existing lightweight modules and three new encoders; The same number of updates does not equal the same calculus, and reports should not be confused.
- For P4 at least verify the break-up combination of linear+SSM, linear+TimesBlock, linear+Mamba and timegate collapse; The non-upgrading of effects does not automatically count as a failure, but the mechanism must be amended to be ineffective.
- If the hardware is unable to complete Mamba acceleration alignment, only the receiving and inspection reference end will be allowed to explicitly retain the accelerated unverified status. No large pre-training weight download, no ref-test, no automatic promotion.

## 10. Complete definition and risk

Completion requirements: P1-P5 applicable exit conditions are fully met; The three names correspond to the real mechanism; The same experiment can be reliably weighed; Different effective mechanisms and independent repetition of experiments will not be missed; Model combinations can be checked for type, data, output distribution and budget; Training/export consistency; New and old versions and each H independence are clear.

Main risks and constraints:

- Mamba Reference Scan Slower: Limiting default search budgets and performance as an alternative to the authenticity of mechanisms.
- The TimesBlock sample selection frequency differs from the official watch selection frequency: it is open, aligned by sample and does not claim to be re-emerging.
- `[B,C,T,D]` memory growth: pre-assess size and limit search; no automatic pool change model.
- (a) Double branch search space expansion: there are only two branches, one layer combined and limited integration points; Adds a new configuration with an validity test before entering the generator.
- There was a greater risk of error than omission: weighting the white list only at the same price and retaining diagnostics for behavioral resemblance.

Cross-H shared and original TimesNet are not part of the completion criteria, nor are they prefilled for unrealised configurations.

## 11. Design reference

- [Diagonal SSM Parametric and Initialization Paper](https://arxiv.org/abs/2206.11893): Provide background; The actual SSM of this program does not declare complete S4D recurrence.
- [TimesNet official realization](https://github.com/thuml/Time-Series-Library/blob/main/models/TimesNet.py): TimesBlock mechanism source; The programme explicitly changes the life cycle by selecting batches and omits original projection extensions.
- [Mamba dissertation](https://arxiv.org/abs/2312.00752) and [Mamba-1 block](https://github.com/state-spaces/mamba/blob/main/mamba_ssm/modules/mamba_simple.py): for fixing variant, self-contained scan and reference alignment borders.
