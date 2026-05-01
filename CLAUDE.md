# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

NeoResearch is an autonomous TSF (Time Series Forecasting) research platform with two subsystems:

- **`neo_cast/`** — Node.js CLI (`neo-cast`) + Python backend (`py/`) that designs, trains, and exports TSF models. The CLI is published to npm as `neo-cast`; the Python layer handles actual training and evaluation.
- **`opencode/`** — Bun monorepo that provides the Research OS: a TUI cockpit, web dashboard, REST server, and domain-registry bridge connecting the `neo-cast` runner to the UI layer.

## Common Commands

All `make` targets run from the repo root:

```bash
make setup       # bootstrap_local_dev.sh — install deps, write .env.local
make doctor      # verify environment (Python, uv, API keys, runtime)
make test        # quick targeted verification suite (Research OS + neo-cast Python)
make dev-cli     # watch-rebuild + run the CLI
make dev-web     # vite dev server for the web dashboard
make verify-ui   # render-smoke the TUI cockpit
make smoke       # smoke_tsf.sh — dry-run the full design pipeline
```

### neo_cast (Node CLI)

```bash
cd neo_cast
npm install
node ./bin/neo-cast.js doctor
node ./bin/neo-cast.js init-runtime          # one-time: create Python venv
node ./bin/neo-cast.js prepare-data --source /path/to/ETTh1.csv
node ./bin/neo-cast.js design --requirement "efficient ETTh1 model" --mode companion --max-candidates 3
node ./bin/neo-cast.js design --mock-llm --mode companion --max-candidates 1  # offline debug
npm test                                     # node:test suite in test/*.test.js
```

### opencode (Bun monorepo)

```bash
cd opencode
bun install
cd packages/opencode
bun test                      # all unit tests (30 s timeout)
bun test test/research/...    # single test file
npm run typecheck             # tsgo --noEmit
npm run build                 # bundle CLI binary
npm run pack:dry-run          # build + dry-run publish script
```

Targeted test group used for local alpha checks (mirrors `make test --quick`):

```bash
cd opencode/packages/opencode
bun test \
  test/research/domain-registry.test.ts \
  test/research/runtime.test.ts \
  test/research/tsf-domain.test.ts \
  test/research/service.test.ts \
  test/cli/research-command.test.ts \
  test/cli/research-data.test.ts \
  test/cli/tui/research-cockpit-data.test.ts \
  test/cli/tui/research-cockpit-render.test.tsx \
  --timeout 30000
```

Web dashboard tests live in `opencode/packages/app`:

```bash
cd opencode/packages/app
bun test --preload ./happydom.ts src/pages/research-dashboard-data.test.ts --timeout 30000
npm run typecheck
```

## Architecture

### neo_cast

| Layer | Location | Role |
|---|---|---|
| CLI entry | `bin/neo-cast.js`, `src/commands/` | Argument parsing, mode routing (Socratic / Companion) |
| LLM bridge | `src/llm/` | Generates candidate JSON; supports Anthropic, OpenAI-compat, `--mock-llm` heuristics |
| Python runner | `py/runner.py`, `py/validate.py` | Actual model training and evaluation via subprocess |
| Renderer | `py/renderer.py` | Converts LLM candidate JSON → concrete PyTorch training config |
| Model families | `py/models/` | `nlinear`, `tiny_transformer`, `patch_mlp` |
| State | `.neo-cast/` | `results.tsv`, `current_candidate.json`, `resolved_candidate.json`, `runner_state.json`, `artifacts/` |

**Fixed task constants** (in `py/prepare_tsf.py`, frozen — do not modify):
- `INPUT_LEN=512`, `HORIZONS=[96, 192, 336, 720]`, `NUM_CHANNELS=7`, `SEED=42`, `TIME_BUDGET=600s`
- Data split: train `[0, 8640)`, val `[8640, 11520)`, ref_test `[11520, 14400)`
- Metric: `val_avg_mse` across four horizons (lower is better)

**Runner protocol** (`neo_cast/runner-manifest.json`, `protocolVersion: "runner.v1"`):
- Four commands: `smoke` (60 s timeout, 2 epochs), `run`, `ref_test`, `blind_test`
- The opencode layer invokes these via `neo-cast-runner.ts`

### opencode/packages/opencode

The core TypeScript package. Key namespaces under `src/`:

| Module | Role |
|---|---|
| `research/` | Domain model, Effect-based `Service`, DB schema (`research.sql.ts`), event bus, `DomainRegistry` |
| `research/runners/neo-cast-runner.ts` | Subprocess bridge to the Python runner; reads `runner-manifest.json` |
| `research/runtime.ts` | File-system runtime: resolves venv, candidate paths, artifacts dir |
| `cli/cmd/tui/routes/research-cockpit.tsx` | Full TUI cockpit UI (SolidJS via opentui); sends REST requests to the server |
| `cli/cmd/tui/routes/research-cockpit-data.ts` | Pure formatting/projection helpers for the cockpit — tested in isolation |
| `cli/cmd/tui/plugin/api.tsx` | Plugin API that registers routes, keybindings, dialog types |
| `server/` | HTTP REST API consumed by both TUI and web dashboard |

`opencode/packages/app/src/pages/research-dashboard.tsx` is the web UI equivalent of the cockpit.

### Data flow

```
User → CLI design command
  → LLM → candidate JSON written to .neo-cast/current_candidate.json
  → py/validate.py smoke (60 s)
  → py/runner.py run (up to 600 s)
  → results appended to .neo-cast/results.tsv
  → artifact written to .neo-cast/artifacts/run_<id>/
  → opencode Research Service reads DB + events → TUI / web dashboard
```

## Key Invariants

- The Python training layer (`py/`) is the frozen evaluation harness. Do not change data splits, seeds, or the `val_avg_mse` metric definition.
- When changing a recipe action (model family or training step), update schema, DomainRegistry, examples, prompts, and tests together.
- `neo_cast/` uses CommonJS (`require`); `opencode/` uses ESM with Bun APIs.
- The npm package (`opencode/packages/opencode`) publishes under `neo-research@alpha` with a narrow file allowlist (`bin/`, `src/`, `README.md`, `LICENSE`, `package.json`). The `release-boundary.test.ts` enforces this — do not widen `files` without updating that test.
- API keys go in environment variables (`ANTHROPIC_API_KEY`, `NEO_CAST_LLM_API_KEY`) or `.env.local`; never committed.
