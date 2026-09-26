from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(os.environ.get("NEO_CAST_PROJECT_ROOT", Path(__file__).resolve().parent.parent)).expanduser().resolve()
DEFAULT_DATA_ROOT = PROJECT_ROOT / ".neo-cast" / "dataset"
DATA_SPEC_FILENAME = "dataset_spec.json"

ETT_FEATURE_COLUMNS = ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"]


def reject_unsupported_covariates(payload: dict[str, Any]) -> None:
    """Accept empty legacy fields, but never silently discard requested inputs."""
    fields = (
        "known_future_covariates", "known_future_source", "known_future_available",
        "known_future_availability", "num_future_covariate_channels",
        "future_exogenous_channels", "used_known_future_covariates", "static_covariates",
    )
    for field in fields:
        if payload.get(field):
            raise ValueError(f"UNSUPPORTED_COVARIATE: {field} is not supported; use targets and observed-past covariates only")
    if payload.get("future_covariate_mode") not in (None, "", "none"):
        raise ValueError("UNSUPPORTED_COVARIATE: future_covariate_mode is not supported; retrain without future conditioning")
    if payload.get("covariate_fusion"):
        raise ValueError("UNSUPPORTED_COVARIATE: legacy covariate_fusion wrapper is unsupported; retrain with native observed-past inputs")

DEFAULT_ETTH1_SPEC: dict[str, Any] = {
    "schema_version": "dataset.v1",
    "task_id": "etth1",
    "timestamp_col": "date",
    "feature_columns": ETT_FEATURE_COLUMNS,
    "input_len": 512,
    "horizons": [96, 192, 336, 720],
    "splits": {
        "train": [0, 12 * 30 * 24],
        "val": [12 * 30 * 24, 12 * 30 * 24 + 4 * 30 * 24],
        "ref_test": [12 * 30 * 24 + 4 * 30 * 24, 12 * 30 * 24 + 8 * 30 * 24],
    },
    "normalization": {
        "type": "standard",
        "fit_split": "train",
    },
    "missing": {
        "strategy": "forward_fill",
        "limit": None,
    },
    "time": {
        "frequency": "auto",
        "allow_irregular": True,
        "irregular_ratio_warn": 0.01,
    },
}

DEFAULT_ETTM1_SPEC: dict[str, Any] = {
    **DEFAULT_ETTH1_SPEC,
    "task_id": "ettm1",
    "splits": {
        "train": [0, 12 * 30 * 24 * 4],
        "val": [12 * 30 * 24 * 4, 12 * 30 * 24 * 4 + 4 * 30 * 24 * 4],
        "ref_test": [12 * 30 * 24 * 4 + 4 * 30 * 24 * 4, 12 * 30 * 24 * 4 + 8 * 30 * 24 * 4],
    },
}

DATASET_PRESETS: dict[str, dict[str, Any]] = {
    "etth1": {
        **DEFAULT_ETTH1_SPEC,
        "split_strategy": "fixed",
    },
    "ettm1": {
        **DEFAULT_ETTM1_SPEC,
        "split_strategy": "fixed",
    },
    "weather": {
        "schema_version": "dataset.v1",
        "task_id": "weather",
        "timestamp_col": "date",
        "feature_columns": None,
        "input_len": 512,
        "horizons": [96, 192, 336, 720],
        "split_strategy": "tsl_custom_70_10_20",
        "normalization": {"type": "standard", "fit_split": "train"},
        "missing": {"strategy": "forward_fill", "limit": None},
        "time": {"frequency": "auto", "allow_irregular": True, "irregular_ratio_warn": 0.01},
    },
    "traffic": {
        "schema_version": "dataset.v1",
        "task_id": "traffic",
        "timestamp_col": "date",
        "feature_columns": None,
        "input_len": 512,
        "horizons": [96, 192, 336, 720],
        "split_strategy": "tsl_custom_70_10_20",
        "normalization": {"type": "standard", "fit_split": "train"},
        "missing": {"strategy": "forward_fill", "limit": None},
        "time": {"frequency": "auto", "allow_irregular": True, "irregular_ratio_warn": 0.01},
    },
}

