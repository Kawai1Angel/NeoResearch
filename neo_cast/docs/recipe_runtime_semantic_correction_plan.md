# Recipe Runtime Four Batch Amendments to Semantic Consistency

> 2026-09-27 Update: User has requested to delete `direct_multi_horizon`. This action has been removed from the current scheme, registration form, plant and search entry, and its restoration/redefinition description in the old program is no longer applicable.

> Status: the remaining options have been achieved; Batch IV selects the formal renaming of light modules, and incomplete paper models are achieved
> Scope of application: `neo_cast` upgrade from `recipe_schema_v1` to `recipe_schema_v2`, including recipe practice, training data stream, performance contract and semantic testing
> Objective: To ensure that each searchable action or parameter actually changes the model structure, forward computing, training objectives or operational constraints; The ability to deliver cannot continue silently.
> This programme does not include the realization of known future external variables. This capability is temporarily out of line pending redesign.

### Implementation Record (2026-09-23)

- B1-01 / B1-02: CLI, data contract, physicalization, training configuration, factory and export rejection of non-empty future/static configuration with fixed error code `UNSUPPORTED_COVARIATE`.(b) Keep old blank fields compatible;`used_known_future_covariates` is no longer generated.observed-past export inference does not need to provide empty future arrays.
- B1-04: for five categories of action scheme read strict `oneOf` differentiated by `type`; Error locating to JSON path of the selected branch. The results of the high-level ModelRecipe compilation and direct `resolve_recipe` calls were verified at a lower level.
- B1-05: Python registry, training entrance and NeoResearch domain unified head-distribution-loss combination of point/quantile/Gaussian; Quantile levels must be orderly, unique and consistent with the loss, and no point is allowed to predict a multi-digit broadcast.
- B1-06: seasonal mutation uses legitimate moving-overage decomposition; Before sending back by schema and registry, remove old action fields while switching to fusion, and sync embedding white.
- B1-07 (part): Adding illegal parameters, complete output matrix, gradient of quantile/Gaussian parameters, verification, rejection of future/static, input sensitivity and export input testing.

The remaining items have been completed for subsequent implementation:

- B1-03 / B1-07: delete invalid fields such as cross-horizon sharing, old feature switches, base_head, fill_policy, graph_type and global dropout; Python/NeoResearch strictly verify sync. Adds all backbone/embedding/preprocessing/fusion/head structures, input gradients, configuration variance tests and accelerator simultaneous testing.
- B2: Channel-by-channel stand-alone linear, module dropout, per-variable affine norm, visible last-value setting, ordered fusion four gate/residual combinations; Mask saves train/val/ref-test/export before materialization, overwrites train/val/ref-test/export and refills and contracts scaler in CVFold.
- B3: Freeze [v2 contract] (recipe_runtime_v2_contract.md), encoder output `[B,C,min(T,64)]`, five categories of genuine parameterization head exclusive final horizon projection;varate attention, double loaded hybrid, trend branch and train-only/static/learned graph are connected. Manifest contains actual parameter maps digest, head parameters, dropout, sharet, gate and exact source/digest.
- Compatibility: checkpoint/metadata with `runtime_semantics_revision=2`; Export checked versions and parameter maps, and the old model is subject to retrainment. CV protocol incorporates semantic versions to avoid mixing old or new synonyms.
- B4: Use the scheme B:SSM proxy to officially change name `gated_depthwise_conv`, and TimesNet to change light path `timesnet_lite` and mark `paper_derived`. Completed [ETTh1 with budget Sanity Comparison] (recipe_runtime_v2_sanity.md). Full SSM, complete TimesNet, cross-configuration horizon sharing is an optional follow-up to the original scheme and this time it is not claimed.
- Validation: `npm test` passed (71 Node tests and the Python wrapper), all 180 Python tests passed, and 78 relevant NeoResearch tests plus typecheck passed. New tests cover independent export round trips, old-checkpoint rejection, fold-specific graph/imputation isolation, and train/val/ref-test paths using materialized missing masks.
- Expanded inspection: `bun test test/research` failed as 326 passed, 2 failed. Two fixes that do not belong to this recipe/runtime: `hypothesis-evidence-tools.test.ts` fixture does not create `quantitative.json`; The `service.test.ts` plateau test expects the 25 wheel, while currently returns the 7 round. The behaviour of these functions has not been modified to accommodate the old assertion.

