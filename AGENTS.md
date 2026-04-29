# Repository Guidelines

## Project Structure & Module Organization

This repository is a NeoResearch-TSF study and prototype workspace.

- `neo_cast/`: active Node.js CLI and Python backend for time-series model design. Follow `neo_cast/AGENTS.md` for detailed rules.
- `opencode/`: vendored/reference Bun monorepo used for agent-runtime study. Follow `opencode/AGENTS.md` before editing.
- `system_architecture.md` and `文档/`: architecture notes, reviews, readiness reports, and project analysis.
- `neo_cast/.neo-cast/`: generated runtime, datasets, artifacts, and session state. Treat it as local output unless a task explicitly requires otherwise.

## Build, Test, and Development Commands

Run commands from the relevant subproject.

```bash
cd neo_cast && npm install
cd neo_cast && node ./bin/neo-cast.js init-runtime
cd neo_cast && npm test
cd neo_cast && node ./bin/neo-cast.js doctor
cd neo_cast && node ./bin/neo-cast.js design --mock-llm --mode companion --max-candidates 1
```

For `opencode/`, use Bun. Do not run its root `npm test`; tests are package-scoped:

```bash
cd opencode && bun install
cd opencode/packages/opencode && bun test
cd opencode/packages/opencode && bun typecheck
```

## Coding Style & Naming Conventions

In `neo_cast/`, Node code uses CommonJS, Python code uses type hints, and CLI flags use kebab-case. Python modules, functions, and tests use snake_case. Keep JSON schemas strict and update schema, registry, examples, prompts, and tests together when recipe actions change.

In `opencode/`, preserve the existing TypeScript style: Bun APIs, inferred types where practical, early returns, `const` over `let`, and no semicolons.

## Testing Guidelines

Use `neo_cast/test/*.test.js` for Node `node:test` coverage and `neo_cast/py/tests/test_*.py` for Python `unittest` modules. Add shape, schema, registry compatibility, and export-contract tests for new model or recipe behavior. Run `npm test` in `neo_cast/` before submitting changes.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects such as `Replace root README with TextTS project overview`; nested guides also allow conventional prefixes like `fix:`. Keep commits focused by subsystem.

Pull requests should include purpose, user-visible behavior, commands run, test results, and any schema, artifact, CLI, or runtime compatibility impact. Include screenshots only for UI-facing changes.

## Security & Configuration Tips

Keep provider keys in environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NEO_CAST_LLM_API_KEY`, or `AIGCBEST_API_KEY`. Do not commit local config, secrets, generated datasets, or transient experiment artifacts.
