#!/usr/bin/env bash
# LastGit merge gate for kanban-factory (local theater UI over kanban + brain).
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob 2>/dev/null || true

echo "== venue =="
test "$(head -n 1 .last-stack/pr-venue)" = "lastgit"

echo "== shell syntax =="
for f in .lastgit/*.sh scripts/*.sh; do
  [ -e "$f" ] || continue
  echo "bash -n $f"
  bash -n "$f"
done

echo "== node syntax =="
# Prefer node; fall back to bun when CI scratch lacks node.
if command -v node >/dev/null 2>&1; then
  node --check server.mjs
  node --check public/app.js
  node --check ship-meter.mjs
elif command -v bun >/dev/null 2>&1; then
  bun --print "await import('./server.mjs')" >/dev/null 2>&1 || bun build server.mjs --target=node --outfile=/dev/null
  # bun has no --check; syntax-gate app.js via build to /dev/null
  bun build public/app.js --target=browser --outfile=/dev/null
else
  echo "no node/bun on PATH" >&2
  exit 1
fi

echo "== ship-meter unit tests =="
if command -v node >/dev/null 2>&1; then
  node --test *.test.mjs
  python3 scripts/pc-ci-remote.test.py
fi

echo "== required files =="
test -f server.mjs
test -f public/app.js
test -f public/index.html
test -f public/styles.css
test -f package.json
test -f README.md
test -f scripts/run.sh
test -f scripts/install-launchd.sh
test -f launchd/com.edgevector.kanban-factory.plist

echo "== package.json =="
python3 - <<'PY'
import json
from pathlib import Path
pkg = json.loads(Path("package.json").read_text())
assert pkg.get("name") == "kanban-factory"
assert pkg.get("type") == "module"
PY

echo "== board fetch uses --all (no silent 12/column cap) =="
# Guard the statistics bug: bare `kanban list --json` caps at 12/column.
rg -n 'list", \[.*"--json", "--all"' server.mjs \
  || rg -n 'list", \["--json", "--all"\]' server.mjs \
  || rg -n '"--json", "--all"' server.mjs

echo "== LastDB version panel surface =="
rg -n 'collectLastdbVersion|lastdbVersion|/api/lastdb-version' server.mjs >/dev/null
rg -n 'renderLastdbVersion|lastdb-panel|btn-lastdb-version' public/app.js >/dev/null
rg -n 'id="lastdb-panel"|btn-lastdb-version' public/index.html >/dev/null
rg -n '\.lastdb-panel' public/styles.css >/dev/null

echo "lastgit ci gate PASSED"
