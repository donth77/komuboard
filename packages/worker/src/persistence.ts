import * as Y from "yjs";

/**
 * Yjs document persistence helpers, factored out of the Board Durable Object so the
 * save/load *logic* is unit-testable without the Workers runtime. Board owns the SQL
 * (read the BLOB, write `doc`/`doc_corrupt` rows); these functions own the encode/decode
 * and the corrupt-data policy.
 */

/**
 * Encode a Yjs document to a standalone ArrayBuffer for SQLite BLOB storage.
 *
 * `encodeStateAsUpdate` returns a Uint8Array that may be a *view* into a larger pooled
 * ArrayBuffer, so we slice to exactly its bytes — storing `update.buffer` directly could
 * persist unrelated trailing data and bloat (or corrupt) the saved state.
 */
export function encodeDocUpdate(doc: Y.Doc): ArrayBuffer {
  const update = Y.encodeStateAsUpdate(doc);
  return update.buffer.slice(
    update.byteOffset,
    update.byteOffset + update.byteLength,
  ) as ArrayBuffer;
}

export type LoadResult = "applied" | "empty" | "corrupt";

/**
 * Apply a stored doc BLOB onto `doc`. Never throws — returns a verdict the caller acts on:
 *  - `"empty"`   — nothing usable stored (no row, or an unexpected non-ArrayBuffer) → start fresh.
 *  - `"applied"` — the update decoded and applied cleanly.
 *  - `"corrupt"` — the BLOB threw while decoding; the caller should keep the doc empty and stash
 *                  the bytes for forensics, NOT rethrow (a bad save must not brick the room).
 */
export function loadStoredDoc(doc: Y.Doc, stored: unknown): LoadResult {
  if (!(stored instanceof ArrayBuffer)) return "empty";
  try {
    Y.applyUpdate(doc, new Uint8Array(stored));
    return "applied";
  } catch {
    return "corrupt";
  }
}
