/**
 * Kanban Factory — client theater engine
 * Live-polls /api/state, animates card moves, personifies routines.
 */

import { extractCardAsk } from "./card-ask.js";

const COLS = ["backlog", "todo", "doing", "done"];
// Client polls cache; server refreshes in background. Don't stampede kanban.
const POLL_MS = 5000;
const SHORT = (s, n = 48) => {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** In-flight hover enrichments so we don't stampede kanban show. */
const askFetch = new Map(); // slug -> Promise

// ─── Sound (Web Audio, no assets) ───────────────────────────────────────────
const Sound = (() => {
  let ctx = null;
  let enabled = true;
  const ensure = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const tone = (freq, dur, type = "sine", gain = 0.05, delay = 0) => {
    if (!enabled) return;
    try {
      const c = ensure();
      const t0 = c.currentTime + delay;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(c.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    } catch {}
  };
  return {
    get enabled() {
      return enabled;
    },
    set enabled(v) {
      enabled = v;
    },
    unlock() {
      try {
        ensure();
      } catch {}
    },
    pickup() {
      // cheerful scoop
      tone(440, 0.08, "triangle", 0.045);
      tone(660, 0.1, "sine", 0.04, 0.05);
      tone(880, 0.12, "sine", 0.03, 0.1);
    },
    move() {
      tone(320, 0.07, "sine", 0.035);
      tone(480, 0.09, "triangle", 0.03, 0.04);
    },
    done() {
      // little victory arpeggio
      tone(523.25, 0.1, "sine", 0.04);
      tone(659.25, 0.1, "sine", 0.04, 0.08);
      tone(783.99, 0.14, "triangle", 0.045, 0.16);
      tone(1046.5, 0.18, "sine", 0.03, 0.26);
    },
    unblock() {
      tone(300, 0.06, "square", 0.02);
      tone(600, 0.12, "sine", 0.035, 0.05);
      tone(900, 0.14, "sine", 0.03, 0.12);
    },
    error() {
      tone(180, 0.15, "sawtooth", 0.03);
      tone(140, 0.18, "sawtooth", 0.025, 0.1);
    },
    parade() {
      [392, 494, 587, 784].forEach((f, i) => tone(f, 0.1, "triangle", 0.035, i * 0.08));
    },
    combo(n = 3) {
      const base = 520 + Math.min(n, 8) * 40;
      [base, base * 1.25, base * 1.5, base * 2].forEach((f, i) =>
        tone(f, 0.12, "triangle", 0.04 + i * 0.005, i * 0.07)
      );
    },
    stamp() {
      tone(200, 0.04, "square", 0.03);
      tone(800, 0.08, "sine", 0.035, 0.03);
    },
    hum: (() => {
      let nodes = null;
      return {
        start() {
          if (!enabled || nodes) return;
          try {
            const c = ensure();
            const o1 = c.createOscillator();
            const o2 = c.createOscillator();
            const g = c.createGain();
            const f = c.createBiquadFilter();
            o1.type = "sine";
            o2.type = "triangle";
            o1.frequency.value = 55;
            o2.frequency.value = 82.5;
            f.type = "lowpass";
            f.frequency.value = 220;
            g.gain.value = 0.0001;
            o1.connect(f);
            o2.connect(f);
            f.connect(g);
            g.connect(c.destination);
            o1.start();
            o2.start();
            g.gain.exponentialRampToValueAtTime(0.012, c.currentTime + 1.2);
            nodes = { o1, o2, g, c };
          } catch {}
        },
        stop() {
          if (!nodes) return;
          try {
            const { o1, o2, g, c } = nodes;
            g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.4);
            setTimeout(() => {
              try {
                o1.stop();
                o2.stop();
              } catch {}
            }, 500);
          } catch {}
          nodes = null;
        },
        get on() {
          return !!nodes;
        },
      };
    })(),
  };
})();

// ─── Particle canvas ────────────────────────────────────────────────────────
const Fx = (() => {
  const canvas = document.getElementById("fx");
  const ctx = canvas.getContext("2d");
  let w = 0,
    h = 0,
    particles = [],
    confetti = [],
    raf = 0;

  const resize = () => {
    w = canvas.width = window.innerWidth * devicePixelRatio;
    h = canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  };
  window.addEventListener("resize", resize);
  resize();

  const burst = (x, y, color = "#fb923c", n = 18) => {
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      const sp = 1.5 + Math.random() * 3.5;
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1,
        life: 1,
        decay: 0.015 + Math.random() * 0.02,
        color,
        r: 1.5 + Math.random() * 2.5,
      });
    }
  };

  const celebrate = (x, y, mega = false) => {
    const colors = ["#34d399", "#60a5fa", "#fbbf24", "#f472b6", "#a78bfa"];
    const n = mega ? 72 : 36;
    for (let i = 0; i < n; i++) {
      confetti.push({
        x,
        y,
        vx: (Math.random() - 0.5) * (mega ? 12 : 8),
        vy: -2 - Math.random() * (mega ? 8 : 5),
        life: 1,
        decay: 0.006 + Math.random() * 0.01,
        color: colors[i % colors.length],
        w: 3 + Math.random() * 4,
        h: 2 + Math.random() * 3,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
      });
    }
    burst(x, y, "#34d399", mega ? 28 : 12);
  };

  const trail = (x, y, color = "#fb923c") => {
    particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6,
      life: 0.7,
      decay: 0.04 + Math.random() * 0.03,
      color,
      r: 1.2 + Math.random() * 2,
    });
  };

  let rings = [];
  const ring = (x, y, color = "#34d399") => {
    rings.push({ x, y, r: 4, max: 80, life: 1, color });
  };

  const tick = () => {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    particles = particles.filter((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.06;
      p.life -= p.decay;
      if (p.life <= 0) return false;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      return true;
    });
    confetti = confetti.filter((c) => {
      c.x += c.vx;
      c.y += c.vy;
      c.vy += 0.12;
      c.rot += c.vr;
      c.life -= c.decay;
      if (c.life <= 0) return false;
      ctx.save();
      ctx.globalAlpha = Math.max(0, c.life);
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
      return true;
    });
    rings = rings.filter((rg) => {
      rg.r += 2.2;
      rg.life -= 0.025;
      if (rg.life <= 0) return false;
      ctx.globalAlpha = Math.max(0, rg.life) * 0.7;
      ctx.strokeStyle = rg.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
      ctx.stroke();
      return true;
    });
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(tick);
  };
  tick();

  return { burst, celebrate, trail, ring };
})();

// ─── DOM refs ───────────────────────────────────────────────────────────────
const slots = {
  backlog: document.getElementById("slot-backlog"),
  todo: document.getElementById("slot-todo"),
  doing: document.getElementById("slot-doing"),
  done: document.getElementById("slot-done"),
};
const crewEl = document.getElementById("crew");
const handsEl = document.getElementById("hands");
const handsPanel = document.getElementById("hands-panel");
const feedEl = document.getElementById("feed");
const tooltip = document.getElementById("tooltip");
const toast = document.getElementById("toast");
const boot = document.getElementById("boot");
const liveDot = document.getElementById("live-dot");
const shakeRoot = document.getElementById("shake-root");
const floatLayer = document.getElementById("float-layer");
const tickerTrack = document.getElementById("ticker-track");
const stampEl = document.getElementById("stamp");
const achEl = document.getElementById("achievement");
const momentumFill = document.getElementById("momentum-fill");
const momentumLabel = document.getElementById("momentum-label");

const countEls = {
  backlog: document.getElementById("n-backlog"),
  todo: document.getElementById("n-todo"),
  doing: document.getElementById("n-doing"),
  done: document.getElementById("n-done"),
  blocked: document.getElementById("n-blocked"),
};
const laneCounts = {
  backlog: document.querySelector('[data-count="backlog"]'),
  todo: document.querySelector('[data-count="todo"]'),
  doing: document.querySelector('[data-count="doing"]'),
  done: document.querySelector('[data-count="done"]'),
};

// ─── State ──────────────────────────────────────────────────────────────────
let cardMap = new Map(); // slug -> card data
let cardEls = new Map(); // slug -> DOM
let routineMap = new Map();
let knownEventKeys = new Set();
let firstLoad = true;
let animating = new Set();
const session = {
  ships: 0,
  grabs: 0,
  unblocks: 0,
  streak: 0,
  bestStreak: 0,
  events: [], // recent timestamps for momentum
  ticker: [],
  achievements: new Set(),
};
const NS_COLORS = [
  "#60a5fa",
  "#f472b6",
  "#34d399",
  "#fbbf24",
  "#a78bfa",
  "#fb923c",
  "#22d3ee",
  "#f87171",
];
const nsColor = (ns) => {
  if (!ns) return null;
  let h = 0;
  for (let i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) >>> 0;
  return NS_COLORS[h % NS_COLORS.length];
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function showToast(msg, ms = 2800) {
  toast.textContent = msg;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      toast.hidden = true;
    }, 250);
  }, ms);
}

function updateSessionHud(live = {}) {
  const ships = document.getElementById("hud-ships");
  const grabs = document.getElementById("hud-grabs");
  const streak = document.getElementById("hud-streak");
  const wrap = document.getElementById("hud-streak-wrap");
  const inflight = document.getElementById("hud-inflight");
  const hands = document.getElementById("hud-hands");
  if (ships) ships.textContent = session.ships;
  if (grabs) grabs.textContent = session.grabs;
  if (streak) streak.textContent = session.streak;
  if (wrap) wrap.classList.toggle("hot", session.streak >= 2);
  if (inflight && live.doing != null) inflight.textContent = live.doing;
  if (hands && live.hands != null) hands.textContent = live.hands;
}

