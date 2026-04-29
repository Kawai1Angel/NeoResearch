#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/verify_tui_cockpit.sh

Run NeoResearch Cockpit TUI helper/render tests and save a stable text snapshot.
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
mkdir -p "$ARTIFACT_DIR"

print_step "Running TUI cockpit helper/render tests"
cd "$ROOT/opencode/packages/opencode"
run_bun "$ROOT" test \
  test/cli/tui/research-cockpit-data.test.ts \
  test/cli/tui/research-cockpit-render.test.tsx \
  --timeout 30000

print_step "Capturing TUI cockpit text snapshot"
run_bun "$ROOT" script/verify-tui-cockpit-snapshot.tsx "$ARTIFACT_DIR/tui-cockpit.txt" "$ARTIFACT_DIR/tui-cockpit.json"

print_ok "TUI Cockpit verification completed"