DATASET_PRESET_ALIASES = {
    "etth1_tslib_v1": "etth1",
    "ettm1_tslib_v1": "ettm1",
    "weather_tslib_v1": "weather",
    "traffic_tslib_v1": "traffic",
}

BENCHMARK_DATASET_ORDER = ("etth1", "ettm1", "weather", "traffic")

BENCHMARK_DATASET_METADATA: dict[str, dict[str, Any]] = {
    "etth1": {
        "display_name": "ETTh1",
        "split_policy": "fixed_rows",
        "expected_data_files": ["ETTh1.csv"],
        "notes": "Uses the canonical TSLib hourly ETT split encoded in the dataset preset.",
    },
    "ettm1": {
        "display_name": "ETTm1",
        "split_policy": "fixed_rows",
        "expected_data_files": ["ETTm1.csv"],
        "notes": "Uses the canonical TSLib 15-minute ETT split encoded in the dataset preset.",
    },
    "weather": {
        "display_name": "Weather",
        "split_policy": "tsl_custom_70_10_20",
        "expected_data_files": ["weather.csv"],
        "notes": "Uses contiguous 70/10/20 train/validation/reference-test rows; numeric features are inferred.",
    },
    "traffic": {
        "display_name": "Traffic",
        "split_policy": "tsl_custom_70_10_20",
        "expected_data_files": ["traffic.csv"],
        "notes": "Uses contiguous 70/10/20 train/validation/reference-test rows; numeric features are inferred.",
    },
}


def normalize_dataset_preset(value: str | None) -> str:
    if not value:
        return "etth1"
    key = safe_task_id(value)
    key = DATASET_PRESET_ALIASES.get(key, key)
    if key not in DATASET_PRESETS:
        choices = ", ".join(dataset_preset_names())
        raise ValueError(f"Unknown dataset preset {value!r}; expected one of: {choices}")
    return key


def dataset_preset_names() -> list[str]:
    return sorted([*DATASET_PRESETS.keys(), *DATASET_PRESET_ALIASES.keys()])


def dataset_preset_payload(value: str | None) -> dict[str, Any]:
    return dict(DATASET_PRESETS[normalize_dataset_preset(value)])


def benchmark_manifest() -> dict[str, Any]:
    datasets: dict[str, dict[str, Any]] = {}
    for dataset_id in BENCHMARK_DATASET_ORDER:
        preset = dataset_preset_payload(dataset_id)
        metadata = BENCHMARK_DATASET_METADATA[dataset_id]
        datasets[dataset_id] = {
            "dataset_id": dataset_id,
            "display_name": metadata["display_name"],
            "preset": dataset_id,
            "split_policy": metadata["split_policy"],
            "default_context": preset["input_len"],
            "default_horizons": list(preset["horizons"]),
            "primary_metric": "mse",
            "reference_metrics": ["mse", "mae"],
            "requires_external_data_file": True,
            "expected_data_files": list(metadata["expected_data_files"]),
            "notes": metadata["notes"],
        }

    return {
        "schema_version": "benchmark_manifest.v1",
        "description": "Supported time-series forecasting benchmark presets. This manifest records protocol metadata only and contains no measured results.",
        "datasets": datasets,
        "result_table_expected_columns": [
            "dataset_id",
            "horizon",
            "model_id",
            "run_id",
            "primary_metric",
            "mse",
            "mae",
            "trained_at",
            "data_file",
            "git_commit",
            "notes",
        ],
    }


def resolve_data_root() -> Path:
    return Path(os.getenv("NEO_TSF_DATA_ROOT", str(DEFAULT_DATA_ROOT))).expanduser()


def dataset_spec_path(data_root: Path | None = None) -> Path:
    return (data_root or resolve_data_root()) / DATA_SPEC_FILENAME


def project_dataset_spec_path(project_root: Path = PROJECT_ROOT) -> Path:
    return project_root / ".neo-cast" / DATA_SPEC_FILENAME