/** Speedometer + 3/12/24h rates + 24h hourly ship chart */
function renderVelocity(v) {
  if (!v || !v.ships) return;
  const ARC = 144.5; // approximate path length of semicircle
  // Cap speedo at 12 ships/h full scale (fun, not scientific)
  const ph3 = v.ships.h3?.perHour ?? 0;
  const pct = Math.min(1, ph3 / 12);
  const arc = document.getElementById("speedo-arc");
  const needle = document.getElementById("speedo-needle");
  const nEl = document.getElementById("speedo-n");
  if (arc) arc.style.strokeDashoffset = String(ARC * (1 - pct));
  if (needle) {
    // -90deg = empty left, +90deg = full right; rest at bottom center
    const deg = -90 + pct * 180;
    needle.style.transform = `rotate(${deg}deg)`;
  }
  if (nEl) nEl.textContent = String(ph3);

  const setWin = (hours, key) => {
    const s = v.ships[key];
    if (!s) return;
    const ph = document.getElementById(`velo-ph-${hours}`);
    const n = document.getElementById(`velo-n-${hours}`);
    if (ph) ph.textContent = String(s.perHour);
    if (n) n.textContent = `${s.count} ship${s.count === 1 ? "" : "s"}`;
  };
  setWin(3, "h3");
  setWin(12, "h12");
  setWin(24, "h24");

  const peak = document.getElementById("velo-peak");
  if (peak && v.peakHour) {
    peak.textContent =
      v.peakHour.ships > 0
        ? `peak ${v.peakHour.ships}/h @ ${v.peakHour.label}`
        : "peak —";
  }
  const note = document.getElementById("velo-note");
  if (note && v.note) note.textContent = v.note;

  const chart = document.getElementById("velo-chart");
  if (!chart || !Array.isArray(v.hourly)) return;
  const max = Math.max(1, ...v.hourly.map((b) => b.ships || 0));
  chart.innerHTML = "";
  for (const b of v.hourly) {
    const bar = document.createElement("div");
    bar.className = "velo-bar";
    bar.dataset.n = String(b.ships || 0);
    const h = Math.max(b.ships ? 8 : 2, Math.round(((b.ships || 0) / max) * 80));
    bar.style.height = h + "px";
    const tip = document.createElement("span");
    tip.className = "tip";
    tip.textContent = `${b.label}: ${b.ships} ship${b.ships === 1 ? "" : "s"}`;
    bar.appendChild(tip);
    bar.title = tip.textContent;
    chart.appendChild(bar);
  }
}

function seedTickerFromBoard(cards, workers) {
  if (session.ticker.length) return;
  const doing = cards.filter((c) => c.column === "doing");
  const done = cards
    .filter((c) => c.column === "done" && c.done_at)
    .sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)))
    .slice(0, 4);
  const items = [];
  if (doing.length) {
    items.push({
      text: `⚡ ${doing.length} in flight right now`,
      kind: "pickup",
    });
  }
  for (const w of (workers || []).filter((x) => (x.load || 0) > 0 || x.status === "working").slice(0, 6)) {
    const n = w.load || (w.carryingAll || []).length || 1;
    const title = (w.carryingTitles && w.carryingTitles[0]) || w.carrying || "…";
    items.push({
      text: `🦾 ${w.label}${n > 1 ? ` ×${n}` : ""} · ${SHORT(title, 40)}`,
      kind: "pickup",
    });
  }
  for (const c of done) {
    items.push({ text: `🏆 recently done · ${SHORT(c.title, 42)}`, kind: "done" });
  }
  if (!items.length) {
    items.push({ text: "board quiet — watching for hops", kind: "dim" });
  }
  session.ticker = items;
  renderTicker();
}

/** First paint: fill Factory Log from heartbeats + recent dones (don't wait for a new fire). */
function seedFeedFromBoard(cards, events, workers) {
  if (feedEl.children.length) return;
  const done = cards
    .filter((c) => c.column === "done" && c.done_at)
    .sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)))
    .slice(0, 5);
  for (const c of [...done].reverse()) {
    pushFeed({
      emoji: "🏆",
      who: "Done",
      what: c.title,
      when: c.done_at ? formatWhen(c.done_at) : "",
      kind: "done",
    });
  }
  // newest heartbeats first in events — push oldest first so newest ends on top
  const recent = (events || []).filter((e) => e.at || e.detail).slice(0, 12);
  for (const e of [...recent].reverse()) {
    const r = routineMap.get(e.routine);
    pushFeed({
      emoji: r?.emoji || "⚙️",
      who: r?.name || e.routine,
      what: `${e.status || "ok"} ${e.detail || ""}`.trim(),
      when: e.at ? formatWhen(e.at) : "",
    });
  }
  const load = (workers || []).reduce((n, w) => n + (w.load || 0), 0);
  if (load > 0) {
    pushFeed({
      emoji: "⚡",
      who: "Floor",
      what: `${load} card${load === 1 ? "" : "s"} in flight across ${(workers || []).filter((w) => (w.load || 0) > 0).length} hands`,
      kind: "move",
    });
  }
}

function renderTicker() {
  if (!tickerTrack) return;
  const items = session.ticker.length
    ? session.ticker
    : [{ text: "watching the live board…", kind: "dim" }];
  const html = [...items, ...items]
    .map((it) => `<span class="ticker-item ${it.kind || ""}">${escapeHtml(it.text)}</span>`)
    .join("");
  tickerTrack.innerHTML = html;
}

/** Live floor pulse: in-flight board work + recent moves this session. */
function refreshMomentum(extra = {}) {
  const cut = Date.now() - 10 * 60 * 1000;
  session.events = session.events.filter((e) => e.t >= cut);
  const recentMoves = session.events.length;

  // Prefer live snapshot when provided; else last known board map
  const cards = extra.cards || [...cardMap.values()];
  const doing = extra.doing ?? cards.filter((c) => c.column === "doing").length;
  const todo = extra.todo ?? cards.filter((c) => c.column === "todo").length;
  const workers = extra.workers || [];
  const handsWorking =
    extra.handsWorking ??
    workers.filter((w) => w.status === "working" || w.carrying).length;
  const routines = extra.routines || [...routineMap.values()];
  const routinesHot = routines.filter(
    (r) => r.mood === "working" || r.mood === "active"
  ).length;

  // Score: live work dominates; session animations are a bonus
  const score =
    doing * 18 +
    handsWorking * 10 +
    Math.min(todo, 6) * 3 +
    Math.min(routinesHot, 8) * 4 +
    recentMoves * 8;

  const pct = Math.max(6, Math.min(100, score));
  if (momentumFill) momentumFill.style.width = pct + "%";
  if (momentumLabel) {
    let label;
    if (doing === 0 && handsWorking === 0 && recentMoves === 0) {
      label = todo > 0 ? "queue waiting · no hands yet" : "idle floor";
    } else if (doing >= 8 || handsWorking >= 5) {
      label = `full throttle · ${doing} in flight`;
    } else if (doing >= 4 || handsWorking >= 3) {
      label = `busy floor · ${doing} working`;
    } else if (doing >= 1) {
      label =
        handsWorking > 0
          ? `${doing} in flight · ${handsWorking} hand${handsWorking === 1 ? "" : "s"}`
          : `${doing} in flight`;
    } else if (recentMoves > 0) {
      label = "recent moves · floor settling";
    } else {
      label = "a stir…";
    }
    if (recentMoves >= 5) label += " · hot session";
    momentumLabel.textContent = label;
    momentumLabel.title = [
      `doing=${doing}`,
      `hands=${handsWorking}`,
      `todo=${todo}`,
      `active routines≈${routinesHot}`,
      `session moves (10m)=${recentMoves}`,
    ].join(" · ");
  }
}

function bumpMomentum(kind = "move") {
  session.events.push({ t: Date.now(), kind });
  refreshMomentum();
}

function pushTicker(text, kind = "") {
  session.ticker.unshift({ text, kind, at: Date.now() });
  session.ticker = session.ticker.slice(0, 24);
  renderTicker();
}

