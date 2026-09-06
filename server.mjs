#!/usr/bin/env node
/**
 * Kanban Factory — local live data server.
 * Serves the theater UI and polls real kanban + routine heartbeats.
 * Board reads stay read-only. Explicit local controls manage fleet and PC CI.
 */
import http from "node:http";
import { PcCiController } from "./pc-ci.mjs";
import { pcCiHandler } from "./pc-ci-http.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCardAsk } from "./public/card-ask.js";
import { collectShipMeter, computeShipMeter } from "./ship-meter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 4177);
const POLL_MS = Number(process.env.POLL_MS || 60000);
const HOME = process.env.HOME || os.homedir();
/**
 * Optional fold monorepo path for the LastDB version panel (ahead-of-running).
 * Public installs usually leave this unset — the panel still shows binary
 * version via `lastdbd --version` / `lastdb status`.
 */
const FOLD_CHECKOUT = process.env.FOLD_CHECKOUT || "";
/** Version panel is slower to refresh than the board (git + binaries). */
const VERSION_TTL_MS = Number(process.env.LASTDB_VERSION_TTL_MS || 60_000);
const VERSION_COMMIT_LIMIT = 8;
const VERSION_RELEASE_LIMIT = 6;
/** Named fleet profiles under ~/.routines/profiles (normal | low-credit | …). */
const ROUTINES_HOME = process.env.ROUTINES_HOME || path.join(HOME, ".routines");
const ROUTINES_PROFILES_DIR = path.join(ROUTINES_HOME, "profiles");
const ROUTINES_REGISTRY_DIR = path.join(ROUTINES_HOME, "registry");
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const ROUTINE_PERSONAS = {
  "kanban-pickup": {
    id: "kanban-pickup",
    name: "Pickup",
    title: "The Grabber",
    emoji: "🦾",
    color: "#fe8019",
    vibe: "Hungry, decisive, hates empty queues. Scoops todo → doing and ships.",
    role: "worker",
  },
  "pipeline-health": {
    id: "pipeline-health",
    name: "Pipeline",
    title: "The Medic",
    emoji: "🩺",
    color: "#8ec07c",
    vibe: "Anxious nurse for merges & deploys. Files P0s when something is bleeding.",
    role: "medic",
  },
  "groom-board": {
    id: "groom-board",
    name: "Groom",
    title: "The Janitor",
    emoji: "🧹",
    color: "#83a598",
    vibe: "Tidy perfectionist. Promotes unblocked backlog, parks holds, prunes noise.",
    role: "janitor",
  },
  "kanban-watch": {
    id: "kanban-watch",
    name: "Watch",
    title: "The Owl",
    emoji: "🦉",
    color: "#fabd2f",
    vibe: "Quiet reconcilier. Nudges stuck PRs, closes done cards, never grabs new work.",
    role: "watcher",
  },
  "kanban-validate": {
    id: "kanban-validate",
    name: "Validate",
    title: "The Inspector",
    emoji: "✅",
    color: "#b8bb26",
    vibe: "Stamp-happy auditor. Checks post-merge END STATE before anything rests.",
    role: "inspector",
  },
  "program-driver": {
    id: "program-driver",
    name: "Program",
    title: "The Foreman",
    emoji: "📋",
    color: "#83a598",
    vibe: "Strategic orchestrator. Files next program slices so Pickup never starves.",
    role: "foreman",
  },
  "north-star-rollup": {
    id: "north-star-rollup",
    name: "NorthStar",
    title: "The Cartographer",
    emoji: "🌟",
    color: "#fabd2f",
    vibe: "Stargazer. Rolls up cards by North Star and draws the constellation map.",
    role: "mapper",
  },
  "north-star-hygiene": {
    id: "north-star-hygiene",
    name: "NS Hygiene",
    title: "The Constellation Fixer",
    emoji: "✨",
    color: "#fabd2f",
    vibe: "Heals orphan North Star pointers so the map stays honest.",
    role: "mapper",
  },
  "routine-fleet-health": {
    id: "routine-fleet-health",
    name: "Fleet",
    title: "Fleet Doctor",
    emoji: "🚑",
    color: "#fb4934",
    vibe: "Watches other routines. Clears stale locks, files error cards, keeps the floor alive.",
    role: "medic",
  },
  "llms-txt-install-smoke": {
    id: "llms-txt-install-smoke",
    name: "Smoke",
    title: "The Smoker",
    emoji: "💨",
    color: "#928374",
    vibe: "Fresh-install saboteur-for-good. Breaks the happy path so users don't.",
    role: "tester",
  },
  "dogfood-rotate": {
    id: "dogfood-rotate",
    name: "Dogfood",
    title: "The Taster",
    emoji: "🐕",
    color: "#fe8019",
    vibe: "Rotates dogfood recipes. Licks every feature until something tastes wrong.",
    role: "tester",
  },
  "worktree-cleanup": {
    id: "worktree-cleanup",
    name: "Cleanup",
    title: "The Sweeper",
    emoji: "🗑️",
    color: "#b8bb26",
    vibe: "Reclaims disk. Prunes zombie worktrees with ruthless cheer.",
    role: "janitor",
  },
  "self-upgrade": {
    id: "self-upgrade",
    name: "Upgrade",
    title: "The Changeling",
    emoji: "🔄",
    color: "#83a598",
    vibe: "Upgrades the stack itself. Mildly recursive existential crisis.",
    role: "meta",
  },
  "self-improvement-loop": {
    id: "self-improvement-loop",
    name: "Improve",
    title: "The Mirror",
    emoji: "🪞",
    color: "#83a598",
    vibe: "Reflects on agent failures and files better tooling.",
    role: "meta",
  },
  "papercut-sweep": {
    id: "papercut-sweep",
    name: "Papercut",
    title: "The Band-Aid",
    emoji: "🩹",
    color: "#fb4934",
    vibe: "Hunts tiny daily frictions and patches them before they fester.",
    role: "worker",
  },
  "disk-reclaim": {
    id: "disk-reclaim",
    name: "Disk",
    title: "The Vacuum",
    emoji: "💽",
    color: "#8ec07c",
    vibe: "Eats gigabytes. Happiest when the disk breathes again.",
    role: "janitor",
  },
  "merge-babysit": {
    id: "merge-babysit",
    name: "Babysit",
    title: "The Sitter",
    emoji: "🍼",
    color: "#fabd2f",
    vibe: "Sits with open PRs until they merge. Patient, slightly judgmental.",
    role: "watcher",
  },
  "drain-open-prs": {
    id: "drain-open-prs",
    name: "Drain",
    title: "The Plumber",
    emoji: "🚰",
    color: "#83a598",
    vibe: "Unclogs the PR sink. Steady hands, no drama.",
    role: "worker",
  },
  "morning-sync": {
    id: "morning-sync",
    name: "Morning",
    title: "The Herald",
    emoji: "☀️",
    color: "#fabd2f",
    vibe: "Wakes Tom with decisions that need a human. Soft alarm energy.",
    role: "herald",
  },
  "consolidate-brain": {
    id: "consolidate-brain",
    name: "Brain",
    title: "The Librarian",
    emoji: "📚",
    color: "#83a598",
    vibe: "Shelves knowledge. Hates duplicate thoughts.",
    role: "mapper",
  },
  "devops-continuous-improvement": {
    id: "devops-continuous-improvement",
    name: "DevOps",
    title: "The Wrench",
    emoji: "🔧",
    color: "#fe8019",
    vibe: "Continuous infrastructure polish. Always finding one more screw.",
    role: "worker",
  },
  "sentry-triage": {
    id: "sentry-triage",
    name: "Sentry",
    title: "The Alarmist",
    emoji: "🚨",
    color: "#ebdbb2",
    vibe: "Reads crash pings so you don't have to. Dramatic but useful.",
    role: "medic",
  },
  "program-rollup": {
    id: "program-rollup",
    name: "ProgRollup",
    title: "The Scorekeeper",
    emoji: "📊",
    color: "#fabd2f",
    vibe: "Tallies program progress. Quiet clipboard energy.",
    role: "mapper",
  },
  "fbrain-heartbeat": {
    id: "fbrain-heartbeat",
    name: "FBrain",
    title: "The Pulse",
    emoji: "💓",
    color: "#928374",
    vibe: "Keeps the brain pulse line flat and green.",
    role: "medic",
  },
};

