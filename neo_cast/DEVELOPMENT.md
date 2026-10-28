# neo-cast Installation and Debugging Guide

> This document is for source developers. To use neo-cast, run `npm install -g neo-cast`.

---

## Requirements

| Dependency | Minimum version | Notes |
|---|---|---|
| Node.js | >= 20 | Check with `node --version` |
| Python | >= 3.10 | Installed into the project venv by `init-runtime` |
| uv | Latest stable | Python package manager: `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| macOS / Linux | macOS 12+ / Ubuntu 22.04+ | Windows is not supported yet |

---

## One-time Environment Setup

```bash
# 1. Clone the repository
git clone <repo-url> neo-cast
cd neo-cast

# 2. Install Node.js dependencies
npm install

# 3. Configure the API key
cp .env.example .env
# Edit .env and enter ANTHROPIC_API_KEY
# For OpenAI-compatible endpoints (such as AIGCBEST), see "Multiple LLM Providers" below

# 4. Initialize the Python runtime in .neo-cast/runtime/.venv
node bin/neo-cast.js init-runtime

# 5. Prepare data (requires ETTh1.csv)
# Download: https://github.com/thuml/Time-Series-Library (dataset/ETT-small/ETTh1.csv)
node bin/neo-cast.js prepare-data --source /path/to/ETTh1.csv

# 6. Verify the environment
node bin/neo-cast.js doctor
# Expected output:
# [OK] python3: Python 3.12.x [runtime venv]
# [OK] uv: ...
# [OK] anthropic_api_key: ANTHROPIC_API_KEY is set.
# [OK] config: Resolved config is valid.
# [OK] runtime: Project runtime is ready at ...
```

---

## Installation Methods

### Method 1: Run with Node (lightweight; recommended for development)

No installation is needed; source changes take effect immediately:

```bash
node bin/neo-cast.js <command> [flags]

# Equivalent to neo-cast doctor
node bin/neo-cast.js doctor

# Run design once in mock mode
node bin/neo-cast.js design \
  --requirement "small nlinear baseline" \
  --mode companion \
  --max-candidates 2 \
  --mock-llm
```

### Method 2: npm link (local global command)

Register `neo-cast` locally. Source changes take effect without reinstalling:

```bash
npm link            # Register the global command (requires sudo or the npm global bin directory on PATH)

neo-cast doctor
neo-cast design --requirement "..." --mock-llm

npm run unlink      # Unregister (or npm unlink -g neo-cast)
```

> **Note:** `npm link` creates a symbolic link. Changes under `src/` take effect immediately without relinking.

### Method 3: Publish to npmjs.com

```bash
# Check the version field in package.json
npm version patch   # Increment the patch version automatically

# Log in to npmjs.com (requires an account and token)
npm login

# Publish
npm publish

# User installation
npm install -g neo-cast
```

---

## npm Script Reference

```bash
npm run doctor          # Check the environment; equivalent to node bin/neo-cast.js doctor
npm run design:mock     # Quick smoke test with mock design in companion mode
npm test                # Run CLI e2e and Python unit tests
npm run test:watch      # Run the full test entrypoint in watch mode
npm run dev             # Equivalent to node bin/neo-cast.js; append a subcommand
npm run dev:debug       # Start the Node.js inspector and wait for a debugger
```

---

## VS Code Debugging

The repository includes `.vscode/launch.json`. Press **F5** in VS Code and select a configuration:

| Configuration | Purpose |
|---|---|
| `design (mock, companion)` | Common setup; no API key; two mock training rounds in companion mode |
| `design (mock, socratic)` | Socratic mode without an API key |
| `design (Claude API, companion)` | Real LLM calls using the key from `.env` |
| `doctor` | Quick environment check |
| `runner status` | Inspect the current experiment |
| `e2e tests` | Debug end-to-end tests with breakpoints |

**Debugging real LLM calls:**

1. Set `ANTHROPIC_API_KEY=sk-ant-...` in `.env`.
2. Select `design (Claude API, companion)` in VS Code's Run & Debug panel.
3. Set breakpoints in `src/llm.js` or `src/cli.js`.
4. Press **F5**.

**Node.js inspector without VS Code:**

```bash
npm run dev:debug -- design --requirement "test" --mock-llm
# Open chrome://inspect in Chrome to connect
```

---

## Common Commands

```bash
# Check the environment
neo-cast doctor

