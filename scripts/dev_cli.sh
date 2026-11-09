#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/dev_cli.sh [neoresearch-cli-args...]

Run the NeoResearch CLI from source with local Neo-Cast environment variables.

Examples:
  scripts/dev_cli.sh research --help
  scripts/dev_cli.sh research create --mode review
  scripts/dev_cli.sh research worker-once
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

load_env_local "$ROOT"
export_local_dev_environment "$ROOT"
ensure_local_dev_dirs

cd "$ROOT/neoresearch/packages/neoresearch"
bun_bin="$(bun_path_for_root "$ROOT")" || {
  print_fail "bun runtime not found; install Bun before running the source CLI"
  exit 1
}
export PATH="$(dirname "$bun_bin"):$PATH"
exec "$bun_bin" run --conditions=browser src/index.ts "$@"
