#!/usr/bin/env bash
# LaunchAgent entrypoint for Kanban Factory (read-only theater server).
#
# Proper install root (post-portal, 2026-07-22+):
#   ~/.local/share/edgevector/kanban-factory
# created as a bare-cache worktree on main — NOT the ambient portal
# ~/code/edgevector/kanban-factory and NOT *.legacy-checkout.
#
# Board reads go through host-track kanban:
#   ~/.local/bin/kanban → ~/.host-track/apps/fkanban/current
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export HOME="${HOME:-/Users/tomtang}"

# PATH hygiene (see last-stack docs/launchd-path-hygiene.md):
# - ~/.local/bin first so host-track kanban/fkanban win
# - /usr/bin before /opt/homebrew/bin (Homebrew git CF-segfault under launchd)
export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/.cargo/bin:/usr/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/bin:/usr/sbin:/sbin"

export PORT="${PORT:-4177}"
export POLL_MS="${POLL_MS:-4000}"
export HOST="127.0.0.1"

# Explicit kanban binary for the server (spawn still uses PATH; this is for diagnostics)
if [[ -x "${HOME}/.local/bin/kanban" ]]; then
  export KANBAN_BIN="${KANBAN_BIN:-${HOME}/.local/bin/kanban}"
elif command -v kanban >/dev/null 2>&1; then
  export KANBAN_BIN="${KANBAN_BIN:-$(command -v kanban)}"
else
  echo "error: kanban not found on PATH (expected host-track ~/.local/bin/kanban)" >&2
  exit 1
fi

cd "$ROOT"
exec /opt/homebrew/bin/node "$ROOT/server.mjs"
