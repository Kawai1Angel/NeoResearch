#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/dev_web.sh [vite-args...]

Run the source Web Dashboard development server.

Example:
  scripts/dev_web.sh
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

load_env_local "$ROOT"
export_local_dev_environment "$ROOT"
ensure_local_dev_dirs

cd "$ROOT/opencode/packages/app"
bun_bin="$(bun_path_for_root "$ROOT")" || {
  print_fail "bun runtime not found; install Bun before running the Web Dashboard"
  exit 1
}
export PATH="$(dirname "$bun_bin"):$PATH"
exec "$bun_bin" run dev "$@"