The following sections retain the original problem analysis, candidate options and acceptance requirements; The final selection is based on the v2 contract and the above performance record.`temporal/shared` is retained and expressly stated in relation to the computational equivalence of `feature_mlp`, prohibiting its attribution as an independent mechanism.

## 1. Background

The current system has completed a round of high-level `model_recipe.v1` alignment repairs, addressing issues such as attention, Gaussian, invert, multiscale catch, DLinear duplicate breakdown, calendar, budget transfer.

`recipe_schema_v1` and recipe runtime:

- Some action names differ, but run-time structures and outputs are identical;
- schema accepted parameters that had never been read;
- Backbone has exported the final horizon, predivide head without a real output projection;
- Some modules are actually calculated but less semantic than the name is claimed;
- Data preparation eliminates information required by certain mechanisms in advance, such as missing locations;
- The tests focus on schema, shape and "enforceability", and there is no validation mechanism for real effectiveness.

These problems can contaminate the automatic research cycle: Agent may treat invalid parameter changes as new models, use candidates for the same calculus as independent evidence and create faulty attributions at the Reflection stage.

## 2. Locked for decision

### 2.1 temporary exit future external variable

Not currently realized. The principle of treatment is "unequivocal rejection" rather than continuing to emptied or record false use.

The surface capacity for temporary exits includes:

- `known_future_covariates`;
- `known_future_source`;
- `known_future_available`;
- `future_covariate_mode`;
- `num_future_covariate_channels`;
- `used_known_future_covariates` and other metadata suggesting that models already consume future variables;
- Legacy covariate wrappers not integrated with the current runtime.

Compatibility strategy:

- There is already a dataset artifact that can continue to be read, but as long as the above fields are not empty, give clear unsupported errors before training;
- Automatically changing non-empty input to an empty list is not allowed;
- CLI, Agent Prompt, README and schema shall remain of the same calibre;
- Use a new visible version or Capability tag for future re-entry, and do not repeat the current act of " Existing but Invalid " .

### 2.2 Restoration Priority Principle

1. First make sure the experiment is honest, then expand the space.
2. A configuration field must meet one of the following conditions:
   - Change parameter maps;
   - Change forward calculation;
   - Change loss or training scheduling;
   - Change operational constraints that are clearly measurable.
3. Fields that do not meet the above conditions must be deleted, rejected or marked and cannot be used only for log tags.
4. A name may promise less than the implementation provides, but must never promise more.
5. For each action to be restored, both schema, prompt, practice, contract execution, export and semantic testing must be restored.

## 3. Summary of scope of amendments

| Problem | Current Status | Target batch | Target handling |
|---|---|---:|---|
| Future external variables | Input emptied or ignored | 1 | Offline for the time being and explicitly refused. |
| Static Accompaniment Variable | Do not enter the model after declaration | 1 | Offline temporarily, awaiting multi-series/entity contract |
| Invalid action argument | schema accepts but practice does not read | 1 | Delete or Reject |
| Quantile Group Matrix | Quite a loss. | 1 | Strictly group verification |
| Invalid status | Generate decomposition that does not match schema | 1 | Modify Templates |
| Missing semantic tests | Only shapes/class names checked | 1 | Add structural, sensitivity, and gradient tests |
| `linear.shared` | true/false Same | 2 | Achieving two paths of sharing and corridor-by-channel |
| Dropout dual source | Invalid `regularization.dropout` | 2 | Create single priority or delete duplicate fields |
| missing mask | Data Layer First Elimination NaN | 2 | Keep original mask and upload the model |
| late-value setting | All non invert backbone default enabled | 2 | Replace with visible action |
| affine instance norm | Only global cursor parameters | 2 | Change to Variable-by-Variance Parameter |
| Ordered Fusion Switches | Invalid `gate/residual` | 2 | Realize Switch Semantics |
| backbone/head Boundary | Backbone exported horizon | 3 | Create uniformity |
| linear/direct head | Both. Identity. | 3 | Redefine and achieve, or delete redundancy accompanies |
| feature fusion | With feature-then-temporal alias | 3 | Achieving a variable token path |
| gated hybrid | Original input with feature mixer door control | 3 | Fulfill temporal/feature Double Branch |
| graph source | Always. | 3 | Accessrain-only correlation/static topology |
| decomposition | Disable branch + constant trend | 3 | trend/residual Double Branch |
| SSM | Depthwise conv | 4 | Real realization of SSM, or official change of name |
| TimesNet | Lite version exposed with full name | 4 | Complete the dissertation core or formally change name |
| Shares across the predicted length | Each configuration horizon standalone model | 4 | Design a single multi-task horizon contract |

