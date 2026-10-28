# ModelRecipe Existing Field for Consistency Review

## Achieve updates (maintain fields and options)

A record of the review prior to its revision is maintained in the main text below. This round uses a completion mechanism, fixes data flows and restrains verification schemes without deleting the original ModelRecipe field or numbering values.

| Problem | Current Achieved |
|---|---|
| MR-001 | `none` does not use attention;`lightweight` uses a positive feature map of linear complexity attention;`full` uses softmax attention. Transformer is performed in the token backbone, with other skeletons using input time-deficient attention modules. |
| MR-002/004 | Gaussian outputs mean and positive standard deviation. `training.loss=gaussian_nll` supervises mean and variance. Schema/compiler checks enforce point/quantile/Gaussian loss compatibility; evaluation records Gaussian NLL and quantile metrics. |
| MR-003 | Invert input executes detached mean/std integration by variable and maintains `[B,C,L]` with a projection of `[B,C,D]`; Variables enter the backbone as token. Transformer path does not add variable location codes, and predicts later variable-by-variate. The non-Transformer combination is maintained as an extension of the project. |
| MR-005 | Evidently incompatible embedding error; Compatible visible request for retention, including linear+watch. Auto can still choose none for the original skeletal backbone. |
| MR-006 | multiscale_blocks controls the multiscale processing depth (1 – 4) and no longer pretends to be a mass; Each layer is handled independently within the scales of the Patch, and then exchanges cross-scale information through a scale summary attitudinal. Compatible default scales are determined by history_window, and players still control the backbone depth alone. |
| MR-007/008 | Readers cannot correct errors; Visible channel_fusion takes precedence over covariates. |
| MR-009 | DLinear's decomposition=trution is partially released from it, without any additional superheavy breakdown;decomposition_kernel enters an internal module. |
| MR-010 | The even-number window retains the original value, padding on the left = floor (kernel-1)/ 2, supplementing the right with Kernel-1 and maintaining the length. |
| MR-011 | time_budget_s enters operational constraints and trains at the check-out deadline at the bat border;max_params exceeded the system ceiling to clearly report errors; Visible max_latency_ms physical measurement and execution of excess limit failed, no longer extrapolating the implied hard cap from latency_sensitive. |
| MR-012 | Calendar uses UTC hours, weeks, days and months of real time stamped by windows; Training, validation, ref-test and export inference transmit the calendar input with clear reporting of errors when missing. |

### Use and compatibility instructions

- Output and loss: point mse/mae/huber/distillation;quantile → quantile;gaussian → gaussian_nll. All existing loss options are retained. Probability candidate is not automatically changed to Huber.
- `forward_distribution()` of the Python model returns `(mean, scale)`, scale is standard deviation; Normal `forward()` preservation point average interface. Exported `predict_distribution_normalized/raw()` returns `{mean, scale}`, and raw correctly reverses the integration of average values and scales. The MCP tool also returns the two distributed fields.
- Internal input for calendar is `[B,L,4]`, followed by hour, dayofweek, day, month. Export call to pass `{"history": [...], "timestamps": [...]}`;dataset.v2 adds timestamps to the original structured input. Time is explained by UTC, time-free input is considered UTC; Cannot replace the calendar value with a place number for each window to restart.
- (a) Delay definition: current equipment, bat = 1, horizon by 3 preheating measure of 10 and median; GPU, when synchronized, compares the maximum of each horizon with the upper limit. Summary to retain individual horizon measurements; This ceiling relates to equipment and is not equivalent to a cross-equipment service SLA.
- Formerly, using multiscale_blocks to set the configuration of original skeletal core depth instead. DLinear is still a self-decomposition model. The normalized path of invert and the parameter structure of multiscale_patch have been changed, and old checkpoint should be retrained; The weight of training when the old calendar/Gaussian or attention is ignored cannot be considered as having been modified.
- The Gaussian combination available for the current high-level DSL has been connected; The low-level unique export channel mix, negative seasonal differentials and the Gaussian combination were clearly rejected because of the need for a joint effort and did not pretend to maintain the Goss distribution.

### Thesis Consistency Boundaries

- Token, variable-by-variate and non-variant location codes for `invert + transformer + full attention + independent fusion` alignment variables; Adds another fusion/preprocessing or replaces another backbone with a `paper_derived` extension.
- `lightweight` is the nucleochemical linear focus of the ELU+ 1 positive characterization map, achieved on the basis of Linear Transformer and not the equivalent of Informer ProbSparse, LogSparse or Pyraformer.
- `multiscale_patch` is a `paper_derived` combination module inspired by the Multi-Resolution Patch model and does not purport to reproduce full calculations of Scaleformer, MICN, TimeMixer or Pathformer.
- `calendar`, direct multistep Gaussian head, `gated_hybrid` and even DLinear Kernel are kept as groupable mechanisms or compatible extensions that do not amount to complete GLAF, DeepAR, TFT or original DLinear respectively.

