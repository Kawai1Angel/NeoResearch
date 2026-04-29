from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from blind_test_sidecar import BlindTestRequestError, _make_handler, handle_score_request  # noqa: E402


class BlindTestSidecarTest(unittest.TestCase):
    def _call_handler_get(self, path: str, *, query_limit: int | None) -> tuple[int, dict[str, object]]:
        handler_type = _make_handler(
            service_token="sidecar-token",
            scorer=lambda *_: {"blind_test_avg_mse": 0.12},
            audit_path=Path("unused-audit.jsonl"),
            query_limit=query_limit,
        )
        handler = object.__new__(handler_type)
        handler.path = path
        captured: dict[str, object] = {}

        def write_json(status: int, payload: dict[str, object]) -> None:
            captured["status"] = status
            captured["payload"] = payload

        handler._write_json = write_json
        handler.do_GET()
        return int(captured["status"]), captured["payload"]  # type: ignore[return-value]

    def test_scores_authenticated_requests_and_writes_private_audit_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_path = Path(tmp) / "audit.jsonl"

            def scorer(artifact_uri: str, task_id: str, promotion_token: str) -> dict[str, float]:
                self.assertEqual(artifact_uri, "/artifacts/run_a")
                self.assertEqual(task_id, "etth1")
                self.assertEqual(promotion_token, "promotion-token")
                return {"blind_test_avg_mse": 0.12, "blind_test_avg_mae": 0.34}

            response = handle_score_request(
                payload={
                    "artifact_uri": "/artifacts/run_a",
                    "task_id": "etth1",
                    "promotion_token": "promotion-token",
                    "request_id": "req-001",
                },
                authorization="Bearer sidecar-token",
                service_token="sidecar-token",
                scorer=scorer,
                audit_path=audit_path,
                query_limit=2,
            )

            self.assertEqual(
                response,
                {
                    "request_id": "req-001",
                    "metrics": {"blind_test_avg_mse": 0.12, "blind_test_avg_mae": 0.34},
                },
            )
            records = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["outcome"], "accepted")
            self.assertEqual(records[0]["request_id"], "req-001")
            self.assertEqual(records[0]["metric_keys"], ["blind_test_avg_mae", "blind_test_avg_mse"])
            self.assertNotIn("blind_test_avg_mse", records[0])
            self.assertNotIn("0.12", audit_path.read_text(encoding="utf-8"))

    def test_rejects_invalid_tokens_before_scoring(self) -> None:
        called = False

        def scorer(artifact_uri: str, task_id: str, promotion_token: str) -> dict[str, float]:
            nonlocal called
            called = True
            return {"blind_test_avg_mse": 0.12}

        with self.assertRaises(BlindTestRequestError) as context:
            handle_score_request(
                payload={
                    "artifact_uri": "/artifacts/run_a",
                    "task_id": "etth1",
                    "promotion_token": "promotion-token",
                },
                authorization="Bearer wrong",
                service_token="sidecar-token",
                scorer=scorer,
            )

        self.assertEqual(context.exception.status, 401)
        self.assertFalse(called)

    def test_enforces_query_limit_with_audit_record(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            audit_path = Path(tmp) / "audit.jsonl"
            audit_path.write_text(
                json.dumps({"task_id": "etth1", "outcome": "accepted"}) + "\n",
                encoding="utf-8",
            )

            with self.assertRaises(BlindTestRequestError) as context:
                handle_score_request(
                    payload={
                        "artifact_uri": "/artifacts/run_b",
                        "task_id": "etth1",
                        "promotion_token": "promotion-token",
                        "request_id": "req-limit",
                    },
                    authorization="Bearer sidecar-token",
                    service_token="sidecar-token",
                    scorer=lambda *_: {"blind_test_avg_mse": 0.12},
                    audit_path=audit_path,
                    query_limit=1,
                )

            self.assertEqual(context.exception.status, 429)
            records = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(records[-1]["outcome"], "rejected")
            self.assertEqual(records[-1]["request_id"], "req-limit")
            self.assertEqual(records[-1]["reason"], "query_limit_exhausted")

    def test_health_endpoint_reports_ready_without_token(self) -> None:
        status, body = self._call_handler_get("/health", query_limit=3)
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["query_limit"], 3)
        self.assertNotIn("audit_log", body)

    def test_get_rejects_unknown_paths(self) -> None:
        status, body = self._call_handler_get("/missing", query_limit=None)
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "not found")


if __name__ == "__main__":
    unittest.main()