function floatPop(x, y, text, kind = "") {
  if (!floatLayer) return;
  const el = document.createElement("div");
  el.className = `float-pop ${kind}`;
  el.textContent = text;
  el.style.left = x + "px";
  el.style.top = y + "px";
  floatLayer.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

function showStamp() {
  if (!stampEl) return;
  stampEl.hidden = false;
  stampEl.classList.remove("show");
  void stampEl.offsetWidth;
  Sound.stamp();
  setTimeout(() => {
    stampEl.hidden = true;
  }, 1100);
}

function screenShake() {
  if (!shakeRoot) return;
  shakeRoot.classList.remove("shake");
  void shakeRoot.offsetWidth;
  shakeRoot.classList.add("shake");
  setTimeout(() => shakeRoot.classList.remove("shake"), 500);
}

function unlockAchievement(id, title, sub, icon = "🏆") {
  if (session.achievements.has(id)) return;
  session.achievements.add(id);
  if (!achEl) return;
  document.getElementById("ach-icon").textContent = icon;
  document.getElementById("ach-title").textContent = title;
  document.getElementById("ach-sub").textContent = sub;
  achEl.hidden = false;
  achEl.style.animation = "none";
  void achEl.offsetWidth;
  achEl.style.animation = "";
  Sound.combo(3);
  setTimeout(() => {
    achEl.hidden = true;
  }, 3400);
}

function updateShift() {
  const h = new Date().getHours();
  let shift = "DAY";
  let cls = "shift-day";
  let label = "shift";
  if (h >= 5 && h < 11) {
    shift = "AM";
    cls = "shift-morning";
    label = "morning";
  } else if (h >= 11 && h < 17) {
    shift = "DAY";
    cls = "shift-day";
    label = "day";
  } else if (h >= 17 && h < 22) {
    shift = "EVE";
    cls = "shift-day";
    label = "evening";
  } else {
    shift = "NITE";
    cls = "shift-night";
    label = "night";
  }
  document.body.classList.remove("shift-morning", "shift-day", "shift-night");
  document.body.classList.add(cls);
  const el = document.getElementById("hud-shift");
  const lab = document.getElementById("hud-shift-label");
  if (el) el.textContent = shift;
  if (lab) lab.textContent = label;
}

function updateLaneHeat(counts) {
  for (const col of COLS) {
    const lane = document.querySelector(`.lane[data-col="${col}"]`);
    if (!lane) continue;
    lane.classList.remove("heat-1", "heat-2", "heat-3", "heat-4");
    const n = counts[col] || 0;
    if (n >= 12) lane.classList.add("heat-4");
    else if (n >= 7) lane.classList.add("heat-3");
    else if (n >= 4) lane.classList.add("heat-2");
    else if (n >= 1) lane.classList.add("heat-1");
  }
}

function onSessionShip(title, x, y) {
  session.ships++;
  session.streak++;
  session.bestStreak = Math.max(session.bestStreak, session.streak);
  updateSessionHud();
  bumpMomentum("ship");
  pushTicker(`🏆 SHIPPED · ${SHORT(title, 48)}`, "done");
  floatPop(x, y, session.streak >= 2 ? `×${session.streak} SHIP` : "+1 SHIP", session.streak >= 2 ? "combo" : "");
  showStamp();
  screenShake();
  if (session.ships === 1) unlockAchievement("first-ship", "First ship of the session", title, "🚀");
  if (session.streak === 3) unlockAchievement("streak-3", "Hot streak ×3", "Three ships in a row", "🔥");
  if (session.streak === 5) unlockAchievement("streak-5", "Unstoppable ×5", "The floor is on fire", "💥");
  if (session.ships === 10) unlockAchievement("ships-10", "Ten ships this session", "Productivity theater pays off", "🏅");
  if (session.streak >= 3) Sound.combo(session.streak);
}

function onSessionGrab(title, x, y) {
  session.grabs++;
  updateSessionHud();
  bumpMomentum("grab");
  pushTicker(`🦾 GRAB · ${SHORT(title, 48)}`, "pickup");
  floatPop(x, y, "GRAB!", "grab");
  if (session.grabs === 1) unlockAchievement("first-grab", "First grab", "Pickup is on the clock", "🦾");
  if (session.grabs === 10) unlockAchievement("grabs-10", "Ten grabs", "Hungry hands", "🦞");
}

function onSessionUnblock(title, x, y) {
  session.unblocks++;
  updateSessionHud();
  bumpMomentum("unblock");
  pushTicker(`🔓 UNBLOCK · ${SHORT(title, 48)}`, "unblock");
  floatPop(x, y, "UNLOCK", "unblock");
  if (session.unblocks === 1) unlockAchievement("first-unblock", "Chains off", title, "🔓");
}

function priorityClass(p) {
  if (!p) return "";
  return String(p).toLowerCase();
}

function shortWorker(assignee) {
  if (!assignee) return "";
  const m = assignee.match(/pickup(-w\d+)?/i);
  if (m) return m[1] ? `Pickup${m[1].toUpperCase()}` : "Pickup";
  if (/watch/i.test(assignee)) return "Watch";
  return SHORT(assignee.replace(/^last-stack-/, "").replace(/^fkanban-/, ""), 16);
}

function ensureCardAskLocal(c) {
  // Prefer server-extracted fields; fall back to client extract on body.
  if (c.askReady && (c.ask || c.deliverable)) return c;
  if (c.body && (!c.ask || !c.deliverable)) {
    const bits = extractCardAsk(c.body);
    if (bits.ask && !c.ask) c.ask = bits.ask;
    if (bits.deliverable && !c.deliverable) c.deliverable = bits.deliverable;
    if (bits.summary && !c.summary) c.summary = bits.summary;
    if (bits.ask || bits.deliverable) c.askReady = true;
  }
  return c;
}

function cardTooltipHtml(c) {
  ensureCardAskLocal(c);
  const since = columnEnteredMs(c);
  const workAge = since != null ? formatWorkAge(since) : null;
  const ageBand = c.column === "doing" && since != null ? workAgeBand(since) : null;
  const sinceLabel = since != null ? new Date(since).toLocaleString() : "";
  const enteredRow = !workAge
    ? null
    : c.column === "doing"
      ? [
          ageBand === "stuck" ? "working ⚠" : ageBand === "warn" ? "working · long" : "working",
          `${workAge} · since ${sinceLabel}`,
        ]
      : c.column === "backlog"
        ? ["in backlog", `${workAge} · since ${sinceLabel}`]
        : c.column === "todo"
          ? ["queued", `${workAge} · in todo since ${sinceLabel}`]
          : c.column === "done"
            ? ["completed", `${sinceLabel} · ${workAge} ago`]
            : [`in ${c.column}`, `${workAge} · since ${sinceLabel}`];
  const createdMs = c.created_at ? Date.parse(c.created_at) : NaN;
  const rows = [
    enteredRow,
    Number.isFinite(createdMs)
      ? ["created", `${new Date(createdMs).toLocaleString()} · ${formatWorkAge(createdMs)} ago`]
      : null,
    c.priority ? ["priority", c.priority] : null,
    c.kind ? ["kind", c.kind] : null,
    c.repo ? ["repo", c.repo] : null,
    c.column ? ["column", c.column] : null,
    c.assignee ? ["assignee", c.assignee] : null,
    c.north_star ? ["north star", c.north_star] : null,
    c.blocked ? ["blocked by", (c.blockedBy || []).join(", ") || "deps"] : null,
    c.block_status && c.block_status !== "none"
      ? ["hold", `${c.block_status}${c.block_reason ? " — " + SHORT(c.block_reason, 120) : ""}`]
      : null,
    c.pr_url ? ["pr", SHORT(c.pr_url, 64)] : null,
  ].filter(Boolean);

  const ask = c.ask || "";
  const deliverable = c.deliverable || "";
  const summary = !ask && !deliverable ? c.summary || "" : "";
  const loading = !c.askReady && !ask && !deliverable && !summary;

  return `
    <h3>${escapeHtml(c.title)}</h3>
    ${
      ask
        ? `<div class="ask"><span class="lbl">Ask</span>${escapeHtml(ask)}</div>`
        : ""
    }
    ${
      deliverable
        ? `<div class="deliverable"><span class="lbl">Done when</span>${escapeHtml(deliverable)}</div>`
        : ""
    }
    ${
      summary
        ? `<div class="ask"><span class="lbl">About</span>${escapeHtml(summary)}</div>`
        : ""
    }
    ${
      loading
        ? `<div class="ask loading"><span class="lbl">Ask</span>Loading goal &amp; deliverable…</div>`
        : ""
    }
    <div class="meta-block">
    ${rows
      .map(
        ([k, v]) =>
          `<div class="row"><b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}</div>`
      )
      .join("")}
    </div>
    <div class="row slug-row"><b>slug:</b> ${escapeHtml(c.slug || "")}</div>
  `;
}

/** Enrich card ask/deliverable from full body (kanban show) while hovered. */
function enrichCardAskOnHover(slug, el) {
  if (!slug) return;
  const c = cardMap.get(slug);
  if (!c) return;
  ensureCardAskLocal(c);
  if (c.askReady && (c.ask || c.deliverable)) return;
  if (askFetch.has(slug)) return;

  const p = fetch(`/api/card/${encodeURIComponent(slug)}`)
    .then((r) => r.json())
    .then((data) => {
      askFetch.delete(slug);
      if (!data || !data.ok) return;
      const live = cardMap.get(slug) || c;
      live.ask = data.ask || live.ask;
      live.deliverable = data.deliverable || live.deliverable;
      live.summary = data.summary || live.summary;
      live.askReady = true;
      if (data.body) live.body = data.body;
      cardMap.set(slug, live);
      // Refresh tooltip only if still hovering this card
      if (el && el.matches(":hover") && !tooltip.hidden) {
        tooltip.innerHTML = cardTooltipHtml(live);
      }
    })
    .catch(() => {
      askFetch.delete(slug);
    });
  askFetch.set(slug, p);
}

