/**
 * Background board-poll gate.
 *
 * WHY: the server used to run `kanban list --json --all` every POLL_MS (60s)
 * whether or not anyone was looking. That command reads the WHOLE BoardCards
 * partition, including the append-only `done` archive. On 2026-09-23 the live
 * board held 268 cards (238 done) and each of these reads cost 7-13s of node
 * `hydrate_atoms` — the single largest BoardCards consumer observed in a
 * 15-minute ring sample of the local LastDB node. With no viewer, nobody reads
 * the result.
 *
 * The gate keeps the full POLL_MS cadence while a viewer is active (an
 * /api/state request within `viewerIdleMs`), and falls back to one refresh per
 * `idlePollMs` otherwise, so an hourly health probe still reads a cache that is
 * at most `idlePollMs` old. `viewerIdleMs <= 0` disables the gate (poll always,
 * the old behavior).
 */
export const DEFAULT_VIEWER_IDLE_MS = 10 * 60_000;
export const DEFAULT_IDLE_POLL_MS = 10 * 60_000;

export function shouldBackgroundRefresh({ now, lastViewerAt, cacheAt, viewerIdleMs, idlePollMs }) {
  if (!(viewerIdleMs > 0)) return true;
  if (lastViewerAt != null && now - lastViewerAt < viewerIdleMs) return true;
  if (!cacheAt) return true;
  return now - cacheAt >= idlePollMs;
}
