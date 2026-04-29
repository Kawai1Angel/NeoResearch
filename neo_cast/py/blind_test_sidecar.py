from __future__ import annotations

import argparse
import json
import os
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

SERVICE_TOKEN_ENV = "NEO_TSF_BLIND_TEST_TOKEN"
QUERY_LIMIT_ENV = "NEO_TSF_BLIND_QUERY_LIMIT"
AUDIT_LOG_ENV = "NEO_TSF_BLIND_AUDIT_LOG"


class BlindTestRequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


ScoreFn = Callable[[str, str, str], dict[str, float]]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _read_limit() -> int | None:
    raw = os.getenv(QUERY_LIMIT_ENV, "").strip()
    if not raw:
        return None
    value = int(raw)
    return value if value > 0 else None


def _audit_path() -> Path:
    raw = os.getenv(AUDIT_LOG_ENV, "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path(".neo-cast") / "blind_test_audit.jsonl"


def _append_audit(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True))
        handle.write("\n")


def _accepted_query_count(path: Path, task_id: str) -> int:
    if not path.exists():
        return 0
    count = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("task_id") == task_id and record.get("outcome") == "accepted":
                count += 1
    return count


def _require_bearer_token(header: str | None, service_token: str) -> None:
    if not service_token:
        raise BlindTestRequestError(500, f"{SERVICE_TOKEN_ENV} is not configured")
    expected = f"Bearer {service_token}"
    if header != expected:
        raise BlindTestRequestError(401, "invalid blind-test bearer token")


def _require_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise BlindTestRequestError(400, f"missing or invalid {key}")
    return value


def _request_id(payload: dict[str, Any]) -> str:
    value = payload.get("request_id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return uuid.uuid4().hex


def _numeric_metrics(metrics: dict[str, Any]) -> dict[str, float]:
    numeric = {str(key): float(value) for key, value in metrics.items() if isinstance(value, (int, float))}
    if not numeric:
        raise BlindTestRequestError(502, "scorer returned no numeric metrics")
    return numeric


def score_hidden_artifact(artifact_uri: str, task_id: str, promotion_token: str) -> dict[str, float]:
    from prepare_tsf import PROMOTION_TOKEN_ENV, query_ref_test

    previous = os.environ.get(PROMOTION_TOKEN_ENV)
    os.environ[PROMOTION_TOKEN_ENV] = promotion_token
    try:
        return query_ref_test(artifact_uri, task_id, promotion_token)
    finally:
        if previous is None:
            os.environ.pop(PROMOTION_TOKEN_ENV, None)
        else:
            os.environ[PROMOTION_TOKEN_ENV] = previous


def handle_score_request(
    *,
    payload: dict[str, Any],
    authorization: str | None,
    service_token: str,
    scorer: ScoreFn = score_hidden_artifact,
    audit_path: Path | None = None,
    query_limit: int | None = None,
) -> dict[str, Any]:
    _require_bearer_token(authorization, service_token)
    artifact_uri = _require_string(payload, "artifact_uri")
    task_id = _require_string(payload, "task_id")
    promotion_token = _require_string(payload, "promotion_token")
    request_id = _request_id(payload)

    audit = audit_path or _audit_path()
    limit = _read_limit() if query_limit is None else query_limit
    if limit is not None and _accepted_query_count(audit, task_id) >= limit:
        _append_audit(
            audit,
            {
                "time_ms": _now_ms(),
                "request_id": request_id,
                "task_id": task_id,
                "artifact_uri": artifact_uri,
                "outcome": "rejected",
                "reason": "query_limit_exhausted",
                "limit": limit,
            },
        )
        raise BlindTestRequestError(429, "blind-test query limit exhausted")

    metrics = _numeric_metrics(scorer(artifact_uri, task_id, promotion_token))
    _append_audit(
        audit,
        {
            "time_ms": _now_ms(),
            "request_id": request_id,
            "task_id": task_id,
            "artifact_uri": artifact_uri,
            "outcome": "accepted",
            "metric_keys": sorted(metrics.keys()),
        },
    )
    return {"request_id": request_id, "metrics": metrics}


def _make_handler(service_token: str, scorer: ScoreFn, audit_path: Path, query_limit: int | None):
    class BlindTestHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health":
                self._write_json(404, {"error": "not found"})
                return
            self._write_json(
                200,
                {
                    "status": "ok",
                    "service": "neo-cast-blind-test-sidecar",
                    "query_limit": query_limit,
                },
            )

        def do_POST(self) -> None:
            if self.path != "/score":
                self._write_json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                body = self.rfile.read(length).decode("utf-8")
                payload = json.loads(body)
                if not isinstance(payload, dict):
                    raise BlindTestRequestError(400, "request body must be a JSON object")
                response = handle_score_request(
                    payload=payload,
                    authorization=self.headers.get("authorization"),
                    service_token=service_token,
                    scorer=scorer,
                    audit_path=audit_path,
                    query_limit=query_limit,
                )
            except BlindTestRequestError as exc:
                self._write_json(exc.status, {"error": exc.message})
                return
            except json.JSONDecodeError:
                self._write_json(400, {"error": "request body must be valid JSON"})
                return
            except Exception as exc:  # pragma: no cover - server boundary
                self._write_json(500, {"error": str(exc)})
                return
            self._write_json(200, response)

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _write_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, sort_keys=True).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return BlindTestHandler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Private Neo-Cast blind-test sidecar.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token", default=os.getenv(SERVICE_TOKEN_ENV, ""))
    parser.add_argument("--audit-log", default=str(_audit_path()))
    parser.add_argument("--query-limit", type=int, default=_read_limit())
    return parser


def main() -> None:
    args = build_parser().parse_args()
    audit_path = Path(args.audit_log).expanduser()
    handler = _make_handler(
        service_token=args.token,
        scorer=score_hidden_artifact,
        audit_path=audit_path,
        query_limit=args.query_limit,
    )
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(
        json.dumps(
            {
                "event": "blind_test_sidecar_started",
                "host": args.host,
                "port": args.port,
                "audit_log": str(audit_path),
                "query_limit": args.query_limit,
            },
            sort_keys=True,
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
