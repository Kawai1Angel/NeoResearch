#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/smoke_tsf.sh [--run] [extra neo_research_tsf_e2e.sh args...]

Run the Neo-Cast TSF smoke dry-run by default. Pass --run to execute the smoke stage.

Examples:
  scripts/smoke_tsf.sh
  scripts/smoke_tsf.sh --run
USAGE
}

run=0
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      run=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

load_env_local "$ROOT"
export_local_dev_environment "$ROOT"
NEO_CAST_ROOT_RESOLVED="$NEO_CAST_ROOT"

cmd=(bash scripts/neo_research_tsf_e2e.sh --python "${PYTHON:-$(neo_cast_python_for_root "$ROOT")}" --stage smoke --candidate py/schemas/recipe.example.json)
if [[ "$run" -eq 0 ]]; then
  cmd+=(--dry-run)
fi
if [[ "${#args[@]}" -gt 0 ]]; then
  cmd+=("${args[@]}")
fi

cd "$NEO_CAST_ROOT_RESOLVED"
exec "${cmd[@]}"
