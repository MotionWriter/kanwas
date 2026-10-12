#!/bin/bash
set -euo pipefail
kanwas_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
kanwas_node="$(command -v node || true)"
kanwas_node_supported() {
  [[ -n "$1" && -x "$1" ]] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1
}
if ! kanwas_node_supported "$kanwas_node"; then
  kanwas_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if ! kanwas_node_supported "$kanwas_node"; then
  echo "Install Node.js 22 or newer before starting Kanwas."
  exit 1
fi
exec "$kanwas_node" "$kanwas_dir/dev/local-trial/launcher.mjs" "$@"
