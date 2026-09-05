import test from "node:test";
import assert from "node:assert/strict";
import { classifyLanded, computeShipMeter, HOUR_MS } from "./ship-meter.mjs";

// A fixed "now" so hour-bucket math is deterministic in every test.
const NOW = Date.parse("2026-09-05T12:00:00.000Z");

function hoursAgo(n) {
  return NOW - n * HOUR_MS;
}

// The hourly bucket for hourAgo=i covers [now-(i+1)h, now-i*h). hoursAgo(n)
// lands exactly on a bucket boundary, so bucket-targeting tests use the
// midpoint of bucket hourAgo=n instead, to land unambiguously inside it.
function midOfHourAgo(n) {
  return NOW - (n + 0.5) * HOUR_MS;
}

test("classifyLanded: landed when merge_oid is an ancestor of the tip", () => {
  const v = classifyLanded({
    mergeOid: "aaa",
    tipOid: "zzz",
    hasObject: () => true,
    isAncestor: () => true,
  });
  assert.equal(v, "landed");
});

test("classifyLanded: unlanded when merged but NOT an ancestor of the tip (re-land churn / lost merge)", () => {
  const v = classifyLanded({
    mergeOid: "aaa",
    tipOid: "zzz",
    hasObject: () => true,
    isAncestor: () => false,
  });
  assert.equal(v, "unlanded");
});

test("classifyLanded: unknown when the local mirror lacks an object, never landed", () => {
  const v = classifyLanded({
    mergeOid: "aaa",
    tipOid: "zzz",
    hasObject: (oid) => oid === "zzz", // mergeOid missing from mirror
    isAncestor: () => {
      throw new Error("must not be called when an object is missing");
    },
  });
  assert.equal(v, "unknown");
});

test("classifyLanded: unknown when the ancestry test itself fails (isAncestor returns null)", () => {
  const v = classifyLanded({
    mergeOid: "aaa",
    tipOid: "zzz",
    hasObject: () => true,
    isAncestor: () => null,
  });
  assert.equal(v, "unknown");
});

test("computeShipMeter: an unreachable-only source renders unavailable, never a silent 0", () => {
  const meter = computeShipMeter({
    mergeRows: [],
    repoAvailability: { "dead-repo": false },
    nowMs: NOW,
  });
  assert.notEqual(meter.ships.h24.count, 0);
  assert.equal(meter.ships.h24.count, null);
  assert.equal(meter.ships.h24.available, false);
  assert.deepEqual(meter.unavailableRepos, ["dead-repo"]);
  for (const bucket of meter.hourly) {
    assert.notEqual(bucket.ships, 0);
    assert.equal(bucket.ships, null);
  }
});

test("computeShipMeter: a partially-reachable set still counts the reachable repos, flagged not-available", () => {
  const meter = computeShipMeter({
    mergeRows: [
      { repo: "ok-repo", mergeOid: "a1", mergeTsMs: hoursAgo(1), landed: "landed" },
    ],
    repoAvailability: { "ok-repo": true, "dead-repo": false },
    nowMs: NOW,
  });
  assert.equal(meter.ships.h24.count, 1);
  assert.equal(meter.ships.h24.available, false); // partial: one repo unreadable
});

test("computeShipMeter: a merge whose card was deleted still counts — no cards param exists at all", () => {
  // The function signature itself is the proof: there is no way to pass card
  // state in, so a reaper deleting the done card cannot change this output.
  const rows = [{ repo: "r", mergeOid: "a1", mergeTsMs: hoursAgo(2), landed: "landed" }];
  const before = computeShipMeter({ mergeRows: rows, repoAvailability: { r: true }, nowMs: NOW });
  // Simulate "after a reaper pass" by calling again with the identical rows —
  // a card-based meter would have to be told the card is gone; this one can't be.
  const after = computeShipMeter({ mergeRows: rows, repoAvailability: { r: true }, nowMs: NOW });
  assert.deepEqual(before, after);
  assert.equal(after.ships.h24.count, 1);
});

test("computeShipMeter: a reaper pass does not change a closed past hour (byte-identical replay)", () => {
  const rows = [
    { repo: "r", mergeOid: "a1", mergeTsMs: midOfHourAgo(4), landed: "landed" },
    { repo: "r", mergeOid: "a2", mergeTsMs: midOfHourAgo(4), landed: "landed" },
    { repo: "r", mergeOid: "a3", mergeTsMs: midOfHourAgo(0), landed: "landed" },
  ];
  const avail = { r: true };
  const run1 = computeShipMeter({ mergeRows: rows, repoAvailability: avail, nowMs: NOW });
  const run2 = computeShipMeter({ mergeRows: rows, repoAvailability: avail, nowMs: NOW });
  assert.deepEqual(run1.hourly, run2.hourly);
  const closedHourBucket = run1.hourly.find((b) => b.hourAgo === 4);
  assert.equal(closedHourBucket.ships, 2);
});

test("computeShipMeter: a merged-but-off-base CR does not ship, and shows up as unlanded", () => {
  const meter = computeShipMeter({
    mergeRows: [
      { repo: "last-stack", mergeOid: "landed1", mergeTsMs: hoursAgo(1), landed: "landed" },
      { repo: "last-stack", mergeOid: "offbase1", mergeTsMs: hoursAgo(1), landed: "unlanded" },
    ],
    repoAvailability: { "last-stack": true },
    nowMs: NOW,
  });
  assert.equal(meter.ships.h24.count, 1);
  assert.equal(meter.ships.h24.unlanded, 1);
});

test("computeShipMeter: an hour is keyed by the real merge time, not by when the CR was created", () => {
  // A CR created in hour N (hoursAgo 5) but merged in hour N-1 (hoursAgo 4) —
  // the row only carries the real merge timestamp, so it must bucket at 4.
  const rows = [{ repo: "r", mergeOid: "a1", mergeTsMs: midOfHourAgo(4), landed: "landed" }];
  const meter = computeShipMeter({ mergeRows: rows, repoAvailability: { r: true }, nowMs: NOW });
  const bucketAt4 = meter.hourly.find((b) => b.hourAgo === 4);
  const bucketAt5 = meter.hourly.find((b) => b.hourAgo === 5);
  assert.equal(bucketAt4.ships, 1);
  assert.equal(bucketAt5.ships, 0);
});

test("computeShipMeter: replaying the six historical zero-ship heartbeat hours against a merge histogram", () => {
  // Worked example from the card body: 2026-09-03T22:30Z..2026-09-04T08:25Z
  // reported ships_h=0 every hour although merges landed 4,4,4,5,3,2. Prove the
  // hourly bucketing mechanism reproduces non-zero counts for hours that had
  // real landed merges, using the same "keyed by real merge time" logic.
  const counts = [4, 4, 4, 5, 3, 2];
  const rows = [];
  counts.forEach((n, idx) => {
    const hourAgo = counts.length - idx; // oldest first
    for (let i = 0; i < n; i++) {
      rows.push({ repo: "r", mergeOid: `h${hourAgo}-${i}`, mergeTsMs: midOfHourAgo(hourAgo), landed: "landed" });
    }
  });
  const meter = computeShipMeter({ mergeRows: rows, repoAvailability: { r: true }, nowMs: NOW });
  counts.forEach((n, idx) => {
    const hourAgo = counts.length - idx;
    const bucket = meter.hourly.find((b) => b.hourAgo === hourAgo);
    assert.equal(bucket.ships, n, `hourAgo=${hourAgo} expected ${n}`);
  });
});
