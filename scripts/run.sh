#!/usr/bin/env bash
# LaunchAgent entrypoint for Kanban Factory (read-only theater server).
#
# Install from any checkout of this repo (git clone, last-stack-install-apps,
# or a stable runtime dir). Prefer:
#   ~/.local/share/edgevector/kanban-factory
#
# Board reads use `kanban` on PATH (Last Stack / host-track install puts
# ~/.local/bin first).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${HOME:-}" ]]; then
  echo "error: HOME is not set" >&2
  exit 1
fi

# PATH hygiene (see last-stack docs/launchd-path-hygiene.md when present):
# - ~/.local/bin first so host-track / last-stack-install-apps kanban wins
# - /usr/bin before Homebrew (Homebrew git can CF-segfault under launchd)
export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/.cargo/bin:/usr/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/bin:/usr/sbin:/sbin"

export PORT="${PORT:-4177}"
export POLL_MS="${POLL_MS:-60000}"
export HOST="127.0.0.1"

# Explicit kanban binary for the server (spawn still uses PATH; this is for diagnostics)
if [[ -x "${HOME}/.local/bin/kanban" ]]; then
  export KANBAN_BIN="${KANBAN_BIN:-${HOME}/.local/bin/kanban}"
elif command -v kanban >/dev/null 2>&1; then
  export KANBAN_BIN="${KANBAN_BIN:-$(command -v kanban)}"
else
  echo "error: kanban not found on PATH (install Last Stack apps, then: kanban init)" >&2
  exit 1
fi

resolve_node() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    printf '%s\n' "${NODE_BIN}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN_RESOLVED="$(resolve_node)" || {
  echo "error: node not found (need Node 18+ on PATH)" >&2
  exit 1
}

cd "$ROOT"
exec "$NODE_BIN_RESOLVED" "$ROOT/server.mjs"
