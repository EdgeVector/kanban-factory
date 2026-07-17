#!/usr/bin/env bash
# Install / load / unload the Kanban Factory LaunchAgent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.edgevector.kanban-factory"
PLIST_SRC="$ROOT/launchd/${LABEL}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

usage() {
  cat <<EOF
Usage: $0 <install|uninstall|status|restart>

  install    Copy plist to ~/Library/LaunchAgents and bootstrap
  uninstall  Bootout and remove the installed plist
  status     Show launchctl + health URL
  restart    Kickstart the job (or install if missing)
EOF
}

health() {
  curl -fsS --max-time 2 "http://127.0.0.1:4177/api/health" 2>/dev/null || echo "(not responding)"
}

cmd="${1:-}"
case "$cmd" in
  install)
    chmod +x "$ROOT/scripts/run.sh"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    # Free port if a manual node is still listening
    if lsof -nP -iTCP:4177 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Stopping process(es) on :4177 so launchd can bind…"
      # shellcheck disable=SC2046
      kill $(lsof -nP -iTCP:4177 -sTCP:LISTEN -t) 2>/dev/null || true
      sleep 0.5
    fi
    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST_DST"
    launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
    sleep 1
    echo "Installed + started: $LABEL"
    echo "URL:  http://127.0.0.1:4177"
    echo "Logs: ~/Library/Logs/kanban-factory.{out,err}.log"
    echo -n "Health: "; health; echo
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_DST"
    echo "Uninstalled $LABEL"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | head -30 || echo "(not loaded)"
    echo
    echo -n "Health: "; health; echo
    ;;
  restart)
    if [[ ! -f "$PLIST_DST" ]]; then
      exec "$0" install
    fi
    launchctl kickstart -k "$DOMAIN/$LABEL"
    sleep 1
    echo -n "Health: "; health; echo
    ;;
  *)
    usage
    exit 1
    ;;
esac
