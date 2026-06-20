import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addStroke,
  addText,
  DEFAULT_TEXT_SIZE,
  deleteObject,
  deleteObjects,
  objectsMap,
  orderArray,
  readObject,
  setObjectsPoints,
  setTextGeometry,
  setTextRuns,
  translateObjects,
  type BoardObject,
  type StrokeObject,
  type TextObject,
} from "./schema";

function stroke(id: string, points: number[] = [0, 0, 10, 10]): StrokeObject {
  return {
    id,
    type: "stroke",
    points,
    color: "#000000",
    width: 4,
    style: "solid",
    opacity: 1,
    authorId: "u1",
  };
}

/** Narrow a readObject result to a stroke for the stroke-focused assertions below. */
function asStroke(obj: BoardObject | null): StrokeObject {
  if (!obj || obj.type !== "stroke") throw new Error("expected a stroke");
  return obj;
}

/** Narrow a readObject result to a text object for the text assertions below. */
function asText(obj: BoardObject | null): TextObject {
  if (!obj || obj.type !== "text") throw new Error("expected a text object");
  return obj;
}

function textObj(id: string, over: Partial<TextObject> = {}): TextObject {
  return {
    id,
    type: "text",
    x: 100,
    y: 50,
    runs: [{ text: "hello" }],
    fontFamily: "Inter, sans-serif",
    fontSize: 24,
    align: "left",
    authorId: "u1",
    ...over,
  };
}

/** Insert a raw object map (used to exercise readObject against malformed data). */
function rawObject(doc: Y.Doc, id: string, fields: Record<string, unknown>): void {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  objectsMap(doc).set(id, m);
  orderArray(doc).push([id]);
}

describe("addStroke + readObject", () => {
  it("adds an object + z-order entry and reads it back", () => {
    const doc = new Y.Doc();
    addStroke(doc, stroke("s1", [1, 2, 3, 4]));
    expect(objectsMap(doc).size).toBe(1);
    expect(orderArray(doc).toArray()).toEqual(["s1"]);
    expect(readObject(objectsMap(doc).get("s1")!)).toMatchObject({
      id: "s1",
      type: "stroke",
      points: [1, 2, 3, 4],
      width: 4,
    });
  });

  it("returns null for a non-stroke type", () => {
    const doc = new Y.Doc();
    rawObject(doc, "x", { type: "sticky" });
    expect(readObject(objectsMap(doc).get("x")!)).toBeNull();
  });

  it("rejects malformed points (non-array, odd length, non-finite, non-number)", () => {
    const doc = new Y.Doc();
    rawObject(doc, "a", { type: "stroke", points: "oops" });
    rawObject(doc, "b", { type: "stroke", points: [1, 2, 3] });
    rawObject(doc, "c", { type: "stroke", points: [1, NaN] });
    rawObject(doc, "d", { type: "stroke", points: [1, "x"] });
    for (const id of ["a", "b", "c", "d"]) {
      expect(readObject(objectsMap(doc).get(id)!), `object ${id}`).toBeNull();
    }
  });

  it("defaults garbage width/opacity instead of laundering NaN", () => {
    const doc = new Y.Doc();
    rawObject(doc, "w", { type: "stroke", points: [0, 0], width: "big", opacity: "x" });
    const obj = asStroke(readObject(objectsMap(doc).get("w")!));
    expect(obj.width).toBe(4);
    expect(obj.opacity).toBe(1);
  });
});

describe("delete / translate / setObjectsPoints", () => {
  it("deleteObject removes the object and its z-order entry", () => {
    const doc = new Y.Doc();
    addStroke(doc, stroke("s1"));
    addStroke(doc, stroke("s2"));
    deleteObject(doc, "s1");
    expect(objectsMap(doc).has("s1")).toBe(false);
    expect(orderArray(doc).toArray()).toEqual(["s2"]);
  });

  it("deleteObjects removes several and preserves survivor order", () => {
    const doc = new Y.Doc();
    for (const id of ["a", "b", "c", "d"]) addStroke(doc, stroke(id));
    deleteObjects(doc, ["b", "d"]);
    expect(orderArray(doc).toArray()).toEqual(["a", "c"]);
    expect(objectsMap(doc).size).toBe(2);
  });

  it("translateObjects offsets every coordinate", () => {
    const doc = new Y.Doc();
    addStroke(doc, stroke("s1", [0, 0, 10, 20]));
    translateObjects(doc, ["s1"], 5, -3);
    expect(asStroke(readObject(objectsMap(doc).get("s1")!)).points).toEqual([5, -3, 15, 17]);
  });

  it("setObjectsPoints replaces geometry", () => {
    const doc = new Y.Doc();
    addStroke(doc, stroke("s1", [0, 0]));
    setObjectsPoints(doc, [{ id: "s1", points: [9, 9, 8, 8] }]);
    expect(asStroke(readObject(objectsMap(doc).get("s1")!)).points).toEqual([9, 9, 8, 8]);
  });
});

