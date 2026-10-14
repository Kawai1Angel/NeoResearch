#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/verify_web_ui.sh

Run Playwright verification for the Web Dashboard in desktop and mobile viewports.

Environment:
  PLAYWRIGHT_PORT  Vite dev server port to use. Defaults to 4178.
  NEO_RESEARCH_VERIFY_BUILT_UI=1  Verify the existing production build with Vite preview.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

load_env_local "$ROOT"
export_local_dev_environment "$ROOT"
ensure_local_dev_dirs

ARTIFACT_DIR="$ROOT/.neo-research/artifacts/ui"
PORT="${PLAYWRIGHT_PORT:-4178}"
BASE_URL="http://127.0.0.1:$PORT"
LOG_FILE="$ARTIFACT_DIR/web-dev-server.log"

mkdir -p "$ARTIFACT_DIR"

export VITE_OPENCODE_SERVER_HOST="${VITE_OPENCODE_SERVER_HOST:-127.0.0.1}"
export VITE_OPENCODE_SERVER_PORT="${VITE_OPENCODE_SERVER_PORT:-4096}"

print_step "Starting Web Dashboard verification server"
if [[ "${NEO_RESEARCH_VERIFY_BUILT_UI:-0}" == "1" ]]; then
  [[ -f "$ROOT/opencode/packages/app/dist/index.html" ]] || {
    print_fail "Web Dashboard build missing; run bun run build in opencode/packages/app"
    exit 1
  }
  (
    cd "$ROOT/opencode/packages/app"
    exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port "$PORT" --strictPort
  ) >"$LOG_FILE" 2>&1 &
else
  "$ROOT/scripts/dev_web.sh" -- --host 127.0.0.1 --port "$PORT" --strictPort >"$LOG_FILE" 2>&1 &
fi
server_pid=$!

cleanup() {
  if kill -0 "$server_pid" >/dev/null 2>&1; then
    # bun run dev owns the Vite child; terminate it before waiting for Bun.
    pkill -TERM -P "$server_pid" >/dev/null 2>&1 || true
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 120); do
  if curl -sI "$BASE_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    print_fail "Web Dashboard dev server exited early; see $LOG_FILE"
    exit 1
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  print_fail "Web Dashboard dev server did not become ready at $BASE_URL; see $LOG_FILE"
  exit 1
fi

print_step "Running Playwright Web Dashboard checks"
cd "$ROOT/opencode/packages/app"
run_bun "$ROOT" e2e/verify-web-dashboard.ts "$BASE_URL" "$ARTIFACT_DIR"

print_ok "Web Dashboard UI verification completed"
