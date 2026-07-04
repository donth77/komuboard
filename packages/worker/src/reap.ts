// Inactivity-reap policy for a room's Durable Object (see board.ts). Kept pure + dependency-free so
// it's unit-testable without a DO storage harness — the alarm plumbing itself (setAlarm/getAlarm/
// deleteAll/getConnections) is integration territory for the workers vitest pool (docs/09 T1).

/** A room with no connections or saves for this long has its persisted snapshot reaped. */
export const REAP_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
/** Don't rewrite the alarm on every debounced save — only when it's more than this stale. Keeps the
 *  effective TTL within a day of exact while avoiding a storage write every few seconds of editing. */
export const REAP_REFRESH_SLOP_MS = 24 * 60 * 60 * 1000; // 1 day

/** Whether to (re)arm the reap alarm to `now + REAP_TTL_MS`: true when nothing is scheduled, or the
 *  existing alarm is more than the slop stale (so a room in continuous use resets its TTL cheaply). */
export function shouldRearmReap(currentAlarm: number | null, now: number): boolean {
  return currentAlarm === null || currentAlarm < now + REAP_TTL_MS - REAP_REFRESH_SLOP_MS;
}
