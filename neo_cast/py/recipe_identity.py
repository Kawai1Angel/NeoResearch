"""Canonical recipe identity and crash-recoverable, scoped experiment claims.

Only proven configuration equivalences deduplicate. Probes are diagnostics.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import uuid

NORMALIZATION_REVISION = 1


def digest(value) -> str:
    def numbers(item):
        if isinstance(item, dict):
            return {key: numbers(val) for key, val in item.items()}
        if isinstance(item, list):
            return [numbers(val) for val in item]
        if isinstance(item, float) and item.is_integer():
            return int(item)
        return item
    return hashlib.sha256(json.dumps(numbers(value), sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def file_digest(path: str | Path) -> str:
    result = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def canonical_recipe(payload: dict, *, input_len: int) -> dict:
    from model_recipe import is_model_recipe_payload, compile_model_recipe
    from validate import validate_recipe_object
    recipe = compile_model_recipe(payload) if is_model_recipe_payload(payload) else copy.deepcopy(payload)
    errors = validate_recipe_object(recipe, input_len=input_len)
    if errors:
        raise ValueError("; ".join(errors))
    for key in ("recipe_id", "hypothesis", "notes"):
        recipe.pop(key, None)
    recipe.pop("post_processing", None)  # only accepted value is auto
    fusion = recipe["fusion"]
    if fusion["type"] == "temporal":
        fusion.setdefault("channel_mode", "independent")
        if fusion["channel_mode"] == "shared":
            recipe["fusion"] = {"type": "feature_mlp"}
    backbone = recipe["backbone"]
    if backbone["type"] == "linear":
        for key, value in {"shared": True, "bias": True, "attention": "none"}.items():
            backbone.setdefault(key, value)
    head = recipe["prediction_head"]
    head.setdefault("output_distribution", {"gaussian": "gaussian", "quantile": "quantile"}.get(head["type"], "point"))
    if head["type"] == "gaussian":
        head.setdefault("variance_floor", 1e-6)
    if head["type"] == "quantile":
        head.setdefault("quantiles", [0.5])
    actions = []
    for action in recipe["preprocessing"]["actions"]:
        if action["type"] == "none" or (action["type"] == "sample_reweighting" and action.get("scheme", "uniform") == "uniform"):
            continue
        if action["type"] == "instance_norm":
            action.setdefault("affine", False)
            action.setdefault("eps", 1e-5)
        if action["type"] == "missing_mask":
            action.setdefault("mask_channel", True)
        actions.append(action)
    recipe["preprocessing"]["actions"] = actions
    recipe.setdefault("constraints", {})
    if recipe["recipe_version"] == "recipe_schema_v3":
        recipe.setdefault("composition", {"type": "single"})
    strategy = recipe["training_strategy"]
    strategy.setdefault("scheduler", {"type": "none", "warmup_steps": 0})
    strategy["scheduler"].setdefault("warmup_steps", 0)
    strategy["loss"].setdefault("horizon_weighting", "uniform")
    strategy["optimizer"].setdefault("weight_decay", 0.0)
    for key, value in {"batch_size": 32, "patience": 7, "seed": 42}.items():
        strategy["budget"].setdefault(key, value)
    return recipe


def recipe_identity(payload: dict, *, input_spec: dict, experiment: dict | None = None) -> dict:
    canonical = canonical_recipe(payload, input_len=input_spec["input_len"])
    architecture = {key: value for key, value in canonical.items() if key not in {"training_strategy", "constraints"}}
    secondary = canonical.get("composition", {}).get("secondary")
    branches = [canonical] + ([secondary] if secondary else [])
    if any(branch.get("embedding", {}).get("type") in {"patch", "multiscale_patch"} and
           branch.get("backbone", {}).get("type") in {"mlp", "transformer", "tcn", "mamba", "diagonal_ssm"}
           for branch in branches):
        # Old mean-token experiments are not cache hits for the new readout.
        architecture = {**architecture, "patch_readout_revision": "feature_token_flatten_v1"}
    # A referenced topology is identified by bytes, never only by path.
    topology = architecture.get("fusion", {}).get("topology_artifact")
    if topology:
        architecture = copy.deepcopy(architecture)
        architecture["fusion"]["topology_artifact"] = {"sha256": file_digest(topology)}
    architecture_id = digest({"normalization_revision": NORMALIZATION_REVISION, "architecture": architecture, "input_spec": input_spec})
    result = {"architecture_id": architecture_id, "normalization_revision": NORMALIZATION_REVISION, "canonical_recipe": canonical}
    if experiment is not None:
        required = {"data_digest", "split_protocol", "backend", "precision", "runtime_digest"}
        if not required <= experiment.keys():
            raise ValueError(f"experiment identity requires {sorted(required - experiment.keys())}")
        result["experiment_id"] = digest({"architecture_id": architecture_id,
                                          "training": canonical["training_strategy"], "constraints": canonical["constraints"],
                                          "experiment": experiment})
    return result


class ExperimentStore:
    """SQLite transactions arbitrate claims; owner tokens fence stale workers."""
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, status TEXT NOT NULL, owner TEXT, expires REAL, attempt INTEGER NOT NULL, result TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS attempts (id TEXT, attempt INTEGER, owner TEXT, status TEXT, detail TEXT, PRIMARY KEY(id, attempt))")

    def connect(self):
        return sqlite3.connect(self.path, timeout=30)

    @staticmethod
    def valid_result(result):
        try:
            files = result["files"]
            return bool(files) and all(file_digest(path) == checksum for path, checksum in files.items())
        except (OSError, KeyError, TypeError):
            return False

    def claim(self, identity: str, *, lease_seconds: float = 120):
        owner = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status, owner, expires, attempt, result FROM experiments WHERE id=?", (identity,)).fetchone()
            if row and row[0] == "completed":
                result = json.loads(row[4])
                if self.valid_result(result):
                    return {"status": "completed", "result": result}
            if row and row[0] == "running" and row[2] > time.time():
                return {"status": "running"}
            attempt = row[3] + 1 if row else 1
            if row and row[0] == "running":
                db.execute("UPDATE attempts SET status='expired' WHERE id=? AND attempt=?", (identity, row[3]))
            db.execute("INSERT OR REPLACE INTO experiments VALUES (?, 'running', ?, ?, ?, NULL)", (identity, owner, time.time() + lease_seconds, attempt))
            db.execute("INSERT INTO attempts VALUES (?, ?, ?, 'running', NULL)", (identity, attempt, owner))
        return {"status": "claimed", "owner": owner, "attempt": attempt}

    def heartbeat(self, identity: str, owner: str, lease_seconds: float = 120):
        with self.connect() as db:
            cursor = db.execute("UPDATE experiments SET expires=? WHERE id=? AND owner=? AND status='running'", (time.time() + lease_seconds, identity, owner))
            if cursor.rowcount != 1:
                raise RuntimeError("Experiment lease ownership lost")

    def finish(self, identity: str, owner: str, *, result=None, error=None):
        status = "completed" if error is None else "failed"
        if status == "completed" and not self.valid_result(result):
            raise ValueError("Cannot complete experiment with missing or invalid artifacts")
        detail = json.dumps(result if error is None else {"error": str(error)})
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            cursor = db.execute("UPDATE experiments SET status=?, result=?, expires=0 WHERE id=? AND owner=? AND status='running'", (status, detail, identity, owner))
            if cursor.rowcount != 1:
                raise RuntimeError("Experiment lease ownership lost")
            db.execute("UPDATE attempts SET status=?, detail=? WHERE id=? AND owner=?", (status, detail, identity, owner))


def migrate_recipe(payload: dict, *, input_len: int):
    from model_recipe import compile_model_recipe, is_model_recipe_payload
    from validate import validate_recipe_object
    recipe = compile_model_recipe(payload) if is_model_recipe_payload(payload) else copy.deepcopy(payload)
    if recipe.get("recipe_version") not in {"recipe_schema_v2", "recipe_schema_v3"}:
        raise ValueError("Explicit v2 input required; unknown legacy proxy names are not inferred")
    errors = validate_recipe_object(recipe, input_len=input_len)
    if errors:
        raise ValueError("; ".join(errors))
    source_version = recipe["recipe_version"]
    recipe["recipe_version"] = "recipe_schema_v3"
    recipe.setdefault("representation", {"layout": "channel_latent", "readout": "none", "latent_dim": min(input_len, 64)})
    recipe.setdefault("composition", {"type": "single"})
    errors = validate_recipe_object(recipe, input_len=input_len)
    if errors:
        raise ValueError("; ".join(errors))
    return {"recipe": recipe, "migration": {"source": source_version, "target": "recipe_schema_v3", "requires_retraining": True,
                                              "preserved_latent_dim": recipe["representation"]["latent_dim"]}}


def behavior_probe(model, *, seed: int = 42) -> dict:
    """Diagnostic only; never used as a result-cache key or equality proof."""
    import torch
    parameter = next(model.parameters())
    generator = torch.Generator(device="cpu").manual_seed(seed)
    length, channels = model.input_len, model.num_channels
    time_axis = torch.arange(length).float().reshape(1, length, 1)
    random_input = torch.randn(1, length, channels, generator=generator)
    impulse = torch.zeros_like(random_input)
    impulse[:, length // 2] = 1
    channel_input = random_input.clone()
    channel_input[..., -1] += 1
    cases = {"constant": torch.ones_like(random_input), "impulse": impulse,
             "periodic": torch.sin(time_axis * (2 * torch.pi / 6)).expand_as(random_input),
             "random": random_input, "channel_perturbation": channel_input, "missing_mask": random_input}
    modes = {module: module.training for module in model.modules()}
    model.eval()
    result = {}
    try:
        for name, raw in cases.items():
            x = raw.to(device=parameter.device, dtype=parameter.dtype).clone().requires_grad_(True)
            kwargs = {}
            if model.uses_missing_mask:
                mask = torch.zeros_like(x)
                if name == "missing_mask":
                    mask[:, ::3, :] = 1
                kwargs["missing_mask"] = mask
            output = model(x, **kwargs)
            grad = torch.autograd.grad(output.sum(), x)[0]
            result[name] = {"output_digest": digest(output.detach().float().cpu().tolist()),
                            "gradient_digest": digest(grad.detach().float().cpu().tolist()),
                            "output_l2": float(output.detach().float().norm()), "gradient_l2": float(grad.detach().float().norm()),
                            "output_preview": output.detach().flatten()[:16].float().cpu().tolist()}
    finally:
        for module, training in modes.items():
            module.training = training
    weights = hashlib.sha256()
    for name, tensor in model.state_dict().items():
        weights.update(name.encode())
        weights.update(tensor.detach().float().cpu().contiguous().numpy().tobytes())
    return {"protocol": "behavior_probe.v1", "seed": seed, "device": str(parameter.device), "dtype": str(parameter.dtype),
            "weight_digest": weights.hexdigest(), "diagnostic_only": True, "cases": result}


def main():
    parser = argparse.ArgumentParser(description="Authoritative recipe identity / explicit v3 migration")
    parser.add_argument("command", choices=["identity", "migrate"])
    parser.add_argument("path")
    parser.add_argument("--input-len", type=int, required=True)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--horizon", type=int, default=1)
    args = parser.parse_args()
    payload = json.loads(Path(args.path).read_text())
    result = (migrate_recipe(payload, input_len=args.input_len) if args.command == "migrate" else
              recipe_identity(payload, input_spec={"input_len": args.input_len, "channels": args.channels, "horizon": args.horizon}))
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