/** Host-track kanban CLI (set by scripts/run.sh). Never ambient portal. */
const KANBAN = process.env.KANBAN_BIN || "kanban";

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      resolve({ ok: false, out, err: err || "timeout", code: -1 });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err, code });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: String(e), code: -1 });
    });
  });
}

function normalizeCards(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.cards)) list = raw.cards;
  else if (raw && raw.columns) {
    for (const [col, items] of Object.entries(raw.columns)) {
      for (const c of items || []) list.push({ ...c, column: c.column || col });
    }
  }

  return list.map((c) => {
    const tags = c.tags || [];
    const priority =
      c.priority ||
      (tags.find((t) => /^p[0-3]$/i.test(t)) || "").toUpperCase() ||
      null;
    const rawBody = c.body || "";
    // List previews are short and usually start with agent boilerplate; still
    // extract what we can. Hover fetches full body via /api/card/:slug.
    const askBits = extractCardAsk(rawBody);
    return {
      slug: c.slug,
      title: c.title || c.slug,
      body: rawBody.slice(0, 500),
      ask: askBits.ask,
      deliverable: askBits.deliverable,
      summary: askBits.summary,
      // True when list preview already had GOAL/END STATE (no lazy fetch needed).
      askReady: Boolean(askBits.ask || askBits.deliverable),
      column: c.column || "backlog",
      position: String(c.position ?? ""),
      assignee: c.assignee || "",
      tags,
      deps: c.deps || [],
      repo: c.repo || "",
      kind: c.kind || "",
      block_status: c.block_status || "none",
      block_reason: c.block_reason || "",
      north_star: c.north_star || "",
      milestone: c.milestone || "",
      pr_url: c.pr_url || "",
      branch: c.branch || "",
      blocked: Boolean(c.blocked),
      blockedBy: c.blockedBy || [],
      missingDeps: c.missingDeps || [],
      priority,
      created_at: c.created_at || "",
      updated_at: c.updated_at || "",
      done_at: c.done_at || "",
    };
  });
}

/** Full-card ask extract (cached briefly so hover spam is cheap). */
const cardAskCache = new Map(); // slug -> { at, payload }
const CARD_ASK_TTL_MS = 60_000;

async function fetchCardAsk(slug) {
  const clean = String(slug || "").trim();
  if (!clean || !/^[A-Za-z0-9._-]+$/.test(clean)) {
    return { ok: false, error: "invalid slug" };
  }
  const hit = cardAskCache.get(clean);
  if (hit && Date.now() - hit.at < CARD_ASK_TTL_MS) return hit.payload;

  const res = await run(KANBAN, ["show", clean, "--json"], 20000);
  if (!res.ok) {
    return {
      ok: false,
      error: res.err || res.out || `exit ${res.code}`,
      slug: clean,
    };
  }
  let raw;
  try {
    raw = JSON.parse(res.out);
  } catch (e) {
    return { ok: false, error: `parse: ${e.message}`, slug: clean };
  }
  const body = raw.body || raw.card?.body || "";
  const title = raw.title || raw.card?.title || clean;
  const bits = extractCardAsk(body);
  const payload = {
    ok: true,
    slug: clean,
    title,
    ask: bits.ask,
    deliverable: bits.deliverable,
    summary: bits.summary,
    askReady: true,
    // Enough full body for client re-extract if needed; keep payload modest.
    body: body.slice(0, 4000),
  };
  cardAskCache.set(clean, { at: Date.now(), payload });
  return payload;
}

