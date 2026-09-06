# Kanban Factory 🏭

An animated **local** live theater for your **real** Kanban board and scheduled
routines.

Cards float on conveyor lanes (`backlog → todo → doing → done`). When the board
changes, chips fly between stages with hop arcs, particle bursts, and soft
blips. Routines appear as a crew of characters with personalities — Pickup
grabs work, Groom unblocks backlog, Pipeline checks the merge clinic, etc.

This UI talks only to **your machine** (Kanban + Brain CLIs over the LastDB
socket). Nothing is uploaded; nothing is multi-tenant cloud.

Public source: https://github.com/EdgeVector/kanban-factory  
Canonical (EdgeVector contributors): `lastdb:///kanban-factory` (LastGit)

## Requirements

1. **LastDB stack** with Kanban initialized  
   Follow https://thelastdb.com/llms.txt (or `last-stack-install-apps` after
   cloning Last Stack). You need `kanban` and ideally `brain` on `PATH`.
2. **Node 18+** (`node` on PATH; Homebrew Node is fine)
3. A running `lastdbd` (`brew services start lastdb`)

## Quick start (public install)

```bash
# After Last Stack apps are installed and `kanban init` works:
git clone https://github.com/EdgeVector/kanban-factory.git \
  ~/.local/share/edgevector/kanban-factory
cd ~/.local/share/edgevector/kanban-factory

# One-shot (foreground)
node server.mjs
# → http://127.0.0.1:4177

# Or auto-start on login (macOS LaunchAgent)
./scripts/install-launchd.sh install
open http://127.0.0.1:4177
```

If you used **Last Stack** (`~/.last-stack/bin/last-stack-install-apps`), the
installer also clones this repo under `~/lastdb-apps/kanban-factory` when the
GitHub mirror is public:

```bash
cd ~/lastdb-apps/kanban-factory
node server.mjs
# or: ./scripts/install-launchd.sh install
```

### LaunchAgent helpers

```bash
./scripts/install-launchd.sh status
./scripts/install-launchd.sh restart
./scripts/install-launchd.sh update     # git pull tip (if this is a git checkout) + reinstall
./scripts/install-launchd.sh uninstall
```

The installer **renders** `ProgramArguments`, `WorkingDirectory`, `HOME`, and
log paths from the checkout you run it from — never hardcode another machine’s
paths into the template.

Logs: `~/Library/Logs/kanban-factory.out.log` and `.err.log`

Env knobs:

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `4177` | HTTP bind (loopback only) |
| `POLL_MS` | `60000` | Board poll interval |
| `KANBAN_BIN` | first `kanban` on PATH | Board CLI |
| `FOLD_CHECKOUT` | *(unset)* | Optional path to fold monorepo for version “ahead of running” panel |
| `NODE_BIN` | `node` on PATH | Node binary for LaunchAgent |

## What it reads (mostly read-only)

| Source | How |
|--------|-----|
| Live cards | `kanban list --json --all` (full board; bare `--json` may cap per column) |
| Routine activity | Heartbeat log files + optional `brain` references |
| LastDB version panel | `lastdbd`/`lastdb --version` + `lastdb status` (+ optional local `git` if `FOLD_CHECKOUT` is set) |

Board/brain scrapes are read-only. Version panel is read-only (no upgrades).

**One local mutation:** fleet mode switching via `routines-profile apply` when
that CLI exists:

| Endpoint | Effect |
|---|---|
| `GET /api/routines-profile` | Current mode + available profiles |
| `POST /api/routines-profile` `{"profile":"low-credit"}` | Apply named profile |

UI: top-bar **Fleet** chip — click (or press **M**) for the mode panel.

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
- Animations fire on column diffs between polls

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

## EdgeVector maintainers (LastGit / portals)

Canonical gate: `lastdb:///kanban-factory`. GitHub is a **read-only mirror**
for public clone/browse — open change requests with `lastgit cr`, not `gh`.

```bash
# portal is empty; work only in a worktree
~/code/edgevector/kanban-factory/bin/wt start kanban/<card-slug>
```

## License

MIT — see repository metadata / LICENSE if present.

## PC CI pause

Use the **PC CI** row below the factory header:

1. Select **Pause PC**.
2. Wait for **PC ready for games**. Active jobs must finish first.
3. Select **Resume PC** when you want CI to use the PC again.

The control covers `forgejo-runner` and `forgejo-runner-heavy` on the `pc` SSH host.
It does not stop Windows or WSL. Jobs that require PC labels wait in Forgejo.
The runner grace period is at least three hours. Jobs that exceed that period can be cancelled by the runner.
There is no force-stop button. Resume stays disabled while active jobs finish.

The control uses the existing SSH alias, passwordless sudo, Python 3, systemd,
and the installed `situations` CLI. The Mac also needs Python 3 for the OS request lock. It does not require a new credential.
The factory binds to loopback. PC mutations require a matching Origin, Host, and page token.

Pause records intent at `~/.local/state/last-stack/pc-ci/state.json` and creates
Situation `factory-pc-ci-owner-pause`. It saves the PC watchdog's prior state,
then disables and unloads that watchdog. The PC receives a persistent marker
at `/var/lib/edgevector/pc-ci-paused` and a guarded systemd drop-in for each runner.
The guard blocks service starts after a PC reboot or an external restart request.
The drop-ins also set an unlimited systemd stop timeout and send SIGTERM only
to the runner process. The runner stops new job requests and waits for its jobs.

Install the companion `EdgeVector/last-stack` change for
`last-stack-forge-runner-watchdog` before use. It reads the same intent file
and suppresses expected PC lane alerts. Mac runner and Forge API alerts remain active.

A failed operation retains the pause intent and recovery metadata. Select **Refresh**
to inspect the status, then **Resume PC** to retry recovery. An unavailable PC never
appears ready for games. A factory restart preserves the pause. The OS releases a dead controller
lock automatically; a live controller lock blocks duplicate requests.

### Tests

```sh
npm test
node scripts/pc-ci-demo.mjs
```

The demo at `http://127.0.0.1:14177` uses simulated SSH, launchctl, and Situations.
It cannot pause the live PC. Select **Finish fixture jobs** to complete its test job.
The production server has no fixture mode or test mutation endpoint.
