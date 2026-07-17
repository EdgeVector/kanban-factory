#!/usr/bin/env bash
# LaunchAgent entrypoint for Kanban Factory (read-only theater server).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export HOME="${HOME:-/Users/tomtang}"
export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

export PORT="${PORT:-4177}"
export POLL_MS="${POLL_MS:-4000}"
export HOST="127.0.0.1"

cd "$ROOT"
exec /opt/homebrew/bin/node "$ROOT/server.mjs"