/** Normalize routine ids so pickup fleet workers collapse to one persona. */
function normalizeRoutineId(raw) {
  const id = String(raw || "").trim();
  if (!id) return id;
  // last-stack-fkanban-pickup, last-stack-fkanban-pickup-w3, kanban-pickup-w2 → kanban-pickup
  if (/(?:^|-)(?:fkanban-)?pickup(?:-w\d+)?$/i.test(id) || /^kanban-pickup(?:-w\d+)?$/i.test(id)) {
    return "kanban-pickup";
  }
  // last-stack-fkanban-watch → kanban-watch
  if (/(?:^|-)(?:fkanban-)?watch$/i.test(id) || /^kanban-watch$/i.test(id)) {
    return "kanban-watch";
  }
  if (/(?:^|-)groom-board$/i.test(id) || /^groom-board$/i.test(id)) {
    return "groom-board";
  }
  // Strip last-stack- prefix for roster matching when a persona exists
  if (id.startsWith("last-stack-")) {
    const short = id.slice("last-stack-".length);
    if (ROUTINE_PERSONAS[short]) return short;
    // last-stack-pipeline-health → pipeline-health etc.
    if (ROUTINE_PERSONAS[short.replace(/^fkanban-/, "")]) {
      return short.replace(/^fkanban-/, "");
    }
  }
  return id;
}

function parseHeartbeats(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const events = [];
  // Lines like: kanban-pickup 2026-07-16T21:41:43Z noop idle nothing-safe reason=...
  // Also: 2026-07-20T16:45:42.593Z last-stack-fkanban-pickup-w3 ok harness=...
  const re =
    /^([a-z0-9][a-z0-9-]*)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(ok|noop|error|fail|red|green)?\s*(.*)$/i;
  const reIsoFirst =
    /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([a-z0-9][a-z0-9-]*)\s+(ok|noop|error|fail|red|green)?\s*(.*)$/i;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
    if (trimmed.startsWith("title:") || trimmed.startsWith("status:") || trimmed.startsWith("tags:"))
      continue;
    if (trimmed.startsWith("[") || trimmed.startsWith("created_at") || trimmed.startsWith("updated_at"))
      continue;
    // bare name-only heartbeats
    if (/^[a-z0-9-]+$/.test(trimmed) && ROUTINE_PERSONAS[trimmed]) {
      events.push({
        routine: normalizeRoutineId(trimmed),
        at: null,
        status: "ok",
        detail: "heartbeat",
        raw: trimmed,
      });
      continue;
    }
    let m = trimmed.match(re);
    if (m) {
      const routine = normalizeRoutineId(m[1]);
      if (routine.length < 3) continue;
      events.push({
        routine,
        at: m[2],
        status: (m[3] || "ok").toLowerCase(),
        detail: (m[4] || "").slice(0, 280),
        raw: trimmed.slice(0, 400),
      });
      continue;
    }
    m = trimmed.match(reIsoFirst);
    if (!m) continue;
    const routine = normalizeRoutineId(m[2]);
    if (routine.length < 3) continue;
    events.push({
      routine,
      at: m[1],
      status: (m[3] || "ok").toLowerCase(),
      detail: (m[4] || "").slice(0, 280),
      raw: trimmed.slice(0, 400),
    });
  }
  // Prefer newest events: keep last 200 parsed lines (log is usually append-order).
  return events.slice(-200);
}

function extractWorkerInstances(cards) {
  // Active Hands = assignees currently holding DOING cards only.
  // One worker may hold MANY doing cards — track the full stack.
  // Ignore assignees on todo/backlog/done so idle names don't clutter the strip.
  const workers = new Map();
  for (const c of cards) {
    if (c.column !== "doing") continue;
    const a = c.assignee || "";
    if (!a) continue;
    let base = "kanban-pickup";
    let label = a;
    const m = a.match(/pickup(-w\d+)?/i);
    if (m) {
      base = "kanban-pickup";
      label = m[1] ? `Pickup${m[1].toUpperCase()}` : "Pickup";
    } else if (/watch/i.test(a)) {
      base = "kanban-watch";
      label = "Watch";
    } else if (/groom/i.test(a)) {
      base = "groom-board";
      label = "Groom";
    } else {
      // Shorten long agent ids for the floor
      label = a
        .replace(/^last-stack-/, "")
        .replace(/^fkanban-/, "")
        .slice(0, 18);
    }
    const id = a;
    if (!workers.has(id)) {
      const persona = ROUTINE_PERSONAS[base] || {
        id: base,
        name: base,
        title: base,
        emoji: "🤖",
        color: "#928374",
        vibe: "A hardworking routine instance.",
        role: "worker",
      };
      workers.set(id, {
        id,
        instanceOf: base,
        label,
        emoji: persona.emoji,
        color: persona.color,
        title: persona.title,
        vibe: persona.vibe,
        role: persona.role,
        carrying: null,
        carryingAll: [],
        carryingTitles: [],
        load: 0,
        status: "working",
      });
    }
    const w = workers.get(id);
    w.carryingAll.push(c.slug);
    w.carryingTitles.push(c.title || c.slug);
    w.load = w.carryingAll.length;
    w.carrying = w.carryingAll[0];
    w.status = "working";
  }
  return [...workers.values()].sort((a, b) => b.load - a.load || a.label.localeCompare(b.label));
}

