"""Dataset and budget settings shared by lightweight runner entrypoints."""

from __future__ import annotations

from dataset_contract import load_dataset_spec, resolve_data_root


ACTIVE_SPEC = load_dataset_spec(resolve_data_root())
DATASET = ACTIVE_SPEC.task_id
HORIZONS = ACTIVE_SPEC.horizons
INPUT_LEN = ACTIVE_SPEC.input_len
NUM_CHANNELS = len(ACTIVE_SPEC.target_columns)

TIME_BUDGET = 1200
PARAM_BUDGET = 10_000_000
SEED = 42
PROMOTION_TOKEN_ENV = "NEO_TSF_PROMOTION_TOKEN"
