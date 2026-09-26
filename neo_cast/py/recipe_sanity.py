"""Fixed-budget, train-only ETTh1 sanity comparison (not a paper benchmark).

Read a local CSV or the ETTh1 member of an existing dataset archive. No downloads,
ref-test access, artifact promotion or mutation of the active dataset/runtime state.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import time
import zipfile

import numpy as np
import pandas as pd
import torch

from execution_contract import describe_model
from factory.build_model import build_model
from validate import validate_recipe_object


def compare(source: Path, steps: int = 30, seed: int = 42) -> dict:
    if source.suffix == ".zip":
        with zipfile.ZipFile(source) as archive:
            raw = archive.read("dataset/ETTh1.csv")
    else:
        raw = source.read_bytes()
    frame = pd.read_csv(io.BytesIO(raw))
    columns = ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"]
    # Only the official train interval (first 8640 rows) is opened for learning;
    # its tail is a held-out sanity validation, not the benchmark validation/test.
    values = frame[columns].iloc[:8640].to_numpy(dtype=np.float32)
    fit = values[:7000]
    scaled = (values - fit.mean(0)) / np.maximum(fit.std(0), 1e-6)
    values = torch.from_numpy(scaled)
    input_len, horizon, batch_size = 96, 24, 16
    generator = torch.Generator().manual_seed(seed)
    starts = torch.randint(0, 7000 - input_len - horizon, (steps, batch_size), generator=generator)
    val_starts = torch.arange(7000, 8640 - input_len - horizon, 48)

    def windows(indices):
        return (torch.stack([values[i:i + input_len] for i in indices]),
                torch.stack([values[i + input_len:i + input_len + horizon] for i in indices]))

    configs = [
        {"type": "linear", "shared": True, "bias": True},
        {"type": "gated_depthwise_conv", "hidden_dim": 8, "depth": 1, "kernel_size": 3, "dropout": 0.1},
        {"type": "timesnet_lite", "hidden_dim": 8, "n_layers": 1, "top_k": 2, "kernel_size": 3, "dropout": 0.1},
    ]
    sequence_configs = [
        {"type": "diagonal_ssm", "d_model": 8, "state_dim": 8, "depth": 1, "dropout": 0.1},
        {"type": "timesblock_encoder", "d_model": 8, "d_ff": 16, "depth": 1, "top_k": 2, "num_kernels": 2, "dropout": 0.1},
        {"type": "mamba", "d_model": 8, "d_state": 8, "d_conv": 4, "expand": 2, "depth": 1, "dropout": 0.1, "backend": "torch_reference"},
    ]
    configs += sequence_configs
    configs += [{"type": "linear", "shared": True, "bias": True, "sanity_secondary": cfg} for cfg in sequence_configs]
    configs += [{**sequence_configs[0], "sanity_merge": merge} for merge in ("latent_gate", "history_time_gate")]
    results = []
    for configuration in configs:
        backbone = {k: v for k, v in configuration.items() if not k.startswith("sanity_")}
        recipe = json.loads((Path(__file__).parent / "schemas/recipe_native.example.json").read_text())
        recipe.update(preprocessing={"actions": [{"type": "none"}]}, embedding={"type": "none"}, backbone=backbone,
                      fusion={"type": "temporal", "channel_mode": "independent"}, prediction_head={"type": "linear", "output_distribution": "point"})
        sequence = backbone["type"] in {"diagonal_ssm", "timesblock_encoder", "mamba"}
        recipe["recipe_version"] = "recipe_schema_v3"
        recipe["representation"] = {"layout": "sequence_latent" if sequence else "channel_latent", "readout": "mean" if sequence else "none", "latent_dim": 8 if sequence else min(input_len, 64)}
        recipe["composition"] = {"type": "single"}
        if "sanity_secondary" in configuration:
            recipe["composition"] = {"type": "decomposition_two_branch", "kernel_size": 25,
                                      "secondary": {"embedding": {"type": "none"}, "backbone": configuration["sanity_secondary"],
                                                    "representation": {"layout": "sequence_latent", "readout": "mean", "latent_dim": 8}}}
        if "sanity_merge" in configuration:
            recipe["composition"] = {"type": "parallel_two_branch", "merge": configuration["sanity_merge"],
                                      "secondary": {"embedding": {"type": "none"}, "backbone": sequence_configs[-1], "representation": recipe["representation"].copy()}}
        errors = validate_recipe_object(recipe, input_len=input_len)
        if errors:
            raise ValueError(errors)
        torch.manual_seed(seed)
        model = build_model({"recipe": recipe, "num_channels": len(columns)}, input_len, horizon)
        optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
        begin = time.perf_counter()
        losses = []
        for indices in starts:
            x, y = windows(indices)
            optimizer.zero_grad()
            loss = (model(x) - y).square().mean()
            if not torch.isfinite(loss):
                raise ValueError("Non-finite training loss")
            loss.backward()
            optimizer.step()
            losses.append(loss.item())
        model.eval()
        with torch.no_grad():
            x, y = windows(val_starts)
            error = model(x) - y
            mse, mae = error.square().mean().item(), error.abs().mean().item()
        import resource
        results.append({"backbone": backbone["type"], "steps": steps, "first_train_mse": losses[0], "last_train_mse": losses[-1],
                        "process_peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                        "heldout_mse": mse, "heldout_mae": mae, "seconds": round(time.perf_counter() - begin, 3), **describe_model(model)})
    return {"dataset": "ETTh1", "source_sha256": hashlib.sha256(raw).hexdigest(), "fit_rows": [0, 7000], "heldout_rows": [7000, 8640],
            "input_len": input_len, "horizon": horizon, "batch_size": batch_size, "seed": seed, "optimizer": "Adam(lr=0.001)",
            "budget": "same update count, identical sampled windows, CPU single thread; parameter counts reported, not matched",
            "limitations": "small-sample mechanics sanity only; no paper-reproduction or model-ranking claim", "results": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--seeds", type=int, nargs="+", default=[42, 43, 44])
    args = parser.parse_args()
    if args.steps < 1:
        parser.error("--steps must be positive")
    torch.set_num_threads(1)
    print(json.dumps([compare(args.source, args.steps, seed) for seed in args.seeds], indent=2))
