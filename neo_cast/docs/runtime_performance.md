# Runtime overhead optimizations

The export path uses `preprocess.json` saved by training rather than rebuilding
scalers from the active dataset. New training summaries include an optional
`export_spec` containing the family's model entry and state-dict layout. Together
these snapshots let the first export avoid importing PyTorch, pandas and sklearn.
Legacy artifacts without these snapshots retain the previous loading fallback.
The metadata schema accepts the optional, strictly validated `export_spec` object.

After reference testing, the runner updates only `metadata.json`,
`research_trace.json` and `eval_report.md` in its existing process. It preserves
the original metadata, preprocessing, model weights and standalone runtime files.
If the artifact has not yet been exported, the runner performs a full export.

After the parallel CV folds finish, standard training reuses the CV parent process,
which already loaded the training dependencies for experiment identity calculation.
It uses the same training entrypoint, resets the seed, and retains normalization,
execution-contract verification, experiment deduplication and live NDJSON output.
CV folds remain separate processes. If the parent has CV split overrides, standard
training falls back to a fresh process with those overrides removed. The
`phase_timing` event for `standard_fit` covers entrypoint initialization through
completion, including cache reuse when applicable.

## Independent experiment concurrency

NeoResearch defaults to at most four independent experiments executing at once
within a project. The TUI and CLI create tasks with `budget.maxParallel=4`;
smaller explicit limits are honored, and larger values are capped at four.
Additional prepared experiments wait in the queue until an execution slot is free.
Each parallel experiment has its own runner workspace under the task's
`experiments/<runID>/` directory, while the prepared dataset and experiment
identity registry remain shared within that task. Reference and blind evaluation
reuse the source model's workspace. Workspace writers and champion updates are
serialized to preserve artifact and metric provenance.

This limit applies to independently requested experiments. Dependent NAS steps
continue to follow their existing design, evaluation, and reflection order.

## Measurements

On 2026-09-23, comparing the pre-change exporter with the optimized exporter on
disposable copies of `run_20260923-134625-hbrp`:

| Operation | Before | After |
| --- | ---: | ---: |
| Full export, including Python startup | 26.39 s | 1.09 s |
| Reference-test export update, in the already-loaded worker | Full export again | 0.71 s |

Both full-export copies used the same training summary and preprocessing snapshot;
the new family export contract was added to both copies. Output directories were
under `/tmp`, while source code and the Python environment remained on `/mnt/d`.
These are single-run local measurements, not an end-to-end latency guarantee.

The standard-fit comparison used the same NLinear candidate, dataset, seed and
fresh artifact stores, with dependencies/data already loaded in the CV parent
before either measurement. Spawning a training process took **50.97 s**; reusing
the parent took **31.05 s** (including training). Validation MSE was `0.571858`
in both runs, and every tensor in the two saved checkpoints was bitwise identical.
This isolates standard-fit invocation; it does not measure a complete CV run.

Validation also compared 60 exported package files byte-for-byte, with no changes.
Metadata matched after excluding creation time and newly added reference metrics.