function heartbeatAgeMs(at) {
  if (!at) return Infinity;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

/** Heartbeats older than this are treated as idle (unless board proves working). */
const CREW_STALE_MS = 2 * 60 * 60 * 1000; // 2h

function buildRoutineRoster(events, cards) {
  // Newest event wins per routine (events may be chronological).
  const latestByRoutine = new Map();
  for (const e of events) {
    const id = normalizeRoutineId(e.routine);
    const prev = latestByRoutine.get(id);
    if (!prev) {
      latestByRoutine.set(id, { ...e, routine: id });
      continue;
    }
    const prevT = Date.parse(prev.at || "") || 0;
    const nextT = Date.parse(e.at || "") || 0;
    // Prefer dated events; if both missing, keep later in stream.
    if (nextT >= prevT) latestByRoutine.set(id, { ...e, routine: id });
  }

  // Always include known core cast even if quiet
  const core = [
    "kanban-pickup",
    "pipeline-health",
    "groom-board",
    "kanban-watch",
    "kanban-validate",
    "program-driver",
    "north-star-rollup",
    "routine-fleet-health",
    "llms-txt-install-smoke",
    "dogfood-rotate",
    "worktree-cleanup",
  ];

  // Drop non-persona one-shot noise from the floor unless in core.
  // (Still keep known personas and anything that is currently working on the board.)
  const ids = new Set([...core]);
  for (const id of latestByRoutine.keys()) {
    if (ROUTINE_PERSONAS[id] || core.includes(id)) ids.add(id);
  }

  const pickupWorking = cards.some(
    (c) => c.column === "doing" && /pickup/i.test(c.assignee || "")
  );

  const roster = [];
  for (const id of ids) {
    const persona = ROUTINE_PERSONAS[id] || {
      id,
      name: id,
      title: id,
      emoji: "⚙️",
      color: "#928374",
      vibe: "A scheduled routine on the floor.",
      role: "worker",
    };
    const last = latestByRoutine.get(id);
    let mood = "idle";
    if (last) {
      const detail = `${last.status || ""} ${last.detail || ""}`;
      const age = heartbeatAgeMs(last.at);
      const stale = age > CREW_STALE_MS;
      // Runner meta lines (harness=codex exit=0 dur=…) are not "on the floor" work.
      const harnessOnly =
        /\bharness=/.test(detail) &&
        !/\b(cards=|worked=|merged|promoted|filed|moved|reclaimed|fixed=)/i.test(detail);
      // Pickup handoff / finished unit — worker is free again.
      const finishedHandoff =
        /in-flight-(?:budget-handoff|ci-pending)|result=(?:merged|rolled-back|human-blocked)|final_column=/i.test(
          detail
        );
      if (last.status === "error" || last.status === "fail" || last.status === "red") {
        mood = stale ? "idle" : "error";
      } else if (harnessOnly || finishedHandoff) {
        mood = "idle";
      } else if (/noop|idle|nothing-safe|budget-exhausted|quiet/i.test(detail)) {
        mood = "idle";
      } else if (
        !stale &&
        /merged|cards=\s*[1-9]|promoted|filed|worked=|moved.?done|reclaimed|ship|fixed=\s*[1-9]/i.test(
          detail
        )
      ) {
        // Real work signal — bare "ok" alone is not enough.
        mood = "active";
      } else {
        mood = "idle";
      }
    }
    // Board is ground truth for pickup: holding doing cards = working (overrides handoff idle).
    if (id === "kanban-pickup" && pickupWorking) {
      mood = "working";
    }
    roster.push({
      ...persona,
      mood,
      lastAt: last?.at || null,
      lastStatus: last?.status || null,
      lastDetail: last?.detail || null,
    });
  }

  // Sort: working/active first, then alphabetical
  const rank = { working: 0, active: 1, idle: 2, error: 3 };
  roster.sort((a, b) => (rank[a.mood] ?? 9) - (rank[b.mood] ?? 9) || a.name.localeCompare(b.name));
  return roster;
}

function summarize(cards) {
  const counts = { backlog: 0, todo: 0, doing: 0, done: 0 };
  let blocked = 0;
  let needsHuman = 0;
  for (const c of cards) {
    if (counts[c.column] !== undefined) counts[c.column]++;
    else counts[c.column] = (counts[c.column] || 0) + 1;
    if (c.blocked) blocked++;
    if (c.block_status && c.block_status !== "none") needsHuman++;
  }
  return { counts, blocked, needsHuman, total: cards.length };
}

function parseIsoMs(iso) {
  if (!iso || typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Board-completions throughput from board timestamps (done_at; updated_at for
 * activity). NOT a ship rate: only cards still on the board are visible, and
 * last-stack-card-reaper deletes done cards on a ~6h cycle, so this series
 * decays toward zero as a night passes even when merges kept landing. The
 * real ship rate is `velocity.ships` / `velocity.hourly`, computed by
 * ship-meter.mjs from merges, not cards. This series stays for the board's
 * own completion signal — see `velocity.boardCompletions` in statePayload().
 */
function computeBoardCompletions(cards) {
  const now = Date.now();
  const hourMs = 3600_000;
  const windows = [
    { key: "h3", hours: 3 },
    { key: "h12", hours: 12 },
    { key: "h24", hours: 24 },
  ];

  // Ship = card in done with done_at (or updated_at fallback for done column)
  const shipTimes = [];
  const activityTimes = [];
  for (const c of cards) {
    const doneAt = parseIsoMs(c.done_at);
    const updatedAt = parseIsoMs(c.updated_at);
    if (c.column === "done") {
      const t = doneAt ?? updatedAt;
      if (t != null) shipTimes.push(t);
    }
    if (updatedAt != null) activityTimes.push(updatedAt);
  }

  const rate = (times, hours) => {
    const cut = now - hours * hourMs;
    const n = times.filter((t) => t >= cut).length;
    return {
      count: n,
      perHour: Math.round((n / hours) * 100) / 100,
      hours,
    };
  };

  // Hourly histogram for last 24h (ships by done_at)
  const buckets = [];
  for (let i = 23; i >= 0; i--) {
    const start = now - (i + 1) * hourMs;
    const end = now - i * hourMs;
    const n = shipTimes.filter((t) => t >= start && t < end).length;
    const d = new Date(end);
    buckets.push({
      hourAgo: i,
      label: `${String(d.getHours()).padStart(2, "0")}:00`,
      ships: n,
    });
  }

  const ships = {};
  const activity = {};
  for (const w of windows) {
    ships[w.key] = rate(shipTimes, w.hours);
    activity[w.key] = rate(activityTimes, w.hours);
  }

  // Peak hour in last 24h
  let peak = { ships: 0, label: "—" };
  for (const b of buckets) {
    if (b.ships > peak.ships) peak = { ships: b.ships, label: b.label };
  }

  return {
    ships,
    activity,
    hourly: buckets,
    peakHour: peak,
    note: "Board completions, not the ship rate: only cards still on the board are visible, and the reaper deletes done cards on a cycle. See velocity.ships for the merge-derived rate.",
  };
}

/** Count status = "active"|"paused" across a registry dir of TOMLs. */
function countRegistryStatuses(dir) {
  const out = { active: 0, paused: 0, total: 0 };
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".toml")) continue;
    out.total++;
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      const m = text.match(/^status\s*=\s*"([^"]+)"/m);
      if (m?.[1] === "active") out.active++;
      else if (m?.[1] === "paused") out.paused++;
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function readProfileMeta(profileDir) {
  const metaPath = path.join(profileDir, "PROFILE.toml");
  let title = path.basename(profileDir);
  let description = "";
  if (fs.existsSync(metaPath)) {
    try {
      const text = fs.readFileSync(metaPath, "utf8");
      const t = text.match(/^title\s*=\s*"([^"]*)"/m);
      if (t) title = t[1];
      // description may be multiline """…"""
      const d1 = text.match(/^description\s*=\s*"""([\s\S]*?)"""/m);
      const d2 = text.match(/^description\s*=\s*"([^"]*)"/m);
      if (d1) description = d1[1].trim().replace(/\s+/g, " ").slice(0, 280);
      else if (d2) description = d2[1];
    } catch {
      /* ignore */
    }
  }
  return { title, description };
}

