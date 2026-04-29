#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

required_scripts=(
  "bootstrap_local_dev.sh"
  "doctor.sh"
  "test_all.sh"
  "dev_cli.sh"
  "dev_web.sh"
  "verify_web_ui.sh"
  "verify_tui_cockpit.sh"
  "verify_ui.sh"
  "smoke_tsf.sh"
)

for script in "${required_scripts[@]}"; do
  path="$ROOT/scripts/$script"
  if [[ ! -f "$path" ]]; then
    echo "missing script: scripts/$script" >&2
    exit 1
  fi
  if [[ ! -x "$path" ]]; then
    echo "script is not executable: scripts/$script" >&2
    exit 1
  fi
  if ! "$path" --help | grep -q "Usage:"; then
    echo "script help does not include Usage: scripts/$script" >&2
    exit 1
  fi
done

for target in setup doctor test dev-cli dev-web verify-ui smoke; do
  if ! make -C "$ROOT" -n "$target" >/dev/null; then
    echo "missing Makefile target: $target" >&2
    exit 1
  fi
done

if ! "$ROOT/scripts/bootstrap_local_dev.sh" --dry-run --skip-install >/dev/null; then
  echo "bootstrap dry-run failed" >&2
  exit 1
fi

if ! "$ROOT/scripts/smoke_tsf.sh" >/dev/null; then
  echo "Neo-Cast smoke dry-run failed" >&2
  exit 1
fi

echo "local dev scripts contract OK"
