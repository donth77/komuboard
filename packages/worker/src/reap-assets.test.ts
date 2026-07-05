import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { addImage, addStamp } from "@komuboard/shared";

import { ASSET_GRACE_MS, collectImageKeys, keysToSweep, sweepIsSafe } from "./reap-assets";

const NOW = 1_700_000_000_000;
const OLD = NOW - ASSET_GRACE_MS - 1; // just past the grace window
const RECENT = NOW - 1000; // within the grace window

describe("keysToSweep", () => {
  it("deletes an unreferenced object past the grace window", () => {
    expect(keysToSweep(new Set(), [{ key: "a.png", uploaded: OLD }], NOW)).toEqual(["a.png"]);
  });

  it("keeps a referenced object even when it's old", () => {
    expect(keysToSweep(new Set(["a.png"]), [{ key: "a.png", uploaded: OLD }], NOW)).toEqual([]);
  });

  it("keeps a recent object (within grace) even when unreferenced", () => {
    expect(keysToSweep(new Set(), [{ key: "a.png", uploaded: RECENT }], NOW)).toEqual([]);
  });

  it("deletes only the old orphan from a mix", () => {
    const out = keysToSweep(
      new Set(["ref.png"]),
      [
        { key: "ref.png", uploaded: OLD }, // referenced → keep
        { key: "orphan.png", uploaded: OLD }, // unreferenced + old → delete
        { key: "fresh.png", uploaded: RECENT }, // unreferenced but recent → keep
      ],
      NOW,
    );
    expect(out).toEqual(["orphan.png"]);
  });
});

describe("sweepIsSafe — circuit breaker", () => {
  it("allows deleting up to half, blocks past it", () => {
    expect(sweepIsSafe(5, 10)).toBe(true);
    expect(sweepIsSafe(6, 10)).toBe(false);
  });
  it("is safe when there's nothing to delete", () => {
    expect(sweepIsSafe(0, 0)).toBe(true);
  });
  it("blocks a would-be full wipe (e.g. a corrupt/empty index)", () => {
    expect(sweepIsSafe(100, 100)).toBe(false);
  });
});

describe("collectImageKeys", () => {
  it("returns image srcs, ignoring stamps and other objects", () => {
    const doc = new Y.Doc();
    addImage(doc, {
      id: "i1",
      type: "image",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      src: "hash1.png",
      authorId: "u",
    });
    addImage(doc, {
      id: "i2",
      type: "image",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      src: "hash2.jpg",
      authorId: "u",
    });
    addStamp(doc, { id: "s1", type: "stamp", x: 0, y: 0, size: 40, src: "emoji:1f600", authorId: "u" });
    expect(collectImageKeys(doc).sort()).toEqual(["hash1.png", "hash2.jpg"]);
  });

  it("returns [] for an empty doc", () => {
    expect(collectImageKeys(new Y.Doc())).toEqual([]);
  });
});