/**
 * Live fleet profile state for the UI.
 * active = marker in profiles/ACTIVE (best-effort); live counts from registry.
 */
function readRoutinesProfile() {
  let active = null;
  const activeFile = path.join(ROUTINES_PROFILES_DIR, "ACTIVE");
  try {
    if (fs.existsSync(activeFile)) {
      active = fs.readFileSync(activeFile, "utf8").trim() || null;
    }
  } catch {
    active = null;
  }

  const live = countRegistryStatuses(ROUTINES_REGISTRY_DIR);
  const profiles = [];
  if (fs.existsSync(ROUTINES_PROFILES_DIR)) {
    for (const name of fs.readdirSync(ROUTINES_PROFILES_DIR)) {
      if (name.startsWith("_") || name === "ACTIVE" || name.endsWith(".md")) continue;
      const dir = path.join(ROUTINES_PROFILES_DIR, name);
      const reg = path.join(dir, "registry");
      if (!fs.existsSync(reg) || !fs.statSync(dir).isDirectory()) continue;
      const meta = readProfileMeta(dir);
      const counts = countRegistryStatuses(reg);
      profiles.push({
        id: name,
        title: meta.title,
        description: meta.description,
        activeCount: counts.active,
        pausedCount: counts.paused,
        total: counts.total,
        isActive: active === name,
      });
    }
  }
  profiles.sort((a, b) => {
    // prefer normal, low-credit, then alpha; hide deep autosaves (already skipped _)
    const order = { normal: 0, "low-credit": 1 };
    const ao = order[a.id] ?? 50;
    const bo = order[b.id] ?? 50;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });

  const mode =
    active === "low-credit"
      ? "low-credit"
      : active === "normal"
        ? "normal"
        : active || (live.active <= 8 ? "low-credit?" : "unknown");

  return {
    ok: true,
    active,
    mode,
    live,
    profiles,
    profilesDir: ROUTINES_PROFILES_DIR,
  };
}

