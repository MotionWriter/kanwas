#!/bin/bash
set -euo pipefail

# User-run macOS launcher. The CLI opens the system browser; no embedded login.
kanwas_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
kanwas_node="$(command -v node || true)"
kanwas_node_supported() {
  [[ -n "$1" && -x "$1" ]] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1
}
if ! kanwas_node_supported "$kanwas_node"; then
  kanwas_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi

if ! kanwas_node_supported "$kanwas_node"; then
  echo "Node.js 22 or newer is required. Install the fork's dependencies first."
  exit 1
fi
if [[ ! -d "$kanwas_dir/backend/node_modules/tsx" ]]; then
  echo "Dependencies are missing. Run pnpm install --frozen-lockfile in the Kanwas directory."
  exit 1
fi

if [[ "$#" -eq 1 && "$1" == "--check" ]]; then
  echo "Local sign-in launcher is ready."
  exit 0
fi
if [[ "$#" -ne 0 ]]; then
  echo "Usage: try_chatgpt_signin.command [--check]"
  exit 1
fi

cd -- "$kanwas_dir/backend"
export KANWAS_CHATGPT_AUTH_DIR="$kanwas_dir/.chatgpt-plan/signin-test"
echo "This tests ChatGPT sign-in only; it does not start the Kanwas canvas."
echo "Your regular browser will open. Complete login and review Kanwas's requested access."
echo "The local callback waits up to five minutes. No API key is used."

kanwas_result=0
"$kanwas_node" --import tsx scripts/chatgpt_plan_auth.ts signin --user-id local-signin-test || kanwas_result=$?
echo
if [[ "$kanwas_result" -eq 0 ]]; then
  echo "Sign-in flow finished. The status above shows whether ChatGPT plan access was granted."
else
  echo "Sign-in did not finish. Re-run this launcher for a fresh attempt."
fi
if [[ -t 0 ]]; then
  read -r -p "Press Return to close this window. " || true
fi
exit "$kanwas_result"
