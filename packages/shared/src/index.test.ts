import { describe, expect, it } from "vitest";
import { isPing, roomIdFromUrl, sanitizeRoomId } from "./index";

describe("sanitizeRoomId", () => {
  it("lowercases and slugifies unsafe input", () => {
    expect(sanitizeRoomId("Hello World!")).toBe("hello-world");
  });

  it("collapses repeated separators and trims edges", () => {
    expect(sanitizeRoomId("  Design __ Review  ")).toBe("design-review");
  });

  it("falls back when nothing usable remains", () => {
    expect(sanitizeRoomId("???")).toBe("lobby");
    expect(sanitizeRoomId("", "home")).toBe("home");
  });
});

describe("roomIdFromUrl", () => {
  it("prefers the ?room= query", () => {
    expect(roomIdFromUrl(new URL("https://coboard.app/anything?room=Lunar-Otter"))).toBe(
      "lunar-otter",
    );
  });

  it("uses the first path segment otherwise", () => {
    expect(roomIdFromUrl(new URL("https://coboard.app/Sprint-24/extra"))).toBe("sprint-24");
  });

  it("falls back for the bare root", () => {
    expect(roomIdFromUrl(new URL("https://coboard.app/"))).toBe("lobby");
  });
});

describe("isPing", () => {
  it("accepts a well-formed ping", () => {
    expect(isPing({ type: "ping", t: 1 })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isPing({ type: "ping" })).toBe(false);
    expect(isPing({ type: "echo", t: 1 })).toBe(false);
    expect(isPing(null)).toBe(false);
  });
});
