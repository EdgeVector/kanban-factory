import test from "node:test";
import assert from "node:assert/strict";
import { shouldBackgroundRefresh } from "./poll-gate.mjs";

const NOW = Date.parse("2026-09-23T22:00:00.000Z");
const MIN = 60_000;
const base = { now: NOW, viewerIdleMs: 10 * MIN, idlePollMs: 10 * MIN };

test("an active viewer keeps the full poll cadence", () => {
  assert.equal(
    shouldBackgroundRefresh({ ...base, lastViewerAt: NOW - 2 * MIN, cacheAt: NOW - 1 * MIN }),
    true,
  );
});

test("no viewer and a fresh cache: skip the whole-board read", () => {
  assert.equal(shouldBackgroundRefresh({ ...base, lastViewerAt: null, cacheAt: NOW - 1 * MIN }), false);
  assert.equal(
    shouldBackgroundRefresh({ ...base, lastViewerAt: NOW - 30 * MIN, cacheAt: NOW - 9 * MIN }),
    false,
  );
});

test("no viewer: the cache is still refreshed once per idle interval", () => {
  assert.equal(
    shouldBackgroundRefresh({ ...base, lastViewerAt: NOW - 30 * MIN, cacheAt: NOW - 10 * MIN }),
    true,
  );
});

test("no cache yet: always refresh", () => {
  assert.equal(shouldBackgroundRefresh({ ...base, lastViewerAt: null, cacheAt: null }), true);
});

test("viewerIdleMs <= 0 disables the gate (old always-poll behavior)", () => {
  assert.equal(
    shouldBackgroundRefresh({ ...base, viewerIdleMs: 0, lastViewerAt: null, cacheAt: NOW }),
    true,
  );
});