function applyRoutinesProfile(name) {
  return new Promise((resolve) => {
    if (!PROFILE_NAME_RE.test(name) || name.startsWith("_")) {
      resolve({ ok: false, error: `invalid profile name: ${name}` });
      return;
    }
    const profileDir = path.join(ROUTINES_PROFILES_DIR, name, "registry");
    if (!fs.existsSync(profileDir)) {
      resolve({ ok: false, error: `unknown profile: ${name}` });
      return;
    }
    const bin =
      process.env.ROUTINES_PROFILE_BIN ||
      path.join(ROUTINES_HOME, "bin", "routines-profile");
    const fallback = path.join(HOME, ".local/bin/routines-profile");
    const cmd = fs.existsSync(bin) ? bin : fs.existsSync(fallback) ? fallback : "routines-profile";
    const child = spawn(cmd, ["apply", name], {
      env: { ...process.env, HOME, PATH: process.env.PATH || "/usr/bin:/bin" },
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => {
      resolve({ ok: false, error: String(e.message || e), stdout, stderr });
    });
    child.on("close", (code) => {
      const profile = readRoutinesProfile();
      if (code === 0) {
        resolve({ ok: true, applied: name, stdout: stdout.trim(), profile });
      } else {
        resolve({
          ok: false,
          error: `routines-profile apply exited ${code}`,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          profile,
        });
      }
    });
  });
}

let cache = {
  at: 0,
  cards: [],
  events: [],
  routines: [],
  workers: [],
  summary: { counts: {}, blocked: 0, needsHuman: 0, total: 0 },
  velocity: null,
  lastdbVersion: null,
  routinesProfile: null,
  error: null,
  refreshing: false,
  lastRefreshMs: 0,
};

/** Single-flight refresh so stacked /api/state?refresh=1 calls don't pile on kanban. */
let refreshPromise = null;
let versionRefreshPromise = null;

/**
 * Parse `lastdbd 0.22.10-canary.…-gf3aa966ea-dirty` → { binary, version, sha, dirty }.
 */
function parseBinaryVersionLine(line) {
  const text = String(line || "").trim().split("\n")[0] || "";
  if (!text) return { binary: "", version: "", sha: "", dirty: false, raw: "" };
  const parts = text.split(/\s+/);
  const binary = parts[0] || "";
  const version = parts.slice(1).join(" ") || parts[0] || "";
  const shaMatch = version.match(/-g([0-9a-f]{7,40})(?:-dirty)?\b/i);
  const dirty = /-dirty\b/i.test(version);
  return {
    binary,
    version,
    sha: shaMatch ? shaMatch[1] : "",
    dirty,
    raw: text,
  };
}

function detectVenue(binPath) {
  const p = String(binPath || "");
  if (!p) return { venue: "unknown", path: "" };
  if (/Cellar\/lastdb|homebrew.*lastdb/i.test(p)) {
    return { venue: "brew", path: p };
  }
  if (/bin-with-upload-cap|\.lastdb\/current|LASTDB_HOME/i.test(p) || p.includes(`${path.sep}.lastdb${path.sep}`)) {
    return { venue: "sidebin", path: p };
  }
  if (p.includes("target") || p.includes("debug") || p.includes("release")) {
    return { venue: "dev-build", path: p };
  }
  return { venue: "path", path: p };
}

async function resolveBinaryPath(name) {
  const which = await run("which", [name], 5000);
  if (!which.ok || !which.out.trim()) return "";
  const resolved = which.out.trim().split("\n")[0];
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function gitFold(args, timeoutMs = 12000) {
  return run("git", ["-C", FOLD_CHECKOUT, ...args], timeoutMs);
}

/**
 * Snapshot of the running Mini binary vs local fold checkout (no network).
 * Answers: what am I on, what's on main that isn't in my binary, which tags.
 */
async function collectLastdbVersion() {
  const t0 = Date.now();
  const empty = {
    ok: false,
    at: Date.now(),
    ms: 0,
    foldCheckout: FOLD_CHECKOUT,
    foldExists: false,
    running: {
      daemon: null,
      cli: null,
      version: "",
      sha: "",
      dirty: false,
      venue: "unknown",
      path: "",
      uptime: "",
      pid: null,
      home: "",
      socket: "",
    },
    main: { ref: "", sha: "", label: "" },
    aheadOfRunning: { count: 0, commits: [], note: "" },
    runningAheadOfMain: { count: 0, commits: [], note: "" },
    releases: [],
    upgradeTrail: [],
    error: null,
  };

  try {
    const [daemonVer, cliVer, statusRes, daemonPath, cliPath] = await Promise.all([
      run("lastdbd", ["--version"], 8000),
      run("lastdb", ["--version"], 8000),
      run("lastdb", ["status"], 8000),
      resolveBinaryPath("lastdbd"),
      resolveBinaryPath("lastdb"),
    ]);

    const daemon = parseBinaryVersionLine(daemonVer.ok ? daemonVer.out : "");
    const cli = parseBinaryVersionLine(cliVer.ok ? cliVer.out : "");
    const venue = detectVenue(daemonPath || cliPath);

    let uptime = "";
    let pid = null;
    let home = "";
    let socket = "";
    if (statusRes.ok || statusRes.out) {
      for (const line of statusRes.out.split("\n")) {
        const t = line.trim();
        if (/^Uptime:/i.test(t)) uptime = t.replace(/^Uptime:\s*/i, "");
        if (/^Home:/i.test(t)) home = t.replace(/^Home:\s*/i, "");
        if (/^Socket:/i.test(t)) socket = t.replace(/^Socket:\s*/i, "");
        const pm = t.match(/pid\s+(\d+)/i);
        if (pm) pid = Number(pm[1]);
      }
    }

    const runningSha = daemon.sha || cli.sha;
    const runningVersion = daemon.version || cli.version || "";

    empty.running = {
      daemon: daemon.raw ? daemon : null,
      cli: cli.raw ? cli : null,
      version: runningVersion,
      sha: runningSha,
      dirty: Boolean(daemon.dirty || cli.dirty),
      venue: venue.venue,
      path: daemonPath || venue.path || "",
      uptime,
      pid,
      home,
      socket,
    };

    if (!daemonVer.ok && !cliVer.ok) {
      empty.error = `lastdbd/lastdb version failed: ${daemonVer.err || cliVer.err || "missing"}`;
      empty.ms = Date.now() - t0;
      return empty;
    }

    const foldExists = fs.existsSync(path.join(FOLD_CHECKOUT, ".git"));
    empty.foldExists = foldExists;
    empty.ok = true;

    if (!foldExists) {
      empty.aheadOfRunning.note = FOLD_CHECKOUT
        ? `No fold checkout at ${FOLD_CHECKOUT} (set FOLD_CHECKOUT)`
        : "FOLD_CHECKOUT unset — version panel shows binary only";
      empty.ms = Date.now() - t0;
      empty.at = Date.now();
      return { ...empty, ok: true };
    }

    // Prefer origin/main, fall back to main
    let mainRef = "origin/main";
    let mainShaRes = await gitFold(["rev-parse", "--short=9", "origin/main"]);
    if (!mainShaRes.ok) {
      mainRef = "main";
      mainShaRes = await gitFold(["rev-parse", "--short=9", "main"]);
    }
    const mainSha = mainShaRes.ok ? mainShaRes.out.trim() : "";
    empty.main = {
      ref: mainRef,
      sha: mainSha,
      label: mainSha ? `${mainRef} @ ${mainSha}` : mainRef,
    };

    if (runningSha) {
      const resolve = await gitFold(["rev-parse", "--verify", `${runningSha}^{commit}`]);
      if (!resolve.ok) {
        empty.aheadOfRunning.note = `Running SHA ${runningSha} not found in ${FOLD_CHECKOUT}`;
      } else {
        const countAhead = await gitFold([
          "rev-list",
          "--count",
          `${runningSha}..${mainRef}`,
        ]);
        const logAhead = await gitFold([
          "log",
          "--format=%h\t%s",
          `${runningSha}..${mainRef}`,
          `-n${VERSION_COMMIT_LIMIT}`,
        ]);
        const nAhead = countAhead.ok ? Number(countAhead.out.trim()) || 0 : 0;
        const commitsAhead = (logAhead.ok ? logAhead.out : "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [h, ...rest] = l.split("\t");
            return { sha: h, subject: rest.join("\t") };
          });
        empty.aheadOfRunning = {
          count: nAhead,
          commits: commitsAhead,
          note:
            nAhead === 0
              ? "Running binary includes fold tip (no commits missing)"
              : `${nAhead} commit(s) on ${mainRef} not in running binary`,
        };

        const countBehind = await gitFold([
          "rev-list",
          "--count",
          `${mainRef}..${runningSha}`,
        ]);
        const logBehind = await gitFold([
          "log",
          "--format=%h\t%s",
          `${mainRef}..${runningSha}`,
          `-n${VERSION_COMMIT_LIMIT}`,
        ]);
        const nBehind = countBehind.ok ? Number(countBehind.out.trim()) || 0 : 0;
        empty.runningAheadOfMain = {
          count: nBehind,
          commits: (logBehind.ok ? logBehind.out : "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const [h, ...rest] = l.split("\t");
              return { sha: h, subject: rest.join("\t") };
            }),
          note:
            nBehind === 0
              ? ""
              : `Running is ${nBehind} commit(s) ahead of ${mainRef} (canary-only)`,
        };
      }
    } else {
      empty.aheadOfRunning.note = "Could not parse -gSHA from lastdbd --version";
    }

    // Local tags as release list
    const tagsRes = await gitFold([
      "tag",
      "--sort=-creatordate",
      "--format=%(refname:short)\t%(objectname:short)\t%(creatordate:short)",
    ]);
    const tags = (tagsRes.ok ? tagsRes.out : "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, VERSION_RELEASE_LIMIT);

    const releases = [];
    for (const line of tags) {
      const [name, tagSha, date] = line.split("\t");
      if (!name) continue;
      let inRunning = null;
      if (runningSha && tagSha) {
        const anc = await gitFold([
          "merge-base",
          "--is-ancestor",
          tagSha,
          runningSha,
        ]);
        // exit 0 = tag is ancestor of running → release is in binary
        inRunning = anc.ok;
      }
      let isRunningTag = false;
      if (runningVersion && name && runningVersion.startsWith(name.replace(/^v/, ""))) {
        isRunningTag = true;
      }
      if (runningSha && tagSha && runningSha.startsWith(tagSha)) isRunningTag = true;
      releases.push({
        name,
        sha: tagSha || "",
        date: date || "",
        inRunning,
        isRunning: isRunningTag || Boolean(inRunning && name.includes("canary") && runningVersion.includes(name.replace(/^v/, ""))),
      });
    }
    empty.releases = releases;

    // bak-pre trail next to the live binary
    const binDir = daemonPath ? path.dirname(daemonPath) : "";
    const trail = [];
    if (binDir && fs.existsSync(binDir)) {
      try {
        const names = fs
          .readdirSync(binDir)
          .filter((n) => n.startsWith("lastdbd.bak-pre-"))
          .sort()
          .reverse()
          .slice(0, 8);
        for (const n of names) {
          const m = n.match(
            /^lastdbd\.bak-pre-(.+?)-(\d{8}T\d{6}Z)$/
          );
          trail.push({
            file: n,
            label: m ? m[1] : n.replace(/^lastdbd\.bak-pre-/, ""),
            at: m ? m[2] : "",
            kind: "bak",
          });
        }
      } catch {
        /* ignore */
      }
    }
    empty.upgradeTrail = trail;

    empty.ms = Date.now() - t0;
    empty.at = Date.now();
    empty.ok = true;
    empty.error = null;
    return empty;
  } catch (e) {
    empty.error = String(e);
    empty.ms = Date.now() - t0;
    empty.at = Date.now();
    return empty;
  }
}

async function refreshLastdbVersion(force = false) {
  const fresh =
    cache.lastdbVersion &&
    cache.lastdbVersion.at &&
    Date.now() - cache.lastdbVersion.at < VERSION_TTL_MS;
  if (!force && fresh) return cache.lastdbVersion;
  if (versionRefreshPromise) return versionRefreshPromise;
  versionRefreshPromise = (async () => {
    try {
      const snap = await collectLastdbVersion();
      cache.lastdbVersion = snap;
      return snap;
    } finally {
      versionRefreshPromise = null;
    }
  })();
  return versionRefreshPromise;
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    cache.refreshing = true;
    const t0 = Date.now();
    try {
      // `--all` is required: bare `kanban list --json` caps at 12 cards per
      // column (fkanban DEFAULT_COLUMN_LIMIT), which silently under-counts
      // backlog/done and wrecks velocity/heat stats. Bodies stay ~200-char
      // previews either way; we only need full *counts*, not full bodies.
            const heartbeatLog =
        process.env.ROUTINE_HEARTBEATS_LOG ||
        path.join(HOME, ".last-stack", "logs", "routine-heartbeats.log");

      const [kanbanRes, brainRes, logRes, versionSnap, shipMeterCollected] = await Promise.all([
        run(KANBAN, ["list", "--json", "--all"], 45000),
        run("brain", ["get", "routine-heartbeats", "--type", "reference"], 20000),
        // Filesystem log is append-complete; brain record is often truncated/stale.
        fs.promises
          .readFile(heartbeatLog, "utf8")
          .then((text) => ({ ok: true, out: text }))
          .catch((e) => ({ ok: false, out: "", err: String(e) })),
        refreshLastdbVersion(false),
        // Merge-derived ship rate (see ship-meter.mjs). Never throws: a
        // collection failure keeps the previous shipMeter, not a crash.
        collectShipMeter({ home: HOME }).catch((e) => ({ collectError: String(e?.message || e) })),
      ]);

      let cards = cache.cards;
      let error = null;

      if (kanbanRes.ok) {
        try {
          cards = normalizeCards(JSON.parse(kanbanRes.out));
        } catch (e) {
          error = `kanban parse: ${e.message}`;
        }
      } else {
        error = `kanban list failed: ${kanbanRes.err || kanbanRes.out || kanbanRes.code}`;
      }

      // Prefer the complete log; fall back to brain reference.
      let events = cache.events;
      const hbText =
        (logRes.ok && logRes.out && logRes.out.length > 200 ? logRes.out : "") ||
        ((brainRes.ok || brainRes.out) && brainRes.out) ||
        "";
      if (hbText) {
        events = parseHeartbeats(hbText);
      }

      const workers = extractWorkerInstances(cards);
      const routines = buildRoutineRoster(events, cards);
      const summary = summarize(cards);
      const boardCompletions = computeBoardCompletions(cards);

      let shipMeter = cache.shipMeter;
      let shipMeterError = null;
      if (shipMeterCollected && !shipMeterCollected.collectError) {
        try {
          shipMeter = computeShipMeter({
            mergeRows: shipMeterCollected.rows,
            repoAvailability: shipMeterCollected.repoAvailability,
            nowMs: Date.now(),
          });
        } catch (e) {
          shipMeterError = `ship-meter compute: ${e.message}`;
        }
      } else {
        shipMeterError = `ship-meter collect: ${shipMeterCollected?.collectError || "unknown"}`;
      }
      if (!shipMeter) {
        // Cold start with no prior cache and a failed first collection: report
        // unavailable, never a silent 0 (the exact defect this replaces).
        shipMeter = computeShipMeter({ mergeRows: [], repoAvailability: { startup: false }, nowMs: Date.now() });
      }

      const velocity = {
        ships: shipMeter.ships,
        hourly: shipMeter.hourly,
        peakHour: shipMeter.peakHour,
        available: shipMeter.available,
        unavailableRepos: shipMeter.unavailableRepos,
        note: shipMeter.note,
        error: shipMeterError,
        boardCompletions,
      };

      let routinesProfile = cache.routinesProfile;
      try {
        routinesProfile = readRoutinesProfile();
      } catch (e) {
        routinesProfile = {
          ok: false,
          error: String(e?.message || e),
          active: null,
          mode: "unknown",
          live: { active: 0, paused: 0, total: 0 },
          profiles: [],
        };
      }

      cache = {
        ...cache,
        at: Date.now(),
        cards,
        events: events.slice(0, 40),
        routines,
        workers,
        summary,
        velocity,
        shipMeter,
        lastdbVersion: versionSnap || cache.lastdbVersion,
        routinesProfile,
        error,
        personas: ROUTINE_PERSONAS,
        lastRefreshMs: Date.now() - t0,
        refreshing: false,
      };
    } catch (e) {
      cache.error = String(e);
      cache.refreshing = false;
      cache.lastRefreshMs = Date.now() - t0;
    } finally {
      refreshPromise = null;
      cache.refreshing = false;
    }
  })();
  return refreshPromise;
}

