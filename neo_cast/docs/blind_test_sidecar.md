# Neo-Cast Blind Test Sidecar

`neo_cast/py/blind_test_sidecar.py` is the deployable template for the private blind-test scorer. It must run outside the agent workspace, with access to hidden blind data and scoring code that are never mounted into the agent container.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEO_TSF_BLIND_TEST_TOKEN` | Yes | Bearer token accepted by the sidecar on `POST /score`. The OpenCode/runner caller uses the same value as `NEO_TSF_BLIND_TEST_TOKEN`. |
| `NEO_TSF_BLIND_AUDIT_LOG` | No | JSONL audit destination. Defaults to `.neo-cast/blind_test_audit.jsonl` relative to the sidecar process. Use a private, append-only path in deployment. |
| `NEO_TSF_BLIND_QUERY_LIMIT` | No | Positive integer accepted-query limit per `task_id`. Empty, zero, and negative values mean no sidecar-local limit. OpenCode governance may enforce an earlier limit as well. |
| `NEO_TSF_BLIND_TEST_URL` | Runner only | URL used by `prepare_tsf.query_blind_test`, usually `http://127.0.0.1:8765/score` from the runner host or a private service URL. |

## Start Command

```bash
export NEO_TSF_BLIND_TEST_TOKEN="<secret bearer token>"
export NEO_TSF_BLIND_AUDIT_LOG="/private/audit/neo-cast/blind_test_audit.jsonl"
export NEO_TSF_BLIND_QUERY_LIMIT="1"

python3 neo_cast/py/blind_test_sidecar.py \
  --host 127.0.0.1 \
  --port 8765
```

The sidecar also accepts `--token`, `--audit-log`, and `--query-limit` CLI flags. Prefer environment variables or a secret manager for tokens; do not commit tokens to the repository or pass them through agent-visible logs.

Health check:

```bash
curl -s http://127.0.0.1:8765/health
```

Scoring endpoint:

```bash
curl -s \
  -H "authorization: Bearer ${NEO_TSF_BLIND_TEST_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"artifact_uri":"/private/artifacts/run_001","task_id":"etth1","promotion_token":"opaque-runner-token","request_id":"approval-123"}' \
  http://127.0.0.1:8765/score
```

## OpenCode Blind Gate Flow

1. OpenCode creates or prepares a `blind_test` stage run only after the governance approval gate is satisfied.
2. OpenCode governance enforces `budget.governance.blindTestQueryLimit` before the run is queued. When exhausted, it raises a budget error and creates a budget approval record.
3. The Neo-Cast runner executes `python3 neo_cast/py/runner.py blind-test --run-id <run_id>`.
4. `runner.py` freezes the selected artifact directory, creates an opaque `promotion_token`, and calls `prepare_tsf.query_blind_test`.
5. `query_blind_test` posts `artifact_uri`, `task_id`, and `promotion_token` to `NEO_TSF_BLIND_TEST_URL` with bearer auth.
6. The sidecar validates the token, checks its own per-task query limit, scores with private data, writes an audit JSONL record, and returns numeric `blind_test_*` metrics.
7. The runner writes `blind_test_metrics.json` for the governed run artifact. Hidden labels, private scorer internals, and audit logs stay outside the agent workspace.

OpenCode service tests already cover the approval requirement and blind query-limit budget behavior in `opencode/packages/opencode/test/research/service.test.ts`.

## Audit Contract

Each accepted query writes one JSON object with:

- `time_ms`
- `request_id`
- `task_id`
- `artifact_uri`
- `outcome: "accepted"`
- `metric_keys`

Each sidecar-local query-limit rejection writes:

- `time_ms`
- `request_id`
- `task_id`
- `artifact_uri`
- `outcome: "rejected"`
- `reason: "query_limit_exhausted"`
- `limit`

Audit records intentionally store metric names only. They must not store metric values, hidden labels, raw predictions, promotion tokens, bearer tokens, or private dataset paths beyond the submitted artifact URI.

## Private Data Isolation

- Run the sidecar in a private runtime owned by Runner/Human Gate, not inside the agent-controlled container.
- Mount hidden blind data and private scoring code only into the sidecar runtime.
- Keep `NEO_TSF_BLIND_AUDIT_LOG` in a privileged store. The agent may receive opaque references or final approved metrics, never the raw audit log.
- Use network policy or loopback binding so only the runner/governance service can reach `POST /score`.
- Rotate bearer tokens through a secret manager and treat every `request_id` as an audit correlation key across OpenCode approval, runner execution, and sidecar audit.
- Keep query limits in both places: OpenCode governance for workflow-level budget enforcement, and sidecar `NEO_TSF_BLIND_QUERY_LIMIT` as a privileged backstop.
