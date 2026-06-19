import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeDocUpdate, loadStoredDoc } from "./persistence";

describe("worker persistence (the onSave → onLoad core)", () => {
  it("round-trips a doc through encode → store → load", () => {
    const a = new Y.Doc();
    a.getMap("objects").set("k", "v");
    a.getArray("order").push(["k"]);

    const blob = encodeDocUpdate(a);
    expect(blob).toBeInstanceOf(ArrayBuffer);

    const b = new Y.Doc();
    expect(loadStoredDoc(b, blob)).toBe("applied");
    expect(b.getMap("objects").get("k")).toBe("v");
    expect(b.getArray("order").toArray()).toEqual(["k"]);
  });

  it("encodeDocUpdate slices to exactly the update bytes (not a pooled-buffer view)", () => {
    const a = new Y.Doc();
    a.getMap("objects").set("k", 1);
    const update = Y.encodeStateAsUpdate(a);
    expect(encodeDocUpdate(a).byteLength).toBe(update.byteLength);
  });

  it("treats no / unexpected stored value as empty (start fresh, don't throw)", () => {
    const doc = new Y.Doc();
    expect(loadStoredDoc(doc, undefined)).toBe("empty");
    expect(loadStoredDoc(doc, null)).toBe("empty");
    expect(loadStoredDoc(doc, "not a buffer")).toBe("empty");
    expect(loadStoredDoc(doc, 123)).toBe("empty");
    // A Uint8Array is NOT an ArrayBuffer — the SQLite BLOB comes back as ArrayBuffer.
    expect(loadStoredDoc(doc, new Uint8Array([1, 2, 3]))).toBe("empty");
  });

  it("classifies a corrupt/truncated BLOB as corrupt instead of throwing (room not bricked)", () => {
    const a = new Y.Doc();
    a.getMap("objects").set("k", "v");
    a.getArray("order").push(["k"]);
    const full = encodeDocUpdate(a);
    const truncated = full.slice(0, full.byteLength - 3); // lop off the tail → undecodable

    const doc = new Y.Doc();
    expect(loadStoredDoc(doc, truncated)).toBe("corrupt");
  });

  it("survives an eviction cycle: persist → drop → cold-load converges", () => {
    const live = new Y.Doc();
    const objs = live.getMap("objects");
    objs.set("s1", "stroke-data");
    objs.set("s2", "stroke-data-2");
    live.getArray("order").push(["s1", "s2"]);

    // Simulate DO eviction: persist the doc, discard the in-memory copy, cold-load a new one.
    const persisted = encodeDocUpdate(live);
    const reloaded = new Y.Doc();
    expect(loadStoredDoc(reloaded, persisted)).toBe("applied");
    expect(reloaded.getMap("objects").size).toBe(2);
    expect(reloaded.getArray("order").toArray()).toEqual(["s1", "s2"]);
  });
});