describe("multi-client convergence", () => {
  it("a stroke drawn on A appears on B after sync", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    addStroke(a, stroke("s1", [1, 1, 2, 2]));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(orderArray(b).toArray()).toEqual(["s1"]);
    expect(asStroke(readObject(objectsMap(b).get("s1")!)).points).toEqual([1, 1, 2, 2]);
  });

  it("concurrent edits on both peers converge to identical state", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    addStroke(a, stroke("fromA"));
    addStroke(b, stroke("fromB"));
    const ua = Y.encodeStateAsUpdate(a);
    const ub = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, ub);
    Y.applyUpdate(b, ua);
    expect(objectsMap(a).size).toBe(2);
    // CRDT guarantee: both peers resolve to the *same* z-order, containing both strokes.
    expect(orderArray(a).toArray()).toEqual(orderArray(b).toArray());
    expect(new Set(orderArray(a).toArray())).toEqual(new Set(["fromA", "fromB"]));
  });
});

describe("persistence round-trip (mirrors the worker onSave → onLoad path)", () => {
  it("encode → fresh-doc applyUpdate converges", () => {
    const a = new Y.Doc();
    addStroke(a, stroke("s1", [3, 4, 5, 6]));
    const saved = Y.encodeStateAsUpdate(a); // what onSave persists
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, saved); // what onLoad applies
    expect(asStroke(readObject(objectsMap(reloaded).get("s1")!)).points).toEqual([3, 4, 5, 6]);
  });

  it("applyUpdate throws on a truncated/corrupt update (why onLoad guards it)", () => {
    const a = new Y.Doc();
    addStroke(a, stroke("s1", [0, 0, 1, 1, 2, 2, 3, 3]));
    const full = Y.encodeStateAsUpdate(a);
    const truncated = full.slice(0, full.length - 3); // lop off the tail → incomplete
    const doc = new Y.Doc();
    expect(() => Y.applyUpdate(doc, truncated)).toThrow();
  });
});

describe("text objects", () => {
  it("addText round-trips through readObject (marks + optional width)", () => {
    const doc = new Y.Doc();
    addText(
      doc,
      textObj("t1", {
        width: 320,
        align: "center",
        runs: [
          { text: "Hi ", bold: true, color: "#ff0000" },
          { text: "there", italic: true, highlight: "#ffff00" },
        ],
      }),
    );
    expect(orderArray(doc).toArray()).toEqual(["t1"]);
    expect(asText(readObject(objectsMap(doc).get("t1")!))).toMatchObject({
      id: "t1",
      type: "text",
      x: 100,
      y: 50,
      width: 320,
      align: "center",
      runs: [
        { text: "Hi ", bold: true, color: "#ff0000" },
        { text: "there", italic: true, highlight: "#ffff00" },
      ],
    });
  });

  it("auto-width text omits width entirely (never `undefined`)", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("t1")); // no width
    expect("width" in asText(readObject(objectsMap(doc).get("t1")!))).toBe(false);
  });

  it("setTextRuns replaces content; setTextGeometry + translate move the box", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("t1", { x: 10, y: 20 }));
    setTextRuns(doc, "t1", [{ text: "updated", underline: true }]);
    setTextGeometry(doc, "t1", { x: 200, width: 150 });
    translateObjects(doc, ["t1"], 5, -4);
    expect(asText(readObject(objectsMap(doc).get("t1")!))).toMatchObject({
      x: 205,
      y: 16,
      width: 150,
      runs: [{ text: "updated", underline: true }],
    });
  });

  it("readText rejects bad geometry / non-array runs, and sanitizes the rest", () => {
    const doc = new Y.Doc();
    rawObject(doc, "bad-x", { type: "text", x: NaN, y: 0, runs: [{ text: "x" }] });
    rawObject(doc, "no-runs", { type: "text", x: 0, y: 0, runs: "nope" });
    expect(readObject(objectsMap(doc).get("bad-x")!)).toBeNull();
    expect(readObject(objectsMap(doc).get("no-runs")!)).toBeNull();
    // Drops malformed runs (non-object / missing text / non-string text) and defaults bad props.
    rawObject(doc, "messy", {
      type: "text",
      x: 0,
      y: 0,
      runs: [{ text: "ok" }, { notText: 1 }, "garbage", { text: 5 }],
      fontSize: "big",
      align: "sideways",
    });
    const obj = asText(readObject(objectsMap(doc).get("messy")!));
    expect(obj.runs).toEqual([{ text: "ok" }]);
    expect(obj.fontSize).toBe(DEFAULT_TEXT_SIZE);
    expect(obj.align).toBe("left");
  });

  it("a text object created on A converges on B after sync", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    addText(a, textObj("t1", { runs: [{ text: "shared", bold: true }] }));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(orderArray(b).toArray()).toEqual(["t1"]);
    expect(asText(readObject(objectsMap(b).get("t1")!)).runs).toEqual([
      { text: "shared", bold: true },
    ]);
  });
});