def safe_task_id(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip().lower())
    normalized = normalized.strip("._-")
    if not normalized:
        raise ValueError("task_id must contain at least one alphanumeric character")
    return normalized[:64]


def train_data_path(data_root: Path, task_id: str) -> Path:
    return data_root / f"{safe_task_id(task_id)}_train.csv"


def visible_data_path(data_root: Path, task_id: str) -> Path:
    return data_root / f"{safe_task_id(task_id)}_visible.csv"


def ref_test_data_path(data_root: Path, task_id: str) -> Path:
    return data_root / f"{safe_task_id(task_id)}_ref_test.csv"


def parse_int_list(raw: str) -> list[int]:
    values = [item.strip() for item in raw.split(",") if item.strip()]
    if not values:
        raise ValueError("Expected at least one integer")
    parsed = [int(item) for item in values]
    if any(item <= 0 for item in parsed):
        raise ValueError(f"All values must be positive integers: {raw}")
    if len(set(parsed)) != len(parsed):
        raise ValueError(f"Values must be unique: {raw}")
    return parsed


def parse_column_list(raw: str) -> list[str]:
    values = [item.strip() for item in raw.split(",") if item.strip()]
    if not values:
        raise ValueError("Expected at least one feature column")
    if len(set(values)) != len(values):
        raise ValueError(f"Feature columns must be unique: {raw}")
    return values


def parse_row_range(raw: str) -> tuple[int, int]:
    separator = ":" if ":" in raw else ","
    parts = [item.strip() for item in raw.split(separator) if item.strip()]
    if len(parts) != 2:
        raise ValueError(f"Expected row range as start:end, got: {raw}")
    start, end = int(parts[0]), int(parts[1])
    if start < 0 or end <= start:
        raise ValueError(f"Invalid row range: {raw}")
    return start, end


def infer_contiguous_splits(total_rows: int, input_len: int, max_horizon: int) -> dict[str, tuple[int, int]]:
    train_end = int(total_rows * 0.6)
    val_end = int(total_rows * 0.8)
    ref_end = total_rows
    min_segment = input_len + max_horizon
    if train_end < min_segment or val_end - train_end < max_horizon or ref_end - val_end < max_horizon:
        raise ValueError(
            "Dataset is too short for automatic 60/20/20 splits with "
            f"input_len={input_len}, max_horizon={max_horizon}, rows={total_rows}"
        )
    return {
        "train": (0, train_end),
        "val": (train_end, val_end),
        "ref_test": (val_end, ref_end),
    }


def infer_tsl_custom_splits(total_rows: int, input_len: int, max_horizon: int) -> dict[str, tuple[int, int]]:
    train_end = int(total_rows * 0.7)
    ref_start = total_rows - int(total_rows * 0.2)
    ref_end = total_rows
    min_segment = input_len + max_horizon
    if train_end < min_segment or ref_start - train_end < max_horizon or ref_end - ref_start < max_horizon:
        raise ValueError(
            "Dataset is too short for TSL custom 70/10/20 splits with "
            f"input_len={input_len}, max_horizon={max_horizon}, rows={total_rows}"
        )
    return {
        "train": (0, train_end),
        "val": (train_end, ref_start),
        "ref_test": (ref_start, ref_end),
    }


