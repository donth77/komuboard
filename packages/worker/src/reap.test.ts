import { describe, expect, it } from "vitest";

import { REAP_REFRESH_SLOP_MS, REAP_TTL_MS, shouldRearmReap } from "./reap";

describe("room inactivity-reap policy", () => {
  const now = 1_700_000_000_000;

  it("TTL is 90 days", () => {
    expect(REAP_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("rearms when no alarm is scheduled", () => {
    expect(shouldRearmReap(null, now)).toBe(true);
  });

  it("does NOT rearm a fresh alarm (~full TTL out)", () => {
    expect(shouldRearmReap(now + REAP_TTL_MS, now)).toBe(false);
  });

  it("does NOT rearm within the slop window (avoids a write every save)", () => {
    expect(shouldRearmReap(now + REAP_TTL_MS - REAP_REFRESH_SLOP_MS / 2, now)).toBe(false);
  });

  it("rearms once the alarm is more than the slop stale", () => {
    expect(shouldRearmReap(now + REAP_TTL_MS - REAP_REFRESH_SLOP_MS - 1, now)).toBe(true);
  });

  it("rearms a stale past alarm", () => {
    expect(shouldRearmReap(now - 1000, now)).toBe(true);
  });
});
