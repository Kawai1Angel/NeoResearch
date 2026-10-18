#!/usr/bin/env bash
set -euo pipefail
EXPORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NEO_CAST_ROOT="$EXPORT_ROOT/neo_cast"
export NEO_RESEARCH_EXPERIENCE_DB="$EXPORT_ROOT/.neo-research/experience.db"
export NEO_RESEARCH_RUNTIME_ROOT="$EXPORT_ROOT/.neo-research/runtime"
export XDG_DATA_HOME="$NEO_RESEARCH_RUNTIME_ROOT/xdg/data"
export XDG_CONFIG_HOME="$NEO_RESEARCH_RUNTIME_ROOT/xdg/config"
export XDG_CACHE_HOME="$NEO_RESEARCH_RUNTIME_ROOT/xdg/cache"
export XDG_STATE_HOME="$NEO_RESEARCH_RUNTIME_ROOT/xdg/state"
export NEO_CAST_CV_MAX_PARALLEL_FOLDS=4
export NEO_RESEARCH_LITERATURE_PAPER_MODE=reuse_only
python3 "$EXPORT_ROOT/scripts/initialize_export.py"
exec bash "$EXPORT_ROOT/scripts/dev_cli.sh" "$@"
