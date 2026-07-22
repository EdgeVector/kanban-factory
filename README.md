# Kanban Factory 🏭

An animated live theater for your **real** Kanban board and scheduled routines.

Cards float on conveyor lanes (`backlog → todo → doing → done`). When the board
changes, chips fly between stages with hop arcs, particle bursts, and soft
blips. Routines appear as a crew of characters with personalities — Pickup
grabs work, Groom unblocks backlog, Pipeline checks the merge clinic, etc.

## Run (auto-start on login) — proper path after portals

`~/code/edgevector/kanban-factory` is a **portal** (thin pointer, no product
tree). Do **not** install the LaunchAgent from that path or from
`*.legacy-checkout`.

**Stable runtime** (worktree of bare-cache `main`):

```bash
RUNTIME="$HOME/.local/share/edgevector/kanban-factory"
CACHE="$HOME/.cache/edgevector-git/kanban-factory.git"

# refresh gate tip
~/code/edgevector/kanban-factory/bin/wt fetch

# create or update the runtime worktree on main
if [[ -d "$RUNTIME/.git" || -f "$RUNTIME/.git" ]]; then
  git -C "$RUNTIME" fetch --all --prune 2>/dev/null || true
  git -C "$RUNTIME" checkout -B main main
  git -C "$RUNTIME" reset --hard main
else
  mkdir -p "$(dirname "$RUNTIME")"
  git --git-dir="$CACHE" worktree add -B main "$RUNTIME" main
fi

# install LaunchAgent (rewrites plist paths for THIS root)
"$RUNTIME/scripts/install-launchd.sh" install

open http://127.0.0.1:4177
```

Useful later:

```bash
"$HOME/.local/share/edgevector/kanban-factory/scripts/install-launchd.sh" status
"$HOME/.local/share/edgevector/kanban-factory/scripts/install-launchd.sh" restart
"$HOME/.local/share/edgevector/kanban-factory/scripts/install-launchd.sh" update   # reset to main + reinstall
"$HOME/.local/share/edgevector/kanban-factory/scripts/install-launchd.sh" uninstall
```

The installer **renders** `ProgramArguments` + `WorkingDirectory` from the
checkout it is run from (never hardcodes the ambient portal path).

**Kanban CLI:** LaunchAgent PATH puts `~/.local/bin` first so board scrapes use
host-track kanban (`~/.local/bin/kanban` → `~/.host-track/apps/fkanban/current`).
`run.sh` also exports `KANBAN_BIN` for the server.

Logs: `~/Library/Logs/kanban-factory.out.log` and `.err.log`

### Manual (no launchd)

```bash
cd ~/.local/share/edgevector/kanban-factory
KANBAN_BIN="$HOME/.local/bin/kanban" node server.mjs
# PORT=4177 POLL_MS=4000 node server.mjs
```

## What it reads (read-only)

| Source | How |
|--------|-----|
| Live cards | host-track `kanban list --json --all` (full board; bare `--json` caps at 12/column) |
| Routine activity | `brain get routine-heartbeats --type reference` |
| LastDB version panel | `lastdbd`/`lastdb --version` + `lastdb status` + local `git` against `FOLD_CHECKOUT` (default `~/code/edgevector/fold`) |

Board/brain scrapes are read-only. Version panel is read-only (no upgrades).

**One local mutation:** fleet mode switching via `routines-profile apply`:

| Endpoint | Effect |
|---|---|
| `GET /api/routines-profile` | Current mode + available profiles |
| `POST /api/routines-profile` `{"profile":"low-credit"}` | Apply named profile (autosaves live first) |

UI: top-bar **Fleet** chip — click (or press **M**) for the mode panel.

### LastDB version panel

Top-bar chip shows the running Mini version + short SHA. Press **V** or click the
chip to expand: commits on fold tip not in your binary, local release tags, and
the sidebin `bak-pre-*` upgrade trail (handy for canaries / safe upgrades).

```bash
curl -sS http://127.0.0.1:4177/api/lastdb-version | jq '.running'
# optional: FOLD_CHECKOUT=/path/to/fold POLL_MS=4000 node server.mjs
```

## Features

- Real card titles, priority, kind, repo, assignee, blocked state
- Hover any card or crew member for details; **click a card** for sparkles
- Move sounds (Web Audio — click once to unlock, toggle with **Sound**)
- Optional factory **Hum** (soft sub-bass)
- **Parade** button for a satisfying hop of in-flight work
- Session HUD: ships / grabs / streak · shift clock (morning/day/night)
- Momentum bar, marquee ticker, SHIPPED stamp, screen shake, achievements
- Theater mode (pipeline focus) · keyboard: `S` sound · `P` parade · `F` theater · `H` hum
- Factory log of heartbeats + detected board moves
- Polls every ~4s; animations fire on column diffs

## Crew personas (examples)

| Routine | Character |
|---------|-----------|
| `kanban-pickup` | **The Grabber** — scoops todo → doing and ships |
| `pipeline-health` | **The Medic** — merge/deploy nurse |
| `groom-board` | **The Janitor** — promotes unblocked backlog |
| `kanban-watch` | **The Owl** — reconciles stuck PRs |
| `kanban-validate` | **The Inspector** — END STATE stamps |
| `program-driver` | **The Foreman** — next program slices |
| `north-star-rollup` | **The Cartographer** — constellation map |
| `routine-fleet-health` | **Fleet Doctor** — routine vitals |

## Requirements

- `kanban` and `brain` CLIs on `PATH` (Last Stack / Mini socket)
- Node 18+ (no npm install required)