function routineTooltipHtml(r) {
  return `
    <h3>${escapeHtml(r.emoji || "")} ${escapeHtml(r.name)} — ${escapeHtml(r.title || "")}</h3>
    <div class="row"><b>mood:</b> ${escapeHtml(r.mood || "idle")}</div>
    ${r.lastAt ? `<div class="row"><b>last fire:</b> ${escapeHtml(r.lastAt)}</div>` : ""}
    ${r.lastStatus ? `<div class="row"><b>status:</b> ${escapeHtml(r.lastStatus)}</div>` : ""}
    ${
      r.lastDetail
        ? `<div class="row"><b>detail:</b> ${escapeHtml(SHORT(r.lastDetail, 180))}</div>`
        : ""
    }
    <div class="vibe">${escapeHtml(r.vibe || "")}</div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bindTooltip(el, htmlFn, opts = {}) {
  el.addEventListener("pointerenter", (e) => {
    tooltip.innerHTML = htmlFn();
    tooltip.hidden = false;
    placeTooltip(e.clientX, e.clientY);
    if (typeof opts.onEnter === "function") opts.onEnter(el);
  });
  el.addEventListener("pointermove", (e) => placeTooltip(e.clientX, e.clientY));
  el.addEventListener("pointerleave", () => {
    tooltip.hidden = true;
  });
}

function placeTooltip(x, y) {
  const pad = 14;
  tooltip.style.left = "0px";
  tooltip.style.top = "0px";
  const rect = tooltip.getBoundingClientRect();
  let left = x + 16;
  let top = y + 16;
  if (left + rect.width + pad > window.innerWidth) left = x - rect.width - 12;
  if (top + rect.height + pad > window.innerHeight) top = y - rect.height - 12;
  tooltip.style.left = Math.max(8, left) + "px";
  tooltip.style.top = Math.max(8, top) + "px";
}

// ─── Card DOM ───────────────────────────────────────────────────────────────
function buildCardEl(c) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.slug = c.slug;
  applyCardClasses(el, c);

  const color = nsColor(c.north_star);
  if (color) {
    const dot = document.createElement("span");
    dot.className = "ns-dot";
    dot.style.color = color;
    dot.style.background = color;
    dot.title = c.north_star;
    el.appendChild(dot);
  }

  const title = document.createElement("p");
  title.className = "title";
  title.textContent = c.title;
  el.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "meta";
  fillCardMeta(meta, c);
  el.appendChild(meta);
  // Age band classes for stuck/warn glow
  if (c.column === "doing") {
    const band = workAgeBand(workingSinceMs(c));
    el.classList.toggle("age-warn", band === "warn");
    el.classList.toggle("age-stuck", band === "stuck");
  }
  bindTooltip(el, () => cardTooltipHtml(cardMap.get(c.slug) || c), {
    onEnter: () => enrichCardAskOnHover(c.slug, el),
  });
  el.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const r = rectCenter(el);
    Fx.burst(r.x, r.y, nsColor(c.north_star) || "#a78bfa", 20);
    Fx.ring(r.x, r.y, nsColor(c.north_star) || "#a78bfa");
    el.classList.remove("sparkle-burst");
    void el.offsetWidth;
    el.classList.add("sparkle-burst");
    Sound.move();
  });
  return el;
}

function applyCardClasses(el, c) {
  el.classList.remove(
    "p0",
    "p1",
    "p2",
    "p3",
    "blocked",
    "deferred",
    "needs_human",
    "working",
    "done-pop",
    "age-warn",
    "age-stuck"
  );
  const p = priorityClass(c.priority);
  if (p) el.classList.add(p);
  if (c.blocked) el.classList.add("blocked");
  if (c.block_status === "deferred") el.classList.add("deferred");
  if (c.block_status === "needs_human") el.classList.add("needs_human");
  if (c.column === "doing") {
    el.classList.add("working");
    const band = workAgeBand(workingSinceMs(c));
    if (band === "warn") el.classList.add("age-warn");
    if (band === "stuck") el.classList.add("age-stuck");
  }
  if (c.column === "done") el.classList.add("done-pop");
}

function ensureEmptyHints() {
  for (const col of COLS) {
    const slot = slots[col];
    const hasCards = slot.querySelector(".card");
    let empty = slot.querySelector(".empty-lane");
    if (!hasCards) {
      if (!empty) {
        empty = document.createElement("div");
        empty.className = "empty-lane";
        const icons = {
          backlog: "📭",
          todo: "🧘",
          doing: "☕",
          done: "🌱",
        };
        const msgs = {
          backlog: "Nothing waiting in the dark",
          todo: "Queue empty — Pickup is idle",
          doing: "Nobody working right now",
          done: "Victories land here",
        };
        empty.innerHTML = `<span class="big">${icons[col]}</span>${msgs[col]}`;
        slot.appendChild(empty);
      }
    } else if (empty) {
      empty.remove();
    }
  }
}

// ─── Animation: fly card between lanes ──────────────────────────────────────
function rectCenter(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
}

function animateMove(slug, fromCol, toCol, reason = "move") {
  return new Promise((resolve) => {
    const el = cardEls.get(slug);
    const c = cardMap.get(slug);
    if (!el || !c) {
      resolve();
      return;
    }
    if (animating.has(slug)) {
      // finish hard
      forcePlace(slug, toCol);
      resolve();
      return;
    }
    animating.add(slug);

    const fromSlot = slots[fromCol] || el.parentElement;
    const toSlot = slots[toCol];
    if (!toSlot) {
      animating.delete(slug);
      resolve();
      return;
    }

    // Measure start
    const start = el.getBoundingClientRect();
    // Temporarily put a placeholder at destination for end measure
    const ghost = document.createElement("div");
    ghost.style.height = start.height + "px";
    ghost.style.margin = "0";
    ghost.style.opacity = "0";
    ghost.style.pointerEvents = "none";
    // Prefer top of doing / bottom of done for drama
    if (toCol === "doing" || toCol === "todo") {
      toSlot.prepend(ghost);
    } else {
      toSlot.appendChild(ghost);
    }
    ensureEmptyHints();
    const end = ghost.getBoundingClientRect();

    // Lift card into fixed flight
    el.classList.add("flying");
    el.style.width = start.width + "px";
    el.style.left = start.left + "px";
    el.style.top = start.top + "px";
    document.body.appendChild(el);

    if (reason === "pickup" || toCol === "doing") Sound.pickup();
    else if (toCol === "done") Sound.done();
    else if (reason === "unblock") Sound.unblock();
    else Sound.move();

    const color =
      toCol === "done" ? "#34d399" : toCol === "doing" ? "#fb923c" : "#60a5fa";
    Fx.burst(start.left + start.width / 2, start.top + start.height / 2, color, 14);
    Fx.ring(start.left + start.width / 2, start.top + start.height / 2, color);

    const duration = toCol === "done" ? 950 : 720;
    const hop = toCol === "done" ? 70 : 44;
    const t0 = performance.now();
    let lastTrail = 0;

    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      // ease in-out cubic with slight arc
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const x = start.left + (end.left - start.left) * e;
      const y =
        start.top +
        (end.top - start.top) * e -
        Math.sin(Math.PI * e) * hop; // hop arc
      const scale = 1 + Math.sin(Math.PI * e) * (toCol === "done" ? 0.12 : 0.08);
      const rot = Math.sin(Math.PI * e) * (toCol === "done" ? 12 : 4);
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.transform = `scale(${scale}) rotate(${rot}deg)`;

      if (now - lastTrail > 28) {
        Fx.trail(x + start.width / 2, y + start.height / 2, color);
        lastTrail = now;
      }

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        // land
        el.classList.remove("flying");
        el.style.width = "";
        el.style.left = "";
        el.style.top = "";
        el.style.transform = "";
        ghost.replaceWith(el);
        applyCardClasses(el, { ...c, column: toCol });
        // refresh badges for assignee etc.
        refreshCardContent(el, { ...c, column: toCol });
        ensureEmptyHints();
        const land = rectCenter(el);
        if (toCol === "done") {
          const mega = session.streak >= 2;
          Fx.celebrate(land.x, land.y, mega);
          Fx.ring(land.x, land.y, "#34d399");
          el.classList.add("fresh-ship");
          setTimeout(() => el.classList.remove("fresh-ship"), 1200);
          onSessionShip(c.title, land.x, land.y);
        } else if (toCol === "doing") {
          Fx.burst(land.x, land.y, color, 14);
          Fx.ring(land.x, land.y, color);
          onSessionGrab(c.title, land.x, land.y);
        } else {
          Fx.burst(land.x, land.y, color, 10);
          if (reason === "unblock") onSessionUnblock(c.title, land.x, land.y);
          else {
            // non-ship moves break ship streak
            if (session.streak > 0 && toCol !== "done") {
              /* streak only broken when something else happens after ships without shipping — actually keep streak until non-ship board move after a ship? Better: streak only consecutive ships in session without long gap; break on non-done move of any card */
            }
            bumpMomentum("move");
            pushTicker(`📦 ${fromCol} → ${toCol} · ${SHORT(c.title, 40)}`, "move");
          }
        }
        animating.delete(slug);
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

function forcePlace(slug, col) {
  const el = cardEls.get(slug);
  const c = cardMap.get(slug);
  if (!el || !slots[col]) return;
  el.classList.remove("flying");
  el.style.width = el.style.left = el.style.top = el.style.transform = "";
  if (col === "doing" || col === "todo") slots[col].prepend(el);
  else slots[col].appendChild(el);
  if (c) {
    applyCardClasses(el, { ...c, column: col });
    refreshCardContent(el, { ...c, column: col });
  }
}

function refreshCardContent(el, c) {
  const title = el.querySelector(".title");
  if (title) title.textContent = c.title;
  const meta = el.querySelector(".meta");
  if (meta) fillCardMeta(meta, c);
  if (c.column === "doing") {
    const band = workAgeBand(workingSinceMs(c));
    el.classList.toggle("age-warn", band === "warn");
    el.classList.toggle("age-stuck", band === "stuck");
  } else {
    el.classList.remove("age-warn", "age-stuck");
  }
}

// ─── Crew ───────────────────────────────────────────────────────────────────
function renderCrew(routines) {
  const existing = new Map([...crewEl.querySelectorAll(".worker")].map((el) => [el.dataset.id, el]));
  const seen = new Set();

  for (const r of routines) {
    seen.add(r.id);
    let el = existing.get(r.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "worker";
      el.dataset.id = r.id;
      el.innerHTML = `
        <div class="bubble"></div>
        <div class="avatar"></div>
        <p class="wname"></p>
        <p class="wtitle"></p>
        <span class="wmood"></span>
      `;
      crewEl.appendChild(el);
      bindTooltip(el, () => routineTooltipHtml(routineMap.get(r.id) || r));
    }
    el.style.setProperty("--wcolor", r.color || "#64748b");
    el.classList.remove("mood-idle", "mood-active", "mood-working", "mood-error");
    el.classList.add(`mood-${r.mood || "idle"}`);
    el.querySelector(".avatar").textContent = r.emoji || "⚙️";
    el.querySelector(".wname").textContent = r.name;
    el.querySelector(".wtitle").textContent = r.title || "";
    el.querySelector(".wmood").textContent = r.mood || "idle";
  }

  for (const [id, el] of existing) {
    if (!seen.has(id)) el.remove();
  }
}

function speak(routineId, text, ms = 3200) {
  const el = crewEl.querySelector(`.worker[data-id="${CSS.escape(routineId)}"]`);
  if (!el) return;
  const bubble = el.querySelector(".bubble");
  bubble.textContent = text;
  el.classList.add("speaking");
  clearTimeout(el._speakT);
  el._speakT = setTimeout(() => el.classList.remove("speaking"), ms);
}

// ─── Feed ───────────────────────────────────────────────────────────────────
function pushFeed({ emoji, who, what, when, kind = "" }) {
  const item = document.createElement("div");
  item.className = `feed-item ${kind}`;
  item.innerHTML = `
    <div class="dot">${emoji || "•"}</div>
    <div class="body">
      <div class="who">${escapeHtml(who)}</div>
      <div class="what" title="${escapeHtml(what)}">${escapeHtml(what)}</div>
      ${when ? `<div class="when">${escapeHtml(when)}</div>` : ""}
    </div>
  `;
  feedEl.prepend(item);
  while (feedEl.children.length > 40) feedEl.lastChild.remove();
}

// ─── Diff engine ────────────────────────────────────────────────────────────
async function applyState(data) {
  const cards = data.cards || [];
  const bySlug = new Map(cards.map((c) => [c.slug, c]));

  // Update counts
  const s = data.summary || { counts: {} };
  for (const col of COLS) {
    const n = s.counts?.[col] ?? cards.filter((c) => c.column === col).length;
    if (countEls[col]) countEls[col].textContent = n;
    if (laneCounts[col]) laneCounts[col].textContent = n;
  }
  countEls.blocked.textContent = s.blocked ?? cards.filter((c) => c.blocked).length;
  updateLaneHeat(s.counts || {});
  const doingN = s.counts?.doing ?? cards.filter((c) => c.column === "doing").length;
  const todoN = s.counts?.todo ?? cards.filter((c) => c.column === "todo").length;
  const handsWorking = (data.workers || []).filter(
    (w) => w.status === "working" || w.carrying || (w.load || 0) > 0
  ).length;
  refreshMomentum({
    cards,
    doing: doingN,
    todo: todoN,
    workers: data.workers || [],
    handsWorking,
    routines: data.routines || [],
  });
  updateSessionHud({ doing: doingN, hands: handsWorking });
  renderVelocity(data.velocity);
  renderLastdbVersion(data.lastdbVersion);
  renderFleetMode(data.routinesProfile);

  // Live indicator — show data age, not just a green light
  if (data.error) {
    liveDot.textContent = "ERR";
    liveDot.className = "live err";
    liveDot.title = data.error;
  } else {
    const ageSec = data.ageMs != null ? Math.round(data.ageMs / 1000) : null;
    const stale = ageSec != null && ageSec > 20;
    liveDot.textContent = data.refreshing ? "SYNC" : stale ? "STALE" : "LIVE";
    liveDot.className = "live" + (stale ? " stale" : data.refreshing ? " stale" : "");
    liveDot.title = [
      data.polledAt ? `snapshot ${new Date(data.polledAt).toLocaleTimeString()}` : "",
      ageSec != null ? `age ${ageSec}s` : "",
      data.refreshMs != null ? `last refresh ${data.refreshMs}ms` : "",
      data.refreshing ? "refreshing…" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // Queue empty achievement (only after first paint, truly empty)
  if (!firstLoad && todoN === 0 && doingN === 0) {
    unlockAchievement("quiet-floor", "Quiet floor", "Todo and doing are both empty", "🧘");
  }

  // First load: place everything without flying
  if (firstLoad) {
    for (const c of cards) {
      cardMap.set(c.slug, c);
      const el = buildCardEl(c);
      cardEls.set(c.slug, el);
      if (slots[c.column]) {
        if (c.column === "doing") slots[c.column].prepend(el);
        else slots[c.column].appendChild(el);
      }
    }
    // Cap done display for visual density (still real data; keep newest)
    trimDoneVisual(18);
    ensureEmptyHints();
    seedTickerFromBoard(cards, data.workers || []);
    // routines map filled below — seed feed after routines registered
    session._seedFeed = { cards, events: data.events || [], workers: data.workers || [] };
    firstLoad = false;
  } else {
    // Removals
    for (const slug of [...cardMap.keys()]) {
      if (!bySlug.has(slug)) {
        const el = cardEls.get(slug);
        if (el) {
          el.style.transition = "opacity 0.3s, transform 0.3s";
          el.style.opacity = "0";
          el.style.transform = "scale(0.85)";
          setTimeout(() => el.remove(), 320);
        }
        cardMap.delete(slug);
        cardEls.delete(slug);
      }
    }

    // Adds + moves
    const moveQueue = [];
    for (const c of cards) {
      const prev = cardMap.get(c.slug);
      cardMap.set(c.slug, c);

      if (!cardEls.has(c.slug)) {
        const el = buildCardEl(c);
        cardEls.set(c.slug, el);
        if (slots[c.column]) slots[c.column].appendChild(el);
        pushFeed({
          emoji: "✨",
          who: "Board",
          what: `new card → ${c.column}: ${c.title}`,
          kind: "move",
        });
        Sound.move();
        continue;
      }

      const el = cardEls.get(c.slug);
      // content refresh if not flying
      if (!animating.has(c.slug)) {
        refreshCardContent(el, c);
        applyCardClasses(el, c);
      }

      if (prev && prev.column !== c.column) {
        let reason = "move";
        if (c.column === "doing") reason = "pickup";
        if (c.column === "done") reason = "done";
        // unblock: was blocked, now not, and moved toward todo
        if (prev.blocked && !c.blocked) reason = "unblock";
        moveQueue.push({ slug: c.slug, from: prev.column, to: c.column, reason, card: c });
      } else if (prev && prev.blocked && !c.blocked) {
        // stayed put but unblocked
        Sound.unblock();
        const rc = rectCenter(el);
        Fx.burst(rc.x, rc.y, "#60a5fa", 16);
        Fx.ring(rc.x, rc.y, "#60a5fa");
        pushFeed({
          emoji: "🔓",
          who: "Groom / deps",
          what: `unblocked: ${c.title}`,
          kind: "unblock",
        });
        showToast(`🔓 Unblocked: ${SHORT(c.title, 50)}`);
        speak("groom-board", "Chains off!", 2500);
        onSessionUnblock(c.title, rc.x, rc.y);
      }
    }

    // Ship streak: if this poll has no done moves, don't reset mid-batch;
    // reset streak only when a non-done move batch runs without ships after ships.
    const hasShip = moveQueue.some((m) => m.to === "done");
    const hasOther = moveQueue.some((m) => m.to !== "done");
    if (hasOther && !hasShip && session.streak > 0) {
      // defer reset until after animations if mixed — handle below
    }

    // Animate moves sequentially for satisfaction (cap parallel 2)
    await runMoveQueue(moveQueue);

    if (hasOther && !hasShip && session.streak > 0) {
      session.streak = 0;
      updateSessionHud();
    }

    trimDoneVisual(18);
    ensureEmptyHints();
  }

  // Routines + active hands
  const routines = data.routines || [];
  for (const r of routines) routineMap.set(r.id, r);
  renderCrew(routines);
  renderHands(data.workers || [], cards);

  // First paint: populate Factory Log (before processEvents marks keys known)
  if (session._seedFeed) {
    seedFeedFromBoard(
      session._seedFeed.cards,
      session._seedFeed.events,
      session._seedFeed.workers
    );
    session._seedFeed = null;
  }

  // Heartbeat feed + speech for new events
  processEvents(data.events || []);
}

function renderHands(workers, cards) {
  if (!handsEl) return;
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  // Prefer overloaded / working hands first
  const list = [...workers].sort((a, b) => {
    const la = a.load || (a.carryingAll || []).length || (a.status === "working" ? 1 : 0);
    const lb = b.load || (b.carryingAll || []).length || (b.status === "working" ? 1 : 0);
    return lb - la || a.label.localeCompare(b.label);
  });

  if (!list.length) {
    handsPanel.style.display = "none";
    return;
  }
  handsPanel.style.display = "";
  handsEl.innerHTML = "";

  for (const w of list) {
    const load = w.load || (w.carryingAll || []).length || (w.carrying ? 1 : 0);
    const titles = w.carryingTitles || [];
    const card = w.carrying ? bySlug.get(w.carrying) : null;
    const primaryTitle =
      titles[0] || (card ? card.title : w.carrying) || "waiting for pickup";
    const el = document.createElement("div");
    const overloaded = load >= 3;
    el.className = `hand ${load > 0 ? "working" : "idle"}${overloaded ? " overloaded" : ""}`;
    const taskText =
      load > 1
        ? `${SHORT(primaryTitle, 34)} +${load - 1} more`
        : load > 0
          ? SHORT(primaryTitle, 42)
          : "waiting for pickup";
    el.innerHTML = `
      <div class="hand-avatar">${escapeHtml(w.emoji || "🦾")}</div>
      <div class="hand-body">
        <p class="hand-name">${escapeHtml(w.label)}${
          load > 1 ? `<span class="hand-load" title="${load} cards">×${load}</span>` : ""
        }</p>
        <p class="hand-task">${escapeHtml(taskText)}</p>
      </div>
      ${load > 0 ? `<div class="hand-grip" title="carrying ${load}">📦</div>` : ""}
    `;
    bindTooltip(el, () => {
      const lines = [
        `<h3>${escapeHtml(w.emoji || "")} ${escapeHtml(w.label)} — ${escapeHtml(w.title || "Worker")}</h3>`,
        `<div class="row"><b>instance:</b> ${escapeHtml(w.id)}</div>`,
        `<div class="row"><b>status:</b> ${escapeHtml(w.status)} · load ${load}</div>`,
      ];
      const stack = w.carryingAll || (w.carrying ? [w.carrying] : []);
      stack.forEach((slug, i) => {
        const c = bySlug.get(slug);
        const t = (w.carryingTitles && w.carryingTitles[i]) || c?.title || slug;
        lines.push(`<div class="row"><b>#${i + 1}:</b> ${escapeHtml(t)}</div>`);
      });
      lines.push(`<div class="vibe">${escapeHtml(w.vibe || "")}</div>`);
      return lines.join("");
    });
    // Click cycles focus across this hand's stack
    if (load > 0) {
      el.style.cursor = "pointer";
      el.dataset.stackIdx = "0";
      el.addEventListener("click", () => {
        const stack = w.carryingAll || (w.carrying ? [w.carrying] : []);
        let idx = Number(el.dataset.stackIdx || 0) % stack.length;
        const slug = stack[idx];
        el.dataset.stackIdx = String(idx + 1);
        const cardEl = cardEls.get(slug);
        if (!cardEl) return;
        cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
        cardEl.style.outline = "2px solid #fb923c";
        setTimeout(() => {
          cardEl.style.outline = "";
        }, 1400);
        const rc = rectCenter(cardEl);
        Fx.burst(rc.x, rc.y, overloaded ? "#f87171" : "#fb923c", 16);
        Sound.pickup();
        if (load > 1) {
          showToast(`${w.label}: card ${idx + 1}/${load} — ${SHORT(bySlug.get(slug)?.title || slug, 40)}`, 1800);
        }
      });
    }
    handsEl.appendChild(el);
  }
}

