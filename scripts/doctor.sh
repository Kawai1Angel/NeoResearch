#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/doctor.sh [--quick]

Check whether the NeoResearch local development environment is ready.

Options:
  --quick     Skip slower smoke dry-runs.
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
NEO_CAST_ROOT_RESOLVED="$NEO_CAST_ROOT"
RUNTIME_ROOT_RESOLVED="$NEO_RESEARCH_RUNTIME_ROOT"
failures=0

check_command() {
  local tool="$1"
  if have_command "$tool"; then
    print_ok "$tool found"
  else
    print_fail "$tool not found"
    failures=$((failures + 1))
  fi
}

check_path() {
  local label="$1"
  local path="$2"
  if [[ -e "$path" ]]; then
    print_ok "$label: $path"
  else
    print_fail "$label missing: $path"
    failures=$((failures + 1))
  fi
}

print_step "Toolchain"
check_command node
check_command npm
check_command python3
if have_bun_runtime "$ROOT"; then
  print_ok "bun runtime found: $(bun_path_for_root "$ROOT")"
else
  print_fail "bun runtime not found"
  failures=$((failures + 1))
fi

print_step "Project paths"
check_path "opencode root" "$ROOT/opencode"
check_path "opencode CLI entry" "$ROOT/opencode/packages/opencode/src/index.ts"
check_path "Neo-Cast root" "$NEO_CAST_ROOT_RESOLVED"
check_path "Neo-Cast smoke runner" "$NEO_CAST_ROOT_RESOLVED/scripts/neo_research_tsf_e2e.sh"
check_path "Neo-Cast recipe example" "$NEO_CAST_ROOT_RESOLVED/py/schemas/recipe.example.json"

print_step "Local runtime"
if [[ -d "$RUNTIME_ROOT_RESOLVED" ]]; then
  print_ok "runtime root: $RUNTIME_ROOT_RESOLVED"
else
  print_warn "runtime root not initialized: $RUNTIME_ROOT_RESOLVED"
fi
check_path "XDG data home" "$XDG_DATA_HOME"
check_path "XDG config home" "$XDG_CONFIG_HOME"
check_path "XDG cache home" "$XDG_CACHE_HOME"
check_path "XDG state home" "$XDG_STATE_HOME"

print_step "Workspace dependencies"
if [[ -d "$ROOT/opencode/node_modules" ]]; then
  print_ok "opencode/node_modules exists"
else
  print_fail "opencode/node_modules missing; run scripts/bootstrap_local_dev.sh"
  failures=$((failures + 1))
fi

print_step "Python imports"
python_bin="$(neo_cast_python_for_root "$ROOT")"
if "$python_bin" - <<'PY' >/dev/null 2>&1
import numpy
import torch
PY
then
  print_ok "numpy and torch import: $python_bin"
else
  print_fail "Python cannot import numpy and torch: $python_bin"
  failures=$((failures + 1))
fi

if [[ "$quick" -eq 0 ]]; then
  print_step "Neo-Cast smoke dry-run"
  if (cd "$NEO_CAST_ROOT_RESOLVED" && bash scripts/neo_research_tsf_e2e.sh --dry-run --stage smoke --candidate py/schemas/recipe.example.json >/dev/null); then
    print_ok "Neo-Cast smoke dry-run"
  else
    print_fail "Neo-Cast smoke dry-run failed"
    failures=$((failures + 1))
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  print_fail "$failures check(s) failed"
  exit 1
fi

print_ok "NeoResearch local development environment looks ready"