Example: `py/schemas/model_recipe_gaussian_calendar.example.json`, `py/schemas/model_recipe_invert.example.json`. Returns to `py/tests/test_model_recipe_consistency.py` and `test_train_execution.py`, covering cross-variant gradients, square gradients, real window calendars, four scales, even windows, budgets, delayed excesses and export contracts.

Validation: all 54 recipe tests and CLI validation of new/native examples passed. Python passed 139/140; the remaining old assertion expects val_avg_mse although research records now use cv_avg_mse. The Node stage of `npm test` passed 67/69; failures were missing local `datasets (1)/ETTh1.csv` and a scheduler enum/prompt-list mismatch. New default-value tests passed; rerunning prompt tests gave 10/11 with the same scheduler failure. These preexisting issues were unchanged.

> Date of review: 2026-09-20
> Subject: Fields already existing in `py/schemas/model_recipe_schema.json`.
> Out of range: future competitor issues, low layer `recipe_schema_v1` unique fields, high level DSL extension proposal.

## 1. Conclusions

This time only check whether the current ModelRecipe field maintains the same term from schema, compiler to run. The following categories of 12 are not consistent:

- **P0: 4**: Fields are legal but not valid, or output/training syntax is invalid.
- **P1: 7 Division**: Fields have been rewritten silently, stringed, duplicated or unbound incompatible combinations.
- **P2: 1 Division**: Field names differ from current semantics.

This paper does not recommend the addition of any fields. Each change is made in only one of three ways:

1. Semantics by the current name of the field;
2. Explicitly report errors in unsupported values or combinations;
3. Remove unimplemented fields or enum values from the existing schema.

## 2. Summary of issues

| ID | Priority | Existing Fields | Current behaviour | Decision |
|---|---|---|---|---|
| MR-001 | P0 | `architecture.attention` | The compiler is completely unread, and three count values generate the same model | Field is invalid |
| MR-002 | P0 | `architecture.output_distribution=gaussian` | Discarded and no Gassian losses | Mechanism not achieved |
| MR-003 | P0 | `architecture.embedding=invert` | Channels flatten first, but no variables formed token | The semantics of the mechanism do not match. |
| MR-004 | P0 | `architecture.output_distribution` + `training.loss` | Could form an unsupervised output branch or semantic conflict combination | Synchronising folder |
| MR-005 | P1 | `architecture.embedding` + `backbone` | Partially visible embedding request silently changed to `none` | Quiet demotion |
| MR-006 | P1 | `architecture.multiscale_blocks` | 4 still has only 3 scales | Parameter Thread |
| MR-007 | P1 | `architecture.heads` | It can't be reduced by silence. | Quietly rewriting |
| MR-008 | P1 | `input.covariates` + `architecture.channel_fusion` | `covariates=true` will overwhelm visible `independent` | Visible Configuration Overrided |
| MR-009 | P1 | `architecture.decomposition` + `backbone=dlinear` | External and DLinear implementation splits | Repetition mechanism |
| MR-010 | P1 | `decomposition_kernel` | Even after schema, add one when running | Quietly rewriting |
| MR-011 | P1 | `training.time_budget_s`,`constraints.max_latency_ms`,`constraints.max_params` | Time budgets are replaced by default values; The deferred ceiling was not implemented; The upper limit of the parameters could be tightened silently. | Inconsistent binding |
| MR-012 | P2 | `architecture.embedding=calendar` | Use location index synthesizing cycle features without reading real calendar values | Name semantic deviation |

## 3. Detailed questions

### MR-001: `architecture.attention` is not valid at all

**Statement**