## 4. Batch one: make the results credible first.

### 4.1 Target

This batch does not seek to increase modelling capacity, but only ensures that:

- There are no known invalid variables in the search space;
- The ability not to support will be rejected before a candidate can enter the smoke;
- Two have been declared as different candidates, with verifiable differences at least in structural, computing or training objectives;
- The error message indicates the field and the direction of the fix.

### 4.2 Job

#### B1-01: Lower future external variable

Involving location:

- `py/schemas/dataset_schema.json`
- `py/dataset_contract.py`
- `py/prepare_tsf.py`
- `py/train.py`
- `py/export.py`
- `py/schemas/metadata_schema.json`
- `src/cli.js`
- `README.md`
- Description of data capabilities in Agent Prompt

Treatment:

1. Validator returns the fixed error code and readable description when it encounters a non-empty configuration;
2. Delete the act of "cleaning up after receiving";
3. The training summary is no longer included in the "Accomplished Future Variables";
4. CLI does not display parameters for the time being, or retains them but immediately reports unsuppleted;
5. Removes an example of the current README that implies that this capability is available;
6. Legacy checkpoint continues to categorically refuse and request retrainment if it contains the futurity covariate wrapper.

Receiving and Inspection:

- Non-empty configuration cannot enter the state;
- An empty configuration to keep the target and observed-past paths of dataset.v1/v2 is available;
- It is not misleading anymore.

#### B1-02: temporary offline static cosmopolitan variable

Currently runtime does not have a entity/batch level static feature contract, and static values in single-series tasks are usually constants. At this stage, the same visible rejection strategy as that used for futility cavariane is applied.

Acceptance and acceptance: Non-empty `static_covariates` failed before the data materialization, no longer having a "configured but non-batch" status.

#### B1-03: Acceleration invalid action field

In the first phase, a minimum set of implemented actuals will be retained.

It is suggested to temporarily remove or reject:

| Action | Fields/values temporarily removed | Retention capacity |
|---|---|---|
| `linear` head | `share_across_horizons` | Action itself is also suspending search until batch 3 |
| `direct_multi_horizon` | Total action | Waiting for batch 3 to be redefined |
| `feature` | `variate_token`,`cross_attention` | If retained, only explicitly named Channel MLP |
| `feature_then_temporal` | Duplicate action with `feature` | Only one for now. |
| ordered fusion | `gate`,`residual` | Use fixed behaviour before batch 2 is achieved |
| `graph` | `static`,`correlation`,`sparsity` | Only retain |
| `gated_hybrid` | `gate_type` Enumeration | Only keep the current Channel-like date and change its exact name |
| `residual_correction` | `base_head` | Keep only `correction_dim`, or fix it as backbone forecast |
| training regularization | `dropout` | Only `grad_clip` will be retained until the second batch determines the sole source |

Synchronize changes:

- `py/schemas/recipe_schema.json`
- `py/registry/action_specs.py`
- `src/llm.js`
- `src/reflect.js`
- NeoResearch TSF domain schema and ModelDesigner programt
- Example recipe and usage instructions

#### B1-04: use discriminated scheme

Replace preprocessing, embedding, Backbone, Fusion, Head with `oneOf` based on `type` as Discriminator

Example target:

```json
{
  "oneOf": [
    {
      "properties": {
        "type": {"const": "linear"},
        "shared": {"type": "boolean"},
        "bias": {"type": "boolean"}
      },
      "required": ["type", "shared", "bias"],
      "additionalProperties": false
    }
  ]
}
```

Receiving and Inspection:

- `linear` backbone with `top_k` must fail.
- `graph` fusion with `cross_attention` must fail.
- `linear` head carrying `quantiles` must fail.
- Cannot initialise Evolution's mail component.

#### B1-05: complete output distribution -head-loss matrix

Legitimate combination:

| Head | Output distribution | Loss |
|---|---|---|
| point head | `point` | `mse`,`mae`,`huber`,`distillation` |
| quantile head | `quantile` | `quantile` |
| Gaussian head | `gaussian` | `gaussian_nll` |

Additional rules:

