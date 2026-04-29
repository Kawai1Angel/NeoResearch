# Repository Guidelines

## Project Structure & Module Organization

`neo-cast` is a Node.js CLI with a Python time-series backend.

- `bin/neo-cast.js`: executable CLI entrypoint.
- `src/`: Node command routing, config, doctor checks, LLM bridge, and design modes.
- `py/`: Python runtime for dataset preparation, validation, training, export, runner, and model search.
- `py/factory/`: native `recipe_schema_v1` PyTorch model factory.
- `py/families/`: legacy and recipe model family registry.
- `py/registry/`: supported recipe actions and compatibility validation.
- `py/schemas/`: JSON schemas and example candidate/recipe/metadata files.
- `py/tests/`: Python unit tests.
- `test/`: Node `node:test` end-to-end and wrapper tests.
- `.neo-cast/`: generated runtime, dataset materialization, artifacts, and session state. Do not commit secrets or transient artifacts.

## Build, Test, and Development Commands

Run from the repository root:

```bash
npm install
node ./bin/neo-cast.js init-runtime
npm test
```

- `npm test`: runs Node tests in `test/*.test.js` plus Python unit wrappers.
- `node ./bin/neo-cast.js doctor`: checks local environment/config.
- `node ./bin/neo-cast.js prepare-data --source /path/to/data.csv`: materializes a `dataset.v1` task.
- `node ./bin/neo-cast.js design --requirement "..." --mock-llm`: runs a local mock design loop.
- `node ./bin/neo-cast.js validate recipe py/schemas/recipe_dlinear.example.json`: validates a recipe against schema and registry.

## Coding Style & Naming Conventions

Use CommonJS for Node files (`require`, `module.exports`) and keep tested CLI output machine-readable. Use Python type hints and small pure helpers for schema, registry, search, and factory code. Prefer snake_case for Python names, kebab-case for CLI flags, and recipe IDs like `recipe_dlinear_example`.

Keep JSON schemas strict with `additionalProperties: false`. When adding recipe actions, update schema, registry, prompt text, examples, and tests together.

## Testing Guidelines

Use Node’s built-in `node:test` for CLI behavior and Python `unittest` for backend modules. Add Python tests under `py/tests/test_*.py` and Node tests under `test/*.test.js`.

Before committing, run:

```bash
npm test
node ./bin/neo-cast.js validate recipe py/schemas/recipe_native.example.json
```

For new model modules, add forward-shape tests, registry compatibility tests, and at least one schema-valid example recipe.

## Commit & Pull Request Guidelines

Recent history uses concise imperative commits, sometimes with conventional prefixes, e.g. `fix: update default Anthropic model...`. Prefer short subject lines naming the changed subsystem.

Pull requests should include:

- Purpose and user-facing behavior change.
- Commands run and test results.
- Any schema, artifact, or CLI compatibility impact.
- Screenshots only for dashboard/UI changes.

## Security & Configuration Tips

Keep API keys in environment variables only: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NEO_CAST_LLM_API_KEY`, or `AIGCBEST_API_KEY`. Do not commit local provider details.