# Socratic mode: clarify requirements, then run automatically
neo-cast design \
  --requirement "A small forecasting model with strong long-horizon performance" \
  --mode socratic \
  --max-candidates 5

# Companion mode: explain progress during training; enter stop at any time
neo-cast design \
  --requirement "transformer based model for ETTh1" \
  --mode companion \
  --max-candidates 5

# Mock mode: use heuristic candidates without calling an LLM
neo-cast design \
  --requirement "patch mlp model" \
  --mode companion \
  --max-candidates 3 \
  --mock-llm

# Skip smoke runs to speed up development
neo-cast design --requirement "..." --mock-llm --skip-smoke

# View the best result
neo-cast runner status

# Trigger reference-test evaluation manually
neo-cast runner ref-test

# Inspect artifacts
ls .neo-cast/artifacts/
```

---

## Multiple LLM Providers

### Anthropic (default)

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

User configuration (`~/.config/neo-cast/config.json`):

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "temperature": 0.3
  }
}
```

### OpenAI-compatible endpoints (AIGCBEST, local vLLM, etc.)

```bash
export NEO_CAST_LLM_API_KEY="your-key"
```

User configuration:

```json
{
  "llm": {
    "provider": "openai-compatible",
    "base_url": "https://api.aigcbest.top/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 1024,
    "temperature": 0.3
  }
}
```

`neo-cast config init` creates `~/.config/neo-cast/config.json`. Edit it, then verify with `neo-cast config show`.

---

## Project Structure Reference

```
neo-cast/
  bin/neo-cast.js          <- CLI entrypoint
  src/
    cli.js                 <- Command parsing and the main design workflow
    config.js              <- Configuration loading (environment/user/project)
    doctor.js              <- Environment checks
    llm.js                 <- Claude/OpenAI-compatible calls and heuristic fallback
    python-bridge.js       <- Python subprocess spawning
    runtime.js             <- Python venv management
    session.js             <- results.tsv reader
    output.js              <- Machine-readable key=value output
    modes/
      socratic.js          <- Interactive Socratic requirements gathering
      companion.js         <- Companion narration and stop listener
  test/
    e2e.test.js            <- End-to-end tests (node --test)
    python-unit.test.js    <- Python unittest wrapper
  py/                      <- Python backend (training/validation/export)
    train.py               <- Training entrypoint; dispatches to families/
    runner.py              <- Keep/discard state machine
    renderer.py            <- Candidate JSON to training configuration
    validate.py            <- Schema validation and smoke runs
    export.py              <- Ten-file artifact export
    families/              <- Model families: nlinear/tiny_transformer/patch_mlp
    schemas/               ← candidate_schema.json / metadata_schema.json
  .vscode/launch.json      <- VS Code debugging with six presets
  .env.example             <- Environment variable template
```

---

## Troubleshooting

| Symptom | Steps |
|---|---|
| `python3: not available` | Run `neo-cast init-runtime` to initialize the venv |
| `ANTHROPIC_API_KEY is not set` | Set the environment variable or test with `--mock-llm` |
| `data not found` | Run `neo-cast prepare-data --source /path/to/ETTh1.csv` |
| Training crash / shape mismatch | Inspect crash rows in `.neo-cast/results.tsv` |
| Command missing after `npm link` | Check the global npm bin directory is on `$PATH`: `npm bin -g` |
| Validator rejects an LLM candidate | Inspect `py/schemas/candidate_schema.json`, or use `--mock-llm` |