- Quantile head must be consistent with the quantile loss level;
- Quantile levels must be strictly incremental and not duplicated;
- Not allowing point submission to impersonate multiple quants;
- Quantile median is not allowed to export the complete number;
- The Gaussian scale branch must have a non-zero gradient.

#### B1-06: Invalid repair

Modify seasonal bias status to valid configuration:

```json
{
  "type": "series_decomposition",
  "method": "moving_average",
  "kernel_size": 25
}
```

mutation output must go through both schema and registry validator before return, and cannot give invalid recipe to a subsequent candidate process.

#### B1-07: Add semantic tests

Add new test principles:

1. **Structural Difference Test**: Fields claiming a structural change must change the type of module, parameter name or number of parameters.
2. **Enter sensitivity test**: Disturbing an input when it is claimed to consume must change the output or corresponding gradient.
3. **Switch test**: expected differences must occur on both sides of the boolean value; Otherwise, the field must be rejected.
4. **Gradient test**: The new mechanism parameter must have a non-zero gradient at the match point.
5. **End-to-end tests:** cover materialize → loader → model → loss, rather than only isolated classes.
6. **Equivalent testing test**: Different action should not be allowed to generate identical state structure and output under seed unless the equivalence is stated in a prominent manner.

It is proposed to add:

- `py/tests/test_recipe_semantics.py`
- `py/tests/test_recipe_action_sensitivity.py`
- Action-space sync test on Node/NeoResearch

### 4.3 Batch 1 completion threshold

- Schema, registry, LLM programt and runtime action are fully consistent;
- There are no known unread fields;
- future/static covariate explicitly failed when it was not empty.
- Full coverage of the quantile/Gaussian matrix;
- Every candidate generated by the campaign can pass through the same set of validators;
- All action has at least one structural, sensitivity or gradient test;
- The performance contract no longer considers the two Identity subcategories as sufficient semantic proof.

## 5. Batch II: Real semantics with lower repair costs

### 5.1 Target

Restores the actual role of an existing field, corrects hidden global behaviour and allows data streams to retain the information required for action.

### 5.2 Job

#### B2-01: achieve `backbone.linear.shared`

Definitions:

- `shared=true`: All variables share one `Linear(input_len, horizon)`;
- `shared=false`: Each variable has an independent `Linear(input_len, horizon)`;
- `fusion.channel_mode` only describes cross-variate integration and no longer replaces backbone parameter sharing semantics.

Achieving attention to:

- The number of effective channels must be known at the time of construction;
- Dissing-mask additional channel cannot correspond to target/past channel weight error;
- strutted input and eventually only output tannels;
- Parameters are budgeted to reflect the growth of corridor-by-channel parameters.

Receiving and Inspection:

- true/false parameters vary;
- false different channel weight objects;
- The ross of any channel can only update the corresponding standalone layer;
- An example record of a real shared state.

#### B2-02: Unified dropout source

Suggested contracts:

- `training_strategy.regularization.dropout` is a global default;
- An action internal `dropout` is local override;
- The compiled resolved profile must write down the dropout for each module;
- Two fields are prohibited but their priority is not clear.

If global default is not required, delete regularization dropout and keep only the module level dropout. Only one option could be chosen.

Acceptance: `nn.Dropout.p` and training output in the model must change only when changing a valid dropout field.

#### B2-03: recreate missing-mask data stream

Target data contracts:

```text
raw values
  ├─ missing mask ───────────────────────┐
  └─ train-fitted imputation → values ──┼→ WindowDataset
                                        └→ MissingMaskAction
```

Requests:

- mask generated before any fill/drop;
- train/val/ref-test uses the same meaning;
- scaler uses only valid training values or explicitly after filling;
- `mask_channel=true` Add Real Mask;
- `fill_policy` and dataset-level missing system do not duplicate;
- Export reasoned support values entered with mask.

It is proposed that the "data cleansing strategy" and "model missing modelling strategy" be broken down into two different fields to avoid conflicts of responsibilities under the same name.

#### B2-04: visible last-value setting

All non-invert paths are currently hidden:

```text
series = x - x[:, -1:, :]
forecast = model(series) + x[:, -1:, :]
```

Amendments:

1. Add visible pre-empting action, such as `last_value_centering`;
2. `preprocessing=none` no longer performs case-level dynamical changes;
3. NLinear baseline recipe to add the action significantly;
4. By default, DLinear, TCN, TimesNet, N-BEATS no longer inherits NLINEAR bias;
5. Invert keeps its own per-variable mean/std record.

