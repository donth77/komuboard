import { describe, expect, it } from "vitest";
import { roomIdFromUrl, sanitizeRoomId } from "./index";

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
