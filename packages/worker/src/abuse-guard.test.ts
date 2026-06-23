import { describe, expect, it } from "vitest";
import {
  ConnectionLimiter,
  MAX_CONNECTIONS,
  MAX_DROPPED_BEFORE_CLOSE,
  MSG_BURST,
  MSG_RATE_PER_SEC,
  overCapacity,
} from "./abuse-guard";

describe("overCapacity (room-size cap)", () => {
  it("admits up to MAX_CONNECTIONS and refuses the overflow (newcomer is pre-counted)", () => {
    expect(overCapacity(MAX_CONNECTIONS - 1)).toBe(false);
    expect(overCapacity(MAX_CONNECTIONS)).toBe(false); // the Nth connection fills the room
    expect(overCapacity(MAX_CONNECTIONS + 1)).toBe(true); // the (N+1)th is refused
  });
});

describe("ConnectionLimiter (per-connection token bucket)", () => {
  // Small, explicit limits so the behaviour is easy to reason about: 3 burst, 10/s, close after 5 drops.
  const make = (now = 0) => new ConnectionLimiter(now, 3, 10, 5);

  it("allows up to the burst capacity immediately, then drops", () => {
    const l = make(0);
    expect(l.check(0)).toBe("allow");
    expect(l.check(0)).toBe("allow");
    expect(l.check(0)).toBe("allow"); // capacity = 3
    expect(l.check(0)).toBe("drop"); // bucket empty, no time elapsed
    expect(l.check(0)).toBe("drop");
  });

  it("refills over elapsed time (10/s → 1 token per 100ms)", () => {
    const l = make(0);
    l.check(0);
    l.check(0);
    l.check(0); // drained
    expect(l.check(0)).toBe("drop");
    expect(l.check(100)).toBe("allow"); // +100ms → +1 token
    expect(l.check(100)).toBe("drop"); // spent it
    expect(l.check(350)).toBe("allow"); // +250ms → +2 tokens (capped at 3)
    expect(l.check(350)).toBe("allow");
  });

  it("a delivered message resets the drop streak (bursty ≠ flooding, never closes)", () => {
    const l = make(0);
    l.check(0);
    l.check(0);
    l.check(0); // drained
    let now = 0;
    for (let i = 0; i < 100; i++) {
      // Two drops at this tick (streak reaches 2)…
      expect(l.check(now)).toBe("drop");
      expect(l.check(now)).toBe("drop");
      // …then enough elapsed time to earn one token → allow, which resets the streak well below 5.
      now += 100; // +1 token at 10/s
      expect(l.check(now)).toBe("allow");
    }
  });

  it("closes the connection on a sustained same-tick flood", () => {
    const l = make(0);
    l.check(0);
    l.check(0);
    l.check(0); // drained, no time will pass → no refill
    let decision = "drop";
    let drops = 0;
    for (let i = 0; i < 100 && decision !== "close"; i++) {
      decision = l.check(0);
      if (decision === "drop") drops++;
    }
    expect(decision).toBe("close");
    expect(drops).toBe(5); // MAX_DROPPED (5) drops, then the 6th is "close"
  });

  it("never drops at a steady legal pace (1 msg per refill interval)", () => {
    const l = make(0);
    for (let t = 0; t <= 5000; t += 100) {
      // 10/s allows one message every 100ms indefinitely.
      expect(l.check(t)).toBe("allow");
    }
  });

  it("ships sane production defaults", () => {
    expect(MAX_CONNECTIONS).toBeGreaterThanOrEqual(2);
    expect(MSG_BURST).toBeGreaterThanOrEqual(MSG_RATE_PER_SEC); // burst absorbs at least ~1s of rate
    expect(MAX_DROPPED_BEFORE_CLOSE).toBeGreaterThan(MSG_BURST);
  });
});