Compatible impact: All old checkpoints should be considered as old calculations and must not be loaded without hint to a new semantic model.

#### B2-05: variable by variable

Change the affine parameter to `[1,1,C]` and process the number of channels before and after mask additions. If the number of dynamic channels is allowed in the future, the input contract will be frozen using lazy integration or during model construction.

Accepted and accepted: Different variables can learn different scale/shift, reverse transformation correct.

#### B2-06: realization of open switch

Suggested syntax:

| Configure | Behaviour |
|---|---|
| `gate=false,residual=false` | Direct Thread Output |
| `gate=false,residual=true` | `x + branch(x)` |
| `gate=true,residual=false` | `g * branch(x)` |
| `gate=true,residual=true` | `g * branch(x) + (1-g) * x` |

Specify the gate shape and normalization position explicitly, and test both `temporal_then_feature` and `feature_then_temporal`.

### 5.3 Batch 2 completion threshold

- Each of the values taken from `linear.shared`, dropout, Gate and resaidual is tested for variance;
- (a) missing mask contains original missing information on real physical data;
- `preprocessing=none` no longer performs undeclared dynamic changes;
- NLinear baseline maintains the original behaviour through a visible action;
- Old artifact can recognize semantic versions and give a reminder;
- Full test, export inference and at least one end-to-end smoke pass.

## 6. Batch III: Rebuilding model combination boundary

### 6.1 Design Checkpoint

The following contracts must be frozen before commencement of the third instalment:

1. The unity of the backbone last;
2. Whether or not the channel-independent and variable-token paths use the same path;
3. Whether the predation head has only a horizon projection;
4. "horizon" means a single model lead step, or the projected length configuration in the mission;
5. A mathematical difference between linear and direct-multi-horizon;
6. Whether decompositing, Backbone wrapper or fusion graph;
7. whether to upgrade schema to a new version.

`recipe_schema_v2` is recommended to avoid changing the semantic of calculation under the same version.

### 6.2 Unified

Proposed underlying contracts:

```text
channel-independent latent: [B, C, D]
Temporal-token slot: [B, C, T, D] (optional)
variate-token latent:       [B, C, D]
point forecast:             [B, H, C]
quantile forecast:          [B, H, C, Q]
distribution forecast:      mean/scale [B, H, C]
```

Backbone provides `encode()` or equivalent interfaces; Predation head monopolizes final horizon output. Original sequence backbone, if natural output is given, can be clearly marked by `ForecastBackboneAdapter` rather than disguised as a late backup.

### 6.3 redefine head

#### Linear head

- Enter `[B,C,D]`;
- Output `[B,H,C]`;
- is the default forecast head.

#### Direct multi-horizon head

A truly different definition must first be chosen. Recommendations:

- Each lead step uses a separate small head/tower;
- The first tier could be shared, but the final output parameters were independent;
- `horizon_specific=true` indicates that each `t+k` has an independent force;
- Do not represent the sharing of multiple H models in the task configuration.

If `Linear(D,H)` is ultimately only, it is not sufficiently different from normal linear head and the action should be permanently deleted.

#### Quantile/Gaussian/Residual head

- Read directly theient instead of reading the dot prediction that has been generated by the backbone;
- Quantile head output Q values for each lead step;
- Gaussian head output means positive scale;
- Resaidual control holds case head and learns about evidence.

### 6.4 achieves true meaning

It is suggested that a distinction be made between:

- `feature_mlp`: Do ChannelMixer along variables;
- `variate_attention`: make self-attraction as a token variable;
- `temporal_then_feature`: first obtains each variable, then integrates the variables;
- `feature_then_temporal`: Combine variables at each point of time before modelling them.

Do not continue to use the broad `feature` name for multiple different mechanisms.

### 6.5 achieve real gadhbrid

Target structure:

```text
input
  ├─ temporal branch ─┐
  └─ feature branch ──┼─ gate(scalar/channel/time) → fused latent
```

Gate definition:

| `gate_type` | Recommendation Shape |
|---|---|
| `scalar` | `[B,1,1]` |
| `channel` | `[B,1,C]` or `[B,C,1]`, depending on the slot playout |
| `time` | `[B,T,1]` |
| `learned` | Static learning parameters, which must be clearly distinguished from input condition gate |

Each Gate type must produce a different parameter chart and have a gradient test.

### 6.6 Extension