@dataclass(frozen=True)
class DatasetSpec:
    schema_version: str
    task_id: str
    timestamp_col: str
    feature_columns: tuple[str, ...]
    target_columns: tuple[str, ...]
    observed_past_covariates: tuple[str, ...]
    known_future_covariates: tuple[str, ...]
    static_covariates: tuple[str, ...]
    input_len: int
    horizons: tuple[int, ...]
    train: tuple[int, int]
    val: tuple[int, int]
    ref_test: tuple[int, int]
    normalization: dict[str, Any]
    missing: dict[str, Any]
    time: dict[str, Any]
    known_future_availability: dict[str, Any] | None = None
    experiment_scope: str | None = None
    production_comparable: bool | None = None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "DatasetSpec":
        reject_unsupported_covariates(payload)
        schema_version = str(payload.get("schema_version", ""))
        if schema_version not in {"dataset.v1", "dataset.v2"}:
            raise ValueError("dataset spec schema_version must be dataset.v1 or dataset.v2")

        task_id = safe_task_id(str(payload["task_id"]))
        timestamp_col = str(payload["timestamp_col"])
        if schema_version == "dataset.v1":
            feature_columns = tuple(str(item) for item in payload["feature_columns"])
            target_columns = feature_columns
            observed_past_covariates: tuple[str, ...] = ()
            known_future_covariates: tuple[str, ...] = ()
            static_covariates: tuple[str, ...] = ()
        else:
            target_columns = tuple(str(item) for item in payload["target_columns"])
            observed_past_covariates = tuple(str(item) for item in payload.get("observed_past_covariates", []))
            known_future_covariates = tuple(str(item) for item in payload.get("known_future_covariates", []))
            static_covariates = tuple(str(item) for item in payload.get("static_covariates", []))
            feature_columns = tuple(dict.fromkeys((
                *target_columns,
                *observed_past_covariates,
                *known_future_covariates,
                *static_covariates,
            )))
        horizons = tuple(int(item) for item in payload["horizons"])
        input_len = int(payload["input_len"])
        splits = payload["splits"]
        normalization = dict(payload.get("normalization") or {"type": "standard", "fit_split": "train"})
        missing = dict(payload.get("missing") or {"strategy": "forward_fill", "limit": None})
        time = dict(
            payload.get("time")
            or {"frequency": "auto", "allow_irregular": True, "irregular_ratio_warn": 0.01}
        )

        if not timestamp_col:
            raise ValueError("timestamp_col must not be empty")
        if not target_columns:
            raise ValueError("target_columns must not be empty")
        for name, columns in (
            ("target_columns", target_columns),
            ("observed_past_covariates", observed_past_covariates),
            ("known_future_covariates", known_future_covariates),
            ("static_covariates", static_covariates),
        ):
            if len(set(columns)) != len(columns):
                raise ValueError(f"{name} must be unique")
        target_overlap = set(target_columns).intersection(
            (*observed_past_covariates, *known_future_covariates, *static_covariates)
        )
        if target_overlap:
            raise ValueError(f"target columns must not also be covariates: {sorted(target_overlap)}")
        if timestamp_col in feature_columns:
            raise ValueError("timestamp_col must not also be a feature column")
        if input_len <= 0:
            raise ValueError("input_len must be positive")
        if not horizons or any(item <= 0 for item in horizons):
            raise ValueError("horizons must contain positive integers")
        if len(set(horizons)) != len(horizons):
            raise ValueError("horizons must be unique")
        if normalization.get("type") != "standard" or normalization.get("fit_split") != "train":
            raise ValueError("Only standard normalization fitted on train split is supported")
        if missing.get("strategy") not in {"reject", "drop", "forward_fill", "mean_fill", "linear_interpolate"}:
            raise ValueError(f"Unsupported missing strategy: {missing.get('strategy')}")
        limit = missing.get("limit")
        if limit is not None and (not isinstance(limit, int) or limit < 1):
            raise ValueError("missing.limit must be null or a positive integer")
        if time.get("frequency") is None:
            time["frequency"] = "auto"
        if not isinstance(time.get("frequency"), str):
            raise ValueError("time.frequency must be a string")
        time["allow_irregular"] = bool(time.get("allow_irregular", True))
        warn_ratio = float(time.get("irregular_ratio_warn", 0.01))
        if warn_ratio < 0.0 or warn_ratio > 1.0:
            raise ValueError("time.irregular_ratio_warn must be in [0, 1]")
        time["irregular_ratio_warn"] = warn_ratio

        train = tuple(int(item) for item in splits["train"])
        val = tuple(int(item) for item in splits["val"])
        ref_test = tuple(int(item) for item in splits["ref_test"])
        cls._validate_splits(train, val, ref_test, input_len, max(horizons))

        return cls(
            schema_version=schema_version,
            task_id=task_id,
            timestamp_col=timestamp_col,
            feature_columns=feature_columns,
            target_columns=target_columns,
            observed_past_covariates=observed_past_covariates,
            known_future_covariates=known_future_covariates,
            static_covariates=static_covariates,
            input_len=input_len,
            horizons=horizons,
            train=(train[0], train[1]),
            val=(val[0], val[1]),
            ref_test=(ref_test[0], ref_test[1]),
            normalization=normalization,
            missing=missing,
            time=time,
            known_future_availability=(
                dict(payload["known_future_availability"])
                if isinstance(payload.get("known_future_availability"), dict)
                else None
            ),
            experiment_scope=(str(payload["experiment_scope"]) if payload.get("experiment_scope") else None),
            production_comparable=(
                bool(payload["production_comparable"])
                if "production_comparable" in payload
                else None
            ),
        )

    @staticmethod
    def _validate_splits(
        train: tuple[int, int],
        val: tuple[int, int],
        ref_test: tuple[int, int],
        input_len: int,
        max_horizon: int,
    ) -> None:
        if train[0] != 0:
            raise ValueError("train split must start at row 0 in the current standard loader")
        if not (train[0] < train[1] <= val[0] < val[1] <= ref_test[0] < ref_test[1]):
            raise ValueError("splits must be ordered and non-overlapping")
        if train[1] != val[0] or val[1] != ref_test[0]:
            raise ValueError("splits must be contiguous: train_end == val_start and val_end == ref_test_start")
        if train[1] - train[0] < input_len + max_horizon:
            raise ValueError("train split is too short for input_len + max_horizon")
        if val[1] - (val[0] - input_len) < input_len + max_horizon:
            raise ValueError("val split is too short for validation windows")
        if ref_test[1] - (ref_test[0] - input_len) < input_len + max_horizon:
            raise ValueError("ref_test split is too short for reference test windows")

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema_version": self.schema_version,
            "task_id": self.task_id,
            "timestamp_col": self.timestamp_col,
            "input_len": self.input_len,
            "horizons": list(self.horizons),
            "splits": {
                "train": list(self.train),
                "val": list(self.val),
                "ref_test": list(self.ref_test),
            },
            "normalization": dict(self.normalization),
            "missing": dict(self.missing),
            "time": dict(self.time),
        }
        if self.schema_version == "dataset.v1":
            payload["feature_columns"] = list(self.feature_columns)
        else:
            payload.update({
                "target_columns": list(self.target_columns),
                "observed_past_covariates": list(self.observed_past_covariates),
                "known_future_covariates": list(self.known_future_covariates),
                "static_covariates": list(self.static_covariates),
            })
            if self.known_future_availability is not None:
                payload["known_future_availability"] = dict(self.known_future_availability)
            if self.experiment_scope is not None:
                payload["experiment_scope"] = self.experiment_scope
            if self.production_comparable is not None:
                payload["production_comparable"] = self.production_comparable
        return payload


def load_dataset_spec(data_root: Path | None = None) -> DatasetSpec:
    path = dataset_spec_path(data_root)
    if path.exists():
        return DatasetSpec.from_payload(json.loads(path.read_text(encoding="utf-8")))
    project_path = project_dataset_spec_path()
    if project_path.exists():
        return DatasetSpec.from_payload(json.loads(project_path.read_text(encoding="utf-8")))
    return DatasetSpec.from_payload(DEFAULT_ETTH1_SPEC)


def write_dataset_spec(
    spec: DatasetSpec,
    data_root: Path | None = None,
    project_root: Path | None = None,
) -> Path:
    root = data_root or resolve_data_root()
    root.mkdir(parents=True, exist_ok=True)
    path = dataset_spec_path(root)
    path.write_text(f"{json.dumps(spec.to_payload(), indent=2, sort_keys=True)}\n", encoding="utf-8")

    project_path = project_dataset_spec_path(project_root or PROJECT_ROOT)
    project_path.parent.mkdir(parents=True, exist_ok=True)
    project_path.write_text(f"{json.dumps(spec.to_payload(), indent=2, sort_keys=True)}\n", encoding="utf-8")
    return path
