#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/test_all.sh [--quick]

Run the NeoResearch local verification suite across opencode and neo_cast.

Options:
  --quick     Run the targeted Research OS and Neo-Cast tests used for local alpha checks.
  -h, --help  Show this help.
USAGE
}

quick=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)
      quick=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      print_fail "unknown option: $1"
      usage
      exit 2
      ;;
  esac
done

load_env_local "$ROOT"
export_local_dev_environment "$ROOT"
ensure_local_dev_dirs

print_step "OpenCode Research OS targeted tests"
(cd "$ROOT/opencode/packages/opencode" && run_bun "$ROOT" test \
  test/research/domain-registry.test.ts \
  test/research/runtime.test.ts \
  test/research/tsf-domain.test.ts \
  test/research/service.test.ts \
  test/cli/research-command.test.ts \
  test/cli/research-data.test.ts \
  test/cli/tui/research-cockpit-data.test.ts \
  test/cli/tui/research-cockpit-render.test.tsx \
  --timeout 30000)

print_step "OpenCode package typecheck"
(cd "$ROOT/opencode/packages/opencode" && npm run typecheck)

print_step "Web Dashboard helper tests"
(cd "$ROOT/opencode/packages/app" && run_bun "$ROOT" test --preload ./happydom.ts src/pages/research-dashboard-data.test.ts --timeout 30000)

print_step "App typecheck"
(cd "$ROOT/opencode/packages/app" && npm run typecheck)

print_step "Neo-Cast Python tests"
(cd "$ROOT/neo_cast" && python3 -m unittest \
  py.tests.test_e2e_contract \
  py.tests.test_benchmark_manifest \
  py.tests.test_benchmark_report \
  py.tests.test_blind_test_sidecar \
  py.tests.test_dataset_presets \
  py.tests.test_probabilistic_metrics \
  py.tests.test_export_contract \
  py.tests.test_recipe_factory \
  py.tests.test_runner_curves \
  py.tests.test_train_execution \
  py.tests.test_mutate)

print_step "Neo-Cast smoke dry-run"
"$ROOT/scripts/smoke_tsf.sh"

if [[ "$quick" -eq 0 ]]; then
  print_ok "full local alpha verification completed"
else
  print_ok "quick local alpha verification completed"
fi
