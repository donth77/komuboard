import { YServer } from "y-partyserver";
import * as Y from "yjs";

/**
 * Board — one Durable Object per room, hosting the room's single Yjs document
 * via Y-PartyServer. Hibernation-enabled; the document is persisted to the DO's
 * co-located SQLite storage so a room survives eviction/redeploy. (M2 adds
 * snapshot compaction + update-log truncation.)
 */
export class Board extends YServer {
  // WebSocket Hibernation: idle rooms stop accruing duration charges.
  static override options = { hibernate: true };

  // Debounced autosave: onSave() runs ~2s after edits settle (10s hard cap).
  static override callbackOptions = { debounceWait: 2000, debounceMaxWait: 10_000 };

  override async onLoad(): Promise<void> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ydoc (id TEXT PRIMARY KEY, data BLOB)");
    const rows = this.ctx.storage.sql.exec("SELECT data FROM ydoc WHERE id = 'doc'").toArray();
    const stored = rows[0]?.data as ArrayBuffer | undefined;
    if (stored) Y.applyUpdate(this.document, new Uint8Array(stored));
  }

  override async onSave(): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.document);
    const blob = update.buffer.slice(
      update.byteOffset,
      update.byteOffset + update.byteLength,
    ) as ArrayBuffer;
    // Table is created in onLoad, which always runs before any save — no need to repeat it here.
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO ydoc (id, data) VALUES ('doc', ?)", blob);
  }
}
