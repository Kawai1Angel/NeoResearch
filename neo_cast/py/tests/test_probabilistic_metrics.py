from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

import prepare_tsf  # noqa: E402


class ConstantQuantileModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.quantiles = [0.1, 0.5, 0.9]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.ones(x.size(0), 4, x.size(2), device=x.device, dtype=x.dtype)

    def forward_quantiles(self, x: torch.Tensor) -> torch.Tensor:
        batch, _, channels = x.shape
        values = x.new_tensor([0.0, 1.0, 2.0]).view(1, 1, 1, 3)
        return values.expand(batch, 4, channels, 3)


class ProbabilisticMetricsTest(unittest.TestCase):
    def test_validation_metrics_include_quantile_quality_and_interval_calibration(self) -> None:
        x = torch.zeros(2, 8, 3)
        y = torch.ones(2, 4, 3)

        def fake_loader(split: str, horizon: int, batch_size: int, shuffle: bool | None = None) -> DataLoader:
            del split, horizon, batch_size, shuffle
            return DataLoader(TensorDataset(x, y), batch_size=2)

        model = ConstantQuantileModel()

        with patch.object(prepare_tsf, "make_dataloader", fake_loader):
            metrics = prepare_tsf.evaluate_val_tsf(model, torch.device("cpu"), horizons=[4])

        self.assertEqual(metrics["val_h4_mse"], 0.0)
        self.assertEqual(metrics["val_h4_mae"], 0.0)
        self.assertAlmostEqual(metrics["val_h4_pinball"], 1.0 / 15.0, places=6)
        self.assertAlmostEqual(metrics["val_avg_pinball"], 1.0 / 15.0, places=6)
        self.assertAlmostEqual(metrics["val_h4_crps_approx"], 2.0 / 15.0, places=6)
        self.assertAlmostEqual(metrics["val_avg_crps_approx"], 2.0 / 15.0, places=6)
        self.assertEqual(metrics["val_h4_interval_80_coverage"], 1.0)
        self.assertEqual(metrics["val_h4_interval_80_width"], 2.0)
        self.assertEqual(metrics["val_avg_interval_80_coverage"], 1.0)
        self.assertEqual(metrics["val_avg_interval_80_width"], 2.0)

    def test_blind_test_sidecar_posts_artifact_identity_and_returns_numeric_metrics(self) -> None:
        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(
                    {
                        "metrics": {
                            "blind_test_avg_mse": 0.123,
                            "blind_test_avg_mae": 0.456,
                            "note": "ignored",
                        }
                    }
                ).encode("utf-8")

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["data"] = request.data
            captured["authorization"] = request.headers["Authorization"]
            captured["content_type"] = request.headers["Content-type"]
            captured["timeout"] = timeout
            return FakeResponse()

        with patch.dict(
            os.environ,
            {
                prepare_tsf.BLIND_TEST_URL_ENV: "https://blind.example/score",
                prepare_tsf.BLIND_TEST_TOKEN_ENV: "sidecar-token",
            },
        ), patch.object(prepare_tsf.urllib.request, "urlopen", fake_urlopen):
            metrics = prepare_tsf.query_blind_test("/artifacts/run_1", "etth1", "promotion-token")

        self.assertEqual(metrics, {"blind_test_avg_mse": 0.123, "blind_test_avg_mae": 0.456})
        self.assertEqual(captured["url"], "https://blind.example/score")
        self.assertEqual(captured["authorization"], "Bearer sidecar-token")
        self.assertEqual(captured["content_type"], "application/json")
        self.assertEqual(captured["timeout"], 30)
        self.assertEqual(
            json.loads(captured["data"].decode("utf-8")),
            {
                "artifact_uri": "/artifacts/run_1",
                "task_id": "etth1",
                "promotion_token": "promotion-token",
            },
        )


if __name__ == "__main__":
    unittest.main()
