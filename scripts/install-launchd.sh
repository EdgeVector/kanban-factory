#!/usr/bin/env bash
# Install / load / unload the Kanban Factory LaunchAgent.
#
# Always installs from THIS checkout (ROOT). Rewrites the LaunchAgent plist so
# ProgramArguments + WorkingDirectory + HOME/USER/PATH match this machine —
# never leave author-machine placeholders in ~/Library/LaunchAgents.
#
# Public install (any machine):
#   git clone https://github.com/EdgeVector/kanban-factory.git \
#     ~/.local/share/edgevector/kanban-factory
#   ~/.local/share/edgevector/kanban-factory/scripts/install-launchd.sh install
#
# Or use a checkout under ~/lastdb-apps/kanban-factory from last-stack-install-apps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.edgevector.kanban-factory"
PLIST_SRC="$ROOT/launchd/${LABEL}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

# launchd PATH: host-track first, Apple git before Homebrew (path hygiene)
LAUNCHD_PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${HOME}/.cargo/bin:/usr/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/bin:/usr/sbin:/sbin"

usage() {
  cat <<EOF
Usage: $0 <install|uninstall|status|restart|update|refresh-git>

  install      Render plist for this ROOT, bootstrap LaunchAgent, start
  uninstall    Bootout and remove the installed plist
  status       Show launchctl + health URL + which kanban/factory root
  restart      Kickstart the job (or install if missing)
  update       Reset this checkout to origin/main + reinstall + restart
  refresh-git  Fetch origin/main and hard-reset this checkout to that tip

This ROOT: $ROOT
EOF
}

# Reset ROOT to refs/remotes/origin/main. Local `main` is not the tip: a
# registered worktree that checks out `main` freezes that ref, so
# `reset --hard main` is a no-op on a stale install (live :4177 sat on
# 31a4fe1 for ~8 weeks while origin/main already had ship-meter.mjs).
refresh_git() {
  if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Not a git checkout; leaving $ROOT as-is"
    return 0
  fi
  echo "Updating checkout at $ROOT to origin/main …"
  fetch_ok=0
  if command -v last-stack-forge-git >/dev/null 2>&1; then
    if last-stack-forge-git -C "$ROOT" fetch origin --prune \
        '+refs/heads/main:refs/remotes/origin/main'; then
      fetch_ok=1
    fi
  elif git -C "$ROOT" fetch origin --prune \
      '+refs/heads/main:refs/remotes/origin/main'; then
    fetch_ok=1
  fi
  if ! git -C "$ROOT" rev-parse --verify refs/remotes/origin/main >/dev/null 2>&1; then
    echo "error: origin/main missing after fetch (fetch_ok=${fetch_ok})" >&2
    return 1
  fi
  if [[ "$fetch_ok" -eq 0 ]]; then
    echo "warn: git fetch origin failed; resetting to already-cached origin/main"
  fi
  git -C "$ROOT" checkout -B main refs/remotes/origin/main
  git -C "$ROOT" reset --hard refs/remotes/origin/main
  git -C "$ROOT" log -1 --oneline
}

health() {
  curl -fsS --max-time 2 "http://127.0.0.1:4177/api/health" 2>/dev/null || echo "(not responding)"
}

