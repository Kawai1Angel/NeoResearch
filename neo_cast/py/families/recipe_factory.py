from __future__ import annotations

import torch.nn as nn

from factory.build_model import FAMILY_SPEC, build_model as _build_model


def build_model(model_config: dict, input_len: int, horizon: int) -> nn.Module:
    return _build_model(model_config, input_len, horizon)