async function runMoveQueue(queue) {
  // Prioritize pickups and dones
  queue.sort((a, b) => {
    const score = (m) =>
      m.to === "done" ? 0 : m.to === "doing" ? 1 : m.reason === "unblock" ? 2 : 3;
    return score(a) - score(b);
  });

  const parallel = 2;
  let i = 0;
  while (i < queue.length) {
    const batch = queue.slice(i, i + parallel);
    await Promise.all(
      batch.map(async (m) => {
        const label =
          m.to === "doing"
            ? `🦾 Pickup grabbed: ${SHORT(m.card.title, 42)}`
            : m.to === "done"
              ? `🏆 Shipped: ${SHORT(m.card.title, 42)}`
              : m.reason === "unblock"
                ? `🔓 → ${m.to}: ${SHORT(m.card.title, 42)}`
                : `📦 ${m.from} → ${m.to}: ${SHORT(m.card.title, 40)}`;

        pushFeed({
          emoji: m.to === "done" ? "🏆" : m.to === "doing" ? "🦾" : "📦",
          who: m.to === "doing" ? "Pickup" : m.to === "done" ? "Pipeline" : "Board",
          what: `${m.from} → ${m.to}: ${m.card.title}`,
          kind: m.to === "done" ? "done" : "move",
        });
        showToast(label, 2200);

        if (m.to === "doing") {
          speak("kanban-pickup", `Mine! ${SHORT(m.card.title, 24)}`, 3000);
          // light up matching worker bubble if assignee
        } else if (m.to === "done") {
          speak("kanban-pickup", "Shipped ✓", 2200);
        } else if (m.from === "backlog" && m.to === "todo") {
          speak("groom-board", "Promoted!", 2200);
        }

        await animateMove(m.slug, m.from, m.to, m.reason);
      })
    );
    i += parallel;
  }
}