function statePayload() {
  return {
    ok: !cache.error,
    error: cache.error,
    polledAt: cache.at,
    pollMs: POLL_MS,
    refreshMs: cache.lastRefreshMs,
    refreshing: Boolean(cache.refreshing || refreshPromise),
    ageMs: cache.at ? Date.now() - cache.at : null,
    cards: cache.cards,
    events: cache.events,
    routines: cache.routines,
    workers: cache.workers,
    summary: cache.summary,
    velocity: cache.velocity,
    lastdbVersion: cache.lastdbVersion,
    routinesProfile: cache.routinesProfile,
  };
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

const pcCi = pcCiHandler(new PcCiController(), PORT);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/api/pc-ci") return pcCi(req, res);

  if (url.pathname === "/api/state") {
    const force = url.searchParams.get("refresh") === "1";
    const stale = !cache.at || Date.now() - cache.at > POLL_MS;
    const wait = url.searchParams.get("wait") === "1";

    // Stale-while-revalidate: return cache immediately; kick a single refresh.
    // Only block on first paint (no cache) or explicit wait=1.
    if (!cache.at || (force && wait)) {
      await refresh();
    } else if (force || stale) {
      refresh().catch(() => {});
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(statePayload()));
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        cards: cache.summary.total,
        doing: cache.summary.counts?.doing || 0,
        at: cache.at,
        ageMs: cache.at ? Date.now() - cache.at : null,
        refreshing: Boolean(cache.refreshing || refreshPromise),
        lastdbVersion: cache.lastdbVersion?.running?.version || null,
        lastdbSha: cache.lastdbVersion?.running?.sha || null,
      })
    );
    return;
  }

  if (url.pathname === "/api/lastdb-version") {
    const force = url.searchParams.get("refresh") === "1";
    const snap = await refreshLastdbVersion(force);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(snap));
    return;
  }

  // GET/POST /api/routines-profile — fleet mode (normal | low-credit | …)
  // POST is a deliberate local mutation (localhost-only server).
  if (url.pathname === "/api/routines-profile") {
    if (req.method === "GET") {
      const profile = readRoutinesProfile();
      cache.routinesProfile = profile;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(profile));
      return;
    }
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
        return;
      }
      const name = String(body.profile || body.name || "").trim();
      const result = await applyRoutinesProfile(name);
      if (result.ok && result.profile) cache.routinesProfile = result.profile;
      res.writeHead(result.ok ? 200 : 400, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
    return;
  }

  // GET /api/card/:slug — full body ask/deliverable for hover tooltips
  const cardMatch = url.pathname.match(/^\/api\/card\/([A-Za-z0-9._-]+)$/);
  if (cardMatch) {
    const payload = await fetchCardAsk(cardMatch[1]);
    res.writeHead(payload.ok ? 200 : 404, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(payload));
    return;
  }

  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.join(PUBLIC, filePath);
  if (!abs.startsWith(PUBLIC) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(abs) });
  fs.createReadStream(abs).pipe(res);
});

// Listen first so a slow/busy `kanban list --all` cannot leave the factory
// unreachable (health/UI). First /api/state with empty cache still awaits
// refresh once; subsequent polls use stale-while-revalidate.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  🏭 Kanban Factory running at http://127.0.0.1:${PORT}\n`);
});

function logSnapshot() {
  console.log(
    `  cards=${cache.summary.total}  doing=${cache.summary.counts.doing || 0}  backlog=${cache.summary.counts.backlog || 0}  done=${cache.summary.counts.done || 0}`
  );
  if (cache.error) console.warn("  warn:", cache.error);
}

refresh()
  .then(logSnapshot)
  .catch((e) => {
    cache.error = String(e);
    console.warn("  initial refresh failed:", e);
  });

setInterval(() => {
  refresh().catch((e) => {
    cache.error = String(e);
  });
}, POLL_MS);
