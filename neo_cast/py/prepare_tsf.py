"""
Standardized data and evaluation harness for neo-research TSF.

This file is the runtime ground truth for:
- dataset.v1 spec loading
- split boundaries
- scaling behavior
- dataloader construction
- validation metrics

Usage:
    python prepare_tsf.py
    python prepare_tsf.py --materialize-visible --source-csv /path/to/ETTh1.csv
    python prepare_tsf.py --materialize-visible --dataset-preset ettm1 --source-csv /path/to/ETTm1.csv
    python prepare_tsf.py --materialize-visible --dataset-preset weather --source-csv /path/to/weather.csv
    python prepare_tsf.py --materialize-visible --source-csv /path/to/data.csv \
      --task-id custom --timestamp-col date --feature-cols a,b,c \
      --input-len 96 --horizons 24,48 --train-rows 0:1000 --val-rows 1000:1200 --ref-test-rows 1200:1400
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
import torch
from sklearn.preprocessing import StandardScaler
from torch.utils.data import DataLoader, Dataset

from dataset_contract import (
    DEFAULT_ETTH1_SPEC,
    DatasetSpec,
    dataset_preset_names,
    dataset_preset_payload,
    dataset_spec_path,
    infer_contiguous_splits,
    infer_tsl_custom_splits,
    load_dataset_spec,
    parse_column_list,
    parse_int_list,
    parse_row_range,
    project_dataset_spec_path,
    ref_test_data_path,
    resolve_data_root,
    train_data_path,
    visible_data_path,
    write_dataset_spec,
)
from runtime_config import PARAM_BUDGET, PROMOTION_TOKEN_ENV, SEED, TIME_BUDGET

# ---------------------------------------------------------------------------
# Runtime constants from dataset.v1
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(os.environ.get("NEO_CAST_PROJECT_ROOT", Path(__file__).resolve().parent.parent)).expanduser().resolve()
DATA_ROOT = resolve_data_root()
ACTIVE_SPEC = load_dataset_spec(DATA_ROOT)

DATASET = ACTIVE_SPEC.task_id
TIMESTAMP_COL = ACTIVE_SPEC.timestamp_col
FEATURE_COLUMNS = ACTIVE_SPEC.feature_columns
TARGET_COLUMNS = ACTIVE_SPEC.target_columns
OBSERVED_PAST_COVARIATES = ACTIVE_SPEC.observed_past_covariates
KNOWN_FUTURE_COVARIATES = ACTIVE_SPEC.known_future_covariates
PAST_COVARIATE_COLUMNS = tuple(dict.fromkeys((*OBSERVED_PAST_COVARIATES, *KNOWN_FUTURE_COVARIATES)))
STATIC_COVARIATES = ACTIVE_SPEC.static_covariates
TRAIN_DATA_PATH = train_data_path(DATA_ROOT, DATASET)
VISIBLE_DATA_PATH = visible_data_path(DATA_ROOT, DATASET)
REF_TEST_DATA_PATH = ref_test_data_path(DATA_ROOT, DATASET)
DEFAULT_RAW_DATA_PATH = DATA_ROOT / "ETTh1.csv"

NUM_CHANNELS = len(TARGET_COLUMNS)
INPUT_LEN = ACTIVE_SPEC.input_len
HORIZONS = ACTIVE_SPEC.horizons

BORDER_TRAIN = ACTIVE_SPEC.train
BORDER_VAL = ACTIVE_SPEC.val
BORDER_TEST = ACTIVE_SPEC.ref_test
# The materialized visible file always represents the original train+val
# interval. CV overrides only change the active training/evaluation boundaries.
VISIBLE_DATA_ROWS = (ACTIVE_SPEC.train[0], ACTIVE_SPEC.val[1])

CV_TRAIN_ROWS_ENV = "NEO_CAST_TRAIN_ROWS"
CV_VAL_ROWS_ENV = "NEO_CAST_VAL_ROWS"
CV_FOLD_INDEX_ENV = "NEO_CAST_CV_FOLD_INDEX"


def _parse_cv_row_override(name: str, value: str) -> tuple[int, int]:
    parts = value.split(":")
    if len(parts) != 2:
        raise ValueError(f"{name} must use start:end integer syntax, got {value!r}")
    try:
        start, end = (int(part) for part in parts)
    except ValueError as exc:
        raise ValueError(f"{name} must use start:end integer syntax, got {value!r}") from exc
    if start < 0 or end <= start:
        raise ValueError(f"{name} must be a non-empty non-negative range, got {value!r}")
    return start, end


def _split_bounds_with_cv_override(
    train_rows: tuple[int, int],
    val_rows: tuple[int, int],
    ref_test_rows: tuple[int, int],
) -> tuple[tuple[int, int], tuple[int, int]]:
    train_raw = os.environ.get(CV_TRAIN_ROWS_ENV)
    val_raw = os.environ.get(CV_VAL_ROWS_ENV)
    if (train_raw is None) != (val_raw is None):
        raise ValueError(f"{CV_TRAIN_ROWS_ENV} and {CV_VAL_ROWS_ENV} must be provided together")
    if train_raw is None:
        return train_rows, val_rows

    override_train = _parse_cv_row_override(CV_TRAIN_ROWS_ENV, train_raw)
    override_val = _parse_cv_row_override(CV_VAL_ROWS_ENV, val_raw or "")
    visible_start, visible_end = train_rows[0], val_rows[1]
    if not (visible_start <= override_train[0] < override_train[1] <= visible_end):
        raise ValueError(f"CV train override {override_train} is outside visible rows {(visible_start, visible_end)}")
    if not (visible_start <= override_val[0] < override_val[1] <= visible_end):
        raise ValueError(f"CV val override {override_val} is outside visible rows {(visible_start, visible_end)}")
    if override_train[1] > override_val[0]:
        raise ValueError(f"CV train must end at or before val start, got {override_train} and {override_val}")
    if override_val[1] > ref_test_rows[0]:
        raise ValueError(f"CV val override {override_val} touches ref-test starting at {ref_test_rows[0]}")
    return override_train, override_val


BORDER_TRAIN, BORDER_VAL = _split_bounds_with_cv_override(BORDER_TRAIN, BORDER_VAL, BORDER_TEST)

EVAL_BATCH_SIZE = 64
BLIND_TEST_URL_ENV = "NEO_TSF_BLIND_TEST_URL"
BLIND_TEST_TOKEN_ENV = "NEO_TSF_BLIND_TEST_TOKEN"


@dataclass(frozen=True)
class VisibleDataBundle:
    frame: pd.DataFrame
    scaled_values: np.ndarray
    scaler: StandardScaler
    target_values: np.ndarray
    past_covariate_values: np.ndarray
    future_covariate_values: np.ndarray
    target_scaler: StandardScaler
    covariate_scaler: StandardScaler | None
    profile: dict[str, object]


_VISIBLE_BUNDLE: VisibleDataBundle | None = None


def _apply_spec(spec: DatasetSpec) -> None:
    global ACTIVE_SPEC
    global DATASET
    global TIMESTAMP_COL
    global FEATURE_COLUMNS
    global TARGET_COLUMNS
    global OBSERVED_PAST_COVARIATES
    global KNOWN_FUTURE_COVARIATES
    global PAST_COVARIATE_COLUMNS
    global STATIC_COVARIATES
    global TRAIN_DATA_PATH
    global VISIBLE_DATA_PATH
    global REF_TEST_DATA_PATH
    global NUM_CHANNELS
    global INPUT_LEN
    global HORIZONS
    global BORDER_TRAIN
    global BORDER_VAL
    global BORDER_TEST
    global VISIBLE_DATA_ROWS
    global _VISIBLE_BUNDLE

    ACTIVE_SPEC = spec
    DATASET = spec.task_id
    TIMESTAMP_COL = spec.timestamp_col
    FEATURE_COLUMNS = spec.feature_columns
    TARGET_COLUMNS = spec.target_columns
    OBSERVED_PAST_COVARIATES = spec.observed_past_covariates
    KNOWN_FUTURE_COVARIATES = spec.known_future_covariates
    PAST_COVARIATE_COLUMNS = tuple(dict.fromkeys((*OBSERVED_PAST_COVARIATES, *KNOWN_FUTURE_COVARIATES)))
    STATIC_COVARIATES = spec.static_covariates
    TRAIN_DATA_PATH = train_data_path(DATA_ROOT, DATASET)
    VISIBLE_DATA_PATH = visible_data_path(DATA_ROOT, DATASET)
    REF_TEST_DATA_PATH = ref_test_data_path(DATA_ROOT, DATASET)
    NUM_CHANNELS = len(TARGET_COLUMNS)
    INPUT_LEN = spec.input_len
    HORIZONS = spec.horizons
    BORDER_TRAIN = spec.train
    BORDER_VAL = spec.val
    BORDER_TEST = spec.ref_test
    VISIBLE_DATA_ROWS = (spec.train[0], spec.val[1])
    _VISIBLE_BUNDLE = None


def _expected_columns() -> list[str]:
    return [TIMESTAMP_COL, *FEATURE_COLUMNS]


def _validate_frame(
    df: pd.DataFrame,
    *,
    expected_rows: int | None,
    min_rows: int | None = None,
    context: str,
    allow_missing: bool = False,
) -> None:
    expected_columns = _expected_columns()
    missing_columns = [column for column in expected_columns if column not in df.columns]
    if missing_columns:
        raise ValueError(
            f"{context} missing required columns. "
            f"Expected {expected_columns}, missing {missing_columns}, got {list(df.columns)}"
        )
    if expected_rows is not None and len(df) != expected_rows:
        raise ValueError(
            f"{context} row count mismatch. Expected {expected_rows}, got {len(df)}"
        )
    if min_rows is not None and len(df) < min_rows:
        raise ValueError(
            f"{context} row count mismatch. Expected at least {min_rows}, got {len(df)}"
        )
    if not allow_missing and df[expected_columns].isnull().any().any():
        raise ValueError(f"{context} contains missing values, which is unsupported in the MVP.")
    for column in FEATURE_COLUMNS:
        try:
            pd.to_numeric(df[column])
        except Exception as exc:
            raise ValueError(f"{context} feature column {column!r} must be numeric") from exc


def _profile_time_index(df: pd.DataFrame, timestamp_col: str) -> dict[str, object]:
    timestamps = pd.to_datetime(df[timestamp_col], errors="coerce")
    invalid_count = int(timestamps.isna().sum())
    total_rows = int(len(df))
    duplicate_count = int(timestamps.duplicated().sum()) if invalid_count == 0 else 0
    monotonic_increasing = bool(timestamps.is_monotonic_increasing) if invalid_count == 0 else False

    inferred_frequency = None
    median_delta_seconds = None
    irregular_ratio = 0.0
    irregular_count = 0

    if invalid_count == 0 and total_rows >= 3:
        try:
            inferred_frequency = pd.infer_freq(timestamps)
        except ValueError:
            inferred_frequency = None

        deltas = timestamps.diff().dropna()
        if len(deltas) > 0:
            median_delta = deltas.median()
            median_delta_seconds = float(median_delta.total_seconds())
            irregular_count = int((deltas != median_delta).sum())
            irregular_ratio = float(irregular_count / max(len(deltas), 1))

    return {
        "timestamp_col": timestamp_col,
        "total_rows": total_rows,
        "invalid_timestamp_count": invalid_count,
        "duplicate_timestamp_count": duplicate_count,
        "monotonic_increasing": monotonic_increasing,
        "inferred_frequency": inferred_frequency,
        "median_delta_seconds": median_delta_seconds,
        "irregular_count": irregular_count,
        "irregular_ratio": irregular_ratio,
    }


def _profile_missing(df: pd.DataFrame) -> dict[str, object]:
    feature_missing = {
        column: int(df[column].isna().sum())
        for column in FEATURE_COLUMNS
    }
    return {
        "total_missing": int(sum(feature_missing.values())),
        "feature_missing": feature_missing,
    }


def _build_dataset_profile(df: pd.DataFrame) -> dict[str, object]:
    missing_profile = _profile_missing(df)
    time_profile = _profile_time_index(df, TIMESTAMP_COL)
    return {
        "schema_version": "dataset_profile.v1",
        "task_id": DATASET,
        "rows": int(len(df)),
        "feature_columns": list(FEATURE_COLUMNS),
        "missing": missing_profile,
        "time": time_profile,
    }


def _apply_missing_strategy(df: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, object]]:
    missing_cfg = ACTIVE_SPEC.missing
    strategy = str(missing_cfg.get("strategy", "forward_fill"))
    limit = missing_cfg.get("limit")
    before = _profile_missing(df)
    feature_columns = list(FEATURE_COLUMNS)

    if before["total_missing"] == 0:
        return df.copy(), {
            "strategy": strategy,
            "limit": limit,
            "total_missing_before": 0,
            "total_missing_after": 0,
            "rows_before": int(len(df)),
            "rows_after": int(len(df)),
        }

    cleaned = df.copy()
    if strategy == "reject":
        raise ValueError(
            f"full source CSV contains missing feature values: {before['feature_missing']}. "
            "Use --missing-strategy forward_fill|mean_fill|linear_interpolate|drop to handle them."
        )
    if strategy == "drop":
        cleaned = cleaned.dropna(subset=feature_columns).reset_index(drop=True)
    elif strategy == "forward_fill":
        cleaned[feature_columns] = cleaned[feature_columns].ffill(limit=limit).bfill()
    elif strategy == "mean_fill":
        cleaned[feature_columns] = cleaned[feature_columns].fillna(cleaned[feature_columns].mean(numeric_only=True))
    elif strategy == "linear_interpolate":
        cleaned[feature_columns] = (
            cleaned[feature_columns]
            .interpolate(method="linear", limit=limit, limit_direction="both")
            .ffill()
            .bfill()
        )
    else:
        raise ValueError(f"Unsupported missing strategy: {strategy}")

    after = _profile_missing(cleaned)
    if after["total_missing"] != 0:
        raise ValueError(f"Missing strategy {strategy!r} left missing values: {after['feature_missing']}")

    return cleaned, {
        "strategy": strategy,
        "limit": limit,
        "total_missing_before": int(before["total_missing"]),
        "total_missing_after": int(after["total_missing"]),
        "rows_before": int(len(df)),
        "rows_after": int(len(cleaned)),
        "feature_missing_before": before["feature_missing"],
    }


def _enforce_time_policy(profile: dict[str, object]) -> None:
    time_profile = profile["time"]
    assert isinstance(time_profile, dict)
    if int(time_profile["invalid_timestamp_count"]) > 0:
        raise ValueError(f"Invalid timestamps found: {time_profile['invalid_timestamp_count']}")
    if int(time_profile["duplicate_timestamp_count"]) > 0:
        raise ValueError(f"Duplicate timestamps found: {time_profile['duplicate_timestamp_count']}")
    if not bool(time_profile["monotonic_increasing"]):
        raise ValueError("Timestamp column must be monotonic increasing in the current loader")

    irregular_ratio = float(time_profile["irregular_ratio"])
    if irregular_ratio > 0.0 and not ACTIVE_SPEC.time["allow_irregular"]:
        raise ValueError(
            f"Irregular timestamp intervals detected: irregular_ratio={irregular_ratio:.6f}. "
            "Set --allow-irregular to permit row-based windowing."
        )
    warn_threshold = float(ACTIVE_SPEC.time["irregular_ratio_warn"])
    if irregular_ratio > warn_threshold:
        print(
            f"dataset_warning: irregular_ratio={irregular_ratio:.6f} exceeds warn threshold {warn_threshold:.6f}; "
            "current training still uses row-based windows.",
            flush=True,
        )


def _infer_feature_columns(df: pd.DataFrame, timestamp_col: str) -> list[str]:
    if timestamp_col not in df.columns:
        raise ValueError(f"timestamp_col {timestamp_col!r} not found in source CSV")
    candidates: list[str] = []
    for column in df.columns:
        if column == timestamp_col:
            continue
        if pd.api.types.is_numeric_dtype(df[column]):
            candidates.append(str(column))
    if not candidates:
        raise ValueError(
            "No numeric feature columns could be inferred. "
            "Pass --feature-cols col1,col2,... explicitly."
        )
    return candidates


def _build_materialize_spec(
    *,
    df: pd.DataFrame,
    dataset_preset: str | None,
    task_id: str | None,
    timestamp_col: str | None,
    feature_columns: list[str] | None,
    target_columns: list[str] | None = None,
    observed_past_covariates: list[str] | None = None,
    known_future_covariates: list[str] | None = None,
    static_covariates: list[str] | None = None,
    known_future_source: str | None = None,
    known_future_available: bool | None = None,
    experiment_scope: str | None = None,
    input_len: int | None = None,
    horizons: list[int] | None = None,
    train_rows: tuple[int, int] | None = None,
    val_rows: tuple[int, int] | None = None,
    ref_test_rows: tuple[int, int] | None = None,
    split_strategy: str | None = None,
    missing_strategy: str | None = None,
    missing_limit: int | None = None,
    frequency: str | None = None,
    allow_irregular: bool | None = None,
    irregular_ratio_warn: float | None = None,
) -> DatasetSpec:
    default_payload = dataset_preset_payload(dataset_preset)
    use_preset_policy = dataset_preset is not None
    default_spec = DatasetSpec.from_payload(
        {
            **DEFAULT_ETTH1_SPEC,
            **{key: value for key, value in default_payload.items() if key in DEFAULT_ETTH1_SPEC},
            "feature_columns": default_payload.get("feature_columns") or DEFAULT_ETTH1_SPEC["feature_columns"],
        }
    )
    selected_task_id = task_id or default_spec.task_id
    selected_timestamp_col = timestamp_col or default_spec.timestamp_col
    preset_feature_columns = default_payload.get("feature_columns")
    selected_feature_columns = feature_columns or (
        list(preset_feature_columns)
        if use_preset_policy and isinstance(preset_feature_columns, list)
        else _infer_feature_columns(df, selected_timestamp_col)
    )
    selected_input_len = input_len or default_spec.input_len
    selected_horizons = horizons or list(default_spec.horizons)
    use_role_contract = target_columns is not None
    if use_role_contract and feature_columns is not None:
        raise ValueError("--feature-cols cannot be combined with dataset.v2 role columns")
    selected_target_columns = target_columns or selected_feature_columns
    selected_observed = observed_past_covariates or []
    selected_known_future: list[str] = []
    selected_static = static_covariates or []

    preset_split_strategy = default_payload.get("split_strategy") if use_preset_policy else None
    effective_split_strategy = split_strategy or (
        preset_split_strategy if isinstance(preset_split_strategy, str) else None
    ) or "tsl_custom_70_10_20"

    if train_rows and val_rows and ref_test_rows:
        splits = {
            "train": train_rows,
            "val": val_rows,
            "ref_test": ref_test_rows,
        }
    elif use_preset_policy and default_payload.get("split_strategy") == "fixed":
        splits = {
            "train": default_spec.train,
            "val": default_spec.val,
            "ref_test": default_spec.ref_test,
        }
    elif effective_split_strategy == "tsl_custom_70_10_20":
        splits = infer_tsl_custom_splits(len(df), selected_input_len, max(selected_horizons))
    elif effective_split_strategy == "contiguous_60_20_20":
        splits = infer_contiguous_splits(len(df), selected_input_len, max(selected_horizons))
    else:
        raise ValueError(f"Unsupported split_strategy: {effective_split_strategy}")

    role_payload = (
        {
            "target_columns": selected_target_columns,
            "observed_past_covariates": selected_observed,
            "known_future_covariates": selected_known_future,
            "static_covariates": selected_static,
            **({"experiment_scope": experiment_scope} if experiment_scope else {}),
        }
        if use_role_contract
        else {"feature_columns": selected_feature_columns}
    )
    return DatasetSpec.from_payload(
        {
            "schema_version": "dataset.v2" if use_role_contract else "dataset.v1",
            "task_id": selected_task_id,
            "timestamp_col": selected_timestamp_col,
            **role_payload,
            "input_len": selected_input_len,
            "horizons": selected_horizons,
            "splits": {
                "train": list(splits["train"]),
                "val": list(splits["val"]),
                "ref_test": list(splits["ref_test"]),
            },
            "normalization": {"type": "standard", "fit_split": "train"},
            "missing": {
                "strategy": missing_strategy or default_spec.missing["strategy"],
                "limit": missing_limit,
            },
            "time": {
                "frequency": frequency or default_spec.time["frequency"],
                "allow_irregular": (
                    bool(allow_irregular)
                    if allow_irregular is not None
                    else bool(default_spec.time["allow_irregular"])
                ),
                "irregular_ratio_warn": (
                    float(irregular_ratio_warn)
                    if irregular_ratio_warn is not None
                    else float(default_spec.time["irregular_ratio_warn"])
                ),
            },
        }
    )


def materialize_visible_splits(
    source_csv: str | Path | None = None,
    *,
    force: bool = False,
    dataset_preset: str | None = None,
    task_id: str | None = None,
    timestamp_col: str | None = None,
    feature_columns: list[str] | None = None,
    target_columns: list[str] | None = None,
    observed_past_covariates: list[str] | None = None,
    known_future_covariates: list[str] | None = None,
    static_covariates: list[str] | None = None,
    known_future_source: str | None = None,
    known_future_available: bool | None = None,
    experiment_scope: str | None = None,
    input_len: int | None = None,
    horizons: list[int] | None = None,
    train_rows: tuple[int, int] | None = None,
    val_rows: tuple[int, int] | None = None,
    ref_test_rows: tuple[int, int] | None = None,
    split_strategy: str | None = None,
    missing_strategy: str | None = None,
    missing_limit: int | None = None,
    frequency: str | None = None,
    allow_irregular: bool | None = None,
    irregular_ratio_warn: float | None = None,
) -> dict[str, Path]:
    """
    Create the agent-visible and runner-only split files from a full source CSV.

    Built-in presets cover ETTh1, ETTm1, Weather, and Traffic with TSL-compatible
    split boundaries. Custom tasks can still pass explicit row ranges.
    """
    source_path = Path(source_csv).expanduser() if source_csv is not None else DEFAULT_RAW_DATA_PATH
    if not source_path.exists():
        raise FileNotFoundError(
            f"Source CSV not found: {source_path}. "
            f"Provide --source-csv /path/to/ETTh1.csv or place ETTh1.csv under {DATA_ROOT}"
        )

    df = pd.read_csv(source_path)
    spec = _build_materialize_spec(
        df=df,
        dataset_preset=dataset_preset,
        task_id=task_id,
        timestamp_col=timestamp_col,
        feature_columns=feature_columns,
        target_columns=target_columns,
        observed_past_covariates=observed_past_covariates,
        known_future_covariates=known_future_covariates,
        static_covariates=static_covariates,
        known_future_source=known_future_source,
        known_future_available=known_future_available,
        experiment_scope=experiment_scope,
        input_len=input_len,
        horizons=horizons,
        train_rows=train_rows,
        val_rows=val_rows,
        ref_test_rows=ref_test_rows,
        split_strategy=split_strategy,
        missing_strategy=missing_strategy,
        missing_limit=missing_limit,
        frequency=frequency,
        allow_irregular=allow_irregular,
        irregular_ratio_warn=irregular_ratio_warn,
    )
    _apply_spec(spec)
    _validate_frame(df, expected_rows=None, min_rows=BORDER_TEST[1], context="full source CSV", allow_missing=True)
    df = df[_expected_columns()].copy()
    raw_profile = _build_dataset_profile(df)
    _enforce_time_policy(raw_profile)
    df, missing_action = _apply_missing_strategy(df)
    _validate_frame(df, expected_rows=None, min_rows=BORDER_TEST[1], context="cleaned source CSV")
    prepared_profile = _build_dataset_profile(df)
    _enforce_time_policy(prepared_profile)
    prepared_profile["missing_action"] = missing_action
    df = df.iloc[: BORDER_TEST[1]].copy()

    if not force:
        for path in (TRAIN_DATA_PATH, VISIBLE_DATA_PATH, REF_TEST_DATA_PATH):
            if path.exists():
                raise FileExistsError(
                    f"{path} already exists. Re-run with --force to overwrite prepared split files."
                )

    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    write_dataset_spec(spec, DATA_ROOT, PROJECT_ROOT)
    for spec_path in (dataset_spec_path(DATA_ROOT), project_dataset_spec_path(PROJECT_ROOT)):
        payload = json.loads(spec_path.read_text(encoding="utf-8"))
        payload["source_csv"] = str(source_path.expanduser().resolve())
        spec_path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")
    profile_path = DATA_ROOT / f"{DATASET}_profile.json"
    profile_path.write_text(f"{json.dumps(prepared_profile, indent=2, sort_keys=True)}\n", encoding="utf-8")

    train_df = df.iloc[BORDER_TRAIN[0] : BORDER_TRAIN[1]].copy()
    visible_df = df.iloc[: VISIBLE_DATA_ROWS[1]].copy()
    ref_test_df = df.iloc[BORDER_TEST[0] : BORDER_TEST[1]].copy()

    train_df.to_csv(TRAIN_DATA_PATH, index=False)
    visible_df.to_csv(VISIBLE_DATA_PATH, index=False)
    ref_test_df.to_csv(REF_TEST_DATA_PATH, index=False)

    global _VISIBLE_BUNDLE
    _VISIBLE_BUNDLE = None

    return {
        "train": TRAIN_DATA_PATH,
        "visible": VISIBLE_DATA_PATH,
        "ref_test": REF_TEST_DATA_PATH,
        "profile": profile_path,
    }


def _load_visible_bundle() -> VisibleDataBundle:
    global _VISIBLE_BUNDLE
    if _VISIBLE_BUNDLE is not None:
        return _VISIBLE_BUNDLE

    if not VISIBLE_DATA_PATH.exists():
        raise FileNotFoundError(
            "Prepared visible dataset not found.\n"
            f"Expected: {VISIBLE_DATA_PATH}\n"
            "Run one of:\n"
            "  python prepare_tsf.py --materialize-visible --source-csv /path/to/ETTh1.csv\n"
            f"  python prepare_tsf.py --materialize-visible --source-csv {DEFAULT_RAW_DATA_PATH}"
        )

    df = pd.read_csv(VISIBLE_DATA_PATH)
    _validate_frame(df, expected_rows=VISIBLE_DATA_ROWS[1], context="visible dataset")

    feature_values = df[list(FEATURE_COLUMNS)].to_numpy(dtype=np.float32)
    target_raw = df[list(TARGET_COLUMNS)].to_numpy(dtype=np.float32)
    target_scaler = StandardScaler()
    target_scaler.fit(target_raw[BORDER_TRAIN[0] : BORDER_TRAIN[1]])
    target_values = target_scaler.transform(target_raw).astype(np.float32)

    covariate_columns = tuple(dict.fromkeys((*PAST_COVARIATE_COLUMNS, *STATIC_COVARIATES)))
    covariate_scaler: StandardScaler | None = None
    scaled_covariates = np.empty((len(df), 0), dtype=np.float32)
    if covariate_columns:
        covariate_raw = df[list(covariate_columns)].to_numpy(dtype=np.float32)
        covariate_scaler = StandardScaler()
        covariate_scaler.fit(covariate_raw[BORDER_TRAIN[0] : BORDER_TRAIN[1]])
        scaled_covariates = covariate_scaler.transform(covariate_raw).astype(np.float32)
    covariate_index = {column: index for index, column in enumerate(covariate_columns)}
    past_covariate_values = (
        scaled_covariates[:, [covariate_index[column] for column in PAST_COVARIATE_COLUMNS]]
        if PAST_COVARIATE_COLUMNS
        else np.empty((len(df), 0), dtype=np.float32)
    )
    future_covariate_values = (
        scaled_covariates[:, [covariate_index[column] for column in KNOWN_FUTURE_COVARIATES]]
        if KNOWN_FUTURE_COVARIATES
        else np.empty((len(df), 0), dtype=np.float32)
    )
    # Retain the v1 aliases used by existing callers.
    scaler = target_scaler
    scaled_values = target_values
    profile = _build_dataset_profile(df)

    _VISIBLE_BUNDLE = VisibleDataBundle(
        frame=df,
        scaled_values=scaled_values,
        scaler=scaler,
        target_values=target_values,
        past_covariate_values=past_covariate_values,
        future_covariate_values=future_covariate_values,
        target_scaler=target_scaler,
        covariate_scaler=covariate_scaler,
        profile=profile,
    )
    return _VISIBLE_BUNDLE


def calendar_values(timestamps) -> np.ndarray:
    dates = pd.DatetimeIndex(pd.to_datetime(timestamps, errors="raise", utc=True))
    if dates.isna().any():
        raise ValueError("calendar embedding requires valid timestamps")
    return np.stack([dates.hour, dates.dayofweek, dates.day, dates.month], axis=-1).astype(np.float32)


class WindowDataset(Dataset):
    def __init__(self, split: str, horizon: int, include_calendar: bool = False) -> None:
        if split not in {"train", "val"}:
            raise ValueError(f"Unsupported split: {split}. Agent-visible splits are only 'train' and 'val'.")
        if horizon not in HORIZONS:
            raise ValueError(f"Unsupported horizon: {horizon}. Supported horizons: {HORIZONS}")

        bundle = _load_visible_bundle()
        self.calendar = calendar_values(bundle.frame[TIMESTAMP_COL]) if include_calendar else None
        self.values = bundle.scaled_values
        self.target_values = bundle.target_values
        self.past_covariate_values = bundle.past_covariate_values
        self.future_covariate_values = bundle.future_covariate_values
        self.horizon = horizon
        self.split = split

        if split == "train":
            self.context_start = BORDER_TRAIN[0]
            self.split_end = BORDER_TRAIN[1]
        else:
            # Match TSL semantics: validation windows can use train-tail context.
            self.context_start = BORDER_VAL[0] - INPUT_LEN
            self.split_end = BORDER_VAL[1]

        self.num_windows = self.split_end - self.context_start - INPUT_LEN - horizon + 1
        if self.num_windows <= 0:
            raise ValueError(
                f"No windows available for split={split}, horizon={horizon}. "
                f"context_start={self.context_start}, split_end={self.split_end}"
            )

    def __len__(self) -> int:
        return self.num_windows

    def __getitem__(self, index: int):
        start = self.context_start + index
        end = start + INPUT_LEN
        target_end = end + self.horizon

        if ACTIVE_SPEC.schema_version == "dataset.v1" and self.calendar is None:
            x = self.values[start:end]
            y = self.values[end:target_end]
            return torch.from_numpy(x), torch.from_numpy(y)
        return {
            "target_history": torch.from_numpy(self.target_values[start:end]),
            "exogenous_past": torch.from_numpy(self.past_covariate_values[start:end]),
            "exogenous_future": torch.from_numpy(self.future_covariate_values[end:target_end]),
            "target": torch.from_numpy(self.target_values[end:target_end]),
            **({"calendar_features": torch.from_numpy(self.calendar[start:end])} if self.calendar is not None else {}),
        }


def make_dataloader(split: str, horizon: int, batch_size: int, shuffle: bool | None = None, include_calendar: bool = False) -> DataLoader:
    dataset = WindowDataset(split=split, horizon=horizon, include_calendar=include_calendar)
    if shuffle is None:
        shuffle = split == "train"
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        num_workers=0,
        drop_last=False,
        pin_memory=torch.cuda.is_available(),
    )


def _quantile_levels(model) -> list[float]:
    levels = getattr(model, "quantiles", None)
    if levels is None:
        head = getattr(model, "prediction_head", None)
        levels = getattr(head, "quantiles", None)
    if levels is None:
        return []
    try:
        return [float(value) for value in levels]
    except (TypeError, ValueError):
        return []


def _move_batch(batch, device: torch.device):
    if isinstance(batch, dict):
        moved = {key: value.to(device) for key, value in batch.items()}
        return moved, moved["target"]
    x, y = batch
    return x.to(device), y.to(device)


def _model_inputs(x):
    if isinstance(x, dict):
        return {
            "target_history": x["target_history"],
            "exogenous_past": x["exogenous_past"],
            "exogenous_future": x["exogenous_future"],
            **({"calendar_features": x["calendar_features"]} if "calendar_features" in x else {}),
        }
    return x


def _forward_model(model, x, *, quantiles: bool = False, distribution: bool = False):
    method = model.forward_distribution if distribution else (model.forward_quantiles if quantiles else model)
    inputs = _model_inputs(x)
    return method(**inputs) if isinstance(inputs, dict) else method(inputs)


def _empty_probabilistic_state() -> dict[str, object]:
    return {
        "pinball_sum": 0.0,
        "pinball_count": 0,
        "coverage_sum": 0.0,
        "width_sum": 0.0,
        "interval_count": 0,
        "interval_label": None,
        "gaussian_nll_sum": 0.0,
        "gaussian_count": 0,
    }


def _update_probabilistic_state(
    state: dict[str, object],
    model,
    x,
    y: torch.Tensor,
    *,
    horizon: int,
    prefix: str,
) -> None:
    if getattr(model, "head_cfg", {}).get("output_distribution") == "gaussian":
        mean, scale = _forward_model(model, x, distribution=True)
        nll = torch.nn.functional.gaussian_nll_loss(mean, y, scale.square(), full=True, reduction="sum")
        state["gaussian_nll_sum"] += nll.item()
        state["gaussian_count"] += y.numel()
    if not hasattr(model, "forward_quantiles"):
        return
    quantile_levels = _quantile_levels(model)
    if not quantile_levels:
        return

    pred_quantiles = _forward_model(model, x, quantiles=True)
    if isinstance(pred_quantiles, (tuple, list)):
        pred_quantiles = pred_quantiles[0]
    expected_shape = (*y.shape, len(quantile_levels))
    if pred_quantiles.shape != expected_shape:
        raise ValueError(
            f"{prefix} quantile prediction shape mismatch for horizon={horizon}: "
            f"expected {tuple(expected_shape)}, got {tuple(pred_quantiles.shape)}"
        )

    q = pred_quantiles.new_tensor(quantile_levels).view(1, 1, 1, -1)
    error = y.unsqueeze(-1) - pred_quantiles
    pinball = torch.maximum(q * error, (q - 1.0) * error)
    state["pinball_sum"] = float(state["pinball_sum"]) + pinball.sum().item()
    state["pinball_count"] = int(state["pinball_count"]) + pinball.numel()

    if len(quantile_levels) < 2:
        return

    lower_index = min(range(len(quantile_levels)), key=lambda idx: quantile_levels[idx])
    upper_index = max(range(len(quantile_levels)), key=lambda idx: quantile_levels[idx])
    lower_q = quantile_levels[lower_index]
    upper_q = quantile_levels[upper_index]
    interval_label = f"interval_{int(round((upper_q - lower_q) * 100))}"
    lower = pred_quantiles[..., lower_index]
    upper = pred_quantiles[..., upper_index]
    covered = ((y >= lower) & (y <= upper)).to(dtype=torch.float32)
    width = upper - lower
    state["coverage_sum"] = float(state["coverage_sum"]) + covered.sum().item()
    state["width_sum"] = float(state["width_sum"]) + width.sum().item()
    state["interval_count"] = int(state["interval_count"]) + y.numel()
    state["interval_label"] = interval_label


def _finalize_probabilistic_state(state: dict[str, object]) -> dict[str, float]:
    gaussian_metrics = {"gaussian_nll": float(state["gaussian_nll_sum"]) / int(state["gaussian_count"])} if state.get("gaussian_count", 0) else {}
    pinball_count = int(state["pinball_count"])
    if pinball_count <= 0:
        return gaussian_metrics
    pinball = float(state["pinball_sum"]) / pinball_count
    metrics = {
        **gaussian_metrics,
        "pinball": pinball,
        "crps_approx": 2.0 * pinball,
    }
    interval_count = int(state["interval_count"])
    interval_label = state["interval_label"]
    if interval_count > 0 and isinstance(interval_label, str):
        metrics[f"{interval_label}_coverage"] = float(state["coverage_sum"]) / interval_count
        metrics[f"{interval_label}_width"] = float(state["width_sum"]) / interval_count
    return metrics


def _append_probabilistic_averages(
    probabilistic_by_metric: dict[str, list[float]],
    horizon_metrics: dict[str, float],
) -> None:
    for key, value in horizon_metrics.items():
        probabilistic_by_metric.setdefault(key, []).append(value)


def _write_probabilistic_averages(
    results: dict[str, float],
    *,
    prefix: str,
    probabilistic_by_metric: dict[str, list[float]],
) -> None:
    for key, values in probabilistic_by_metric.items():
        results[f"{prefix}_avg_{key}"] = float(np.mean(values))


def evaluate_val_tsf(model_or_models, device: torch.device, horizons: Iterable[int] | None = None) -> dict[str, float]:
    """
    Evaluate all configured horizons on the validation split in scaled space.
    """
    results: dict[str, float] = {}
    mse_by_horizon: list[float] = []
    mae_by_horizon: list[float] = []
    probabilistic_by_metric: dict[str, list[float]] = {}

    selected_horizons = tuple(horizons) if horizons is not None else HORIZONS
    for horizon in selected_horizons:
        model = model_or_models[horizon] if isinstance(model_or_models, dict) else model_or_models
        was_training = model.training
        model.eval()

        calendar = {"include_calendar": True} if getattr(model, "embedding_type", None) == "calendar" else {}
        loader = make_dataloader("val", horizon, batch_size=EVAL_BATCH_SIZE, shuffle=False, **calendar)
        total_sq_error = 0.0
        total_abs_error = 0.0
        total_values = 0
        probabilistic_state = _empty_probabilistic_state()

        with torch.no_grad():
            for batch in loader:
                x, y = _move_batch(batch, device)

                _update_probabilistic_state(
                    probabilistic_state,
                    model,
                    x,
                    y,
                    horizon=horizon,
                    prefix="Validation",
                )

                pred = _forward_model(model, x)
                if isinstance(pred, (tuple, list)):
                    pred = pred[0]
                if pred.shape != y.shape:
                    raise ValueError(
                        f"Prediction shape mismatch for horizon={horizon}: "
                        f"expected {tuple(y.shape)}, got {tuple(pred.shape)}"
                    )

                diff = pred - y
                total_sq_error += diff.pow(2).sum().item()
                total_abs_error += diff.abs().sum().item()
                total_values += diff.numel()

        if was_training:
            model.train()

        mse = total_sq_error / total_values
        mae = total_abs_error / total_values

        results[f"val_h{horizon}_mse"] = mse
        results[f"val_h{horizon}_mae"] = mae
        mse_by_horizon.append(mse)
        mae_by_horizon.append(mae)
        probabilistic_metrics = _finalize_probabilistic_state(probabilistic_state)
        for key, value in probabilistic_metrics.items():
            results[f"val_h{horizon}_{key}"] = value
        _append_probabilistic_averages(probabilistic_by_metric, probabilistic_metrics)

    results["val_avg_mse"] = float(np.mean(mse_by_horizon))
    results["val_avg_mae"] = float(np.mean(mae_by_horizon))
    _write_probabilistic_averages(results, prefix="val", probabilistic_by_metric=probabilistic_by_metric)
    return results


def build_preprocess_spec() -> dict[str, object]:
    bundle = _load_visible_bundle()
    target_scaler = bundle.target_scaler
    payload: dict[str, object] = {
        "schema_version": "preprocess.v2" if ACTIVE_SPEC.schema_version == "dataset.v2" else "preprocess.v1",
        "task_id": DATASET,
        "timestamp_col": TIMESTAMP_COL,
        "feature_names": list(FEATURE_COLUMNS),
        "target_names": list(TARGET_COLUMNS),
        "observed_past_covariate_names": list(OBSERVED_PAST_COVARIATES),
        "known_future_covariate_names": list(KNOWN_FUTURE_COVARIATES),
        "static_covariate_names": list(STATIC_COVARIATES),
        "input_len": INPUT_LEN,
        "horizons": list(HORIZONS),
        "splits": {
            "train": list(BORDER_TRAIN),
            "val": list(BORDER_VAL),
            "ref_test": list(BORDER_TEST),
        },
        "missing": dict(ACTIVE_SPEC.missing),
        "time": dict(ACTIVE_SPEC.time),
        "dataset_profile": bundle.profile,
        "input_space": "raw",
        "model_input_space": "standard_scaled",
        "output_space": "standard_scaled",
        "scaler_mean": target_scaler.mean_.astype(float).tolist(),
        "scaler_std": target_scaler.scale_.astype(float).tolist(),
        "target_scaler": {
            "mean": target_scaler.mean_.astype(float).tolist(),
            "scale": target_scaler.scale_.astype(float).tolist(),
        },
        "target_channels": len(TARGET_COLUMNS),
        "past_exogenous_channels": len(PAST_COVARIATE_COLUMNS),
        "future_exogenous_channels": len(KNOWN_FUTURE_COVARIATES),
        "model_input_channels": len(TARGET_COLUMNS) + len(PAST_COVARIATE_COLUMNS),
        "model_output_channels": len(TARGET_COLUMNS),
    }
    if bundle.covariate_scaler is not None:
        payload["covariate_scaler"] = {
            "mean": bundle.covariate_scaler.mean_.astype(float).tolist(),
            "scale": bundle.covariate_scaler.scale_.astype(float).tolist(),
        }
    return payload


def _load_ref_test_frame() -> pd.DataFrame:
    if not REF_TEST_DATA_PATH.exists():
        raise FileNotFoundError(
            "Prepared ref-test dataset not found.\n"
            f"Expected: {REF_TEST_DATA_PATH}\n"
            "Run one of:\n"
            "  python prepare_tsf.py --materialize-visible --source-csv /path/to/ETTh1.csv\n"
            f"  python prepare_tsf.py --materialize-visible --source-csv {DEFAULT_RAW_DATA_PATH}"
        )

    df = pd.read_csv(REF_TEST_DATA_PATH)
    _validate_frame(df, expected_rows=BORDER_TEST[1] - BORDER_TEST[0], context="ref-test dataset")
    return df


def _build_ref_test_scaled_values() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    bundle = _load_visible_bundle()
    ref_test_df = _load_ref_test_frame()
    target_ref = bundle.target_scaler.transform(
        ref_test_df[list(TARGET_COLUMNS)].to_numpy(dtype=np.float32)
    ).astype(np.float32)
    target_values = np.concatenate([bundle.target_values, target_ref], axis=0)
    if not PAST_COVARIATE_COLUMNS:
        empty = np.empty((len(target_values), 0), dtype=np.float32)
        return target_values, empty, empty
    if bundle.covariate_scaler is None:
        raise ValueError("Covariate scaler is missing for configured covariates")
    covariate_columns = tuple(dict.fromkeys((*PAST_COVARIATE_COLUMNS, *STATIC_COVARIATES)))
    ref_cov = bundle.covariate_scaler.transform(
        ref_test_df[list(covariate_columns)].to_numpy(dtype=np.float32)
    ).astype(np.float32)
    covariate_index = {column: index for index, column in enumerate(covariate_columns)}
    past_ref = ref_cov[:, [covariate_index[column] for column in PAST_COVARIATE_COLUMNS]]
    future_ref = ref_cov[:, [covariate_index[column] for column in KNOWN_FUTURE_COVARIATES]]
    return (
        target_values,
        np.concatenate([bundle.past_covariate_values, past_ref], axis=0),
        np.concatenate([bundle.future_covariate_values, future_ref], axis=0),
    )


def _iter_scaled_windows(
    values: tuple[np.ndarray, np.ndarray, np.ndarray],
    *,
    horizon: int,
    batch_size: int,
    include_calendar: bool = False,
) -> Iterable[tuple[torch.Tensor, torch.Tensor]]:
    context_start = BORDER_TEST[0] - INPUT_LEN
    split_end = BORDER_TEST[1]
    num_windows = split_end - context_start - INPUT_LEN - horizon + 1
    if num_windows <= 0:
        raise ValueError(
            f"No ref-test windows available for horizon={horizon}. "
            f"context_start={context_start}, split_end={split_end}"
        )

    starts = range(context_start, context_start + num_windows)
    target_values, past_values, future_values = values
    calendar = calendar_values(pd.concat([_load_visible_bundle().frame[TIMESTAMP_COL], _load_ref_test_frame()[TIMESTAMP_COL]], ignore_index=True)) if include_calendar else None
    batch_calendar: list[np.ndarray] = []
    batch_x: list[np.ndarray] = []
    batch_y: list[np.ndarray] = []
    batch_past: list[np.ndarray] = []
    batch_future: list[np.ndarray] = []
    for start in starts:
        end = start + INPUT_LEN
        target_end = end + horizon
        batch_x.append(target_values[start:end])
        batch_y.append(target_values[end:target_end])
        batch_past.append(past_values[start:end])
        batch_future.append(future_values[end:target_end])
        if calendar is not None:
            batch_calendar.append(calendar[start:end])

        if len(batch_x) == batch_size:
            if ACTIVE_SPEC.schema_version == "dataset.v1" and calendar is None:
                yield (torch.from_numpy(np.stack(batch_x)), torch.from_numpy(np.stack(batch_y)))
            else:
                yield {
                    "target_history": torch.from_numpy(np.stack(batch_x)),
                    "exogenous_past": torch.from_numpy(np.stack(batch_past)),
                    "exogenous_future": torch.from_numpy(np.stack(batch_future)),
                    "target": torch.from_numpy(np.stack(batch_y)),
                    **({"calendar_features": torch.from_numpy(np.stack(batch_calendar))} if calendar is not None else {}),
                }
            batch_x.clear()
            batch_y.clear()
            batch_past.clear()
            batch_future.clear()
            batch_calendar.clear()

    if batch_x:
        if ACTIVE_SPEC.schema_version == "dataset.v1" and calendar is None:
            yield (torch.from_numpy(np.stack(batch_x)), torch.from_numpy(np.stack(batch_y)))
        else:
            yield {
                "target_history": torch.from_numpy(np.stack(batch_x)),
                "exogenous_past": torch.from_numpy(np.stack(batch_past)),
                "exogenous_future": torch.from_numpy(np.stack(batch_future)),
                "target": torch.from_numpy(np.stack(batch_y)),
                **({"calendar_features": torch.from_numpy(np.stack(batch_calendar))} if calendar is not None else {}),
            }


def evaluate_ref_test_tsf(model_or_models, device: torch.device, horizons: Iterable[int] | None = None) -> dict[str, float]:
    """
    Runner-only hidden evaluation using the frozen ref-test split.
    """
    results: dict[str, float] = {}
    mse_by_horizon: list[float] = []
    mae_by_horizon: list[float] = []
    probabilistic_by_metric: dict[str, list[float]] = {}
    selected_horizons = tuple(horizons) if horizons is not None else HORIZONS
    scaled_values = _build_ref_test_scaled_values()

    for horizon in selected_horizons:
        model = model_or_models[horizon] if isinstance(model_or_models, dict) else model_or_models
        was_training = model.training
        model.eval()

        total_sq_error = 0.0
        total_abs_error = 0.0
        total_values = 0
        probabilistic_state = _empty_probabilistic_state()

        with torch.no_grad():
            for batch in _iter_scaled_windows(scaled_values, horizon=horizon, batch_size=EVAL_BATCH_SIZE, include_calendar=getattr(model, "embedding_type", None) == "calendar"):
                x, y = _move_batch(batch, device)

                _update_probabilistic_state(
                    probabilistic_state,
                    model,
                    x,
                    y,
                    horizon=horizon,
                    prefix="Reference test",
                )

                pred = _forward_model(model, x)
                if isinstance(pred, (tuple, list)):
                    pred = pred[0]
                if pred.shape != y.shape:
                    raise ValueError(
                        f"Reference test prediction shape mismatch for horizon={horizon}: "
                        f"expected {tuple(y.shape)}, got {tuple(pred.shape)}"
                    )

                diff = pred - y
                total_sq_error += diff.pow(2).sum().item()
                total_abs_error += diff.abs().sum().item()
                total_values += diff.numel()

        if was_training:
            model.train()

        mse = total_sq_error / total_values
        mae = total_abs_error / total_values
        results[f"ref_test_h{horizon}_mse"] = mse
        results[f"ref_test_h{horizon}_mae"] = mae
        mse_by_horizon.append(mse)
        mae_by_horizon.append(mae)
        probabilistic_metrics = _finalize_probabilistic_state(probabilistic_state)
        for key, value in probabilistic_metrics.items():
            results[f"ref_test_h{horizon}_{key}"] = value
        _append_probabilistic_averages(probabilistic_by_metric, probabilistic_metrics)

    results["ref_test_avg_mse"] = float(np.mean(mse_by_horizon))
    results["ref_test_avg_mae"] = float(np.mean(mae_by_horizon))
    _write_probabilistic_averages(results, prefix="ref_test", probabilistic_by_metric=probabilistic_by_metric)
    return results


def query_ref_test(artifact_uri: str, task_id: str, promotion_token: str) -> dict[str, float]:
    """
    Runner-only privileged interface placeholder.

    The MVP keeps this contract explicit, but does not implement a generic
    artifact loader for arbitrary train.py architectures. In later phases this
    should be backed by a runner-managed evaluator that can consume a frozen
    artifact format without exposing ref-test rows to the agent process.
    """
    expected_token = os.getenv(PROMOTION_TOKEN_ENV)
    if not expected_token:
        raise RuntimeError(
            f"{PROMOTION_TOKEN_ENV} is not set. query_ref_test is a runner-only interface."
        )
    if promotion_token != expected_token:
        raise PermissionError("Invalid promotion token for query_ref_test.")
    if task_id != DATASET:
        raise ValueError(f"Unsupported task_id for query_ref_test: {task_id}")

    artifact_dir = Path(artifact_uri).expanduser().resolve()
    model_path = artifact_dir / "model.pt"
    if not model_path.exists():
        raise FileNotFoundError(f"Artifact checkpoint not found: {model_path}")

    checkpoint = torch.load(model_path, map_location="cpu")
    metadata_path = artifact_dir / "metadata.json"
    metadata: dict[str, object] = {}
    if metadata_path.exists():
        metadata_payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        if isinstance(metadata_payload, dict):
            metadata = metadata_payload
    candidate = checkpoint.get("candidate")
    model_family = checkpoint.get("model_family")
    artifact_schema_version = metadata.get("dataset_schema_version") or checkpoint.get("dataset_schema_version")
    state_dict_layout = checkpoint.get("state_dict_layout")
    state_dicts = checkpoint.get("state_dicts")

    if not isinstance(candidate, dict):
        raise ValueError(f"Artifact missing candidate payload: {model_path}")
    if not isinstance(model_family, str):
        raise ValueError(f"Artifact missing model_family: {model_path}")
    if state_dict_layout != "per_horizon":
        raise NotImplementedError(
            f"Unsupported state_dict_layout for query_ref_test: {state_dict_layout!r}"
        )
    if not isinstance(state_dicts, dict):
        raise ValueError(f"Artifact missing state_dicts: {model_path}")
    if artifact_schema_version is not None and artifact_schema_version != ACTIVE_SPEC.schema_version:
        raise ValueError(
            "Artifact dataset schema does not match the active ref-test dataset: "
            f"artifact={artifact_schema_version!r}, active={ACTIVE_SPEC.schema_version!r}. "
            "Pass the exact run artifact for the current task instead of relying on runner state."
        )

    from families import FAMILY_REGISTRY

    if model_family not in FAMILY_REGISTRY:
        raise ValueError(f"Unknown model_family in artifact: {model_family}")

    family_module = FAMILY_REGISTRY[model_family]
    horizons = tuple(int(h) for h in candidate["task"]["horizons"])
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    models: dict[int, torch.nn.Module] = {}
    for horizon in horizons:
        state_key = str(horizon)
        if state_key not in state_dicts:
            raise ValueError(f"Artifact missing state_dict for horizon={horizon}")
        state_dict = state_dicts[state_key]
        if ACTIVE_SPEC.schema_version == "dataset.v2":
            if any(str(key).startswith(("backbone.", "target_head.", "concat_head.", "future_")) for key in state_dict):
                raise ValueError(
                    "Legacy CovariateConditionedForecaster checkpoints are no longer supported. "
                    "Re-train the candidate with native fusion."
                )
            model_config = dict(candidate["model_config"])
            model_config.pop("covariate_fusion", None)
            model_config["num_target_channels"] = len(TARGET_COLUMNS)
            model_config["num_past_covariate_channels"] = len(PAST_COVARIATE_COLUMNS)
            model_config["num_future_covariate_channels"] = len(KNOWN_FUTURE_COVARIATES)
            model_config["num_input_channels"] = len(TARGET_COLUMNS) + len(PAST_COVARIATE_COLUMNS)
            model_config["num_output_channels"] = len(TARGET_COLUMNS)
            model_config["num_channels"] = model_config["num_input_channels"]
            model_config["future_covariate_mode"] = str(model_config.get("future_covariate_mode", "none"))
        else:
            model_config = candidate["model_config"]
        model = family_module.build_model(model_config, INPUT_LEN, horizon).to(device)
        model.load_state_dict(state_dict)
        model.eval()
        models[horizon] = model

    return evaluate_ref_test_tsf(models, device=device, horizons=horizons)


def query_blind_test(artifact_uri: str, task_id: str, promotion_token: str) -> dict[str, float]:
    """
    External blind-test sidecar contract.

    Labels stay outside this repository. The runner sends only artifact identity
    and a short-lived promotion token to a private service configured through
    NEO_TSF_BLIND_TEST_URL / NEO_TSF_BLIND_TEST_TOKEN.
    """
    service_url = os.getenv(BLIND_TEST_URL_ENV)
    service_token = os.getenv(BLIND_TEST_TOKEN_ENV)
    if not service_url:
        raise RuntimeError(f"{BLIND_TEST_URL_ENV} is not set. blind_test requires an external sidecar.")
    if not service_token:
        raise RuntimeError(f"{BLIND_TEST_TOKEN_ENV} is not set. blind_test requires a sidecar token.")

    payload = json.dumps(
        {
            "artifact_uri": artifact_uri,
            "task_id": task_id,
            "promotion_token": promotion_token,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        service_url,
        data=payload,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {service_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"blind test sidecar request failed: {exc}") from exc

    decoded = json.loads(body)
    if not isinstance(decoded, dict):
        raise RuntimeError("blind test sidecar returned a non-object JSON payload")
    metrics = decoded.get("metrics", decoded)
    if not isinstance(metrics, dict):
        raise RuntimeError("blind test sidecar response must contain a metrics object")
    numeric_metrics: dict[str, float] = {}
    for key, value in metrics.items():
        if isinstance(value, (int, float)):
            numeric_metrics[str(key)] = float(value)
    if not numeric_metrics:
        raise RuntimeError("blind test sidecar returned no numeric metrics")
    return numeric_metrics


def _check_data_status() -> int:
    print(f"DATASET_SPEC:      {dataset_spec_path(DATA_ROOT)}")
    print(f"task_id:           {DATASET}")
    print(f"DATA_ROOT:         {DATA_ROOT}")
    print(f"VISIBLE_DATA_PATH: {VISIBLE_DATA_PATH}")
    print(f"REF_TEST_DATA_PATH:{REF_TEST_DATA_PATH}")
    if VISIBLE_DATA_PATH.exists():
        bundle = _load_visible_bundle()
        print("visible_ready:     yes")
        print(f"visible_rows:      {len(bundle.frame)}")
        print(f"input_len:         {INPUT_LEN}")
        print(f"horizons:          {list(HORIZONS)}")
        print(f"feature_columns:   {list(FEATURE_COLUMNS)}")
        print(f"missing_strategy:  {ACTIVE_SPEC.missing['strategy']}")
        time_profile = bundle.profile["time"]
        assert isinstance(time_profile, dict)
        print(f"inferred_frequency:{time_profile['inferred_frequency']}")
        print(f"irregular_ratio:   {time_profile['irregular_ratio']}")
    else:
        print("visible_ready:     no")

    print(f"ref_test_ready:    {'yes' if REF_TEST_DATA_PATH.exists() else 'no'}")
    return 0 if VISIBLE_DATA_PATH.exists() else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare fixed split files for neo-research TSF.")
    parser.add_argument(
        "--materialize-visible",
        action="store_true",
        help="Split a full source CSV into agent-visible and runner-only CSVs.",
    )
    parser.add_argument(
        "--source-csv",
        type=str,
        default=None,
        help="Path to the full source CSV.",
    )
    parser.add_argument(
        "--task-id",
        type=str,
        default=None,
        help="Dataset/task id written into dataset_spec.json. Defaults to etth1.",
    )
    parser.add_argument(
        "--dataset-preset",
        choices=dataset_preset_names(),
        default=None,
        help="Built-in TSL dataset preset: etth1, ettm1, weather, or traffic.",
    )
    parser.add_argument(
        "--timestamp-col",
        type=str,
        default=None,
        help="Timestamp column name. Defaults to date.",
    )
    parser.add_argument(
        "--feature-cols",
        type=str,
        default=None,
        help="Comma-separated numeric feature columns. Custom tasks infer numeric columns if omitted.",
    )
    parser.add_argument("--target-cols", type=str, default=None, help="Comma-separated dataset.v2 prediction targets.")
    parser.add_argument(
        "--observed-past-covariates", type=str, default=None,
        help="Comma-separated covariates available in the historical context.",
    )
    parser.add_argument(
        "--known-future-covariates", type=str, default=None,
        help="Comma-separated covariates available throughout the forecast horizon.",
    )
    parser.add_argument(
        "--static-covariates", type=str, default=None,
        help="Comma-separated static covariate columns.",
    )
    parser.add_argument("--known-future-source", type=str, default=None)
    parser.add_argument("--known-future-available", choices=["true", "false"], default=None)
    parser.add_argument("--experiment-scope", type=str, default=None)
    parser.add_argument(
        "--input-len",
        type=int,
        default=None,
        help="Lookback window length. Defaults to 512.",
    )
    parser.add_argument(
        "--horizons",
        type=str,
        default=None,
        help="Comma-separated horizons, e.g. 96,192,336,720.",
    )
    parser.add_argument(
        "--train-rows",
        type=str,
        default=None,
        help="Train row range as start:end.",
    )
    parser.add_argument(
        "--val-rows",
        type=str,
        default=None,
        help="Validation row range as start:end.",
    )
    parser.add_argument(
        "--ref-test-rows",
        type=str,
        default=None,
        help="Runner-only reference test row range as start:end.",
    )
    parser.add_argument(
        "--split-strategy",
        choices=["tsl_custom_70_10_20", "contiguous_60_20_20"],
        default=None,
        help="Automatic split policy when explicit row ranges are omitted. Custom CSV defaults to tsl_custom_70_10_20.",
    )
    parser.add_argument(
        "--missing-strategy",
        choices=["reject", "drop", "forward_fill", "mean_fill", "linear_interpolate"],
        default=None,
        help="How to handle missing feature values. Defaults to forward_fill.",
    )
    parser.add_argument(
        "--missing-limit",
        type=int,
        default=None,
        help="Optional max consecutive values filled for forward/interpolate strategies.",
    )
    parser.add_argument(
        "--frequency",
        type=str,
        default=None,
        help="Expected data frequency label. Currently recorded in dataset_spec.json; use 'auto' to infer.",
    )
    parser.add_argument(
        "--allow-irregular",
        action="store_true",
        help="Allow irregular timestamp intervals and continue with row-based windows.",
    )
    parser.add_argument(
        "--reject-irregular",
        action="store_true",
        help="Reject irregular timestamp intervals instead of allowing row-based windows.",
    )
    parser.add_argument(
        "--irregular-ratio-warn",
        type=float,
        default=None,
        help="Warn when irregular interval ratio exceeds this threshold. Defaults to 0.01.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing prepared split files.",
    )
    args = parser.parse_args()

    if args.materialize_visible:
        explicit_ranges = [args.train_rows, args.val_rows, args.ref_test_rows]
        if any(explicit_ranges) and not all(explicit_ranges):
            parser.error("--train-rows, --val-rows, and --ref-test-rows must be provided together")
        if args.allow_irregular and args.reject_irregular:
            parser.error("--allow-irregular and --reject-irregular are mutually exclusive")
        role_args = [args.observed_past_covariates, args.known_future_covariates, args.static_covariates]
        if any(role_args) and not args.target_cols:
            parser.error("--target-cols is required when covariate role arguments are used")
        if args.target_cols and args.feature_cols:
            parser.error("--target-cols cannot be combined with --feature-cols")

        paths = materialize_visible_splits(
            args.source_csv,
            force=args.force,
            dataset_preset=args.dataset_preset,
            task_id=args.task_id,
            timestamp_col=args.timestamp_col,
            feature_columns=parse_column_list(args.feature_cols) if args.feature_cols else None,
            target_columns=parse_column_list(args.target_cols) if args.target_cols else None,
            observed_past_covariates=(
                parse_column_list(args.observed_past_covariates) if args.observed_past_covariates else []
            ),
            known_future_covariates=(
                parse_column_list(args.known_future_covariates) if args.known_future_covariates else []
            ),
            static_covariates=parse_column_list(args.static_covariates) if args.static_covariates else [],
            known_future_source=args.known_future_source,
            known_future_available=(args.known_future_available == "true" if args.known_future_available else None),
            experiment_scope=args.experiment_scope,
            input_len=args.input_len,
            horizons=parse_int_list(args.horizons) if args.horizons else None,
            train_rows=parse_row_range(args.train_rows) if args.train_rows else None,
            val_rows=parse_row_range(args.val_rows) if args.val_rows else None,
            ref_test_rows=parse_row_range(args.ref_test_rows) if args.ref_test_rows else None,
            split_strategy=args.split_strategy,
            missing_strategy=args.missing_strategy,
            missing_limit=args.missing_limit,
            frequency=args.frequency,
            allow_irregular=(True if args.allow_irregular else False if args.reject_irregular else None),
            irregular_ratio_warn=args.irregular_ratio_warn,
        )
        print(f"materialized_visible:  {paths['visible']}")
        print(f"materialized_ref_test: {paths['ref_test']}")
        print(f"materialized_profile:  {paths['profile']}")

    raise SystemExit(_check_data_status())


if __name__ == "__main__":
    main()