function trimDoneVisual(max) {
  const slot = slots.done;
  const cards = [...slot.querySelectorAll(".card")];
  // Keep first max (newest if we prepend — we append, so keep last max)
  if (cards.length <= max) return;
  const remove = cards.slice(0, cards.length - max);
  for (const el of remove) {
    // keep in map but hide extras? Better: keep data, only hide DOM overflow with a counter
    el.style.display = "none";
  }
  // show a remainder chip
  let more = slot.querySelector(".empty-lane.more");
  const hidden = remove.length;
  if (hidden > 0) {
    if (!more) {
      more = document.createElement("div");
      more.className = "empty-lane more";
      slot.prepend(more);
    }
    more.innerHTML = `<span class="big">📚</span>+${hidden + (cards.length - max > hidden ? 0 : 0)} older done cards still tracked`;
    // recount hidden
    const reallyHidden = [...slot.querySelectorAll(".card")].filter(
      (c) => c.style.display === "none"
    ).length;
    more.innerHTML = `<span class="big">📚</span>+${reallyHidden} older victories tucked away`;
  }
}

function processEvents(events) {
  // newest first from server
  for (const e of [...events].reverse()) {
    const key = `${e.routine}|${e.at}|${e.detail}`;
    if (knownEventKeys.has(key)) continue;
    knownEventKeys.add(key);
    // skip flooding on first paint — seed set silently
    if (processEvents.seeding) continue;

    const r = routineMap.get(e.routine);
    const emoji = r?.emoji || "⚙️";
    const status = e.status || "ok";
    pushFeed({
      emoji,
      who: r?.name || e.routine,
      what: `${status} ${e.detail || ""}`.trim(),
      when: e.at ? formatWhen(e.at) : "",
      kind: status === "error" || status === "fail" ? "" : "",
    });

    if (status === "error" || status === "fail" || status === "red") {
      Sound.error();
      speak(e.routine, "Ow!", 2000);
    } else if (/cards=\d|worked=|merged|promoted|filed/i.test(e.detail || "")) {
      speak(e.routine, speechFromDetail(e), 2800);
    } else if (/noop|idle/i.test(e.detail || "")) {
      // quiet
    } else {
      speak(e.routine, "…", 1200);
    }
  }
  // cap known keys
  if (knownEventKeys.size > 300) {
    knownEventKeys = new Set([...knownEventKeys].slice(-150));
  }
}
processEvents.seeding = true;

function speechFromDetail(e) {
  const d = e.detail || "";
  const worked = d.match(/worked=([^\s]+)/);
  if (worked) return `Working ${SHORT(worked[1], 18)}`;
  if (/merged/i.test(d)) return "Merged!";
  if (/promoted/i.test(d)) return "Promoted!";
  if (/filed/i.test(d)) return "Filed a card";
  if (/noop|idle/i.test(d)) return "Idle…";
  return SHORT(d, 22) || "On it";
}

function formatWhen(iso) {
  try {
    const d = new Date(iso);
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    return d.toLocaleTimeString();
  } catch {
    return iso;
  }
}

/**
 * When a card entered its current column. fkanban sets `position` to Date.now()
 * on move/claim, so for doing cards that's "actively working since".
 * Falls back to updated_at if position isn't a plausible epoch-ms.
 */
