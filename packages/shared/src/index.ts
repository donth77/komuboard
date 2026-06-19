/**
 * Coboard shared contracts (M0).
 *
 * The `shared` package is the single contract layer consumed by `client-web`,
 * `vr`, and `worker` so the three can never diverge. In M1 this grows to hold
 * the Yjs document schema + awareness payload types; for M0 it carries the
 * minimal realtime ping/echo protocol and a room-id helper.
 */

/** The PartyServer "party" name; the worker routes /parties/main/:roomId. */
export const PARTY = "main" as const;

// Yjs document schema + presence types (the shared contract for canvas content).
export * from "./schema";

/** Client → server: a latency probe. */
export interface PingMessage {
  type: "ping";
  /** Client send time (epoch ms), echoed back to measure round-trip. */
  t: number;
}

/** Server → client: the echo of a ping, stamped with server time + room. */
export interface EchoMessage {
  type: "echo";
  t: number;
  serverTime: number;
  room: string;
}

/** Server → client: sent on connect with the current room + connection count. */
export interface WelcomeMessage {
  type: "welcome";
  room: string;
  connections: number;
}

export type ClientMessage = PingMessage;
export type ServerMessage = EchoMessage | WelcomeMessage;

export function isPing(value: unknown): value is PingMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ping" &&
    typeof (value as { t?: unknown }).t === "number"
  );
}

/**
 * Derive a safe room id from a board URL. Prefers `?room=`, then the first path
 * segment, else the fallback. Always sanitized.
 */
export function roomIdFromUrl(url: URL, fallback = "lobby"): string {
  const query = url.searchParams.get("room");
  if (query) return sanitizeRoomId(query, fallback);
  const segment = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  return segment ? sanitizeRoomId(segment, fallback) : fallback;
}

/** Lowercase, collapse to a URL-safe slug, and fall back if nothing usable remains. */
export function sanitizeRoomId(raw: string, fallback = "lobby"): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}
