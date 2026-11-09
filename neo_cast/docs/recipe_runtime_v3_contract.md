# ModelRecipe v3 Implementation Notes


> 2026-09-27 update: Removed `direct_multi_horizon` from schemas, registry, factory, and search entrypoints; legacy configurations are explicitly rejected rather than converted to another head. `gated_depthwise_conv` / `timesnet_lite` preserve requested even kernel sizes with asymmetric padding. Defaults apply only to missing fields; explicit invalid values and incompatible embedding return validation errors for agent correction. Old even-kernel checkpoints require retraining and are not converted automatically.
Date: 2026-09-23. The high-level version is `model_recipe.v2`, execution version `recipe_schema_v3`, and runtime revision 3. Old v1/v2 inputs and revision-2 checkpoints are not silently upgraded.

## Models and Compositions

- `diagonal_ssm`: stable negative diagonal state matrix, learnable time step, ZOH discretization, and explicit state recurrence; not a convolution proxy.
- `mamba`: Mamba-1 causal depthwise convolution, input-dependent delta/B/C, selective scan, D skip, and SiLU gating. Full, chunked, and stepwise computation are provided; state resets between windows by default.
- `timesblock_encoder`: FFT non-DC frequency selection, periodic 2D rearrangement, multikernel 2D convolution, amplitude weighting, and residuals. Periods are selected per sample to avoid batch-dependent predictions; this is not full TimesNet.
- New encoders require embedding.type=none, representation.layout=`sequence_latent` or `channel_sequence`, explicit mean/last readout, and explicit latent_dim. Older encoders use `channel_latent` / `none`.
- `parallel_two_branch` supports `latent_gate`, `history_time_gate`, and `forecast_step_gate`; `decomposition_two_branch` splits history into primary trend and secondary residual branches and sums their predictions. Nested compositions and repeated decomposition are prohibited.
- History gates require matching sequence axes, widths, and representations. Forecast gates and decomposition currently support point outputs only. Branches have independent parameters but share the head configuration type; arbitrary separate head configurations are not supported yet.
- Each H has its own model, optimizer, and checkpoint. Cross-H sharing is outside this iteration.

Executable examples: `py/schemas/recipe_{diagonal_ssm,timesblock_encoder,mamba}.example.json`; high-level example: `py/schemas/model_recipe_v2.example.json`. Composition secondary explicitly supplies embedding, backbone, and representation; other settings inherit from the primary branch.

## Search Identity and Reuse

`py/recipe_identity.py` is authoritative. Architecture identity excludes explanatory text and training settings; experiment identity includes dataset contents, time splits, training settings, seeds, precision, backend, and runtime code digest. Only known equivalent configurations are normalized; behavioral similarity is not mathematical equivalence.

Full training and CV check SQLite before training. Transactional reservations, lease heartbeats, and owner tokens prevent concurrent duplicates and stale writes. Completed records are reused only after artifact hashes and the current execution contract pass validation. Failed, expired, or corrupted results may retry. Duplicates are not independent evidence, add no runner result row, and do not advance plateau counters. Node/NeoResearch stops after three consecutive duplicates with `no_new_candidate`.

Smoke runs are not reused. V3 smoke saves `behavior_probe.json` with fixed-input output/input-gradient summaries, weight digests, device, and precision. This diagnostic does not affect caching or automatic equivalence merging.

```bash
PYTHONPATH=py .neo-cast/runtime/.venv/bin/python py/recipe_identity.py identity py/schemas/recipe_mamba.example.json --input-len 96 --channels 7 --horizon 24
PYTHONPATH=py .neo-cast/runtime/.venv/bin/python py/recipe_identity.py migrate py/schemas/recipe_native.example.json --input-len 96
```

Migration emits a new configuration and provenance and requires retraining. It preserves old latent widths and decomposition wrappers rather than converting existing checkpoints. Arbitrary expression equivalence detection is not implemented.

## Validation and Boundaries

Coverage includes state recurrence, chunked/stepwise equivalence, causality, gradients, long-sequence stability, TimesBlock batch independence, masks/past covariates, probabilistic heads, composition parameter effectiveness, resource limits, migration, caching, and standalone-process export reload for all three new models. Mamba retains an independent formula reference; optional official CUDA selective scan is compared for outputs, all parameter/input gradients, short training, and old-weight loading.

Mamba supports `torch_reference`, `auto`, and `cuda_optimized`. Auto uses the official scan kernel on CUDA when the extension is available and d_state<=256; otherwise it records the reference path and fallback reason. Explicit cuda_optimized fails on unmet prerequisites without silent fallback. Explicit torch_reference recipes retain reference execution. Both raw sequences and single-scale patches support the backend; streaming forward_state remains reference recurrence. Actual/requested backends and binary/source digests contribute to execution manifests and experiment identity. Budgets bound parameters and activation elements; the latter is not a full peak-VRAM estimate. Automatic mutation for new encoders currently bounds depth/learning-rate changes rather than exploring broad composition topologies.

See [v3 sanity](recipe_runtime_v3_sanity.md) for small-sample, three-seed results. Correct mechanisms do not imply better forecasts; short-budget results did not outperform the linear baseline. Native TimesNet, cross-H sharing, and reproduced paper metrics are not provided.

References and pinned versions: `py/factory/encoders/PROVENANCE.md`.

## Regression Record

- `neo_cast/npm test`: passed (71 Node tests and the complete Python unittest wrapper). A later targeted run of new CLI deduplication and autonomous-loop tests passed all 16 tests.
- `tests.test_recipe_v3`: 16 passed, including three standalone export reloads, reference-formula comparisons, and concurrent reservation. `tests.test_training_identity_v3` checks reuse of identical configurations, retraining for changed seeds, and independent cross-H parameters.
- NeoResearch `bun run typecheck`: passed.
- NeoResearch `bun test test/research`: 328 passed, 2 failed, matching preexisting failures: hypothesis-evidence-tools lacks quantitative.json; service default plateau expects 25 but gets 7. These are not counted as passing. An additional targeted service test confirms cached results are not independent metric evidence.
- `git diff --check`: passed. These results do not cover the CUDA backend, paper benchmarks, or composition topology search.
