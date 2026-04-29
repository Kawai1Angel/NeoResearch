#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PYTHON_BIN="${PYTHON:-python3}"
CANDIDATE_PATH=""
STAGE="smoke"
DRY_RUN=0
SKIP_REF_TEST=0
SEEDS="42,43,44"

usage() {
  cat <<'EOF'
Usage:
  neo_research_tsf_e2e.sh [options]

Options:
  --dry-run                         Print writes and commands without executing them.
  --project-root PATH               Neo-Cast project root. Defaults to this script's parent.
  --python PATH                     Python executable. Defaults to $PYTHON or python3.
  --candidate PATH                  Candidate/recipe JSON to copy into .neo-cast/current_candidate.json.
  --stage smoke|full|seed-sweep|ref-test
                                    Acceptance stage to run. Defaults to smoke.
  --skip-ref-test                   For --stage full, do not run runner.py ref-test afterward.
  --seeds CSV                       Seeds for --stage seed-sweep. Defaults to 42,43,44.
  -h, --help                        Show this help.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --project-root)
      [[ $# -ge 2 ]] || fail "--project-root requires a value"
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --python)
      [[ $# -ge 2 ]] || fail "--python requires a value"
      PYTHON_BIN="$2"
      shift 2
      ;;
    --candidate)
      [[ $# -ge 2 ]] || fail "--candidate requires a value"
      CANDIDATE_PATH="$2"
      shift 2
      ;;
    --stage)
      [[ $# -ge 2 ]] || fail "--stage requires a value"
      STAGE="$2"
      shift 2
      ;;
    --skip-ref-test)
      SKIP_REF_TEST=1
      shift
      ;;
    --seeds)
      [[ $# -ge 2 ]] || fail "--seeds requires a value"
      SEEDS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

case "$STAGE" in
  smoke|full|seed-sweep|ref-test) ;;
  *) fail "--stage must be one of: smoke, full, seed-sweep, ref-test" ;;
esac

PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
STATE_DIR=".neo-cast"
CURRENT_CANDIDATE="${STATE_DIR}/current_candidate.json"
RESOLVED_CANDIDATE="${STATE_DIR}/resolved_candidate.json"
ARTIFACTS_DIR="${STATE_DIR}/artifacts"
RUNNER_STATE="${STATE_DIR}/runner_state.json"

if [[ "$STAGE" != "ref-test" && -z "$CANDIDATE_PATH" ]]; then
  fail "--candidate is required for stage $STAGE"
fi

if [[ -n "$CANDIDATE_PATH" ]]; then
  CANDIDATE_PATH="$(cd "$(dirname "$CANDIDATE_PATH")" && pwd)/$(basename "$CANDIDATE_PATH")"
  [[ -f "$CANDIDATE_PATH" ]] || fail "candidate not found: $CANDIDATE_PATH"
fi

[[ -f "${PROJECT_ROOT}/py/runner.py" ]] || fail "py/runner.py not found under project root: $PROJECT_ROOT"
[[ -f "${PROJECT_ROOT}/py/validate.py" ]] || fail "py/validate.py not found under project root: $PROJECT_ROOT"

quote_cmd() {
  printf "%q" "$1"
  shift || true
  for arg in "$@"; do
    printf " %q" "$arg"
  done
}

run_cmd() {
  printf "command=(cd %q && " "$PROJECT_ROOT"
  quote_cmd "$PYTHON_BIN" "$@"
  printf ")\n"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    (cd "$PROJECT_ROOT" && "$PYTHON_BIN" "$@")
  fi
}

ensure_state_dirs() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "mkdir=${PROJECT_ROOT}/${ARTIFACTS_DIR}"
  else
    mkdir -p "${PROJECT_ROOT}/${ARTIFACTS_DIR}"
  fi
}

write_candidate() {
  ensure_state_dirs
  echo "write_candidate=${PROJECT_ROOT}/${CURRENT_CANDIDATE}"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    cp "$CANDIDATE_PATH" "${PROJECT_ROOT}/${CURRENT_CANDIDATE}"
  fi
}

write_candidate_with_seed() {
  local seed="$1"
  ensure_state_dirs
  echo "write_candidate=${PROJECT_ROOT}/${CURRENT_CANDIDATE}"
  echo "write_candidate_seed=${seed}"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$PYTHON_BIN" - "$CANDIDATE_PATH" "${PROJECT_ROOT}/${CURRENT_CANDIDATE}" "$seed" <<'PY'
import json
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
seed = int(sys.argv[3])
payload = json.loads(source.read_text(encoding="utf-8"))

def patch_seed(obj):
    if not isinstance(obj, dict):
        return
    train_config = obj.get("train_config")
    if isinstance(train_config, dict):
        train_config["seed"] = seed
    training_strategy = obj.get("training_strategy")
    if isinstance(training_strategy, dict):
        budget = training_strategy.setdefault("budget", {})
        if isinstance(budget, dict):
            budget["seed"] = seed
    recipe = obj.get("recipe")
    if isinstance(recipe, dict):
        patch_seed(recipe)
    model_config = obj.get("model_config")
    if isinstance(model_config, dict) and isinstance(model_config.get("recipe"), dict):
        patch_seed(model_config["recipe"])

patch_seed(payload)
target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
  fi
}

ensure_runner_state() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "state_check=${PROJECT_ROOT}/${RUNNER_STATE}"
    run_cmd "py/runner.py" "init"
    return
  fi
  if [[ ! -f "${PROJECT_ROOT}/${RUNNER_STATE}" ]]; then
    run_cmd "py/runner.py" "init"
  fi
}

run_smoke() {
  write_candidate
  run_cmd \
    "py/validate.py" \
    "smoke" \
    "--candidate-path" "$CURRENT_CANDIDATE" \
    "--resolved-path" "$RESOLVED_CANDIDATE" \
    "--artifacts-dir" "$ARTIFACTS_DIR"
}

run_full_once() {
  local description="$1"
  ensure_runner_state
  run_cmd "py/runner.py" "run" "--description" "$description"
}

run_ref_test() {
  ensure_runner_state
  run_cmd "py/runner.py" "ref-test"
}

echo "neo_research_tsf_e2e_stage=${STAGE}"
echo "project_root=${PROJECT_ROOT}"
echo "python=${PYTHON_BIN}"
echo "dry_run=${DRY_RUN}"

case "$STAGE" in
  smoke)
    run_smoke
    ;;
  full)
    write_candidate
    run_full_once "NeoResearch TSF full e2e"
    if [[ "$SKIP_REF_TEST" -eq 0 ]]; then
      run_ref_test
    fi
    ;;
  seed-sweep)
    IFS=',' read -r -a seed_items <<< "$SEEDS"
    for raw_seed in "${seed_items[@]}"; do
      seed="$(echo "$raw_seed" | tr -d '[:space:]')"
      [[ "$seed" =~ ^[0-9]+$ ]] || fail "invalid seed in --seeds: $raw_seed"
      write_candidate_with_seed "$seed"
      run_full_once "NeoResearch TSF seed-sweep seed ${seed}"
    done
    ;;
  ref-test)
    run_ref_test
    ;;
esac
