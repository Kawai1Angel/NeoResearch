#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/bootstrap_local_dev.sh [--dry-run] [--skip-install]

Prepare the NeoResearch source tree for local development.

Options:
  --dry-run       Print checks and planned actions without writing files or installing dependencies.
  --skip-install  Do not run bun install even when opencode/node_modules is missing.
  -h, --help      Show this help.
USAGE
}

dry_run=0
skip_install=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --skip-install)
      skip_install=1
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

print_step "Checking toolchain"
for tool in node npm python3; do
  if have_command "$tool"; then
    print_ok "$tool found"
  else
    print_fail "$tool not found"
    exit 1
  fi
done
if have_bun_runtime "$ROOT"; then
  print_ok "bun runtime found: $(bun_path_for_root "$ROOT")"
elif [[ "$dry_run" -eq 1 ]]; then
  print_warn "bun runtime not found; install Bun before running dependency install or dev servers"
else
  print_fail "bun runtime not found; install Bun before running dependency install or dev servers"
  exit 1
fi

print_step "Checking project directories"
[[ -d "$ROOT/opencode" ]] || { print_fail "missing opencode directory"; exit 1; }
[[ -d "$NEO_CAST_ROOT_RESOLVED" ]] || { print_fail "missing Neo-Cast root: $NEO_CAST_ROOT_RESOLVED"; exit 1; }
print_ok "opencode directory found"
print_ok "Neo-Cast root: $NEO_CAST_ROOT_RESOLVED"

print_step "Checking Python runtime dependencies"
if python3 - <<'PY' >/dev/null 2>&1
import numpy
import torch
PY
then
  print_ok "Python imports numpy and torch"
else
  print_warn "Python cannot import numpy and torch; install Neo-Cast Python dependencies before full training"
fi

print_step "Preparing local configuration"
if [[ "$dry_run" -eq 1 ]]; then
  print_ok "would write $ROOT/.env.local"
  print_ok "would create $RUNTIME_ROOT_RESOLVED"
  print_ok "would create local XDG runtime directories"
  print_ok "would create $NEO_CAST_ROOT_RESOLVED/.neo-cast/artifacts"
else
  write_env_local "$ROOT" "$NEO_CAST_ROOT_RESOLVED" "$RUNTIME_ROOT_RESOLVED"
  ensure_local_dev_dirs
  print_ok "wrote .env.local"
  print_ok "created runtime and artifact directories"
fi

print_step "Checking opencode workspace dependencies"
if [[ "$skip_install" -eq 1 || "$dry_run" -eq 1 ]]; then
  if [[ -d "$ROOT/opencode/node_modules" ]]; then
    print_ok "opencode/node_modules exists"
  else
    print_warn "opencode/node_modules missing; run bun install in opencode or rerun without --skip-install"
  fi
else
  if [[ -d "$ROOT/opencode/node_modules" ]]; then
    print_step "Refreshing opencode workspace dependencies"
  else
    print_step "Running bun install in opencode"
  fi
  (cd "$ROOT/opencode" && run_bun "$ROOT" install)
fi

print_step "Bootstrap summary"
print_ok "NEO_CAST_ROOT=$NEO_CAST_ROOT_RESOLVED"
print_ok "NEO_RESEARCH_RUNTIME_ROOT=$RUNTIME_ROOT_RESOLVED"
printf '\nNext:\n'
printf '  ./scripts/doctor.sh\n'
printf '  ./scripts/dev_cli.sh research --help\n'
printf '  ./scripts/smoke_tsf.sh\n'
