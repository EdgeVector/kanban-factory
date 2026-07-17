# Kanban Factory 🏭

An animated live theater for your **real** Kanban board and scheduled routines.

Cards float on conveyor lanes (`backlog → todo → doing → done`). When the board
changes, chips fly between stages with hop arcs, particle bursts, and soft
blips. Routines appear as a crew of characters with personalities — Pickup
grabs work, Groom unblocks backlog, Pipeline checks the merge clinic, etc.

## Run (auto-start on login)

```bash
# one-time install — LaunchAgent, KeepAlive, starts on login
~/code/edgevector/kanban-factory/scripts/install-launchd.sh install

open http://127.0.0.1:4177
```

Useful later:

```bash
~/code/edgevector/kanban-factory/scripts/install-launchd.sh status
~/code/edgevector/kanban-factory/scripts/install-launchd.sh restart
~/code/edgevector/kanban-factory/scripts/install-launchd.sh uninstall   # stop auto-start
```

Logs: `~/Library/Logs/kanban-factory.out.log` and `.err.log`

### Manual (no launchd)

```bash
cd ~/code/edgevector/kanban-factory
node server.mjs
# PORT=4177 POLL_MS=4000 node server.mjs
```

## What it reads (read-only)

| Source | How |
|--------|-----|
| Live cards | `kanban list --json --all` (full board; bare `--json` caps at 12/column) |
| Routine activity | `brain get routine-heartbeats --type reference` |

Nothing is written to the board or brain.

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
