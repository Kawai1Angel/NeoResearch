#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

# Verify interpreter precedence without depending on installed Python packages.
(
  fixture_root="$(mktemp -d)"
  trap 'rm -rf "$fixture_root"' EXIT
  unset NEO_CAST_ROOT NEO_CAST_PYTHON
  [[ "$(neo_cast_python_for_root "$fixture_root")" == "python3" ]]
  runtime_python="$fixture_root/neo_cast/.neo-cast/runtime/.venv/bin/python"
  mkdir -p "$(dirname "$runtime_python")"
  touch "$runtime_python"
  chmod +x "$runtime_python"
  [[ "$(neo_cast_python_for_root "$fixture_root")" == "$runtime_python" ]]
  export NEO_CAST_ROOT="$fixture_root/external neo cast"
  [[ "$(neo_cast_python_for_root "$fixture_root")" == "python3" ]]
  custom_python="$NEO_CAST_ROOT/.neo-cast/runtime/.venv/bin/python"
  mkdir -p "$(dirname "$custom_python")"
  touch "$custom_python"
  chmod +x "$custom_python"
  [[ "$(neo_cast_python_for_root "$fixture_root")" == "$custom_python" ]]
  export NEO_CAST_PYTHON="$fixture_root/explicit python"
  [[ "$(neo_cast_python_for_root "$fixture_root")" == "$NEO_CAST_PYTHON" ]]
)

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
