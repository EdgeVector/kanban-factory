/**
 * Merge-derived ship meter.
 *
 * The board-derived velocity (see computeVelocity in server.mjs) counts cards
 * still on the board in column "done". last-stack-card-reaper deletes done
 * cards on a ~6h cycle, so that series decays toward zero as a night passes
 * even though merges kept landing. This module counts merges instead: a ship
 * is a change whose merge commit is an ancestor of its repo's canonical base
 * tip, read from LastGit CRs (fleet fan-out) and Forgejo-venue PRs (fold,
 * lastgit). It never reads kanban cards, so a card being reaped, renamed, or
 * never having existed (dead-code-reaper commits, non-kanban branches) cannot
 * change the count.
 */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";

export const HOUR_MS = 3600_000;

/** Repos served by a local Forgejo instance rather than LastGit. */
export const FORGEJO_REPOS = new Set(["fold", "lastgit"]);

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      resolve({ ok: false, out, err: err || "timeout", code: -1 });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
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

function mirrorPath(home, repo) {
  return path.join(home, ".cache", "edgevector-git", `${repo}.git`);
}

/** True only when the mirror actually holds the object — never fetches. */
export function gitHasObject(mirror, oid) {
  if (!oid) return false;
  try {
    execFileSync("git", ["-C", mirror, "cat-file", "-e", oid], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

export function gitCommitterDateMs(mirror, oid) {
  try {
    const out = execFileSync("git", ["-C", mirror, "show", "-s", "--format=%cI", oid], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** true = ancestor, false = not an ancestor, null = the test itself failed (never "not landed"). */
export function gitIsAncestor(mirror, oid, tip) {
  try {
    execFileSync("git", ["-C", mirror, "merge-base", "--is-ancestor", oid, tip], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (e) {
    if (e && e.status === 1) return false;
    return null;
  }
}

/**
 * landed = merge_oid is an ancestor of the repo's canonical tip: it shipped.
 * unlanded = merged (both oids known) but NOT an ancestor: re-land churn or a
 *   lost merge — the ref-CAS defect papercut-lastgit-cr-records-unreachable-
 *   merge-oid-after-concurrent-main-move.
 * unknown = the mirror lacks one of the objects needed to test ancestry (never
 *   fetched here — collectShipMeter never pack-fetches). Never counted as
 *   landed.
 */
export function classifyLanded({ mergeOid, tipOid, hasObject, isAncestor }) {
  if (!mergeOid || !tipOid) return "unknown";
  if (!hasObject(mergeOid) || !hasObject(tipOid)) return "unknown";
  const anc = isAncestor(mergeOid, tipOid);
  if (anc === true) return "landed";
  if (anc === false) return "unlanded";
  return "unknown";
}

/**
 * Pure aggregation. Takes ONLY merge rows + per-repo read availability — no
 * kanban cards — so a card being reaped/renamed/never-created cannot change
 * the result, and calling this twice with the same rows (e.g. before/after a
 * reaper pass) is byte-identical by construction.
 *
 * mergeRows: [{ repo, mergeOid, mergeTsMs: number|null, landed: "landed"|"unlanded"|"unknown" }]
 * repoAvailability: { [repo]: boolean } — false means that repo's read failed
 *   this cycle (UNREADABLE / venue unreachable), not "read, zero merges".
 */
export function computeShipMeter({ mergeRows, repoAvailability, nowMs, hours = 24 }) {
  const availFlags = Object.values(repoAvailability);
  const anyRepoAvailable = availFlags.length === 0 || availFlags.some(Boolean);
  const anyRepoUnavailable = availFlags.some((v) => v === false);

  const windows = [
    { key: "h3", hours: 3 },
    { key: "h12", hours: 12 },
    { key: "h24", hours: 24 },
  ];

  const windowStat = (winHours) => {
    if (!anyRepoAvailable) {
      return { count: null, perHour: null, unlanded: null, unknown: null, hours: winHours, available: false };
    }
    const cutoff = nowMs - winHours * HOUR_MS;
    let count = 0;
    let unlanded = 0;
    let unknown = 0;
    for (const row of mergeRows) {
      if (repoAvailability[row.repo] === false) continue;
      if (row.mergeTsMs == null || row.mergeTsMs < cutoff) continue;
      if (row.landed === "landed") count++;
      else if (row.landed === "unlanded") unlanded++;
      else unknown++;
    }
    return {
      count,
      perHour: Math.round((count / winHours) * 100) / 100,
      unlanded,
      unknown,
      hours: winHours,
      available: !anyRepoUnavailable,
    };
  };

  const ships = {};
  for (const w of windows) ships[w.key] = windowStat(w.hours);

  const hourly = [];
  for (let i = hours - 1; i >= 0; i--) {
    const start = nowMs - (i + 1) * HOUR_MS;
    const end = nowMs - i * HOUR_MS;
    let count = 0;
    let unlanded = 0;
    let unknown = 0;
    for (const row of mergeRows) {
      if (repoAvailability[row.repo] === false) continue;
      if (row.mergeTsMs == null) continue;
      if (row.mergeTsMs >= start && row.mergeTsMs < end) {
        if (row.landed === "landed") count++;
        else if (row.landed === "unlanded") unlanded++;
        else unknown++;
      }
    }
    const d = new Date(end);
    hourly.push({
      hourAgo: i,
      label: `${String(d.getHours()).padStart(2, "0")}:00`,
      ships: anyRepoAvailable ? count : null,
      unlanded: anyRepoAvailable ? unlanded : null,
      unknown: anyRepoAvailable ? unknown : null,
      available: anyRepoAvailable && !anyRepoUnavailable,
    });
  }

  let peak = { ships: 0, label: "—" };
  for (const b of hourly) {
    if ((b.ships || 0) > peak.ships) peak = { ships: b.ships, label: b.label };
  }

  return {
    ships,
    hourly,
    peakHour: peak,
    available: !anyRepoUnavailable,
    unavailableRepos: Object.entries(repoAvailability)
      .filter(([, ok]) => ok === false)
      .map(([r]) => r),
    note:
      "Merge-derived: landed = merge_oid is an ancestor of the repo's canonical base tip (a real ship). " +
      "unlanded = merged but not on tip (re-land churn / a lost merge). unknown = local mirror lacks an " +
      "object needed to test ancestry — never counted as landed. A repo whose read failed renders its " +
      "contribution unavailable, never a silent 0.",
  };
}

async function resolveCanonicalTip(repo, { lastgitBin, forgeApiBin }) {
  if (FORGEJO_REPOS.has(repo)) {
    const res = await run(forgeApiBin, [`repos/EdgeVector/${repo}/branches/main`], 15000);
    if (!res.ok) return null;
    try {
      return JSON.parse(res.out)?.commit?.id || null;
    } catch {
      return null;
    }
  }
  const res = await run(lastgitBin, ["ref", repo, "main", "--json"], 15000);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.out)?.oid || null;
  } catch {
    return null;
  }
}

async function collectForgejoRows(repo, sinceMs, { forgeApiBin }) {
  const res = await run(
    forgeApiBin,
    [`repos/EdgeVector/${repo}/pulls?state=closed&limit=50&sort=recentupdate&type=pulls`],
    20000,
  );
  if (!res.ok) return { rows: null, available: false };
  let prs;
  try {
    prs = JSON.parse(res.out);
  } catch {
    return { rows: null, available: false };
  }
  const rows = [];
  for (const pr of prs || []) {
    if (!pr.merged || !pr.merge_commit_sha || !pr.merged_at) continue;
    const ts = Date.parse(pr.merged_at);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    rows.push({ repo, mergeOid: pr.merge_commit_sha, crId: `pr-${pr.number}`, mergeTsMs: ts });
  }
  return { rows, available: true };
}

function parseUnreadableRepos(stderrText) {
  const set = new Set();
  for (const line of String(stderrText || "").split("\n")) {
    const m = line.match(/^UNREADABLE\t(\S+)/);
    if (m) set.add(m[1]);
  }
  return set;
}

/**
 * Real IO: enumerate merges across every LastGit repo (one fleet fan-out
 * process, per lastgit's own guidance) plus the Forgejo-hosted repos, resolve
 * each merge's real time and landed/unlanded/unknown classification against
 * the LOCAL mirror only (never a pack fetch — a mirror gap renders "unknown"),
 * and return { rows, repoAvailability } for computeShipMeter.
 */
export async function collectShipMeter({
  home,
  sinceHours = 26,
  nowMs = Date.now(),
  lastgitBin = "lastgit",
  forgeApiBin = "last-stack-forge-api",
  forgejoRepos = FORGEJO_REPOS,
} = {}) {
  const sinceMs = nowMs - sinceHours * HOUR_MS;
  const repoAvailability = {};
  const rows = [];

  const lg = await run(
    lastgitBin,
    ["cr", "list", "--all-repos", "--state", "merged", "--since", `${sinceHours}h`, "--json"],
    45000,
  );
  let lgRows = [];
  try {
    lgRows = JSON.parse(lg.out || "[]");
  } catch {
    lgRows = [];
  }
  const unreadable = parseUnreadableRepos(lg.err);
  for (const r of lgRows) {
    if (repoAvailability[r.repo] === undefined) repoAvailability[r.repo] = true;
    if (!r.merge_oid) continue;
    rows.push({ repo: r.repo, mergeOid: r.merge_oid, crId: r.cr_id, mergeTsMs: null });
  }
  for (const repo of unreadable) repoAvailability[repo] = false;

  for (const repo of forgejoRepos) {
    const { rows: fRows, available } = await collectForgejoRows(repo, sinceMs, { forgeApiBin });
    repoAvailability[repo] = available;
    if (available) rows.push(...fRows);
  }

  const tipCache = new Map();
  const tipFor = async (repo) => {
    if (!tipCache.has(repo)) tipCache.set(repo, await resolveCanonicalTip(repo, { lastgitBin, forgeApiBin }));
    return tipCache.get(repo);
  };

  for (const row of rows) {
    const mirror = mirrorPath(home, row.repo);
    const hasObject = (oid) => gitHasObject(mirror, oid);
    if (row.mergeTsMs == null && hasObject(row.mergeOid)) {
      row.mergeTsMs = gitCommitterDateMs(mirror, row.mergeOid);
    }
    const tipOid = await tipFor(row.repo);
    row.landed = classifyLanded({
      mergeOid: row.mergeOid,
      tipOid,
      hasObject,
      isAncestor: (a, b) => gitIsAncestor(mirror, a, b),
    });
  }

  return { rows, repoAvailability };
}
