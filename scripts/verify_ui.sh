#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/verify_ui.sh

Run Web Dashboard and TUI Cockpit UI verification, then write ui-verification.json.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ARTIFACT_DIR="$ROOT/.neo-research/artifacts/ui"
mkdir -p "$ARTIFACT_DIR"

set +e
"$ROOT/scripts/verify_web_ui.sh"
web_status=$?
"$ROOT/scripts/verify_tui_cockpit.sh"
tui_status=$?
set -e

node - "$ARTIFACT_DIR" "$web_status" "$tui_status" <<'NODE'
const fs = require("fs")
const path = require("path")

const artifactDir = process.argv[2]
const webStatus = Number(process.argv[3])
const tuiStatus = Number(process.argv[4])

function readJSON(name) {
  const file = path.join(artifactDir, name)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

fs.writeFileSync(
  path.join(artifactDir, "ui-verification.json"),
  JSON.stringify(
    {
      ok: webStatus === 0 && tuiStatus === 0,
      generatedAt: new Date().toISOString(),
      web: {
        ok: webStatus === 0,
        status: webStatus,
        result: readJSON("web-dashboard.json"),
      },
      tui: {
        ok: tuiStatus === 0,
        status: tuiStatus,
        result: readJSON("tui-cockpit.json"),
      },
      artifacts: {
        webDesktop: path.join(artifactDir, "web-dashboard-desktop.png"),
        webMobile: path.join(artifactDir, "web-dashboard-mobile.png"),
        tuiSnapshot: path.join(artifactDir, "tui-cockpit.txt"),
      },
    },
    null,
    2,
  ) + "\n",
)
NODE

if [[ "$web_status" -ne 0 || "$tui_status" -ne 0 ]]; then
  print_fail "UI verification failed; see $ARTIFACT_DIR/ui-verification.json"
  exit 1
fi

print_ok "UI verification completed"
