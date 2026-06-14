from __future__ import annotations

import random
import string
from typing import Any

from model_recipe import compile_model_recipe, is_model_recipe_payload
from prepare_tsf import INPUT_LEN
from registry.action_specs import validate_recipe_against_registry


def _random_suffix(length: int = 6) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(length))


def is_recipe_payload(payload: dict[str, Any]) -> bool:
    return payload.get("recipe_version") == "recipe_schema_v1"


def to_candidate_recipe(payload: dict[str, Any]) -> dict[str, Any]:
    if is_recipe_payload(payload):
        return payload
    if is_model_recipe_payload(payload):
        return compile_model_recipe(payload)
    raise ValueError("Expected recipe_schema_v1 or model_recipe.v1 payload")


def normalize_recipe_id(recipe: dict[str, Any]) -> str:
    recipe_id = recipe.get("recipe_id")
    if isinstance(recipe_id, str) and recipe_id:
        return recipe_id
    backbone = recipe.get("backbone", {}).get("type", "recipe")
    embedding = recipe.get("embedding", {}).get("type", "none")
    return f"recipe_{embedding}_{backbone}_{_random_suffix()}"


def bridge_validate_recipe(recipe: dict[str, Any]) -> list[str]:
    errors = validate_recipe_against_registry(recipe, input_len=INPUT_LEN, bridge_only=True)
    training_strategy = recipe.get("training_strategy", {})
    loss_base = training_strategy.get("loss", {}).get("base")
    if loss_base != "mse":
        errors.append("Phase A/B bridge only supports training_strategy.loss.base='mse'")
    scheduler = training_strategy.get("scheduler", {})
    scheduler_type = scheduler.get("type", "none")
    warmup_steps = scheduler.get("warmup_steps", 0)
    if scheduler_type != "none" or warmup_steps:
        errors.append("Phase A/B bridge only supports scheduler.type='none' with warmup_steps=0")
    return errors


def _recipe_train_config(recipe: dict[str, Any]) -> dict[str, Any]:
    strategy = recipe["training_strategy"]
    optimizer = strategy["optimizer"]
    budget = strategy["budget"]
    return {
        "lr": float(optimizer["lr"]),
        "batch_size": int(budget.get("batch_size", 32)),
        "max_epochs": int(budget["max_epochs"]),
        "weight_decay": float(optimizer.get("weight_decay", 0.0)),
        "patience": int(budget.get("patience", 7)),
        "seed": int(budget.get("seed", 42)),
    }


def _recipe_constraints(recipe: dict[str, Any]) -> dict[str, Any]:
    strategy_budget = recipe["training_strategy"]["budget"]
    constraints = recipe.get("constraints") or {}
    max_params = constraints.get("max_params")
    return {
        "params_max_million": float(max_params) / 1_000_000 if max_params else 1.0,
        "time_budget_seconds": int(strategy_budget["time_budget_s"]),
        "latency_priority": constraints.get("latency_priority", "medium"),
    }

