import { YServer } from "y-partyserver";
import { encodeDocUpdate, loadStoredDoc } from "./persistence";

/**
 * Board — one Durable Object per room, hosting the room's single Yjs document
 * via Y-PartyServer. Hibernation-enabled; the document is persisted to the DO's
 * co-located SQLite storage so a room survives eviction/redeploy. (M2 adds
 * snapshot compaction + update-log truncation.)
 */
/** Persisted-doc row ids in the `ydoc` table (bound as SQL params, never interpolated). */
const DOC_ROW_ID = "doc";
const CORRUPT_ROW_ID = "doc_corrupt";

export class Board extends YServer {
  // WebSocket Hibernation: idle rooms stop accruing duration charges.
  static override options = { hibernate: true };

  // Debounced autosave: onSave() runs ~2s after edits settle (10s hard cap).
  static override callbackOptions = { debounceWait: 2000, debounceMaxWait: 10_000 };

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
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO ydoc (id, data) VALUES (?, ?)",
      DOC_ROW_ID,
      encodeDocUpdate(this.document),
    );
  }
}
