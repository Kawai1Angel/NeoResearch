# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This directory is a research study hub for exploring autonomous AI research infrastructure, with a focus on applying ideas from Karpathy's `autoresearch` project to time series forecasting (TSF) / foundation model scenarios.

- `autoresearch/` — A fork/copy of Karpathy's autoresearch project: an autonomous agent loop that edits `train.py`, runs 5-minute training experiments, and keeps changes that lower `val_bpb`.
- `autoresearch解读.md` — Deep Chinese analysis of the autoresearch design philosophy and its implications for TSF research.

## Running Experiments (autoresearch/)

**Requirements:** Single NVIDIA GPU (H100 tested), Python 3.10+, `uv`.

```bash
# One-time setup
uv sync
uv run prepare.py          # downloads data, trains BPE tokenizer (~2 min)

# Run a single training experiment (~5 min)
uv run train.py

# Redirect output for agent use
uv run train.py > run.log 2>&1
grep "^val_bpb:\|^peak_vram_mb:" run.log
```

## Architecture of autoresearch

Three files define the entire system:

| File | Role | Editable? |
|------|------|-----------|
| `prepare.py` | Fixed constants (`MAX_SEQ_LEN`, `TIME_BUDGET=300s`), data prep, BPE tokenizer, dataloader, `evaluate_bpb()` | **No** |
| `train.py` | GPT model (`GPTConfig`), Muon+AdamW optimizer, training loop | **Agent edits this** |
| `program.md` | Agent behavior protocol: setup, experiment loop, keep/discard rules, logging format | **Human edits this** |

The metric is `val_bpb` (validation bits per byte) — lower is better, vocab-size-independent.

## Agent Experiment Loop

When running the autonomous agent:

1. Branch: `git checkout -b autoresearch/<tag>` (e.g. `autoresearch/apr21`)
2. Initialize `results.tsv` with header: `commit\tval_bpb\tmemory_gb\tstatus\tdescription`
3. Establish baseline: run `train.py` unmodified first
4. Loop: modify `train.py` → `git commit` → run → read results → keep (advance branch) or discard (`git reset`)
5. `results.tsv` is intentionally left untracked by git

**What the agent can change in `train.py`:** `GPTConfig` fields (`n_layer`, `n_head`, `n_embd`, `window_pattern`), optimizer hyperparameters, batch size, learning rate schedules, block structure, MLP form, value embeddings.

## Key Design Constraints

- Training always runs exactly **5 minutes wall clock** (excluding startup/compilation) — set in `prepare.py` as `TIME_BUDGET`.
- Only `train.py` is modified; `prepare.py` and evaluation harness are frozen.
- No new packages can be installed; use only what's in `pyproject.toml`.
- Simplicity matters: a change that improves `val_bpb` by 0.001 but adds 20 lines of complex code is not worth keeping.

## TSF/Foundation Model Applicability

Key ideas from `autoresearch解读.md` for adapting this approach to TSF:
- Freeze data splits, evaluation windows, metrics, and seeds before opening model search
- Design a cheap proxy metric if full training is expensive (analogous to 5-min budget)
- Start with the minimal loop: one dataset, one evaluator, one editable file, clear keep/discard rules
