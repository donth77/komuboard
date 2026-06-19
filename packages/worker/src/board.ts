import { Server, type Connection } from "partyserver";
import type { ServerMessage } from "@coboard/shared";
import type { Env } from "./index";

/**
 * Board — one Durable Object per room (M0 skeleton).
 *
 * For M0 this is a hibernation-enabled WebSocket echo plus a SQLite persistence
 * smoke test. In M1 it becomes the Y-PartyServer-bound host of the room's single
 * Yjs document (the single source of truth shared by the 2D and VR renderers).
 */
export class Board extends Server<Env> {
  /** Use the WebSocket Hibernation API so idle rooms stop accruing duration charges. */
  static override options = { hibernate: true };

  override onStart(): void {
    // SQLite smoke test: co-located, free-tier-eligible Durable Object storage.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('smoke', 'ok')",
    );
  }

  override onConnect(connection: Connection): void {
    const welcome: ServerMessage = {
      type: "welcome",
      room: this.name,
      connections: [...this.getConnections()].length,
    };
    connection.send(JSON.stringify(welcome));
  }

  override onMessage(connection: Connection, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;

    let t = 0;
    try {
      const parsed = JSON.parse(message) as { t?: unknown };
      if (typeof parsed.t === "number") t = parsed.t;
    } catch {
      // Ignore malformed frames in M0; M1 validates against the shared schema.
    }

    const echo: ServerMessage = {
      type: "echo",
      t,
      serverTime: Date.now(),
      room: this.name,
    };
    connection.send(JSON.stringify(echo));
  }
}
