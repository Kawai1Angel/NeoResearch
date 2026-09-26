"""
Candidate-driven neo-cast training entrypoint.

Usage:
    python train.py
    python train.py --resolved-candidate .neo-cast/resolved_candidate.json
    python train.py --smoke
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import random
import shutil
import string
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from families import FAMILY_REGISTRY
from training_identity import deduplicate_training
from prepare_tsf import (
    ACTIVE_SPEC,
    DATASET,
    HORIZONS,
    INPUT_LEN,
    KNOWN_FUTURE_COVARIATES,
    NUM_CHANNELS,
    PAST_COVARIATE_COLUMNS,
    SEED,
    build_preprocess_spec,
    evaluate_val_tsf,
    make_dataloader,
)


PROJECT_ROOT = Path(os.environ.get("NEO_CAST_PROJECT_ROOT", Path(__file__).resolve().parent.parent)).expanduser().resolve()
DEFAULT_STATE_DIR = PROJECT_ROOT / ".neo-cast"
DEFAULT_RESOLVED_CANDIDATE = DEFAULT_STATE_DIR / "resolved_candidate.json"
DEFAULT_ARTIFACTS_DIR = DEFAULT_STATE_DIR / "artifacts"
SMOKE_ARTIFACT_KEEP = 30


def emit(event: str, **payload: Any) -> None:
    record = {"event": event, **payload}
    print(json.dumps(record), flush=True)


def _artifact_dir_for_run(artifact_root: Path, run_id: str, *, smoke: bool) -> Path:
    parent = artifact_root / "smoke" if smoke else artifact_root
    return parent / f"run_{run_id}"


def _gc_smoke_artifacts(artifact_root: Path, *, keep: int = SMOKE_ARTIFACT_KEEP) -> None:
    smoke_root = artifact_root / "smoke"
    if keep <= 0 or not smoke_root.exists():
        return
    try:
        run_dirs = [path for path in smoke_root.iterdir() if path.is_dir() and path.name.startswith("run_")]
    except OSError:
        return
    run_dirs.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for stale_dir in run_dirs[keep:]:
        shutil.rmtree(stale_dir, ignore_errors=True)


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def build_default_candidate() -> dict[str, Any]:
    default_recipe: dict[str, Any] = {
        "recipe_version": "recipe_schema_v2",
        "recipe_id": "baseline_nlinear",
        "hypothesis": "Fallback NLinear baseline for direct train.py execution.",
        "preprocessing": {"actions": [{"type": "last_value_centering"}]},
        "embedding": {"type": "none"},
        "backbone": {"type": "linear", "shared": False, "bias": True},
        "fusion": {"type": "temporal", "channel_mode": "independent"},
        "prediction_head": {"type": "linear", "output_distribution": "point"},
        "training_strategy": {
            "loss": {"base": "mse", "horizon_weighting": "uniform"},
            "optimizer": {"type": "adam", "lr": 1e-3, "weight_decay": 0.0},
            "scheduler": {"type": "none", "warmup_steps": 0},
            "regularization": { "grad_clip": 1.0},
            "budget": {"max_epochs": 100, "time_budget_s": 1200, "batch_size": 32, "patience": 7, "seed": SEED},
        },
    }
    return {
        "schema_version": "resolved_candidate.v1",
        "candidate_id": "baseline_nlinear",
        "hypothesis": "Fallback NLinear baseline for direct train.py execution.",
        "model_family": "recipe_factory",
        "model_config": {"recipe": default_recipe, "num_channels": NUM_CHANNELS},
        "train_config": {
            "lr": 1e-3,
            "batch_size": 32,
            "max_epochs": 100,
            "weight_decay": 0.0,
            "patience": 7,
            "seed": SEED,
        },
        "constraints": {
            "param_budget_m": 1.0,
            "time_budget_s": 1200,
            "latency_priority": "medium",
        },
        "smoke_config": {
            "horizon": 96,
            "batch_size": 16,
            "max_epochs": 2,
            "timeout_s": 60,
        },
        "task": {
            "task_id": DATASET,
            "input_len": INPUT_LEN,
            "horizons": list(HORIZONS),
            "num_channels": NUM_CHANNELS,
        },
        "recipe": default_recipe,
    }


def load_resolved_candidate(path: Path) -> dict[str, Any]:
    if not path.exists():
        emit(
            "candidate_defaulted",
            reason=f"resolved_candidate_missing:{path}",
            candidate_id="baseline_nlinear",
        )
        return build_default_candidate()

    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object at {path}, got {type(payload).__name__}")
    return payload


def _with_native_channel_roles(model_config: dict[str, Any]) -> dict[str, Any]:
    from dataset_contract import reject_unsupported_covariates

    reject_unsupported_covariates(model_config)
    config = copy.deepcopy(model_config)
    if ACTIVE_SPEC.schema_version != "dataset.v2":
        return config
    input_channels = NUM_CHANNELS + len(PAST_COVARIATE_COLUMNS)
    config.pop("covariate_fusion", None)
    config["num_target_channels"] = NUM_CHANNELS
    config["num_past_covariate_channels"] = len(PAST_COVARIATE_COLUMNS)
    config["num_future_covariate_channels"] = len(KNOWN_FUTURE_COVARIATES)
    config["num_input_channels"] = input_channels
    config["num_output_channels"] = NUM_CHANNELS
    config["num_channels"] = input_channels
    config["target_channel_indices"] = list(range(NUM_CHANNELS))
    config["future_covariate_mode"] = str(config.get("future_covariate_mode", "none"))
    return config


def _normalize_candidate_model_config(candidate: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(candidate)
    model_config = normalized.get("model_config")
    if isinstance(model_config, dict):
        normalized["model_config"] = _with_native_channel_roles(model_config)
    return normalized


def run_epoch(
    model: nn.Module,
    loader,
    optimizer: torch.optim.Optimizer,
    device: torch.device,
    loss_fn,
    grad_clip: float | None,
    predict_fn=None,
    on_batch=None,
    batch_report_interval: int = 50,
    deadline: float | None = None,
) -> int:
    model.train()
    updates = 0
    for batch_idx, batch in enumerate(loader):
        if deadline is not None and time.time() >= deadline:
            break
        x, y = _move_batch(batch, device)

        pred = predict_fn(model, x) if predict_fn is not None else model(x)
        context = x["target_history"] if isinstance(x, dict) else x
        loss = loss_fn(pred, y, context)
        if not torch.isfinite(loss):
            raise ValueError("Non-finite training loss")

        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        if grad_clip is not None:
            nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
        optimizer.step()
        updates += 1

        if on_batch is not None and (batch_idx + 1) % batch_report_interval == 0:
            on_batch(batch_idx + 1)
    return updates


@torch.no_grad()
def compute_val_loss(model: nn.Module, loader, device: torch.device, predict_fn=None) -> float:
    model.eval()
    total_loss = 0.0
    total_batches = 0
    for batch in loader:
        x, y = _move_batch(batch, device)
        pred = predict_fn(model, x) if predict_fn is not None else model(x)
        total_loss += F.mse_loss(_point_prediction(pred, y), y).item()
        total_batches += 1
    return total_loss / max(total_batches, 1)


def _move_batch(batch, device: torch.device):
    if isinstance(batch, dict):
        moved = {key: value.to(device) for key, value in batch.items()}
        return moved, moved["target"]
    x, y = batch
    return x.to(device), y.to(device)


def _recipe_training_strategy(candidate: dict[str, Any]) -> dict[str, Any]:
    recipe = candidate.get("recipe")
    if isinstance(recipe, dict):
        strategy = recipe.get("training_strategy")
        if isinstance(strategy, dict):
            return strategy
    model_config = candidate.get("model_config")
    if isinstance(model_config, dict):
        recipe = model_config.get("recipe")
        if isinstance(recipe, dict):
            strategy = recipe.get("training_strategy")
            if isinstance(strategy, dict):
                return strategy
    return {}


def _recipe_prediction_head(candidate: dict[str, Any]) -> dict[str, Any]:
    recipe = candidate.get("recipe")
    if not isinstance(recipe, dict):
        model_config = candidate.get("model_config")
        recipe = model_config.get("recipe") if isinstance(model_config, dict) else None
    if isinstance(recipe, dict) and isinstance(recipe.get("prediction_head"), dict):
        return recipe["prediction_head"]
    return {}


def _recipe_preprocessing_actions(candidate: dict[str, Any]) -> list[dict[str, Any]]:
    recipe = candidate.get("recipe")
    if not isinstance(recipe, dict):
        model_config = candidate.get("model_config")
        recipe = model_config.get("recipe") if isinstance(model_config, dict) else None
    if isinstance(recipe, dict):
        actions = recipe.get("preprocessing", {}).get("actions", [])
        if isinstance(actions, list):
            return [action for action in actions if isinstance(action, dict)]
    return []


def _sample_reweighting_scheme(candidate: dict[str, Any]) -> str:
    for action in _recipe_preprocessing_actions(candidate):
        if action.get("type") == "sample_reweighting":
            return str(action.get("scheme", "uniform"))
    return "uniform"


def _horizon_weights(horizon: int, weighting: str, *, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    if weighting == "front_heavy":
        weights = torch.linspace(1.5, 0.5, steps=horizon, device=device, dtype=dtype)
    elif weighting == "tail_heavy":
        weights = torch.linspace(0.5, 1.5, steps=horizon, device=device, dtype=dtype)
    else:
        weights = torch.ones(horizon, device=device, dtype=dtype)
    return (weights / weights.mean().clamp_min(1e-8)).view(1, horizon, 1)


def _sample_weights(target: torch.Tensor, scheme: str) -> torch.Tensor:
    if scheme == "outlier_robust":
        magnitude = target.detach().abs().mean(dim=(1, 2))
        weights = 1.0 / (1.0 + magnitude)
    elif scheme == "horizon_tail":
        tail_len = max(target.size(1) // 4, 1)
        weights = 1.0 + target.detach()[:, -tail_len:, :].abs().mean(dim=(1, 2))
    else:
        return torch.ones(target.size(0), device=target.device, dtype=target.dtype)
    return weights / weights.mean().clamp_min(1e-8)


def _reduce_loss(loss: torch.Tensor, weighting: str, sample_scheme: str, target: torch.Tensor) -> torch.Tensor:
    weights = _horizon_weights(loss.size(1), weighting, device=loss.device, dtype=loss.dtype)
    per_sample = (loss * weights).mean(dim=(1, 2))
    sample_weights = _sample_weights(target, sample_scheme)
    return (per_sample * sample_weights).mean()


def _point_prediction(pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    if isinstance(pred, tuple):
        return pred[0]
    if pred.dim() == target.dim() + 1:
        return pred[..., pred.size(-1) // 2]
    return pred


def _teacher_forecast(context: torch.Tensor, target: torch.Tensor, teacher_cfg: dict[str, Any]) -> torch.Tensor:
    teacher_type = str(teacher_cfg.get("type", "last_value"))
    if teacher_type == "moving_average":
        window = int(teacher_cfg.get("window", min(context.size(1), 24)))
        window = max(1, min(window, context.size(1)))
        base = context[:, -window:, :].mean(dim=1, keepdim=True)
    elif teacher_type == "last_value":
        base = context[:, -1:, :]
    else:
        raise ValueError(f"Unsupported distillation teacher type: {teacher_type}")
    return base.expand_as(target).detach()


def _build_train_loss(candidate: dict[str, Any]):
    strategy = _recipe_training_strategy(candidate)
    loss_cfg = strategy.get("loss", {})
    loss_base = loss_cfg.get("base", "mse")
    from registry.action_specs import validate_output_contract

    errors = validate_output_contract(_recipe_prediction_head(candidate), loss_cfg)
    if errors:
        raise ValueError("; ".join(errors))
    if _recipe_prediction_head(candidate).get("output_distribution") == "gaussian" and loss_base != "gaussian_nll":
        raise ValueError("Gaussian output requires gaussian_nll loss")
    horizon_weighting = str(loss_cfg.get("horizon_weighting", "uniform"))
    sample_scheme = _sample_reweighting_scheme(candidate)
    if loss_base == "gaussian_nll":
        def gaussian_loss(pred, target, context=None):
            mean, scale = pred
            return _reduce_loss(F.gaussian_nll_loss(mean, target, scale.square(), full=True, reduction="none"), horizon_weighting, sample_scheme, target)
        return gaussian_loss
    if loss_base == "mse":
        return lambda pred, target, context=None: _reduce_loss(
            F.mse_loss(_point_prediction(pred, target), target, reduction="none"),
            horizon_weighting,
            sample_scheme,
            target,
        )
    if loss_base == "mae":
        return lambda pred, target, context=None: _reduce_loss(
            F.l1_loss(_point_prediction(pred, target), target, reduction="none"),
            horizon_weighting,
            sample_scheme,
            target,
        )
    if loss_base == "huber":
        delta = float(loss_cfg.get("delta", 1.0))
        return lambda pred, target, context=None: _reduce_loss(
            F.huber_loss(_point_prediction(pred, target), target, reduction="none", delta=delta),
            horizon_weighting,
            sample_scheme,
            target,
        )
    if loss_base == "quantile":
        head_cfg = _recipe_prediction_head(candidate)
        quantiles = [float(value) for value in loss_cfg.get("quantiles", head_cfg.get("quantiles", [0.5]))]

        def quantile_loss(pred: torch.Tensor, target: torch.Tensor, context=None) -> torch.Tensor:
            q = pred.new_tensor(quantiles).view(1, 1, 1, -1)
            if tuple(pred.shape) != (*target.shape, len(quantiles)):
                raise ValueError(
                    f"Quantile loss expected prediction shape {(*target.shape, len(quantiles))}, got {tuple(pred.shape)}"
                )
            error = target.unsqueeze(-1) - pred
            per_quantile = torch.maximum(q * error, (q - 1.0) * error)
            return _reduce_loss(per_quantile.mean(dim=-1), horizon_weighting, sample_scheme, target)

        return quantile_loss
    if loss_base == "distillation":
        supervised_weight = float(loss_cfg.get("supervised_weight", 0.5))
        teacher_weight = float(loss_cfg.get("teacher_weight", 0.5))
        teacher_cfg = loss_cfg.get("teacher", {})
        if not isinstance(teacher_cfg, dict):
            teacher_cfg = {"type": "last_value"}

        def distillation_loss(pred: torch.Tensor, target: torch.Tensor, context: torch.Tensor | None = None) -> torch.Tensor:
            if context is None:
                raise ValueError("Distillation loss requires the input context tensor.")
            point = _point_prediction(pred, target)
            teacher = _teacher_forecast(context, target, teacher_cfg)
            supervised = F.mse_loss(point, target, reduction="none")
            distilled = F.mse_loss(point, teacher, reduction="none")
            blended = supervised_weight * supervised + teacher_weight * distilled
            return _reduce_loss(blended, horizon_weighting, sample_scheme, target)

        return distillation_loss
    raise ValueError(f"Unsupported training loss: {loss_base}")


def _predict_for_training(model: nn.Module, candidate: dict[str, Any], x) -> torch.Tensor:
    strategy = _recipe_training_strategy(candidate)
    loss_base = strategy.get("loss", {}).get("base")
    head_cfg = _recipe_prediction_head(candidate)
    wants_quantiles = (
        loss_base == "quantile"
        or head_cfg.get("type") == "quantile"
        or head_cfg.get("output_distribution") == "quantile"
    )
    if isinstance(x, dict):
        inputs = {
            "target_history": x["target_history"],
            **({"missing_mask": x["missing_mask"]} if "missing_mask" in x else {}),
            "exogenous_past": x["exogenous_past"],
            "exogenous_future": x["exogenous_future"],
            **({"calendar_features": x["calendar_features"]} if "calendar_features" in x else {}),
        }
        if loss_base == "gaussian_nll":
            return model.forward_distribution(**inputs)
        if wants_quantiles and hasattr(model, "forward_quantiles"):
            return model.forward_quantiles(**inputs)
        return model(**inputs)
    if loss_base == "gaussian_nll":
        return model.forward_distribution(x)
    if wants_quantiles and hasattr(model, "forward_quantiles"):
        return model.forward_quantiles(x)
    return model(x)


def _slice_context_window(x: torch.Tensor, input_len: int) -> torch.Tensor:
    if isinstance(x, dict):
        return {
            **x,
            "target_history": x["target_history"][:, -input_len:, :],
            **({"missing_mask": x["missing_mask"][:, -input_len:, :]} if "missing_mask" in x else {}),
            "exogenous_past": x["exogenous_past"][:, -input_len:, :],
            **({"calendar_features": x["calendar_features"][:, -input_len:, :]} if "calendar_features" in x else {}),
        }
    if x.size(1) > input_len:
        return x[:, -input_len:, :]
    return x


@torch.no_grad()
def measure_latency_ms(model: nn.Module, inputs, repeats: int = 10) -> float:
    """Median batch-one model call after three warmups, including device completion."""
    was_training = model.training
    model.eval()
    device = next(model.parameters()).device
    def predict():
        if isinstance(inputs, dict):
            kwargs = {key: value[:1] for key, value in inputs.items() if key != "target"}
            if getattr(model, "head_cfg", {}).get("type") == "gaussian":
                model.forward_distribution(**kwargs)
            elif getattr(model, "head_cfg", {}).get("type") == "quantile":
                model.forward_quantiles(**kwargs)
            else:
                model(**kwargs)
        elif getattr(model, "head_cfg", {}).get("type") == "gaussian":
            model.forward_distribution(inputs[:1])
        elif getattr(model, "head_cfg", {}).get("type") == "quantile":
            model.forward_quantiles(inputs[:1])
        else:
            model(inputs[:1])
        if device.type == "cuda":
            torch.cuda.synchronize(device)
    try:
        for _ in range(3):
            predict()
        samples = []
        for _ in range(repeats):
            start = time.perf_counter()
            predict()
            samples.append((time.perf_counter() - start) * 1000)
        return sorted(samples)[len(samples) // 2]
    finally:
        model.train(was_training)


def _build_runtime_model(family_module, candidate: dict[str, Any], input_len: int, horizon: int) -> nn.Module:
    fusion = candidate.get("model_config", {}).get("recipe", {}).get("fusion", {})
    if fusion.get("type") == "graph" and fusion.get("adjacency_source", "learned") != "learned":
        import prepare_tsf as data
        config = candidate["model_config"]
        if "graph_adjacency" not in config or fusion["adjacency_source"] == "correlation":
            names = list((*data.TARGET_COLUMNS, *data.PAST_COVARIATE_COLUMNS))
            source = fusion["adjacency_source"]
            if source == "correlation":
                bundle = data._load_visible_bundle()
                values = np.concatenate([bundle.target_values, bundle.past_covariate_values], axis=1)[data.BORDER_TRAIN[0]:data.BORDER_TRAIN[1]]
                matrix = np.atleast_2d(np.nan_to_num(np.corrcoef(values, rowvar=False), nan=0.0))
                np.fill_diagonal(matrix, 1)
                provenance = {"source": source, "train_rows": list(data.BORDER_TRAIN), "channel_names": names}
            else:
                path = Path(fusion["topology_artifact"]).expanduser().resolve()
                topology = json.loads(path.read_text())
                if topology.get("channel_names") != names:
                    raise ValueError("static topology channel_names must exactly match dataset input order")
                matrix = np.asarray(topology["adjacency"], dtype=np.float32)
                provenance = {"source": source, "channel_names": names, "artifact": str(path)}
            if matrix.shape != (len(names), len(names)) or not np.isfinite(matrix).all():
                raise ValueError("graph adjacency must be finite C x C")
            actions = config["recipe"]["preprocessing"]["actions"]
            if any(a.get("type") == "missing_mask" and a.get("mask_channel", True) for a in actions):
                expanded = np.eye(len(names) * 2, dtype=np.float32)
                expanded[:len(names), :len(names)] = matrix
                matrix = expanded
            config["graph_adjacency"] = matrix.tolist()
            config["graph_provenance"] = provenance
    return family_module.build_model(_with_native_channel_roles(candidate["model_config"]), input_len, horizon)


def _candidate_recipe(candidate: dict[str, Any]) -> dict[str, Any] | None:
    recipe = candidate.get("recipe")
    if isinstance(recipe, dict):
        return recipe
    model_config = candidate.get("model_config")
    if isinstance(model_config, dict) and isinstance(model_config.get("recipe"), dict):
        return model_config["recipe"]
    return None


def _recipe_execution_summary(candidate: dict[str, Any]) -> dict[str, Any]:
    recipe = _candidate_recipe(candidate)
    if recipe is None:
        return {
            "training_prediction": "point_forecast",
            "output_distribution": "point",
        }

    preprocessing = recipe.get("preprocessing", {}).get("actions", [])
    preprocessing_actions = [
        str(action.get("type", "unknown"))
        for action in preprocessing
        if isinstance(action, dict) and action.get("type") != "none"
    ]
    head_cfg = recipe.get("prediction_head", {})
    strategy = recipe.get("training_strategy", {})
    loss_cfg = strategy.get("loss", {}) if isinstance(strategy, dict) else {}
    loss_base = loss_cfg.get("base", "mse") if isinstance(loss_cfg, dict) else "mse"
    output_distribution = str(head_cfg.get("output_distribution", "point")) if isinstance(head_cfg, dict) else "point"
    quantiles = None
    if isinstance(head_cfg, dict) and isinstance(head_cfg.get("quantiles"), list):
        quantiles = [float(value) for value in head_cfg["quantiles"]]
    elif isinstance(loss_cfg, dict) and isinstance(loss_cfg.get("quantiles"), list):
        quantiles = [float(value) for value in loss_cfg["quantiles"]]

    summary: dict[str, Any] = {
        "implementation_status": "paper_derived" if recipe.get("backbone", {}).get("type") == "timesnet_lite" else "native",
        "preprocessing_actions": preprocessing_actions,
        "embedding": str(recipe.get("embedding", {}).get("type", "unknown")),
        "backbone": str(recipe.get("backbone", {}).get("type", "unknown")),
        "fusion": str(recipe.get("fusion", {}).get("type", "unknown")),
        "prediction_head": str(head_cfg.get("type", "unknown")) if isinstance(head_cfg, dict) else "unknown",
        "output_distribution": output_distribution,
        "training_prediction": "gaussian_distribution" if output_distribution == "gaussian" else (
            "quantile_distribution" if loss_base == "quantile" or output_distribution == "quantile" else "point_forecast"
        ),
        "loss": str(loss_base),
    }
    if quantiles is not None:
        summary["quantiles"] = quantiles
    return summary


def _build_optimizer(
    model: nn.Module,
    candidate: dict[str, Any],
    *,
    lr: float,
    weight_decay: float,
) -> torch.optim.Optimizer:
    strategy = _recipe_training_strategy(candidate)
    optimizer_type = strategy.get("optimizer", {}).get("type", "adam")
    parameters = [
        {"params": [p for p in model.parameters() if not getattr(p, "_no_weight_decay", False)]},
        {"params": [p for p in model.parameters() if getattr(p, "_no_weight_decay", False)], "weight_decay": 0.0},
    ]
    if optimizer_type == "adam":
        return torch.optim.Adam(parameters, lr=lr, weight_decay=weight_decay)
    if optimizer_type == "adamw":
        return torch.optim.AdamW(parameters, lr=lr, weight_decay=weight_decay)
    if optimizer_type == "sgd":
        return torch.optim.SGD(parameters, lr=lr, weight_decay=weight_decay)
    raise ValueError(f"Unsupported optimizer: {optimizer_type}")


class _LinearWarmupWrapper:
    """Linearly ramps LR over the first warmup_epochs epochs, then delegates to base_scheduler (may be None)."""

    def __init__(self, optimizer, warmup_epochs: int, base_scheduler, start_factor: float = 0.1):
        self._optimizer = optimizer
        self._warmup_epochs = warmup_epochs
        self._base_scheduler = base_scheduler
        self._start_factor = start_factor
        self._base_lrs = [group["lr"] for group in optimizer.param_groups]
        self._epoch = 0
        self._apply_warmup_lr()

    def _apply_warmup_lr(self) -> None:
        progress = min(self._epoch / max(self._warmup_epochs, 1), 1.0)
        factor = self._start_factor + (1.0 - self._start_factor) * progress
        for group, base_lr in zip(self._optimizer.param_groups, self._base_lrs):
            group["lr"] = base_lr * factor

    def step(self, val_loss: float | None = None) -> None:
        self._epoch += 1
        if self._epoch <= self._warmup_epochs:
            self._apply_warmup_lr()
            return
        if self._base_scheduler is None:
            return
        if isinstance(self._base_scheduler, torch.optim.lr_scheduler.ReduceLROnPlateau):
            self._base_scheduler.step(val_loss)
        else:
            self._base_scheduler.step()


class _DatasciLrAdjustScheduler:
    """Replicates the epoch-end lradj rules used by the datasci baselines."""

    _TYPE2_LRS = {
        2: 5e-5,
        4: 1e-5,
        6: 5e-6,
        8: 1e-6,
        10: 5e-7,
        15: 1e-7,
        20: 5e-8,
    }

    def __init__(self, optimizer: torch.optim.Optimizer, scheduler_type: str):
        self._optimizer = optimizer
        self._scheduler_type = scheduler_type
        self._base_lrs = [float(group["lr"]) for group in optimizer.param_groups]
        self._epoch = 0

    def _lr_for_epoch(self, epoch: int, base_lr: float) -> float | None:
        if self._scheduler_type == "lradj_type1":
            return base_lr * (0.5 ** ((epoch - 1) // 1))
        if self._scheduler_type == "lradj_type2":
            return self._TYPE2_LRS.get(epoch)
        if self._scheduler_type == "lradj_type3":
            return base_lr if epoch < 3 else base_lr * (0.9 ** ((epoch - 3) // 1))
        if self._scheduler_type == "lradj_3":
            return base_lr if epoch < 10 else base_lr * 0.1
        if self._scheduler_type == "lradj_4":
            return base_lr if epoch < 15 else base_lr * 0.1
        if self._scheduler_type == "lradj_5":
            return base_lr if epoch < 25 else base_lr * 0.1
        if self._scheduler_type == "lradj_6":
            return base_lr if epoch < 5 else base_lr * 0.1
        raise ValueError(f"Unsupported datasci lradj scheduler: {self._scheduler_type}")

    def step(self) -> None:
        self._epoch += 1
        for group, base_lr in zip(self._optimizer.param_groups, self._base_lrs):
            lr = self._lr_for_epoch(self._epoch, base_lr)
            if lr is not None:
                group["lr"] = lr


def _build_scheduler(
    optimizer: torch.optim.Optimizer,
    candidate: dict[str, Any],
    *,
    max_epochs: int,
):
    strategy = _recipe_training_strategy(candidate)
    scheduler_cfg = strategy.get("scheduler", {})
    scheduler_type = scheduler_cfg.get("type", "none")
    warmup_steps = int(scheduler_cfg.get("warmup_steps", 0))
    warmup_steps = max(0, min(warmup_steps, max(max_epochs - 1, 0)))

    remaining_epochs = max(max_epochs - warmup_steps, 1)

    base_scheduler = None
    if scheduler_type == "cosine":
        base_scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=remaining_epochs)
    elif scheduler_type == "one_cycle":
        max_lr = max(float(group["lr"]) for group in optimizer.param_groups)
        pct_start = (warmup_steps / max_epochs) if warmup_steps else 0.3
        return torch.optim.lr_scheduler.OneCycleLR(
            optimizer, max_lr=max_lr, total_steps=max(max_epochs, 1), pct_start=pct_start,
        )
    elif scheduler_type == "plateau":
        base_scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
            optimizer,
            mode="min",
            factor=float(scheduler_cfg.get("factor", 0.5)),
            patience=int(scheduler_cfg.get("patience", 1)),
        )
    elif scheduler_type in {
        "lradj_type1",
        "lradj_type2",
        "lradj_type3",
        "lradj_3",
        "lradj_4",
        "lradj_5",
        "lradj_6",
    }:
        base_scheduler = _DatasciLrAdjustScheduler(optimizer, scheduler_type)
    elif scheduler_type not in {None, "none"}:
        raise ValueError(f"Unsupported scheduler: {scheduler_type}")

    if warmup_steps > 0:
        return _LinearWarmupWrapper(optimizer, warmup_steps, base_scheduler)
    return base_scheduler


def _step_scheduler(scheduler, val_loss: float) -> None:
    if isinstance(scheduler, _LinearWarmupWrapper):
        scheduler.step(val_loss)
    elif isinstance(scheduler, torch.optim.lr_scheduler.ReduceLROnPlateau):
        scheduler.step(val_loss)
    else:
        scheduler.step()


def _grad_clip(candidate: dict[str, Any]) -> float | None:
    strategy = _recipe_training_strategy(candidate)
    value = strategy.get("regularization", {}).get("grad_clip")
    if value is None:
        return None
    return float(value)


def _make_run_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    suffix = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(4))
    return f"{stamp}-{suffix}"


def save_run_artifacts(
    *,
    artifact_dir: Path,
    run_id: str,
    candidate: dict[str, Any],
    family_spec: dict[str, Any],
    models: dict[int, nn.Module],
    val_results: dict[str, float],
    training_summary: dict[str, Any],
) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)

    model_path = artifact_dir / "model.pt"
    val_metrics_path = artifact_dir / "val_metrics.json"
    training_summary_path = artifact_dir / "training_summary.json"
    resolved_candidate_path = artifact_dir / "resolved_candidate.json"
    preprocess_path = artifact_dir / "preprocess.json"

    torch.save(
        {
            "runtime_semantics_revision": training_summary.get("runtime_semantics_revision", 2),
            "model_manifests": training_summary.get("model_manifests", {}),
            "model_manifest_digest": training_summary.get("model_manifest_digest"),
            "run_id": run_id,
            "candidate": candidate,
            "model_family": candidate["model_family"],
            "dataset_schema_version": ACTIVE_SPEC.schema_version,
            "input_len": INPUT_LEN,
            "target_channels": NUM_CHANNELS,
            "past_exogenous_channels": len(PAST_COVARIATE_COLUMNS),
            "future_exogenous_channels": len(KNOWN_FUTURE_COVARIATES),
            "state_dict_layout": family_spec["state_dict_layout"],
            "state_dicts": {str(h): model.state_dict() for h, model in models.items()},
        },
        model_path,
    )
    val_metrics_path.write_text(f"{json.dumps(val_results, indent=2, sort_keys=True)}\n", encoding="utf-8")
    training_summary_path.write_text(
        f"{json.dumps(training_summary, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    resolved_candidate_path.write_text(f"{json.dumps(candidate, indent=2, sort_keys=True)}\n", encoding="utf-8")
    preprocess_path.write_text(
        f"{json.dumps(build_preprocess_spec(), indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )


@deduplicate_training
def train_models(
    *,
    candidate: dict[str, Any],
    smoke: bool,
    artifact_root: Path,
    experiment_identity: dict | None = None,
    artifact_callback=None,
    execution_contract_path: str | None = None,
    candidate_path: str | None = None,
    verification_path: str | None = None,
) -> int:
    train_config = candidate["train_config"]
    constraints = candidate["constraints"]
    smoke_config = candidate["smoke_config"]
    family_name = candidate["model_family"]
    family_module = FAMILY_REGISTRY[family_name]
    family_spec = family_module.FAMILY_SPEC

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats(device)
    torch.set_float32_matmul_precision("high")

    horizons = (smoke_config["horizon"],) if smoke else tuple(candidate["task"]["horizons"])
    batch_size = int(smoke_config["batch_size"]) if smoke else int(train_config["batch_size"])
    max_epochs = int(smoke_config["max_epochs"]) if smoke else int(train_config["max_epochs"])
    time_budget_s = int(smoke_config["timeout_s"]) if smoke else int(constraints["time_budget_s"])
    lr = float(train_config["lr"])
    weight_decay = float(train_config["weight_decay"])
    patience = int(train_config["patience"])

    emit(
        "stage_start",
        stage="smoke" if smoke else "full",
        candidate_id=candidate["candidate_id"],
        model_family=family_name,
    )

    t_start = time.time()
    input_len = int(candidate.get("task", {}).get("input_len", INPUT_LEN))
    models = {h: _build_runtime_model(family_module, candidate, input_len, h).to(device) for h in horizons}
    if execution_contract_path:
        from execution_contract import load_contract, verify_models, digest
        try:
            contract = load_contract(execution_contract_path)
            if not candidate_path:
                raise ValueError("Missing candidate path for execution contract")
            manifests, mismatches = verify_models(contract, list(models.values()), candidate_path, candidate)
            for manifest in manifests:
                emit("executed_model_manifest", **{k: v for k, v in manifest.items() if k != "event"})
            if not smoke:
                verification = json.loads(Path(verification_path or "").read_text())
                if verification.get("contract_digest") != digest(contract) or verification.get("candidate_id") != contract["candidate_id"] or verification.get("status") != "verified":
                    mismatches.append({"path": "smoke_verification", "expected": digest(contract), "actual": verification})
            if mismatches:
                emit("execution_contract_violation", status="invalid", contract_digest=digest(contract), mismatches=mismatches)
                return 5
            verification = {"event": "execution_contract_verified", "status": "verified", "candidate_id": contract["candidate_id"], "candidate_spec_sha256": contract["candidate_spec_sha256"], "contract_digest": digest(contract), "manifest": manifests[-1]}
            emit("execution_contract_verified", **{k: v for k, v in verification.items() if k != "event"})
            if smoke and verification_path:
                Path(verification_path).parent.mkdir(parents=True, exist_ok=True)
                Path(verification_path).write_text(json.dumps(verification) + "\n", encoding="utf-8")
        except Exception as exc:
            emit("execution_contract_violation", status="invalid", mismatches=[{"path": "contract", "expected": "valid contract and verification", "actual": str(exc)}])
            return 5
    num_params = sum(param.numel() for model in models.values() for param in model.parameters())
    num_params_m = num_params / 1e6
    param_budget_m = float(constraints["param_budget_m"])

    if num_params_m > param_budget_m:
        emit(
            "error",
            kind="param_budget_exceeded",
            candidate_id=candidate["candidate_id"],
            num_params_m=round(num_params_m, 6),
            allowed_m=round(param_budget_m, 6),
        )
        emit("done", status="smoke_fail" if smoke else "full_fail")
        return 3

    loss_fn = _build_train_loss(candidate)
    predict_fn = lambda model, x: _predict_for_training(model, candidate, _slice_context_window(x, input_len))
    grad_clip = _grad_clip(candidate)
    optimizers = {
        h: _build_optimizer(models[h], candidate, lr=lr, weight_decay=weight_decay)
        for h in horizons
    }
    schedulers = {
        h: _build_scheduler(optimizers[h], candidate, max_epochs=max_epochs)
        for h in horizons
    }
    calendar = {"include_calendar": True} if any(getattr(m, "embedding_type", None) == "calendar" for m in models.values()) else {}
    if any(getattr(m, "uses_missing_mask", False) for m in models.values()):
        calendar["include_missing_mask"] = True
    train_loaders = {h: make_dataloader("train", h, batch_size, shuffle=True, **calendar) for h in horizons}
    val_loaders = {h: make_dataloader("val", h, batch_size, shuffle=False, **calendar) for h in horizons}
    latency_by_horizon = {}
    if "max_latency_ms" in constraints:
        for h, model in models.items():
            inputs, _ = _move_batch(next(iter(val_loaders[h])), device)
            latency_by_horizon[h] = measure_latency_ms(model, _slice_context_window(inputs, input_len))
        measured = max(latency_by_horizon.values())
        emit("latency_measured", batch_size=1, statistic="median_10_after_3_warmups", latency_ms=measured, by_horizon=latency_by_horizon, device=str(device))
        if measured > float(constraints["max_latency_ms"]):
            emit("error", kind="latency_budget_exceeded", measured_ms=measured, allowed_ms=constraints["max_latency_ms"])
            emit("done", status="smoke_fail" if smoke else "full_fail")
            return 3
    first_batch = next(iter(train_loaders[horizons[0]]))
    if isinstance(first_batch, dict):
        first_batch_shapes = {key: list(value.shape) for key, value in first_batch.items()}
    else:
        first_batch_shapes = {"input": list(first_batch[0].shape), "target": list(first_batch[1].shape)}

    best_states = {h: copy.deepcopy(models[h].state_dict()) for h in horizons}
    best_val_losses = {h: float("inf") for h in horizons}
    patience_counters = {h: 0 for h in horizons}
    stopped = {h: False for h in horizons}
    timed_out = False
    update_counts = {h: 0 for h in horizons}

    def mark_timeout() -> None:
        nonlocal timed_out
        if timed_out:
            return
        timed_out = True
        emit("timeout", elapsed_s=round(time.time() - t_start, 3), budget_s=time_budget_s)

    for epoch in range(1, max_epochs + 1):
        if time.time() - t_start >= time_budget_s:
            mark_timeout()
            break

        active_horizons = [h for h in horizons if not stopped[h]]
        if not active_horizons:
            break

        for horizon in active_horizons:
            if time.time() - t_start >= time_budget_s:
                mark_timeout()
                break

            def _on_batch(batch_idx: int, _h: int = horizon, _e: int = epoch) -> None:
                emit("batch_progress", horizon=_h, epoch=_e, batch=batch_idx, elapsed_s=round(time.time() - t_start, 1))

            updates = run_epoch(
                models[horizon],
                train_loaders[horizon],
                optimizers[horizon],
                device,
                loss_fn,
                grad_clip,
                predict_fn,
                on_batch=_on_batch,
                deadline=t_start + time_budget_s,
            )
            update_counts[horizon] += updates or 0
            val_loss = compute_val_loss(models[horizon], val_loaders[horizon], device, predict_fn)
            if schedulers[horizon] is not None:
                _step_scheduler(schedulers[horizon], val_loss)
            emit("epoch_end", horizon=horizon, epoch=epoch, val_loss=round(val_loss, 6))

            if val_loss < best_val_losses[horizon]:
                best_val_losses[horizon] = val_loss
                best_states[horizon] = copy.deepcopy(models[horizon].state_dict())
                patience_counters[horizon] = 0
            else:
                patience_counters[horizon] += 1
                if patience_counters[horizon] >= patience:
                    stopped[horizon] = True
                    emit(
                        "horizon_done",
                        horizon=horizon,
                        best_val_loss=round(best_val_losses[horizon], 6),
                        reason="early_stopping",
                    )
        if timed_out:
            break

    if any(getattr(model, "runtime_semantics_revision", 2) == 3 for model in models.values()) and any(count == 0 for count in update_counts.values()):
        emit("error", kind="untrained_horizon", message="Budget expired before every independent horizon received an optimizer update")
        emit("done", status="full_fail" if not smoke else "smoke_fail")
        return 124

    for horizon in horizons:
        models[horizon].load_state_dict(best_states[horizon])
        models[horizon].eval()
        if not stopped[horizon]:
            emit(
                "horizon_done",
                horizon=horizon,
                best_val_loss=round(best_val_losses[horizon], 6),
                reason="timeout" if timed_out else "finished",
            )

    t_train_end = time.time()
    val_results = evaluate_val_tsf(models, device=device, horizons=horizons)
    peak_vram_mb = (
        torch.cuda.max_memory_allocated(device) / 1024 / 1024 if torch.cuda.is_available() else 0.0
    )
    training_summary: dict[str, Any] = {
        **(experiment_identity or {}),
        "export_spec": {key: family_spec[key] for key in ("model_impl_entry", "state_dict_layout")},
        "runtime_semantics_revision": next(iter(models.values())).runtime_semantics_revision if candidate["model_family"] == "recipe_factory" else 2,
        "model_manifests": {str(h): __import__("execution_contract").describe_model(model) for h, model in models.items()},
        "training_seconds": round(t_train_end - t_start, 6),
        "total_seconds": round(time.time() - t_start, 6),
        "peak_vram_mb": round(peak_vram_mb, 6),
        "num_params_M": round(num_params_m, 6),
        **_recipe_execution_summary(candidate),
        "target_columns": list(ACTIVE_SPEC.target_columns),
        "used_observed_past_covariates": list(ACTIVE_SPEC.observed_past_covariates),
        "target_channels": NUM_CHANNELS,
        "past_exogenous_channels": len(PAST_COVARIATE_COLUMNS),
        "future_exogenous_channels": len(KNOWN_FUTURE_COVARIATES),
        "model_input_channels": NUM_CHANNELS + len(PAST_COVARIATE_COLUMNS),
        "model_output_channels": NUM_CHANNELS,
        "first_batch_shapes": first_batch_shapes,
        "latency_ms_by_horizon": latency_by_horizon,
    }
    from execution_contract import digest
    training_summary["model_manifest_digest"] = digest(training_summary["model_manifests"])

    run_id = _make_run_id()
    artifact_dir = _artifact_dir_for_run(artifact_root, run_id, smoke=smoke)
    save_run_artifacts(
        artifact_dir=artifact_dir,
        run_id=run_id,
        candidate=candidate,
        family_spec=family_spec,
        models=models,
        val_results=val_results,
        training_summary=training_summary,
    )
    if smoke:
        if training_summary["runtime_semantics_revision"] == 3:
            from recipe_identity import behavior_probe
            probes = {str(h): behavior_probe(model) for h, model in models.items()}
            (artifact_dir / "behavior_probe.json").write_text(json.dumps(probes, indent=2))
            emit("behavior_probe", path=str(artifact_dir / "behavior_probe.json"), diagnostic_only=True)
        _gc_smoke_artifacts(artifact_root)
    if artifact_callback:
        artifact_callback(artifact_dir)

    emit("smoke_eval_done" if smoke else "eval_done", **{k: round(v, 6) for k, v in val_results.items()})
    emit("artifact_ready", artifact_dir=str(artifact_dir.resolve()), run_id=run_id)
    emit("done", status="success")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run neo-cast TSF training from a resolved candidate.")
    parser.add_argument("--resolved-candidate", default=str(DEFAULT_RESOLVED_CANDIDATE))
    parser.add_argument("--artifacts-dir", default=str(DEFAULT_ARTIFACTS_DIR))
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--execution-contract", default=os.environ.get("NEO_CAST_EXECUTION_CONTRACT"))
    parser.add_argument("--candidate-path", default=os.environ.get("NEO_CAST_CONTRACT_CANDIDATE"))
    parser.add_argument("--contract-verification", default=os.environ.get("NEO_CAST_CONTRACT_VERIFICATION"))
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    resolved_candidate_path = Path(args.resolved_candidate).expanduser()
    artifacts_dir = Path(args.artifacts_dir).expanduser()

    try:
        candidate = _normalize_candidate_model_config(load_resolved_candidate(resolved_candidate_path))
        set_seed(int(candidate["train_config"]["seed"]))
        exit_code = train_models(candidate=candidate, smoke=args.smoke, artifact_root=artifacts_dir, execution_contract_path=args.execution_contract, candidate_path=args.candidate_path, verification_path=args.contract_verification)
    except Exception as exc:  # pragma: no cover - defensive CLI path
        emit("error", kind=exc.__class__.__name__.lower(), message=str(exc))
        emit("done", status="crash")
        raise SystemExit(1) from exc

    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