function workingSinceMs(c) {
  if (!c) return null;
  const pos = Number(c.position);
  // ~2001-04 … ~2286-11 in ms
  if (Number.isFinite(pos) && pos > 1e12 && pos < 1e13) return pos;
  if (c.updated_at) {
    const t = Date.parse(c.updated_at);
    if (Number.isFinite(t)) return t;
  }
  if (c.created_at) {
    const t = Date.parse(c.created_at);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Compact duration for badges: 45s · 12m · 1h 04m · 2d 3h */
function formatWorkAge(sinceMs, nowMs = Date.now()) {
  if (sinceMs == null || !Number.isFinite(sinceMs)) return null;
  let sec = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const remM = min % 60;
  if (h < 48) return remM ? `${h}h ${String(remM).padStart(2, "0")}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

/** Age band for styling: ok | warn (≥30m) | stuck (≥60m). */
function workAgeBand(sinceMs, nowMs = Date.now()) {
  if (sinceMs == null) return "ok";
  const min = (nowMs - sinceMs) / 60000;
  if (min >= 60) return "stuck";
  if (min >= 30) return "warn";
  return "ok";
}

/**
 * When a card entered its current column — works for every column, same
 * position-is-move-time trick as workingSinceMs. Done cards prefer a real
 * done_at when the board recorded one.
 */
function columnEnteredMs(c) {
  if (!c) return null;
  if (c.column === "done" && c.done_at) {
    const t = Date.parse(c.done_at);
    if (Number.isFinite(t)) return t;
  }
  return workingSinceMs(c);
}

/** Badge class/text/title for a card's column-entry age. */
function ageBadgeInfo(c, since, nowMs = Date.now()) {
  const age = formatWorkAge(since, nowMs);
  if (!age) return null;
  const when = new Date(since).toLocaleString();
  switch (c.column) {
    case "doing": {
      const band = workAgeBand(since, nowMs);
      return {
        cls: `badge age age-${band}`,
        text: age,
        title:
          band === "stuck"
            ? `Actively working ${age} (since ${when}) — stuck? consider requeue`
            : band === "warn"
              ? `Actively working ${age} (since ${when}) — getting long`
              : `Actively working ${age} (since ${when})`,
      };
    }
    case "backlog":
      return {
        cls: "badge age age-backlog",
        text: age,
        title: `In backlog ${age} (since ${when})`,
      };
    case "todo":
      return {
        cls: "badge age age-todo",
        text: age,
        title: `Queued ${age} (in todo since ${when})`,
      };
    case "done":
      return {
        cls: "badge age age-done",
        text: `✓ ${age}`,
        title: `Completed ${when} (${age} ago)`,
      };
    default:
      return {
        cls: "badge age",
        text: age,
        title: `In ${c.column} ${age} (since ${when})`,
      };
  }
}

function fillCardMeta(meta, c) {
  meta.innerHTML = "";
  if (c.priority) {
    const b = document.createElement("span");
    b.className = `badge pri ${priorityClass(c.priority)}`;
    b.textContent = c.priority;
    meta.appendChild(b);
  }
  if (c.kind) {
    const b = document.createElement("span");
    b.className = "badge kind";
    b.textContent = c.kind;
    meta.appendChild(b);
  }
  if (c.repo) {
    const b = document.createElement("span");
    b.className = "badge repo";
    b.textContent = c.repo.replace(/^EdgeVector\//, "");
    meta.appendChild(b);
  }
  if (c.assignee && c.column === "doing") {
    const b = document.createElement("span");
    b.className = "badge worker";
    b.textContent = shortWorker(c.assignee);
    meta.appendChild(b);
  }
  {
    const since = columnEnteredMs(c);
    const info = since != null ? ageBadgeInfo(c, since) : null;
    if (info) {
      const b = document.createElement("span");
      b.className = info.cls;
      b.dataset.since = String(since);
      b.textContent = info.text;
      b.title = info.title;
      meta.appendChild(b);
    }
  }
  if (c.blocked) {
    const b = document.createElement("span");
    b.className = "badge block";
    b.textContent = "blocked";
    meta.appendChild(b);
  } else if (c.block_status && c.block_status !== "none") {
    const b = document.createElement("span");
    b.className = "badge block";
    b.textContent = c.block_status;
    meta.appendChild(b);
  }
}

/** Tick column-age badges on all cards without a full re-render. */
function refreshCardAges() {
  const now = Date.now();
  for (const [slug, el] of cardEls) {
    const c = cardMap.get(slug);
    if (!c) continue;
    const badge = el.querySelector(".badge.age");
    const since = columnEnteredMs(c);
    const info = since != null ? ageBadgeInfo(c, since, now) : null;
    if (badge && info) {
      badge.textContent = info.text;
      badge.className = info.cls;
      badge.dataset.since = String(since);
      badge.title = info.title;
    }
    if (c.column === "doing") {
      const band = workAgeBand(since, now);
      el.classList.toggle("age-warn", band === "warn");
      el.classList.toggle("age-stuck", band === "stuck");
    } else {
      el.classList.remove("age-warn", "age-stuck");
    }
  }
}

// ─── Demo parade (uses real cards, fake fly for fun) ────────────────────────
async function parade() {
  Sound.parade();
  showToast("✨ Parade mode — replaying the pipeline with your real cards");
  const cards = [...cardMap.values()];
  if (!cards.length) return;

  // Find one card per column if possible
  const sample =
    cards.find((c) => c.column === "doing") ||
    cards.find((c) => c.column === "todo") ||
    cards.find((c) => c.column === "backlog") ||
    cards[0];

  const el = cardEls.get(sample.slug);
  if (!el) return;
  const start = rectCenter(el);
  Fx.burst(start.x, start.y, "#a78bfa", 24);
  Fx.celebrate(start.x, start.y, true);
  speak("kanban-pickup", "Showtime!", 2000);
  speak("pipeline-health", "Looking healthy", 2500);
  speak("groom-board", "All tidy", 2500);
  pushTicker("✨ PARADE · real cards, fake hops", "pickup");

  // Visual hop in place for a few cards
  const hoppers = cards.filter((c) => c.column === "doing").slice(0, 4);
  for (const c of hoppers) {
    const node = cardEls.get(c.slug);
    if (!node || animating.has(c.slug)) continue;
    animating.add(c.slug);
    const r = node.getBoundingClientRect();
    node.classList.add("flying");
    node.style.width = r.width + "px";
    node.style.left = r.left + "px";
    node.style.top = r.top + "px";
    document.body.appendChild(node);
    Sound.pickup();
    await new Promise((res) => {
      const t0 = performance.now();
      let lastTrail = 0;
      const step = (now) => {
        const t = Math.min(1, (now - t0) / 500);
        const e = Math.sin(Math.PI * t);
        const y = r.top - e * 30;
        node.style.top = y + "px";
        node.style.transform = `scale(${1 + e * 0.06}) rotate(${e * 3}deg)`;
        if (now - lastTrail > 30) {
          Fx.trail(r.left + r.width / 2, y + r.height / 2, "#fb923c");
          lastTrail = now;
        }
        if (t < 1) requestAnimationFrame(step);
        else {
          node.classList.remove("flying");
          node.style.width = node.style.left = node.style.top = node.style.transform = "";
          slots.doing.prepend(node);
          animating.delete(c.slug);
          Fx.burst(r.left + r.width / 2, r.top, "#fb923c", 10);
          Fx.ring(r.left + r.width / 2, r.top, "#fb923c");
          res();
        }
      };
      requestAnimationFrame(step);
    });
  }
  // Finale: fake stamp (does not count as a real ship)
  showStamp();
  screenShake();
  showToast("That's the real board — watch LIVE for actual moves", 3500);
}

// ─── Poll loop ──────────────────────────────────────────────────────────────
let polling = false;
let firstPoll = true;

async function poll() {
  if (polling) return; // single-flight — never stack /api/state
  polling = true;
  try {
    // First load: wait for a real snapshot. Later: stale-while-revalidate cache.
    const url = firstPoll ? "/api/state?wait=1" : "/api/state";
    const detail = document.getElementById("boot-detail");
    if (firstPoll && detail) detail.textContent = "Pulling live board + heartbeats…";
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    await applyState(data);
    firstPoll = false;
    if (boot && !boot.classList.contains("hide")) {
      boot.classList.add("hide");
      setTimeout(() => boot.remove(), 450);
      // seed events without animating historical flood
      processEvents.seeding = false;
      // friendly intro
      const doing = data.summary?.counts?.doing || 0;
      const hands = (data.workers || []).filter((w) => w.status === "working" || (w.load || 0) > 0)
        .length;
      showToast(
        doing
          ? `Factory online — ${doing} in flight · ${hands} hand${hands === 1 ? "" : "s"}`
          : "Factory online — floor is quiet, watching for moves",
        3200
      );
      if (doing) speak("kanban-pickup", `${doing} on the bench`, 3000);
    }
  } catch (e) {
    liveDot.textContent = "ERR";
    liveDot.className = "live err";
    liveDot.title = String(e);
    if (boot && !boot.classList.contains("hide")) {
      boot.querySelector("p").textContent = "Can't reach the factory server";
      const muted = boot.querySelector(".muted");
      if (muted) muted.textContent = String(e);
    }
  } finally {
    polling = false;
  }
}

// Controls
document.getElementById("btn-sound").addEventListener("click", (e) => {
  Sound.unlock();
  Sound.enabled = !Sound.enabled;
  e.currentTarget.textContent = Sound.enabled ? "🔊 Sound" : "🔇 Muted";
  e.currentTarget.classList.toggle("off", !Sound.enabled);
  if (!Sound.enabled) Sound.hum.stop();
  if (Sound.enabled) Sound.pickup();
});
document.getElementById("btn-ambient")?.addEventListener("click", (e) => {
  Sound.unlock();
  if (Sound.hum.on) {
    Sound.hum.stop();
    e.currentTarget.classList.add("off");
    e.currentTarget.textContent = "🎵 Hum";
  } else {
    Sound.enabled = true;
    document.getElementById("btn-sound").textContent = "🔊 Sound";
    document.getElementById("btn-sound").classList.remove("off");
    Sound.hum.start();
    e.currentTarget.classList.remove("off");
    e.currentTarget.textContent = "🎵 Hum on";
    showToast("Factory hum on — soft sub-bass", 1800);
  }
});
document.getElementById("btn-demo").addEventListener("click", () => {
  Sound.unlock();
  parade();
});
document.getElementById("btn-theater")?.addEventListener("click", () => {
  document.body.classList.toggle("theater-mode");
  const on = document.body.classList.contains("theater-mode");
  document.getElementById("btn-theater").textContent = on ? "🎬 Exit" : "🎬 Theater";
  showToast(on ? "Theater mode — pipeline takes the stage" : "Back to full floor", 1800);
});

// ─── LastDB version panel ───────────────────────────────────────────────────
function shortVer(v) {
  if (!v) return "–";
  // Prefer semver-ish head: 0.22.10-canary.… → 0.22.10-canary
  const m = String(v).match(/^(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/i);
  if (m) return m[1].replace(/\.\d{8}$/, "");
  return String(v).slice(0, 22);
}

function renderLastdbVersion(snap) {
  const chipVer = document.getElementById("lastdb-chip-ver");
  const btn = document.getElementById("btn-lastdb-version");
  if (!snap || !snap.running) {
    if (chipVer) chipVer.textContent = "…";
    if (btn) btn.title = "LastDB version unavailable";
    return;
  }
  const r = snap.running;
  const verLabel = shortVer(r.version);
  const sha = r.sha ? r.sha.slice(0, 9) : "";
  if (chipVer) chipVer.textContent = sha ? `${verLabel} · ${sha}` : verLabel;
  if (btn) {
    btn.title = [
      r.version || "",
      sha ? `sha ${sha}` : "",
      r.venue ? `venue ${r.venue}` : "",
      snap.aheadOfRunning?.count != null
        ? `${snap.aheadOfRunning.count} commits on fold tip not in binary`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    btn.classList.toggle("warn", (snap.aheadOfRunning?.count || 0) > 0);
    btn.classList.toggle("canary", /canary/i.test(r.version || ""));
  }

  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text || "–";
  };
  set("lastdb-daemon", r.daemon?.version || r.version || "–");
  set("lastdb-cli", r.cli?.version || "–");
  set("lastdb-sha", r.sha || "–");
  set(
    "lastdb-venue",
    [r.venue, r.dirty ? "dirty" : "", r.pid ? `pid ${r.pid}` : ""].filter(Boolean).join(" · ")
  );
  set("lastdb-uptime", r.uptime || "–");
  set("lastdb-path", r.path || "–");

  const gap = snap.aheadOfRunning || {};
  set("lastdb-gap-summary", gap.note || "–");
  set(
    "lastdb-main-ref",
    snap.main?.label
      ? `tip ${snap.main.label}${snap.foldCheckout ? ` · ${snap.foldCheckout}` : ""}`
      : snap.foldExists === false
        ? `no fold checkout (${snap.foldCheckout || "?"})`
        : "–"
  );

  const fillCommits = (ulId, commits) => {
    const ul = document.getElementById(ulId);
    if (!ul) return;
    ul.innerHTML = "";
    for (const c of commits || []) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="mono">${escapeHtml(c.sha || "")}</span> ${escapeHtml(c.subject || "")}`;
      ul.appendChild(li);
    }
    if (!(commits || []).length && ulId === "lastdb-commits-ahead") {
      const li = document.createElement("li");
      li.className = "dim";
      li.textContent = gap.count === 0 ? "You're current with fold tip." : "No commit lines.";
      ul.appendChild(li);
    }
  };
  fillCommits("lastdb-commits-ahead", gap.commits);

  const canary = snap.runningAheadOfMain || {};
  const canaryNote = document.getElementById("lastdb-canary-note");
  if (canaryNote) {
    if (canary.count > 0) {
      canaryNote.hidden = false;
      canaryNote.textContent = canary.note || `${canary.count} canary-only commit(s)`;
    } else {
      canaryNote.hidden = true;
      canaryNote.textContent = "";
    }
  }
  fillCommits("lastdb-commits-canary", canary.count > 0 ? canary.commits : []);

  const relUl = document.getElementById("lastdb-releases");
  if (relUl) {
    relUl.innerHTML = "";
    for (const rel of snap.releases || []) {
      const li = document.createElement("li");
      const badge =
        rel.isRunning || (rel.inRunning && rel.name && (r.version || "").includes(rel.name.replace(/^v/, "")))
          ? "running"
          : rel.inRunning
            ? "in-binary"
            : "not-in";
      li.innerHTML = `<span class="badge ${badge}">${badge === "running" ? "YOU" : badge === "in-binary" ? "in" : "—"}</span>
        <span class="mono">${escapeHtml(rel.name || "")}</span>
        <span class="dim">${escapeHtml(rel.date || "")}</span>
        <span class="mono dim">${escapeHtml((rel.sha || "").slice(0, 9))}</span>`;
      relUl.appendChild(li);
    }
    if (!(snap.releases || []).length) {
      const li = document.createElement("li");
      li.className = "dim";
      li.textContent = "No local tags found";
      relUl.appendChild(li);
    }
  }

  const trailUl = document.getElementById("lastdb-trail");
  if (trailUl) {
    trailUl.innerHTML = "";
    for (const t of snap.upgradeTrail || []) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="mono">${escapeHtml(t.label || t.file || "")}</span>
        <span class="dim">${escapeHtml(t.at || "")}</span>`;
      trailUl.appendChild(li);
    }
    if (!(snap.upgradeTrail || []).length) {
      const li = document.createElement("li");
      li.className = "dim";
      li.textContent = "No bak-pre trail next to binary";
      trailUl.appendChild(li);
    }
  }
}

function setLastdbPanelOpen(open) {
  const panel = document.getElementById("lastdb-panel");
  const btn = document.getElementById("btn-lastdb-version");
  if (!panel) return;
  panel.hidden = !open;
  panel.classList.toggle("collapsed", !open);
  btn?.classList.toggle("active", open);
}

document.getElementById("btn-lastdb-version")?.addEventListener("click", () => {
  const panel = document.getElementById("lastdb-panel");
  // hidden attribute: if currently hidden, open; if visible, close
  const willOpen = panel ? panel.hidden : true;
  setLastdbPanelOpen(willOpen);
  if (willOpen) {
    fetch("/api/lastdb-version?refresh=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((snap) => renderLastdbVersion(snap))
      .catch(() => {});
  }
});
document.getElementById("btn-lastdb-close")?.addEventListener("click", () => {
  setLastdbPanelOpen(false);
});

// ── Routines fleet mode (normal / low-credit) ─────────────────────────────
let fleetModeApplying = false;

function renderFleetMode(profile) {
  const chipVer = document.getElementById("fleet-mode-ver");
  const btn = document.getElementById("btn-fleet-mode");
  const liveEl = document.getElementById("fleet-mode-live");
  const listEl = document.getElementById("fleet-mode-list");
  if (!profile || profile.ok === false) {
    if (chipVer) chipVer.textContent = "—";
    btn?.classList.remove("mode-low", "mode-normal");
    if (liveEl) liveEl.textContent = profile?.error || "profile unavailable";
    return;
  }
  const mode = profile.mode || profile.active || "unknown";
  const live = profile.live || {};
  if (chipVer) {
    chipVer.textContent =
      live.active != null ? `${mode} · ${live.active} on` : String(mode);
  }
  btn?.classList.toggle("mode-low", String(mode).includes("low-credit"));
  btn?.classList.toggle("mode-normal", mode === "normal");
  btn?.setAttribute(
    "title",
    `Routines fleet mode: ${mode} (${live.active ?? "?"} active / ${live.paused ?? "?"} paused). Click to switch (M).`
  );
  if (liveEl) {
    liveEl.textContent = `marker=${profile.active || "—"} · live registry active=${live.active ?? "?"} paused=${live.paused ?? "?"} total=${live.total ?? "?"}`;
  }
  if (!listEl) return;
  const profiles = profile.profiles || [];
  listEl.innerHTML = "";
  if (!profiles.length) {
    listEl.innerHTML = `<p class="dim">No profiles under ~/.routines/profiles</p>`;
    return;
  }
  for (const p of profiles) {
    const card = document.createElement("button");
    card.type = "button";
    card.className =
      "fleet-mode-card" +
      (p.isActive || p.id === profile.active ? " current" : "") +
      (p.id === "low-credit" ? " low-credit" : "");
    card.disabled = fleetModeApplying;
    const action =
      p.isActive || p.id === profile.active
        ? "Current mode"
        : p.id === "low-credit"
          ? "Switch → ship-only"
          : p.id === "normal"
            ? "Switch → full fleet"
            : `Apply ${p.id}`;
    card.innerHTML = `
      <div class="fm-id">${escapeHtml(p.id)}</div>
      <div class="fm-title">${escapeHtml(p.title || p.id)}</div>
      <div class="fm-counts">${p.activeCount ?? "?"} active · ${p.pausedCount ?? "?"} paused</div>
      <div class="fm-desc">${escapeHtml(p.description || "")}</div>
      <div class="fm-action">${escapeHtml(action)}</div>`;
    card.addEventListener("click", () => {
      if (p.isActive || p.id === profile.active) return;
      applyFleetMode(p.id);
    });
    listEl.appendChild(card);
  }
}

function setFleetModePanelOpen(open) {
  const panel = document.getElementById("fleet-mode-panel");
  const btn = document.getElementById("btn-fleet-mode");
  if (!panel) return;
  panel.hidden = !open;
  panel.classList.toggle("collapsed", !open);
  btn?.classList.toggle("active", open);
  if (open) setLastdbPanelOpen(false);
}

async function applyFleetMode(name) {
  const msg = document.getElementById("fleet-mode-msg");
  if (fleetModeApplying) return;
  if (
    !window.confirm(
      `Switch routines fleet to "${name}"?\n\nThis pauses/resumes scheduled routines via routines-profile apply.`
    )
  ) {
    return;
  }
  fleetModeApplying = true;
  if (msg) msg.textContent = `Applying ${name}…`;
  try {
    const res = await fetch("/api/routines-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: name }),
    });
    const data = await res.json();
    if (msg) {
      msg.textContent = data.ok
        ? `Applied ${name}` +
          (data.profile?.live ? ` · ${data.profile.live.active} active` : "")
        : `Failed: ${data.error || res.status}`;
    }
    if (data.profile) renderFleetMode(data.profile);
  } catch (e) {
    if (msg) msg.textContent = `Failed: ${e.message || e}`;
  } finally {
    fleetModeApplying = false;
    fetch("/api/routines-profile", { cache: "no-store" })
      .then((r) => r.json())
      .then((p) => renderFleetMode(p))
      .catch(() => {});
  }
}

document.getElementById("btn-fleet-mode")?.addEventListener("click", () => {
  const panel = document.getElementById("fleet-mode-panel");
  const willOpen = panel ? panel.hidden : true;
  setFleetModePanelOpen(willOpen);
  if (willOpen) {
    fetch("/api/routines-profile", { cache: "no-store" })
      .then((r) => r.json())
      .then((p) => renderFleetMode(p))
      .catch(() => {});
  }
});
document.getElementById("btn-fleet-mode-close")?.addEventListener("click", () => {
  setFleetModePanelOpen(false);
});

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, [contenteditable]")) return;
  const k = e.key.toLowerCase();
  if (k === "s") document.getElementById("btn-sound")?.click();
  if (k === "v") document.getElementById("btn-lastdb-version")?.click();
  if (k === "m") document.getElementById("btn-fleet-mode")?.click();
  if (k === "p") document.getElementById("btn-demo")?.click();
  if (k === "f") document.getElementById("btn-theater")?.click();
  if (k === "h") document.getElementById("btn-ambient")?.click();
});

// Unlock audio on first gesture
window.addEventListener(
  "pointerdown",
  () => {
    Sound.unlock();
  },
  { once: true }
);

// Idle ambient: soft bob is CSS; occasionally speak idle workers
setInterval(() => {
  const idle = [...routineMap.values()].filter((r) => r.mood === "idle");
  if (!idle.length || Math.random() > 0.35) return;
  const r = idle[Math.floor(Math.random() * idle.length)];
  const lines = {
    "kanban-pickup": ["Queue empty…", "Waiting…", "Hungry."],
    "pipeline-health": ["Listening…", "All clear?", "Scanning."],
    "groom-board": ["Dusting…", "Aligning cards…", "Hmm."],
    "kanban-watch": ["…", "Still watching.", "Hoot."],
    "kanban-validate": ["Stamps ready.", "Audit mode."],
    "program-driver": ["Next slice?", "Clipboard ready."],
    "north-star-rollup": ["Counting stars…", "Map steady."],
    "routine-fleet-health": ["Vitals ok.", "Pulse check."],
    "llms-txt-install-smoke": ["Lighter ready.", "Fresh install?"],
    "dogfood-rotate": ["Sniff sniff.", "What's next?"],
    "worktree-cleanup": ["Trash day?", "Reclaiming…"],
  };
  const opts = lines[r.id] || ["…"];
  speak(r.id, opts[Math.floor(Math.random() * opts.length)], 2000);
}, 12000);

// Shift clock + momentum re-score (session-move window decays)
updateShift();
updateSessionHud();
setInterval(updateShift, 60_000);
setInterval(() => refreshMomentum(), 15_000);
// Live "how long in doing" badges (doesn't wait for board poll)
setInterval(refreshCardAges, 15_000);

// Hide kbd hint after a while
setTimeout(() => {
  const h = document.getElementById("kbd-hint");
  if (h) h.style.opacity = "0";
}, 20_000);

poll();
setInterval(poll, POLL_MS);
