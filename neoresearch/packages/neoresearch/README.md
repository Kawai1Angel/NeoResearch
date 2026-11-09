# NeoResearch

NeoResearch is an alpha Research OS for autonomous experiment workflows. This package publishes the
`neo-research` CLI, the local Research OS runtime, the TUI Cockpit, the web dashboard/server, and the
TSF domain protocol used to call a local Neo-Cast runner.

## What Is NeoResearch?

NeoResearch manages research tasks as structured records: task specs, candidate recipes, approvals,
runs, artifacts, memory, and champions. The first built-in domain is time-series forecasting (TSF).
NeoResearch discovers the `neo-cast` npm package or a configured local runner. On first use of an
npm-installed runner, NeoResearch prepares its Python environment in the user's data directory.

## Quick Start

```bash
npm install -g neo-research@alpha neo-cast@alpha
neo-research doctor
neo-research init
neo-research cockpit
```

Use `neo-research serve` for the local API server and `neo-research dashboard` for the web UI.

## NeoResearch-zero

Create a zero variant task to start model search without preset baselines:

```bash
neo-research research create --mode autonomous --research-variant zero \
  --dataset-path /absolute/path/to/data.csv --target-cols OT \
  --context-length 336 --prediction-lengths 96 --neo-cast-root /absolute/path/to/neo_cast
neo-research research pipeline <taskID> --max-iterations 10
```

`research vibe <goal...> --research-variant zero` also supports this variant. For API-created tasks,
set `taskSpec.metadata.researchVariant` to `"zero"`. Omitting the setting preserves the standard workflow.

HypoPlanner creates the initial hypothesis pool and selects an experiment immediately; ModelDesigner
generates its model recipe, followed by the usual compilation, smoke verification, training, evaluation,
and reflection. No baseline options, baseline selection tools, seeded control candidates, or heuristic
recipe fallback are available. If model design fails, bounded retries and the existing design feedback
or validation checkpoint report the failure instead of substituting a preset model. A simple model
chosen autonomously remains valid. The first experiment uses an exploratory contract; later controlled
experiments can reference verified full runs from the same task. Dataset protocols and resource limits
are shared with the standard workflow.

The variant persists across task recovery and cannot change once planning or execution starts. Start
a fresh task for each variant. Zero artifacts carry `researchVariant: "zero"` for experiment tracking.

## Local Source Install

```bash
git clone <repo-url>
cd neo-research/neoresearch
bun install
cd ..
make dev-cli doctor
```

During source development, run CLI commands through the repository-level `make dev-cli` target. It
loads `.env.local`, configures the local Neo-Cast environment, and starts the source CLI with the
right Bun conditions. Avoid launching the TUI directly with
`bun run --conditions=browser ./src/index.ts`; that path skips the local dev wrapper and can leave
workers or terminal focus in an inconsistent state.

`bun run --cwd neoresearch/packages/neoresearch build` builds only the current platform. Use
`bun run --cwd neoresearch/packages/neoresearch build:all` only from release automation when all platform packages
are required.

## npm Install

The npm package boundary is intentionally narrow. It includes `bin/`, `src/`, runtime assets inside
`src/`, `README.md`, `LICENSE`, and `package.json`. It does not publish the full monorepo, test
artifacts, datasets, generated runtimes, or the Neo-Cast Python project.

The source package root is not the release artifact. The published package is generated under
`dist/neo-research` by the release publisher so npm receives a clean JavaScript wrapper package plus
platform binary optional dependencies, without monorepo `workspace:` or `catalog:` dependency
specifiers.

Before publishing, run the dist dry run:

```bash
bun run build
NEO_RESEARCH_PUBLISH_DRY_RUN=1 bun run script/publish.ts
```

For a full multi-platform release, release automation should build all platform packages first:

```bash
bun run build:all
bun run script/publish.ts
```

Direct `npm publish` from this source package is intentionally blocked by `prepublishOnly`.

## TSF Runner Configuration

Install both npm packages in the same project or npm global prefix. The first operation that needs
the TSF runner uses `uv` to set up Python 3.12 and install the dependencies from Neo-Cast's `uv.lock`.
If `uv` is missing, NeoResearch downloads and verifies the appropriate Astral release. The first
run requires network access for any missing downloads. Later runs reuse the environment.

To use a specific source checkout instead, set its path explicitly:

```bash
export NEO_CAST_ROOT=/path/to/neo_cast
neo-research doctor
```

`doctor` reports an npm runner's pending initialization. Once Python is configured, it checks the
interpreter, imports `numpy` and `torch`, and tests whether the Neo-Cast runner can start.

NeoResearch reads `runner-manifest.json` from the Neo-Cast root when present. The manifest is the
explicit runner protocol contract: it declares `protocolVersion: "runner.v1"`, the runner id, the
supported domains, and the subprocess commands for `smoke`, `run`, `ref_test`, and `blind_test`.
If the manifest is missing, NeoResearch falls back to the current Neo-Cast command layout for alpha
compatibility.

## Web Dashboard and TUI Cockpit

```bash
neo-research cockpit
neo-research dashboard
neo-research serve
```

`cockpit` starts the terminal interface. `dashboard` starts the local server and opens the web
interface. `serve` starts the headless Research OS API server for local integrations.

The Literature phase appears between DataAnalysis and HypoPlanner, with bounded progress,
readiness summaries and replay after reopening Cockpit. Set taskSpec `runtime.literatureSessionTools`
to `true` to enable the restricted Literature child session; the initial default remains direct
execution. Use `/literature-session` to open its tool trace. See the
[Literature tools and event contract](src/research/literature/README.md#session-tools-and-cockpit).

## Research Task Lifecycle

```bash
neo-research research create
neo-research research list
neo-research research status <taskID>
neo-research research prepare <taskID> <candidateID>
neo-research research run <taskID> <candidateID>
neo-research research export <taskID>
```

A task produces candidate recipes, run plans, metrics, artifacts, and memory records. TSF candidates
are rendered into the Neo-Cast runner protocol before subprocess execution.

## Current Alpha Limits

- TSF is the first supported research domain.
- TSF execution requires the separately distributed Neo-Cast runner.
- `research create` still starts from a default TSF task template.
- Dashboard and Cockpit are alpha surfaces built from the existing interactive shell.
- APIs and recipe schemas may change before a stable release.
