# <img src="assets/neoresearch-logo.png" alt="" width="64" align="middle"> NeoResearch

NeoResearch uses a general-purpose large language model (LLM) as an autonomous researcher to discover lightweight, domain-specific models for time series forecasting. Its expert-inspired dual-loop workflow couples literature-guided architecture discovery with evidence-guided training optimization through experimental feedback. Hierarchical experience memory consolidates conditional lessons at the architecture and optimization levels to guide their respective loops within and across forecasting tasks.

**Paper** · NeoResearch: Literature- and Experience-Guided Autonomous Time Series Model Discovery · **arXiv link pending**

## Overview

<img src="assets/neoresearch-workflow.png" alt="NeoResearch workflow showing literature-guided architecture discovery, evidence-guided training optimization, and hierarchical experience memory" width="100%">

### Key Features

- **Literature-guided architecture discovery.** Turns modeling mechanisms from scientific literature into testable architectural hypotheses for the target forecasting task.
- **Evidence-guided training optimization.** Uses experimental feedback on a fixed design to decide whether to refine training or revisit the architectural hypothesis.
- **Hierarchical experience memory.** Accumulates architecture-level experience to guide the outer loop and optimization-level experience to guide the inner loop, both within and across forecasting tasks.

## Getting Started

**NeoResearch CLI installation via npm** (Coming Soon)

### 1. Set up from source

Requires Linux or macOS, Node.js 20+, Bun 1.3.13, Python 3.10+, and [uv](https://docs.astral.sh/uv/).

Run from the repository root:

```bash
make setup
(cd neo_cast && npm install && node bin/neo-cast.js init-runtime)
make doctor
make dev-cli
```

### 2. Start a forecasting task

In the TUI, configure an LLM provider, create a task from your CSV dataset, and start the research pipeline. Choose the interaction mode that fits your task.

- **Socratic** clarifies the requirements up front, then runs the research autonomously.
- **Companion** pauses for your approval at key stages.

## Benchmark Results

In the paper's reference-initialized Alpha setting, NeoResearch achieved the lowest held-out error in 19 of 20 MSE and MAE comparisons across ten forecasting datasets.

[<img src="assets/neoresearch-benchmark-results.png" alt="Table 1 from the NeoResearch paper showing MSE and MAE for NeoResearch and the baselines across ten datasets" width="100%">](assets/neoresearch-benchmark-results.png)

Section 4.3 of the paper examines the contributions of the two research loops, literature extraction, and hierarchical experience memory.

## Repository Layout

- `neoresearch/`: CLI, TUI Cockpit, web dashboard, and research orchestration.
- `neo_cast/`: dataset preparation, model recipes, training, evaluation, and export.
- `scripts/`: local setup, development, and verification tools.

## Development

```bash
make test       # Run project verification
make dev-web    # Start the web development environment
```

See the [research workflow](neoresearch/packages/neoresearch/docs/neoresearch-workflow.md), [CLI guide](neoresearch/packages/neoresearch/README.md), and [Neo-Cast usage guide](neo_cast/USAGE.md) for details.
