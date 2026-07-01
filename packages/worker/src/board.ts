import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { encodeDocUpdate, loadStoredDoc } from "./persistence";
import { CLOSE_RATE_LIMIT, CLOSE_ROOM_FULL, ConnectionLimiter, overCapacity } from "./abuse-guard";

/**
 * Board — one Durable Object per room, hosting the room's single Yjs document
 * via Y-PartyServer. Hibernation-enabled. Each save writes the full *compacted*
 * doc state (encodeStateAsUpdate) over a single SQLite BLOB — there is no growing
 * update log to truncate — and the snapshot is also flushed the moment the room
 * empties (onClose), so a room survives eviction/redeploy without losing the last
 * edits to the autosave debounce window.
 */
/** Persisted-doc row ids in the `ydoc` table (bound as SQL params, never interpolated). */
const DOC_ROW_ID = "doc";
const CORRUPT_ROW_ID = "doc_corrupt";
/** Warn (observability only) when a persisted snapshot exceeds this — a signal to add compaction,
 *  not a hard limit. The snapshot is the full *compacted* state, so this flags a genuinely large
 *  board or tombstone build-up, not routine growth. */
const SAVE_WARN_BYTES = 2 * 1024 * 1024;

export class Board extends YServer {
  // WebSocket Hibernation: idle rooms stop accruing duration charges.
  static override options = { hibernate: true };

  // Debounced autosave: onSave() runs ~2s after edits settle, and at least every 5s during
  // continuous editing (the hard cap bounds how much a mid-draw DO death — e.g. a redeploy — can
  // lose; flush-on-empty in onClose covers the far more common idle-eviction path).
  static override callbackOptions = { debounceWait: 2000, debounceMaxWait: 5000 };

  // Per-connection inbound rate limiters. In-memory on purpose: a flood keeps the DO awake so the
  // bucket lives through the burst, and it's fine to discard on hibernation (which only happens once
  // the room is idle — i.e. nobody's flooding).
  readonly #limiters = new Map<string, ConnectionLimiter>();

  // Room-size cap. The newly-accepted socket is already in getConnections(), so a count past the cap
  // means this connection is the overflow — refuse it before the Yjs sync handshake runs.
  override onConnect(connection: Connection, ctx: ConnectionContext): void | Promise<void> {
    if (overCapacity([...this.getConnections()].length)) {
      connection.close(CLOSE_ROOM_FULL, "Room is full");
      return;
    }
    return super.onConnect(connection, ctx);
  }

  // Per-connection rate limit: allow → hand to Yjs; drop → swallow (Yjs resyncs on the next exchange);
  // close → tear down a sustained flood.
  override onMessage(connection: Connection, message: WSMessage): void | Promise<void> {
    const now = Date.now();
    let limiter = this.#limiters.get(connection.id);
    if (!limiter) {
      limiter = new ConnectionLimiter(now);
      this.#limiters.set(connection.id, limiter);
    }
    const decision = limiter.check(now);
    if (decision === "allow") return super.onMessage(connection, message);
    if (decision === "close") {
      this.#limiters.delete(connection.id);
      connection.close(CLOSE_RATE_LIMIT, "Rate limit exceeded");
    }
  }

  override async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    this.#limiters.delete(connection.id);
    await super.onClose(connection, code, reason, wasClean);
    // Flush the persisted snapshot when the room empties. y-partyserver's autosave is debounced
    // (2s, 10s max) and it keeps no handle to flush it, so an idle DO can hibernate/evict — or a
    // redeploy can drop it — before that timer fires, losing the last edits. Persisting directly as
    // the final connection leaves closes that window for the common (room empties → evicts) path.
    // The closing socket may still be in getConnections() here, so exclude it from the count.
    const others = [...this.getConnections()].filter((c) => c.id !== connection.id);
    if (others.length === 0) {
      try {
        await this.onSave();
      } catch (err) {
        console.error("[board] flush-on-empty save failed:", err);
      }
    }
  }

  override async onLoad(): Promise<void> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ydoc (id TEXT PRIMARY KEY, data BLOB)");
    const rows = this.ctx.storage.sql
      .exec("SELECT data FROM ydoc WHERE id = ?", DOC_ROW_ID)
      .toArray();
    const stored = rows[0]?.data;
    if (loadStoredDoc(this.document, stored) === "corrupt") {
      // A corrupt/incompatible BLOB must NOT brick the room: loadStoredDoc kept the doc
      // empty rather than throwing (which would fail every connection with no recovery).
      // Stash the bad bytes for forensics instead of overwriting them on the next save.
      console.error("[board] discarding unreadable stored doc; starting empty");
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO ydoc (id, data) VALUES (?, ?)",
        CORRUPT_ROW_ID,
        stored,
      );
    }
  }

  override async onSave(): Promise<void> {
    // Table is created in onLoad, which always runs before any save — no need to repeat it here.
    const blob = encodeDocUpdate(this.document);
    if (blob.byteLength > SAVE_WARN_BYTES) {
      console.warn(`[board] persisted doc is ${Math.round(blob.byteLength / 1024)}KB`);
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO ydoc (id, data) VALUES (?, ?)",
      DOC_ROW_ID,
      blob,
    );
  }
}