High-level schema accepts `none`, `lightweight`, `full`, see [`model_recipe_schema.json`](../py/schemas/model_recipe_schema.json#L100).

**Actual acts**

[`_compile_backbone()`](../py/model_recipe.py#L151) does not read `attention`. Transformer always constructs the same `nn.TransformerEncoder`, see [`build_model.py`](../py/factory/build_model.py#L987); The other backbone will not use the field.

**Impact**

Three valid values are compiled into the same model. The search process may treat invalid changes as new designs, and the experimental records may also cause errors in attribution.

**Reorganization**

- If the current version is not intended to achieve different attention paths, delete the field from schema and hints.
- If retained, the three values must produce a different lower layer configuration or modular structure.

**Accepted and accepted**

`attention` changes the compilation result or model structure must change; Otherwise, verification must fail.

### MR-002: `output_distribution=gaussian` does not create probability output

**Statement**

`architecture.output_distribution` Accepts `gaussian`, see [`model_recipe_schema.json`](../py/schemas/model_recipe_schema.json#L152). This is how the compiler produces Gaussian head, see [`model_recipe.py`](../py/model_recipe.py#L231).

**Actual acts**

[`GaussianPointHead.forward()`](../py/factory/build_model.py#L746) calculates the variance, but is immediately discarded and returns only the average value. The training end [`_build_train_loss()`](../py/train.py#L325) does not have Gaussian NLL, nor does the predictive path return to the distribution interface of average values and scales.

**Impact**

This field does not produce a training, assessmentable or exportable Gaussian distribution; The differential branch was not effectively monitored.

**Reorganization**

- Complete realization of the average, normal output and Gaussian NLL;or
- Remove `gaussian` from the `output_distribution` count before completion.

**Accepted and accepted**

The Gaussian output contract contains explicit averages and scales, with non-zero gradients obtained by reverse transmission of the difference branch parameters.

### MR-003: `embedding=invert` has not achieved variable token

**Statement**

ModelRecipe uses `invert` as an embedding option, and a hint is also used for variate-token moving.

**Actual acts**

[`_prepare_flat_series()`](../py/factory/build_model.py#L1170), first turn `[B, L, C]` into `[B*C, L]`. Subsequently, [`InvertEmbedding`](../py/factory/build_model.py#L234) project the sequence of each single variable into one `[B*C, 1, D]` token.

The variable dimension has entered a bat before embedding, and the variables do not participate as token in the backbone calculations for Transformer, RNN, SSM or Mixer.

**Impact**

This field is currently closer to " Compresses one token for each single variable series, not a inverted/variate-token model. Field names, hint assumptions and performance maps are not consistent.

**Reorganization**

- When a field name is retained, the variable dimension should enter the backbone as token;or
- Delete the `invert` option and avoid using it as a variable token mechanism if existing realization is maintained.

### MR-004: `output_distribution` missing compatibility verification with `training.loss`

**Statement**

Two fields are listed separately:

- `output_distribution`: point,quantile,gaussian;
- `loss`: mse,mae,huber,quantile,distillation.

Schema is not bound by the combination of both.

**Actual acts**

- When `output_distribution=quantile` is equipped with MSE/MAE/Huber, [`_point_prediction()`](../py/train.py#L314) takes only the middle quantile and other quantile output does not have corresponding oversight.
- When `output_distribution=point` is equipped with a quantile loss, the training path only forms a single 0.5 quantile, different from the usual multi-point prediction.
- `output_distribution=gaussian` with any existing loss is only trained in average values.

**Impact**

Schema is not legal as a training semantic; Part combination produces idle output parameters or targets that differ from field names.

**Reorganization**

Adds no fields, only a combination of existing fields. It is suggested that the current matrix allows:

| Output Distribution | Allowed loss |
|---|---|
| point | mse,mae,huber,distillation |
| quantile | quantile |
| gaussian | Not allowed until Gaussian NLL is completed |

### MR-005: Visible embedding request will be deleted silently

**Statement**

schema allows any `embedding` combination with any `backbone`, without cross-field restriction.

**Actual acts**

For DLinear, TCN, N-BEATS, and TimesNet, `_compile_embedding()` unconditionally returns `{"type": "none"}`; see [`model_recipe.py`](../py/model_recipe.py#L122).

So the following configurations can pass through high-level schema, but embedding will disappear:

```json
{"backbone": "timesnet", "embedding": "frequency"}
```

```json
{"backbone": "temporal_conv", "embedding": "multiscale_patch"}
```

**Impact**

The actual model is not consistent with the user visible selection, hypothesis and search records.

**Reorganization**

- `embedding=auto` can be selected by the compiler for `none`.
- Any visible non-`none` request that is incompatible with the backbone should be reported in error prior to compilation and cannot be rewritten silently.

### MR-006: `multiscale_blocks` controls two different mechanisms

**Statement**

Field names are multiscale blocks, and schema allows 0 - 4.

**Actual acts**

- [`_compile_embedding()`](../py/model_recipe.py#L122) uses it to determine the number of measures for multiscale catch.
- [`_compile_backbone()`](../py/model_recipe.py#L151) also uses it as a generic backbone depth when `layers` defaults.
- The built-in `DEFAULT_SCALES` is only three, so `multiscale_blocks=3` generates the same embedding scale as `4`.
- For the mandatory original `embedding=none` sequence backbone, this field may still change TCN layers, N-BEATS block numbers or TimesNet layers.

**Impact**

One field simultaneously changes embedding and backbone, unable to clean up; Value 4 does not fulfil the four-scale syntax.

**Reorganization**

No new fields:

- Let `multiscale_blocks` control only multiscale embedding;
- Backbone depth only uses already existing `layers`;
- If 4 measures are not supported for the time being, change the maximum value of schema to 3 or clearly report errors on 4.

### MR-007: `heads` will be lost silently

**Statement**

`architecture.heads` allows 1 -32, and `d_model` allows 8 -1024. Schema did not ask for a clean-up.

**Actual acts**

Transformer, if `d_model % heads != 0` is compiled, the compiler recycles less `heads` until it can be completely severed, see [`model_recipe.py`](../py/model_recipe.py#L162). For example, `d_model=64, heads=6` will be changed to 4.

**Impact**

User requests, candidate records and actual model headcounts vary and no diagnostic information is available.

**Reorganization**

Retains the existing field but directs errors that cannot be severed. Do not select another head number for the user.

### MR-008: `input.covariates` will overwhelm visible `channel_fusion=independent`

> This item deals only with the compilation relationship of existing Boolean fields and channel integration, and not with the transfer or consumption of future competitors.

**Statement**

`channel_fusion` expressly allows `independent` and `shared`.

**Actual acts**

[`_compile_fusion()`](../py/model_recipe.py#L219) uses the following condition: As long as `input.covariates` is true, compile and translate `channel_mode="shared"` even if the user clearly specifies `channel_fusion="independent"`.

**Impact**

The visible structure selection is covered silently by another field.`independent` no longer has a synonym when the coding variable exists.

**Reorganization**

Keep the visible `channel_fusion` first; If some form of input does not support independent, the error should be clearly reported instead of automatically changing to sared.

### MR-009: `decomposition=true` and DLinear split

**Statement**

Schema allows `decomposition=true` to appear at the same time as `backbone="dlinear"`.

**Actual acts**

- Compilers generate external `series_decomposition` preordering, see [`model_recipe.py`](../py/model_recipe.py#L108).
- [`DLinearCore`](../py/factory/build_model.py#L362) Re-executing moving-average trend/seasonal decomposition internally.
- The prompt warns against the combination, as shown in [`src/llm.js`](../src/llm.js#L402), but the machine-readable contract does not prevent it.

**Impact**

A valid recipe may accidentally decompose twice; correctness depends on LLM prompt compliance rather than schema/compiler enforcement.

**Reorganization**

`dlinear + decomposition=true` is clearly reported as an error, or the group is prohibited in schema. Do not cancel one field silently.

### MR-010: Even `decomposition_kernel` is silently added

**Statement**

schema accepts all integers of 2 -255, with no odd limit.

**Actual acts**

Both [`SeriesDecompositionAction`](../py/factory/build_model.py#L50) and [`DLinearCore`](../py/factory/build_model.py#L362) silently increment even kernels by one. For example, a requested 24 executes as 25.

**Impact**

Recipe records the excess parameters that affect the recurrence of experiments and the attribution of parameter searches, unlike the performance values.

**Reorganization**

Limit the existing field to an odd number and even enter a direct error reporting; Or you can really achieve an even-number window definition that maintains the length of the sequence. No further silent modifications may be made.

### MR-011: Existing budget and bound fields are not implemented by declaration

#### `training.time_budget_s`

The compiler correctly wrote to `training_strategy.budget.time_budget_s`, but [`resolve_recipe()`](../py/renderer.py#L39) does not read the value when constructing a fixed `DEFAULT_TIME_BUDGET_S` for running restraints. The final consumption at the training end is a replacement operational constraint.

Result: 60 seconds or 1200 seconds are set by the user and may still use global defaults when running properly.

#### `constraints.max_latency_ms`

The compiler writes it into lower layers, see [`model_recipe.py`](../py/model_recipe.py#L268), but renderer does not bring it into operational restraint and there is no delayed measurement or ultra-fail logic of training and acceptance.

Result: The field currently exists only in the compilation product and does not constitute a constraint.

#### `constraints.max_params`

The renderer uses `min(user_limit, DEFAULT_PARAM_BUDGET_M)`; see [`renderer.py`](../py/renderer.py#L70). Smaller limits correctly tighten the budget, while larger limits are silently reduced.

**Reorganization**

- `time_budget_s` should be passed directly to the operational constraint.
- `max_latency_ms` should be removed from the schema before measurement and determination is achieved, or use other than by default is expressly rejected.
- Clearly stated errors and system ceilings when exceeding the upper limit of global parameters, do not remain silent.

### MR-012: `embedding=calendar` is actually a periodic location code

**Statement**

Field names and hints describe them as calendar embedding.

**Actual acts**

[`CalendarEmbedding`](../py/factory/build_model.py#L262) The index to the location of `0..input_len-1` produces sin/cos characteristics for cycles such as 24, 7, 31 and 12. It does not read the true time stamp, hour, week or month of the sample book.

**Impact**

The same "cal" is obtained at the same location when the window has a different starting point, the sampling frequency is not of an hour's grade and there are uncertainties or irregular sampling. Current semantics are cyclical possible embedding, not real calendar embedding.

**Reorganization**

- If the `calendar` name is retained, it must be performed on the basis of a real calendar value;or
- Delete `calendar` from the embedding count in the current version.

This item does not discuss future accompanies variables, but only determines whether the current `calendar` field name corresponds to the syntax of running.

## 4. Fields checked and not found to be clearly inconsistent

The following existing fields have a clear consumption path in the current implementation chain and are not listed as such:

- `schema_version`,`model_name`,`hypothesis`,`notes`;
- `input.history_window`,`prediction_horizon`,`prediction_horizons`;
- `architecture.backbone`;
- `hidden_dim`, `d_model`, `layers`, `kernel_size`, `patch_len`, `stride`, `dropout` for backbone;
- `training.optimizer`,`learning_rate`,`weight_decay`,`batch_size`,`max_epochs`,`patience`,`seed`,`grad_clip`,`warmup_ratio`;
- `constraints.latency_sensitive` will be compiled as a delayed priority metadata, but it is not currently an enforceable hard delay constraint.

The term "not found yet" here does not mean that it applies under all backbones. Currently schema sets most of the framework parameters as global optional fields, so placing them under non-applicable backbone is usually ignored. It was suggested that the following uniform rules should be used, rather than adding new fields each.

## 5. Harmonization of rules

### 5.1 Visible values cannot be rewritten silently

The following actions should be corrected:

- Uncompatible rebone visible embedding changed to `none`;
- `heads` is automatically diminishing;
- Even `decomposition_kernel` added;
- `max_params` is silent on the global cap.
- `channel_fusion=independent` was changed by `covariates=true` to share.

### 5.2 Each existing field must satisfy 'effective, wrongly reported or deleted'

For each field of `model_recipe_schema.json`

```text
Change the valid field value
  ├─ Observable changes in the compilation product or operating structure/behaviour
  ├─ Current group does not support and gives a clear error
  └─ Output is unchanged and no errors are made.
```

### 5.3 Add group verification between existing fields

At least cover:

- `embedding × backbone`;
- `d_model × heads`;
- `decomposition × backbone`;
- `output_distribution × loss`;
- `covariates × channel_fusion`;
- Backbone and its parameters.

### 5.4 Implementing List Final Value

Before the restoration is completed, the implementation list should at least record the actual heads, kernel, embedding, integration modalities and budget compiled and compared to the original ModelRecipe; Discrepancies of silence are detected, which prevents running.

## 6. Suggested reordering

1. **Deleting the false validity**: processing of `attention` and unfinished Gaussian.
2. **Stop training semantic errors**: add `output_distribution × loss` combination validation.
3. **Elimination of silent rewriting**: embedding, heads, chanel fusion, kernel, parameter budget.
4. **Fixing Parameter Thread**: Let `multiscale_blocks` no longer act as `layers`.
5. **Rehabilitation of operational binding transmissions**: `time_budget_s`, `max_latency_ms`, upper limit diagnosis of global parameters.
6. **Name of calibration mechanism**: `invert` and `calendar` either fulfil their current names or remove them from the existing count.

## 7. Complete Definition

Without adding ModelRecipe fields, the following conditions shall be considered complete for consistency in this round:

1. Each of the existing fields in schema is consumed or is clearly misreported under a list not applicable.
2. The compiler no longer replaces any visible values silently.
3. The legitimate combination of `output_distribution` and `loss` is machine-verifiable.
4. The running time budget is consistent with the ModelRecipe statement; Unrealized hard restraints are no longer declared to be valid.
5. The names of mechanisms such as `invert`, `calendar` and `gaussian` correspond to the actual semantics of implementation.
6. All rules have schema, compiler, and runtime regression coverage.

The issue of future coordination variables continues to be tracked independently, without taking into account the above completion definitions.
