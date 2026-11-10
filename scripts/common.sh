#!/usr/bin/env bash

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

print_step() {
  printf '\n==> %s\n' "$1"
}

print_ok() {
  printf 'OK: %s\n' "$1"
}

print_warn() {
  printf 'WARN: %s\n' "$1" >&2
}

print_fail() {
  printf 'FAIL: %s\n' "$1" >&2
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

bun_path_for_root() {
  local root="${1:-}"
  local candidate

  if have_command bun; then
    command -v bun
    return 0
  fi

  if [[ -n "${HOME:-}" && -x "$HOME/.bun/bin/bun" ]]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
    return 0
  fi

  if [[ -n "$root" ]]; then
    for candidate in \
      "$root/neoresearch/node_modules/.bin/bun" \
      "$root/neoresearch/packages/neoresearch/node_modules/.bin/bun" \
      "$root/neoresearch/packages/app/node_modules/.bin/bun"; do
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  fi

  return 1
}

have_bun_runtime() {
  local root="${1:-}"
  bun_path_for_root "$root" >/dev/null 2>&1
}

run_bun() {
  local root="$1"
  shift

  local bun_bin
  bun_bin="$(bun_path_for_root "$root")" || return 127
  PATH="$(dirname "$bun_bin"):$PATH" "$bun_bin" "$@"
}

load_env_local() {
  local root="$1"
  local env_file="$root/.env.local"
  if [[ ! -f "$env_file" ]]; then
    return 0
  fi

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

resolve_neo_cast_root() {
  local root="$1"
  if [[ -n "${NEO_CAST_ROOT:-}" ]]; then
    printf '%s\n' "$NEO_CAST_ROOT"
    return 0
  fi
  printf '%s\n' "$root/neo_cast"
}

neo_cast_python_for_root() {
  local root="$1"
  local neo_cast_root
  neo_cast_root="$(resolve_neo_cast_root "$root")"

  if [[ -n "${NEO_CAST_PYTHON:-}" ]]; then
    printf '%s\n' "$NEO_CAST_PYTHON"
  elif [[ -x "$neo_cast_root/.neo-cast/runtime/.venv/bin/python" ]]; then
    printf '%s\n' "$neo_cast_root/.neo-cast/runtime/.venv/bin/python"
  else
    printf '%s\n' "python3"
  fi
}

resolve_runtime_root() {
  local root="$1"
  if [[ -n "${NEO_RESEARCH_RUNTIME_ROOT:-}" ]]; then
    printf '%s\n' "$NEO_RESEARCH_RUNTIME_ROOT"
    return 0
  fi
  printf '%s\n' "$root/.neo-research/runtime"
}

export_local_dev_environment() {
  local root="$1"
  local runtime_root

  export NEO_CAST_ROOT="$(resolve_neo_cast_root "$root")"
  export NEO_RESEARCH_RUNTIME_ROOT="$(resolve_runtime_root "$root")"
  runtime_root="$NEO_RESEARCH_RUNTIME_ROOT"

  export XDG_DATA_HOME="${XDG_DATA_HOME:-$runtime_root/xdg/data}"
  export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$runtime_root/xdg/config}"
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$runtime_root/xdg/cache}"
  export XDG_STATE_HOME="${XDG_STATE_HOME:-$runtime_root/xdg/state}"
}

ensure_local_dev_dirs() {
  mkdir -p "$NEO_RESEARCH_RUNTIME_ROOT"
  mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
  mkdir -p "$NEO_CAST_ROOT/.neo-cast/artifacts"
}

write_env_local() {
  local root="$1"
  local neo_cast_root="$2"
  local runtime_root="$3"
  local env_file="$root/.env.local"

  cat >"$env_file" <<ENV
NEO_CAST_ROOT=$neo_cast_root
NEO_RESEARCH_RUNTIME_ROOT=$runtime_root
XDG_DATA_HOME=$runtime_root/xdg/data
XDG_CONFIG_HOME=$runtime_root/xdg/config
XDG_CACHE_HOME=$runtime_root/xdg/cache
XDG_STATE_HOME=$runtime_root/xdg/state
ENV
}
