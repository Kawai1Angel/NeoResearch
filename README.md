# NeoResearch

NeoResearch uses LLM agents, scientific literature, and research experience to discover lightweight, domain-specific forecasting models. Its dual-loop workflow combines architecture exploration with training optimization, while hierarchical memory captures experimental lessons for reuse across time-series forecasting tasks.

## Quick Start

Requires Linux or macOS, Node.js 20+, Bun 1.3.13, Python 3.10+, and [uv](https://docs.astral.sh/uv/).

Run from the repository root:

```bash
make setup
(cd neo_cast && npm install && node bin/neo-cast.js init-runtime)
make doctor
make dev-cli
```

In the TUI, configure an LLM provider, create a task from your CSV dataset, and start the research pipeline. Choose **Socratic** mode for initial clarification followed by autonomous execution, or **Companion** mode for approval at key stages.

## Repository Layout

- `opencode/`: CLI, TUI Cockpit, web dashboard, and research orchestration.
- `neo_cast/`: dataset preparation, model recipes, training, evaluation, and export.
- `scripts/`: local setup, development, and verification tools.

## Development

```bash
make test       # Run project verification
make dev-web    # Start the web development environment
```

See the [research workflow](opencode/packages/opencode/docs/neoresearch-workflow.md), [CLI guide](opencode/packages/opencode/README.md), and [Neo-Cast usage guide](neo_cast/USAGE.md) for details.