- `learned`: Current dense employment, options for top-k sparsity;
- `correlation`: Calculated and sustained only using track split;
- `static`: read from visible topology artifact and verify node/channel order;
- All adjacency must enter an artifice contract and execute the contract;
- Ref-test data should not be included in the description graph.

### 6.7 Double Branchdecomposition

Objectives:

```text
x → moving average → trend ─────→ trend model ─────┐
 └───────────────→ residual ────→ residual model ──┼→ forecast
```

You need to decide whether or not the backbone type, hidden size and head should be shared. The first edition proposes a fixed lightweight, recipe backbone to control the size of the search space.

### 6.8 Batch 3 completion threshold

- (a) The completion of the `recipe_schema_v2` or equivalent versioning contract;
- BackboneLatent is the only one with a head export border;
- linear/direct/quantile/Gaussian/residual head has real parameters and gradients;
- There are no more structural aliases for feature, ordered feature, gad hybrid;
- The source of graph ajacency is traceable and no data leak;
- (a) The decomposition variable obtains a non-zero gradient;
- (a) Checking structure synonyms, not just class names;
- The old v1 artifact expressly refuses or loads it through a visible compatible adaptor.

## 7. Batch IV: Thesis level or large module

### 7.1 Target

Dealing with high-level backbone, which is clearly better than achieved, and assessing whether it would be worthwhile to bear long-term maintenance costs. Each module allows for two types of completion:

1. (a) Achieving a core calculation consistent with the name;
2. Keeps the current lightweight realization, but formally changes its name to Lite/Derived and no longer claims to be a complete model.

### 7.2 SSM

The current module is door control and does not contain visible state push or self-scanning.

Option A: Real SSM:

- Explicit choice of S4, DSS, Mamba-like selfdefined SSM or item definition state-space block;
- `state_dim` must correspond to the real state dimension;
- Support long sequence linear complexity;
- Increase in long dependence, complexity and state gradient tests.

Option B: Retain current realized and renamed:

- For action read `gated_depthwise_conv`;
- Synchronization of class names, documents, prompts, experimental reports;
- History SSM results are marked as legacy proxy and not used for attribution of SSM thesis.

Option B is recommended before programme A is developed independently.

### 7.3 TimesNet

The current `TimesNetLiteCore` has achieved the FFT cycle selection and 2D volume, not a placeholder module.

Option A: Complete more complete TimesNet core:

- prediction-length temporal extension;
- Multiscale/Multi-nucleus 2D block;
- (b) Weighted aggregations per layer cycle;
- Compared with the behaviour of those who have publicly achieved a number of values in terms of shape, parameters and small samples.

Scheme B: Publicly named `timesnet_lite`:

- (a) Retain the existing lightweight realization;
- It is prohibited to reproduce the results in the report as complete TimesNet;
- Bibliography is marked with `paper_derived`.

Short-term option B is recommended.

### 7.4 share across the predicted length

Only when it is clear that a model is needed to cover multiple configurations, Horizon.

Candidates:

- Train maximum horizon, shorter horizon direct slices;
- One shared encoder, multiple horizon-specific heads;
- Horizon token/embedding Conditionalize decoder.

Synchronize changes required:

- Training cycle and optimizer life cycle;
- early stopping;
- Budget statistics for parameters;
- checkpoint/state_dict format;
- execution contract;
- Export and inference API;
- CV attribution with horizon indicators.

Until completion of the contract, the system continued to maintain "one model for each configuration horizon" and prohibited fields implying cross-model sharing.

### 7.5 Batch 4 completion threshold

- The name of the advanced module is consistent with the true calculation map;
- The Lite/Derived module carries precise labels in recipe, artifact and reports;
- If cross-horizon sharing is achieved, the parameters budget and indicators are attributed to a new clear calibre;
- At least complete the same budget on standard data sets
- Bibliography names may not be declared by class name or prompt alone.

## 8. Document-level impact matrix

