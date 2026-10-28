# NeoResearch TSF E2E Experiment Path

This document is the acceptance path for running the OpenCode TSF domain bridge
against the local Neo-Cast Python runtime in this directory.

## Runtime Contract

OpenCode TSF run plans use `taskSpec.runtime` to locate Neo-Cast:

```json
{
  "runtime": {
    "bridgeOnly": true,
    "neoCastProjectRoot": "/path/to/NeoResearch/neo_cast",
    "pythonExecutable": "python3",
    "currentCandidatePath": ".neo-cast/current_candidate.json",
    "resolvedCandidatePath": ".neo-cast/resolved_candidate.json",
    "artifactsDir": ".neo-cast/artifacts"
  }
}
```

The OpenCode TSF domain currently renders Neo-Cast recipe payloads and executes:

- `smoke`: `python3 py/validate.py smoke --candidate-path .neo-cast/current_candidate.json --resolved-path .neo-cast/resolved_candidate.json --artifacts-dir .neo-cast/artifacts`
- `full`, `baseline`, `low_fidelity`: `python3 py/runner.py run --description <description>`
- `ref_test`: `python3 py/runner.py ref-test`
- `blind_test`: `python3 py/runner.py blind-test`

OpenCode writes the candidate payload before execution. The local E2E script does
the same write explicitly so the path can be audited without running OpenCode.

## Local Acceptance Script

Script:

```bash
neo_cast/scripts/neo_research_tsf_e2e.sh
```

Dry-run smoke:

```bash
bash neo_cast/scripts/neo_research_tsf_e2e.sh \
  --dry-run \
  --project-root neo_cast \
  --python python3 \
  --candidate neo_cast/py/schemas/recipe.example.json \
  --stage smoke
```

Actual smoke:

```bash
bash neo_cast/scripts/neo_research_tsf_e2e.sh \
  --project-root neo_cast \
  --python python3 \
  --candidate neo_cast/py/schemas/recipe.example.json \
  --stage smoke
```

Actual full run without reference-test promotion:

```bash
bash neo_cast/scripts/neo_research_tsf_e2e.sh \
  --project-root neo_cast \
  --python python3 \
  --candidate neo_cast/py/schemas/recipe.example.json \
  --stage full \
  --skip-ref-test
```

Full run with local ref-test after a successful champion exists:

```bash
bash neo_cast/scripts/neo_research_tsf_e2e.sh \
  --project-root neo_cast \
  --python python3 \
  --candidate neo_cast/py/schemas/recipe.example.json \
  --stage full
```

Seed sweep:

```bash
bash neo_cast/scripts/neo_research_tsf_e2e.sh \
  --project-root neo_cast \
  --python python3 \
  --candidate neo_cast/py/schemas/recipe.example.json \
  --stage seed-sweep \
  --seeds 3,5,7
```

Reference-test only:

```bash
bash neo_cast/scripts/neo_research_tsf_e2e.sh \
  --project-root neo_cast \
  --python python3 \
  --stage ref-test
```

`ref-test` requires `neo_cast/.neo-cast/runner_state.json` to contain a
`best_run_id`, or a manually supplied run through `py/runner.py ref-test
--run-id <run_id>`. The wrapper intentionally keeps the common acceptance path
small and uses the runner's default champion selection.

## Expected Artifacts

All state and artifacts are project-local under:

```text
neo_cast/.neo-cast/
```

Important files:

- `.neo-cast/current_candidate.json`: recipe payload written before each run.
- `.neo-cast/resolved_candidate.json`: renderer output consumed by training.
- `.neo-cast/results.tsv`: runner keep/discard/crash bookkeeping.
- `.neo-cast/runner_state.json`: session ID, best run, counters, crash streak.
- `.neo-cast/artifacts/run_<run_id>/model.pt`: trained model checkpoint.
- `.neo-cast/artifacts/run_<run_id>/val_metrics.json`: validation metrics.
- `.neo-cast/artifacts/run_<run_id>/training_summary.json`: runtime summary.
- `.neo-cast/artifacts/run_<run_id>/preprocess.json`: preprocessing spec.
- `.neo-cast/artifacts/run_<run_id>/eval_report.md`: exported report.
- `.neo-cast/artifacts/run_<run_id>/ref_test_metrics.json`: local ref-test metrics after promotion.

OpenCode records `artifact_ready` directories as `runner_artifact` refs. The
actual files remain in the Neo-Cast artifact directory above.

## OpenCode Path

Create a TSF task with the Neo-Cast root set to this directory:

```bash
cd opencode
bun run packages/opencode/src/index.ts research create \
  --mode review \
  --title "NeoResearch TSF E2E" \
  --neo-cast-root /path/to/NeoResearch/neo_cast
```

Then seed baselines, approve one if required, and run:

```bash
bun run packages/opencode/src/index.ts research seed <taskID>
bun run packages/opencode/src/index.ts research run <taskID> <candidateID> --stage smoke
bun run packages/opencode/src/index.ts research run <taskID> <candidateID> --stage full
bun run packages/opencode/src/index.ts research seed-sweep <taskID> <candidateID> --stage smoke --seeds 3,5,7
```

Request and approve `ref_test` before executing it through OpenCode:

```bash
bun run packages/opencode/src/index.ts research request-ref-test <taskID> <candidateID>
bun run packages/opencode/src/index.ts research run <taskID> <candidateID> --stage ref_test
```

## Minimal Verification

The contract test checks that the dry-run script emits the expected write path
and runner commands without training:

```bash
python3 -m unittest neo_cast/py/tests/test_e2e_contract.py
```
