# NeoResearch

NeoResearch is an alpha Research OS for autonomous experiment workflows. This package publishes the
`neo-research` CLI, the local Research OS runtime, the TUI Cockpit, the web dashboard/server, and the
TSF domain protocol used to call a local Neo-Cast runner.

## What Is NeoResearch?

NeoResearch manages research tasks as structured records: task specs, candidate recipes, approvals,
runs, artifacts, memory, and champions. The first built-in domain is time-series forecasting (TSF).
The npm package does not install a full Python ML stack; it discovers and calls a local `neo_cast`
runner when one is configured.

## Quick Start

```bash
npm install -g neo-research@alpha
neo-research doctor
neo-research init
neo-research cockpit
```

Use `neo-research serve` for the local API server and `neo-research dashboard` for the web UI.

## Local Source Install

```bash
git clone <repo-url>
cd neo-research/opencode
bun install
cd ..
make dev-cli doctor
```

During source development, run CLI commands through the repository-level `make dev-cli` target. It
loads `.env.local`, configures the local Neo-Cast environment, and starts the source CLI with the
right Bun conditions. Avoid launching the TUI directly with
`bun run --conditions=browser ./src/index.ts`; that path skips the local dev wrapper and can leave
workers or terminal focus in an inconsistent state.

`bun run --cwd opencode/packages/opencode build` builds only the current platform. Use
`bun run --cwd opencode/packages/opencode build:all` only from release automation when all platform packages
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

Install or keep `neo_cast` as a sibling/local project, then point NeoResearch at it:

```bash
export NEO_CAST_ROOT=/path/to/neo_cast
neo-research doctor
```

`doctor` checks whether `NEO_CAST_ROOT` is found, Python is executable, `numpy` and `torch` import,
and the Neo-Cast runner can start. It reports problems instead of installing Python packages.

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
- The Python runner is external and must be configured locally.
- `research create` still starts from a default TSF task template.
- Dashboard and Cockpit are alpha surfaces built from the existing interactive shell.
- APIs and recipe schemas may change before a stable release.