| Documentation/module | Batch | Main changes |
|---|---:|---|
| `py/schemas/recipe_schema.json` | 1–3 | Accumulation, disciminated union, v2 contracts |
| `py/schemas/dataset_schema.json` | 1–2 | Pause future/static; Completing missing mask data contracts |
| `py/registry/action_specs.py` | 1–3 | Action Capabilities, Required Fields, Group Validation |
| `py/model_recipe.py` | 1–3 | Compile results synchronized with lower level contracts |
| `py/factory/build_model.py` | 2–4 | Shared linear, visible normarization, latent/head, fusion, advanced backbone |
| `py/prepare_tsf.py` | 1–2 | future/static rejects, saves missing mark |
| `py/train.py` | 1–4 | loss matrix, dropout, model construction, multi-horizon option |
| `py/export.py` | 1–4 | Artiffact Compatibility, Mask, Head Output, New Schema Version |
| `py/execution_contract.py` | 1–4 | Upgrade from class to structure/capacity verification |
| `py/search/mutate.py` | 1 | Authentication after valid attachment and generation |
| `src/llm.js`,`src/reflect.js` | 1–4 | sync action space with runtime |
| NeoResearch TSF domain/agents | 1–4 | Synchronization of synonyms for proposal, transect and refile |
| `py/tests/`,`test/` | 1–4 | Structure, sensitivity, gradient, end-to-end test |

## 9. Test Policy

### 9.1 Minimum Test Contract per action

Each searchable action requires at least three of the following four types of tests:

- schema/registry legitimacy;
- Parameter maps or modular structures;
- Input/configuration sensitivity;
- Target loss down the gradient stream.

Data-related acaction must also be tested with materialize-to-model end to end.

### 9.2 suggests semantic assertion

```text
same seed + same config         → same initialization/output
same seed + structural change  → different state structure or parameter count
same seed + behavioral toggle  → controlled output difference
claimed input perturbed        → output or target gradient changes
disabled capability requested  → validation error, never silent fallback
```

### 9.3 Anti-Equivalent Candidate Examination

Add options for smoke verification:

- Module type sequences;
- Parameter name and sape;
- Key Capability logo;
- Fixed output summary under seed/probe input;
- Optional key input gradient summary.

It's not a substitute for formal testing, but it can prevent the obvious same action from being treated as an independent experiment.

## 10. Artifact and Compatibility Policy

### 10.1 Changes Need Retrenching

The following changes cannot be repeated:

- Last-value centering;
- shared/unshared linear repair;
- per-channel affine instance norm;
- Reconstructing of the backbone/head boundary;
- New structure of feature/gated/decomposition;
- SSM or TimesNet is complete.

### 10.2 version proposal

- `runtime_semantics_revision` may be added to batch I and batch II if only abbreviated/amended v1;
- The third batch should be upgraded to `recipe_schema_v2` as a matter of priority;
- Artificial writings of schema version, runtime security reviews and model best diagest;
- Export loader does not allow speculation on the semantics of an old model by field name only.

## 11. Risk and control

| Risk | Control measures |
|---|---|
| The search space is down. | Make sure every dimension is real and recover. |
| Old experiments are not directly comparable. | legacy/new semantics, requesting further training. |
| Large reorganisation changes multiple variables at the same time | Create independent baseline and semantic snapshots per batch |
| graph data leakage | Only trainFold combined into |
| conflict with scaler | Specify mask generation, imputation, scaler fit order |
| The Lite module was wrongly reproduced as a paper | Action, Classname and Report Unified Lite/Derived Label |
| Only authenticate labels | Add Parameter Maps, Capability and Probe Validation |

## 12. Recommended order of delivery

Each batch is submitted and validated separately without a major change in the four batches.

1. **Batch 1A: Downline and schema contraction**
2. **Batch 1B: Combining validation, mutation and semantic testing**
3. **Batch 2A:shared/dropout/instance norm**
4. **Batch 2B: missing Mask and manifesting**
5. **Batch 2C:ordered Fusion Switch**
6. **Batch 3A: Freezing v2 latent/head contract**
7. **Batch 3B: achieve delivery heads**
8. **Batch 3C: Realization of feature/gated/graph/decomposition**
9. **Batch 4A: Lite module accurately renamed**
10. **Batch 4B: Select the full SSM, TimesNet or cross-horizon share according to research priorities**

## 13. Finalization of definitions

This programme shall be completed in such a manner as to:

- Every field that Agent can propose has a proven role in runningtime;
- The ability not to support will clearly fail before the candidate is built;
- There is no longer an identical calculation chart that distinguishes between categories only;
- The terms `none`, `shared`, `gate` and `residual` are consistent with the actual act;
- Geometric consistency in probability output head, loss, assessment and export;
- Data action can obtain the required information in real data flows;
- Lite/Derived achieves the discontinuation of full paper model names;
- The performance contract, artifact and test can prove the above facts rather than record only configuration labels.
