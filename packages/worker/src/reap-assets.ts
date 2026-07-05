// Orphan-image sweep logic (SEC-R2). Uploaded images live in R2, content-addressed + deduped across
// rooms; the only reference to a key is the `src` of an `image` object in a room's Yjs doc. When a room
// is reaped (or its images deleted) the R2 bytes are orphaned. A periodic cron (worker `scheduled()`)
// unions every live room's referenced keys — read from the KV room index that each Board DO maintains
// on save — and deletes R2 objects referenced by NO room and older than a grace window.
//
// This deletes user data, so the pure decision logic lives here, isolated + unit-tested, and the
// caller layers on hard aborts (empty/unreadable index, circuit breaker).

import { objectsMap, readObject } from "@komuboard/shared";
import type * as Y from "yjs";

/** R2 object as far as the sweep cares: its key + upload time (ms epoch). */
export interface R2ObjectInfo {
  key: string;
  uploaded: number;
}

/** Never touch an object younger than this — a freshly-uploaded image may not be in any *saved* doc
 *  yet (save is debounced), and KV is eventually consistent; the window dwarfs both. */
export const ASSET_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** The R2 keys referenced by a room's doc — the `src` of each `image` object (bare content-hash key,
 *  the exact string stored in R2). Stamps carry `mark:`/`emoji:` srcs and are correctly ignored. */
export function collectImageKeys(doc: Y.Doc): string[] {
  const keys: string[] = [];
  for (const m of objectsMap(doc).values()) {
    const o = readObject(m);
    if (o?.type === "image" && o.src) keys.push(o.src);
  }
  return keys;
}

/** Keys safe to delete: referenced by no live room AND older than the grace window. */
export function keysToSweep(
  referenced: ReadonlySet<string>,
  objects: readonly R2ObjectInfo[],
  now: number,
  graceMs: number = ASSET_GRACE_MS,
): string[] {
  return objects
    .filter((o) => !referenced.has(o.key) && now - o.uploaded > graceMs)
    .map((o) => o.key);
}

/** Circuit breaker: refuse to delete more than `maxFraction` of all objects in one run, so a
 *  corrupt/empty index can't wipe the bucket. Conservative by design — a legitimate sweep that
 *  trips it aborts + logs rather than mass-deleting (raise the threshold or sweep manually). */
export function sweepIsSafe(deleteCount: number, totalCount: number, maxFraction = 0.5): boolean {
  if (totalCount === 0) return true;
  return deleteCount / totalCount <= maxFraction;
}
