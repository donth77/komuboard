// Abuse guards for the Board DO: a per-room connection cap and a per-connection inbound message
// rate limit. Both are "basic" by design — generous enough that real collaboration never trips
// them, strict enough that a single runaway/malicious client can't exhaust a free-tier room.
//
// The rate-limit logic lives here as a pure, time-injected class so it unit-tests deterministically
// (the DO just feeds it Date.now()); see abuse-guard.test.ts.

/** Max simultaneous WebSocket connections per room. */
export const MAX_CONNECTIONS = 50;

/** Sustained inbound messages/sec allowed per connection (token-bucket refill rate). */
export const MSG_RATE_PER_SEC = 200;

/** Token-bucket capacity — short bursts above the sustained rate are absorbed up to this many. */
export const MSG_BURST = 600;

/** After this many messages are dropped on a still-empty bucket, the connection is a flood → close it. */
export const MAX_DROPPED_BEFORE_CLOSE = 2000;

// WebSocket close codes. Application code may only set 1000 or 3000–4999, so the reserved policy
// codes (1008/1013) are off-limits — we use the 4xxx app range, mnemonic of HTTP 429/503.
/** Connection refused because the room is at capacity. */
export const CLOSE_ROOM_FULL = 4503;
/** Connection closed for sustained message flooding. */
export const CLOSE_RATE_LIMIT = 4429;

/**
 * Whether a room is over capacity given its current connection count. Called from onConnect, where
 * the newcomer is *already* counted — so the room holds exactly MAX_CONNECTIONS (count === MAX is
 * allowed; count === MAX + 1 is the overflow that gets refused).
 */
export function overCapacity(connectionCount: number): boolean {
  return connectionCount > MAX_CONNECTIONS;
}

/** What to do with a single inbound message. */
export type LimitDecision = "allow" | "drop" | "close";

/**
 * A token-bucket rate limiter for one connection. `check(now)` accounts for one inbound message at
 * wall-clock `now` (ms) and returns whether to forward it ("allow"), silently drop it ("drop"), or
 * drop it and tear the connection down for sustained flooding ("close"). Time is injected so the DO
 * stays in control of the clock and tests are deterministic.
 */
export class ConnectionLimiter {
  #tokens: number;
  #last: number;
  #dropped = 0;

  constructor(
    now: number,
    private readonly capacity = MSG_BURST,
    private readonly refillPerSec = MSG_RATE_PER_SEC,
    private readonly maxDropped = MAX_DROPPED_BEFORE_CLOSE,
  ) {
    this.#tokens = capacity;
    this.#last = now;
  }

  check(now: number): LimitDecision {
    // Refill for elapsed time (guard against a non-monotonic clock going backwards).
    const elapsed = Math.max(0, now - this.#last);
    this.#tokens = Math.min(this.capacity, this.#tokens + (elapsed / 1000) * this.refillPerSec);
    this.#last = now;

    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      this.#dropped = 0; // a delivered message ends any drop streak
      return "allow";
    }
    this.#dropped += 1;
    return this.#dropped > this.maxDropped ? "close" : "drop";
  }
}
