"""CPU Patch trainability checks using ETTh1 training rows only, not benchmark gains."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import pandas as pd
import torch
from torch import nn
from execution_contract import describe_model
from factory.build_model import build_model
from validate import validate_recipe_object


def compare(source: Path, steps: int = 30, seed: int = 42):
    if steps < 1:
        raise ValueError("steps must be positive")
    frame = pd.read_csv(source, nrows=8640)
    columns = ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"]
    data = frame[columns].to_numpy(dtype=np.float32)
    if len(data) < 8640:
        raise ValueError("Expected the full ETTh1 training interval")
    fit = data[:7000]
    values = torch.from_numpy((data - fit.mean(0)) / np.maximum(fit.std(0), 1e-6))
    length, horizon, batch = 96, 24, 8
    starts = torch.randint(0, 7000-length-horizon, (steps, batch), generator=torch.Generator().manual_seed(seed))
    val_starts = torch.arange(7000, 8640-length-horizon, 64)
    def windows(indices):
        return (torch.stack([values[i:i+length] for i in indices]), torch.stack([values[i+length:i+length+horizon] for i in indices]))
    backbones = {
        "mlp": {"type":"mlp","hidden_dim":16,"depth":1,"activation":"gelu","dropout":0.0},
        "transformer": {"type":"transformer","d_model":8,"n_heads":2,"n_layers":1,"ffn_mult":2,"dropout":0.0},
        "tcn": {"type":"tcn","hidden_dim":16,"n_layers":2,"kernel_size":3,"activation":"gelu","dropout":0.0},
        "mamba": {"type":"mamba","d_model":8,"d_state":4,"d_conv":2,"expand":2,"depth":1,"dropout":0.0,"backend":"torch_reference"},
        "diagonal_ssm": {"type":"diagonal_ssm","d_model":8,"state_dim":4,"depth":1,"dropout":0.0},
    }
    variants = [(name, emb, False) for name in backbones for emb in (["patch", "multiscale_patch"] if name in {"mlp","transformer","tcn"} else ["patch"])]
    variants += [(name, "patch", True) for name in ["mlp", "transformer"]]
    results = []
    for name, embedding, historical in variants:
        r = json.loads((Path(__file__).parent / "schemas/recipe_native.example.json").read_text())
        r.update(recipe_version="recipe_schema_v3", backbone=backbones[name], preprocessing={"actions":[{"type":"none"}]},
                 fusion={"type":"temporal","channel_mode":"independent"}, prediction_head={"type":"linear","output_distribution":"point"}, composition={"type":"single"})
        r["embedding"] = ({"type":"patch","patch_len":16,"stride":16,"d_model":8} if embedding == "patch" else
                          {"type":"multiscale_patch","scales":[{"patch_len":8,"stride":8},{"patch_len":16,"stride":16}],"d_model":8,"num_blocks":1})
        seq = name in {"mamba", "diagonal_ssm"}
        r["representation"] = {"layout":"channel_sequence" if seq else "channel_latent", "readout":"flatten" if seq else "none", "latent_dim":16}
        errors = validate_recipe_object(r, input_len=length)
        if errors:
            raise ValueError(errors)
        torch.manual_seed(seed)
        m = build_model({"recipe":r,"num_channels":7}, length, horizon)
        if historical:
            width = backbones[name].get("hidden_dim", 8)
            m.model["head"] = nn.Sequential(nn.LayerNorm(width), nn.Linear(width, 16))
        optimizer = torch.optim.Adam(m.parameters(), lr=0.001)
        losses, start = [], time.perf_counter()
        for indices in starts:
            x,y = windows(indices); optimizer.zero_grad(); loss = (m(x)-y).square().mean()
            if not torch.isfinite(loss):
                raise ValueError("Non-finite loss")
            loss.backward()
            if any(p.grad is None or not torch.isfinite(p.grad).all() for p in m.parameters()):
                raise ValueError("Missing/non-finite gradient")
            optimizer.step(); losses.append(loss.item())
        m.eval()
        with torch.no_grad():
            x,y = windows(val_starts); error = m(x)-y
            shuffled = x.reshape(len(x),6,16,7)[:,[5,1,2,3,4,0]].reshape_as(x)
            gap = (m(x)-m(shuffled)).abs().mean().item()
        results.append({"backbone":name,"embedding":embedding,"readout":"historical_mean_reference" if historical else "feature_token_flatten",
                        "steps":steps,"first_train_mse":losses[0],"last_train_mse":losses[-1],"internal_holdout_mse":error.square().mean().item(),
                        "internal_holdout_mae":error.abs().mean().item(),"patch_swap_mean_prediction_gap":gap,
                        "seconds":round(time.perf_counter()-start,3),**describe_model(m)})
    return {"schemaVersion":"patch_sanity.v1","dataset":"ETTh1","source_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
            "fit_rows":[0,7000],"internal_holdout_rows":[7000,8640],"benchmark_validation_or_test_used":False,
            "input_len":length,"horizon":horizon,"batch_size":batch,"seed":seed,"optimizer":"Adam(lr=0.001)",
            "limitation":"Small trainability checks; old/new parameter counts differ. No matched-capacity mechanism test or general forecasting improvement is established.","results":results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(); torch.set_num_threads(1)
    report = compare(args.source, args.steps)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({"variants":len(report["results"]),"steps":args.steps,"output":str(args.output)}))