render_plist() {
  # Prefer a checked-in template when present; always rewrite absolute paths.
  mkdir -p "$(dirname "$PLIST_DST")"
  if [[ -f "$PLIST_SRC" ]]; then
    cp "$PLIST_SRC" "$PLIST_DST"
  fi
  python3 - "$ROOT" "$PLIST_DST" "$LAUNCHD_PATH" "$HOME" <<'PY'
import plistlib
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
dst = Path(sys.argv[2])
launchd_path = sys.argv[3]
home = sys.argv[4]

run_sh = root / "scripts" / "run.sh"
if not run_sh.is_file():
    raise SystemExit(f"missing entrypoint: {run_sh}")

if dst.is_file():
    with dst.open("rb") as f:
        data = plistlib.load(f)
else:
    data = {}

data["Label"] = "com.edgevector.kanban-factory"
data["ProgramArguments"] = [str(run_sh)]
data["WorkingDirectory"] = str(root)
data["RunAtLoad"] = True
data["KeepAlive"] = True
data["ProcessType"] = "Background"
data["ThrottleInterval"] = 5
data["StandardOutPath"] = str(Path(home) / "Library/Logs/kanban-factory.out.log")
data["StandardErrorPath"] = str(Path(home) / "Library/Logs/kanban-factory.err.log")

env = data.setdefault("EnvironmentVariables", {})
env["HOME"] = home
env["USER"] = Path(home).name
env["PATH"] = launchd_path
env["PORT"] = str(env.get("PORT") or "4177")
env["POLL_MS"] = str(env.get("POLL_MS") or "60000")

with dst.open("wb") as f:
    plistlib.dump(data, f, sort_keys=False)

print(f"rendered {dst}")
print(f"  ProgramArguments: {data['ProgramArguments']}")
print(f"  WorkingDirectory: {data['WorkingDirectory']}")
print(f"  PATH: {env['PATH']}")
PY
}

free_port() {
  if lsof -nP -iTCP:4177 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Stopping process(es) on :4177 so launchd can bind…"
    # shellcheck disable=SC2046
    kill $(lsof -nP -iTCP:4177 -sTCP:LISTEN -t) 2>/dev/null || true
    sleep 0.5
  fi
}

do_install() {
  chmod +x "$ROOT/scripts/run.sh" "$ROOT/scripts/install-launchd.sh"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  free_port
  render_plist
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST_DST"
  launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
  sleep 1
  echo "Installed + started: $LABEL"
  echo "ROOT: $ROOT"
  echo "URL:  http://127.0.0.1:4177"
  echo "Logs: ~/Library/Logs/kanban-factory.{out,err}.log"
  echo -n "Health: "; health; echo
  if command -v kanban >/dev/null 2>&1; then
    echo "kanban: $(command -v kanban)"
    # show host-track resolution without hanging on status
    ls -la "$(command -v kanban)" 2>/dev/null || true
  else
    echo "warn: kanban not on PATH for this shell (LaunchAgent uses rendered PATH)"
  fi
}

cmd="${1:-}"
case "$cmd" in
  install)
    do_install
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_DST"
    echo "Uninstalled $LABEL"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | head -40 || echo "(not loaded)"
    echo
    echo "ROOT (this script): $ROOT"
    if [[ -f "$PLIST_DST" ]]; then
      echo "Installed plist:"
      plutil -p "$PLIST_DST" 2>/dev/null | head -40 || true
    fi
    echo -n "Health: "; health; echo
    if lsof -nP -iTCP:4177 -sTCP:LISTEN >/dev/null 2>&1; then
      pid=$(lsof -nP -iTCP:4177 -sTCP:LISTEN -t | head -1)
      echo "Listener PID $pid:"
      ps -p "$pid" -o pid=,command= 2>/dev/null || true
    fi
    PATH="$LAUNCHD_PATH" command -v kanban 2>/dev/null | sed 's/^/kanban (launchd PATH): /' || echo "kanban (launchd PATH): missing"
    ;;
  restart)
    if [[ ! -f "$PLIST_DST" ]]; then
      exec "$0" install
    fi
    # Re-render in case ROOT moved
    render_plist
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    free_port
    launchctl bootstrap "$DOMAIN" "$PLIST_DST"
    launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
    sleep 1
    echo -n "Health: "; health; echo
    ;;
  update)
    refresh_git
    if [[ "${KANBAN_FACTORY_SKIP_LAUNCHD:-}" == "1" ]]; then
      echo "KANBAN_FACTORY_SKIP_LAUNCHD=1: skipped LaunchAgent reinstall"
      exit 0
    fi
    do_install
    ;;
  refresh-git)
    refresh_git
    ;;
  *)
    usage
    exit 1
    ;;
esac
