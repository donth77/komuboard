import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addConnector,
  addStamp,
  addStroke,
  addText,
  cloneObject,
  DEFAULT_CONNECTOR_WIDTH,
  DEFAULT_TEXT_SIZE,
  deleteObject,
  deleteObjects,
  expandGroups,
  groupObjects,
  objectsMap,
  orderArray,
  readObject,
  setLocked,
  ungroupObjects,
  setConnectorEnds,
  setObjectsPoints,
  setTextGeometry,
  setTextRuns,
  sideMidpoint,
  translateObjects,
  type BoardObject,
  type ConnectorObject,
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

function asConnector(obj: BoardObject | null): ConnectorObject {
  if (!obj || obj.type !== "connector") throw new Error("expected a connector object");
  return obj;
}

function connector(id: string, over: Partial<ConnectorObject> = {}): ConnectorObject {
  return {
    id,
    type: "connector",
    kind: "arrow",
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 },
    color: "#1f2933",
    width: 6,
    style: "solid",
    startCap: "none",
    endCap: "line",
    authorId: "u1",
    ...over,
  };
}

describe("connectors", () => {
  it("round-trips a free-ended connector through the doc", () => {
    const doc = new Y.Doc();
    addConnector(doc, connector("c1", { kind: "elbow", to: { x: 80, y: 40 } }));
    expect(orderArray(doc).toArray()).toEqual(["c1"]);
    expect(asConnector(readObject(objectsMap(doc).get("c1")!))).toMatchObject({
      id: "c1",
      type: "connector",
      kind: "elbow",
      from: { x: 0, y: 0 },
      to: { x: 80, y: 40 },
    });
  });

  it("persists a bound end (shapeId + side) and drops a half-binding", () => {
    const doc = new Y.Doc();
    addConnector(doc, connector("c1", { from: { x: 0, y: 0, shapeId: "s1", side: "right" } }));
    const c = asConnector(readObject(objectsMap(doc).get("c1")!));
    expect(c.from).toEqual({ x: 0, y: 0, shapeId: "s1", side: "right" });
    // A binding missing its side is dropped → the end stays free.
    rawObject(doc, "c2", {
      type: "connector",
      kind: "arrow",
      from: { x: 1, y: 2, shapeId: "s1" },
      to: { x: 3, y: 4 },
    });
    expect(asConnector(readObject(objectsMap(doc).get("c2")!)).from).toEqual({ x: 1, y: 2 });
  });

  it("readConnector rejects non-finite endpoints, defaults bad kind/width", () => {
    const doc = new Y.Doc();
    rawObject(doc, "bad", { type: "connector", from: { x: NaN, y: 0 }, to: { x: 1, y: 1 } });
    expect(readObject(objectsMap(doc).get("bad")!)).toBeNull();
    rawObject(doc, "messy", {
      type: "connector",
      kind: "squiggle",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      width: -5,
    });
    const c = asConnector(readObject(objectsMap(doc).get("messy")!));
    expect(c.kind).toBe("arrow");
    expect(c.width).toBe(DEFAULT_CONNECTOR_WIDTH);
  });

  it("setConnectorEnds re-binds an end", () => {
    const doc = new Y.Doc();
    addConnector(doc, connector("c1"));
    setConnectorEnds(doc, "c1", { to: { x: 5, y: 5, shapeId: "s9", side: "left" } });
    expect(asConnector(readObject(objectsMap(doc).get("c1")!)).to).toEqual({
      x: 5,
      y: 5,
      shapeId: "s9",
      side: "left",
    });
  });

  it("translateObjects shifts free endpoints", () => {
    const doc = new Y.Doc();
    addConnector(doc, connector("c1", { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }));
    translateObjects(doc, ["c1"], 5, 7);
    const c = asConnector(readObject(objectsMap(doc).get("c1")!));
    expect(c.from).toEqual({ x: 5, y: 7 });
    expect(c.to).toEqual({ x: 15, y: 7 });
  });

  it("deleteObject removes a connector + its z-order entry", () => {
    const doc = new Y.Doc();
    addConnector(doc, connector("c1"));
    deleteObject(doc, "c1");
    expect(objectsMap(doc).has("c1")).toBe(false);
    expect(orderArray(doc).toArray()).toEqual([]);
  });

  it("sideMidpoint returns each side's mid-edge", () => {
    const rect = { x: 10, y: 20, width: 100, height: 60 };
    expect(sideMidpoint(rect, "top")).toEqual({ x: 60, y: 20 });
    expect(sideMidpoint(rect, "bottom")).toEqual({ x: 60, y: 80 });
    expect(sideMidpoint(rect, "left")).toEqual({ x: 10, y: 50 });
    expect(sideMidpoint(rect, "right")).toEqual({ x: 110, y: 50 });
  });
});

describe("cloneObject (copy / paste)", () => {
  it("clones a stroke with a fresh id/author and offsets every point", () => {
    const src = stroke("s1", [0, 0, 10, 20]);
    const clone = asStroke(cloneObject(src, "s2", "me", 5, -3));
    expect(clone).toMatchObject({ id: "s2", authorId: "me", points: [5, -3, 15, 17] });
    expect(src.points).toEqual([0, 0, 10, 20]); // original untouched
  });

  it("clones a text object: offsets x/y and deep-copies runs", () => {
    const src = textObj("t1", { x: 100, y: 50, runs: [{ text: "hi", bold: true }] });
    const clone = asText(cloneObject(src, "t2", "me", 10, 10));
    expect(clone).toMatchObject({ id: "t2", x: 110, y: 60, authorId: "me" });
    expect(clone.runs).toEqual([{ text: "hi", bold: true }]);
    expect(clone.runs).not.toBe(src.runs); // deep copy, not a shared reference
    expect(clone.runs[0]).not.toBe(src.runs[0]);
  });

  it("clones a connector: offsets endpoints and remaps a bound shape via idMap", () => {
    const src = connector("c1", {
      from: { x: 0, y: 0, shapeId: "shapeA", side: "right" },
      to: { x: 40, y: 0, shapeId: "shapeB", side: "left" },
    });
    const idMap = new Map([["shapeA", "shapeA2"]]); // only shapeA was copied alongside the connector
    const clone = asConnector(cloneObject(src, "c2", "me", 8, 8, idMap));
    expect(clone).toMatchObject({ id: "c2", authorId: "me" });
    expect(clone.from).toMatchObject({ x: 8, y: 8, side: "right" });
    expect(clone.to).toMatchObject({ x: 48, y: 8, side: "left" });
    // the end bound to a copied shape rebinds to the copy; the other keeps its original binding
    expect(clone.from.shapeId).toBe("shapeA2");
    expect(clone.to.shapeId).toBe("shapeB");
  });

  it("keeps a free (unbound) connector end unbound", () => {
    const src = connector("c1", { from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
    const clone = asConnector(cloneObject(src, "c2", "me", 2, 2));
    expect(clone.from.shapeId).toBeUndefined();
    expect(clone.to.shapeId).toBeUndefined();
  });
});

describe("stamp attachment", () => {
  const stampAt = (
    id: string,
    x: number,
    y: number,
    over: Partial<Parameters<typeof addStamp>[1]> = {},
  ) => ({ id, type: "stamp" as const, x, y, size: 30, src: "emoji:2705", authorId: "u1", ...over });

  it("rides its host when the host is translated", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("host", { x: 100, y: 50 }));
    addStamp(doc, stampAt("st", 110, 60, { attachedTo: "host" }));
    translateObjects(doc, ["host"], 10, 20);
    const st = readObject(objectsMap(doc).get("st")!) as Extract<BoardObject, { type: "stamp" }>;
    expect([st.x, st.y]).toEqual([120, 80]); // followed the host's +10,+20
  });

  it("does not double-move when host + stamp are translated together (group move)", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("host", { x: 100, y: 50 }));
    addStamp(doc, stampAt("st", 110, 60, { attachedTo: "host" }));
    translateObjects(doc, ["host", "st"], 10, 0);
    const st = readObject(objectsMap(doc).get("st")!) as Extract<BoardObject, { type: "stamp" }>;
    expect(st.x).toBe(120); // moved once (+10), not twice
  });

  it("is deleted when its host is deleted, but survives as its own node otherwise", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("host"));
    addText(doc, textObj("other"));
    addStamp(doc, stampAt("st", 110, 60, { attachedTo: "host" }));
    deleteObjects(doc, ["other"]); // unrelated delete leaves it
    expect(objectsMap(doc).get("st")).toBeDefined();
    deleteObjects(doc, ["host"]); // host delete cascades
    expect(objectsMap(doc).get("st")).toBeUndefined();
    expect(orderArray(doc).toArray()).not.toContain("st");
  });

  it("a free (unattached) stamp ignores a host's move + delete", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("host", { x: 100, y: 50 }));
    addStamp(doc, stampAt("free", 110, 60)); // no attachedTo
    translateObjects(doc, ["host"], 10, 20);
    deleteObjects(doc, ["host"]);
    const free = readObject(objectsMap(doc).get("free")!) as Extract<
      BoardObject,
      { type: "stamp" }
    >;
    expect([free.x, free.y]).toEqual([110, 60]); // unmoved
    expect(objectsMap(doc).get("free")).toBeDefined(); // undeleted
  });
});

describe("grouping", () => {
  const seed = (doc: Y.Doc, ids: string[]) =>
    ids.forEach((id, i) => addText(doc, textObj(id, { x: i * 10 })));

  it("groupObjects assigns one shared id; expandGroups selects the whole group from one member", () => {
    const doc = new Y.Doc();
    seed(doc, ["a", "b", "c"]);
    const gid = groupObjects(doc, ["a", "b"]);
    expect(asText(readObject(objectsMap(doc).get("a")!)).groupId).toBe(gid);
    expect(asText(readObject(objectsMap(doc).get("b")!)).groupId).toBe(gid);
    expect(asText(readObject(objectsMap(doc).get("c")!)).groupId).toBeUndefined();
    // Touching just one member expands to both; an ungrouped id stays alone.
    expect([...expandGroups(doc, ["a"])].sort()).toEqual(["a", "b"]);
    expect([...expandGroups(doc, ["c"])]).toEqual(["c"]);
  });

  it("ungroupObjects clears the whole group given any one member", () => {
    const doc = new Y.Doc();
    seed(doc, ["a", "b"]);
    groupObjects(doc, ["a", "b"]);
    ungroupObjects(doc, ["a"]); // pass only one — both clear
    expect(asText(readObject(objectsMap(doc).get("a")!)).groupId).toBeUndefined();
    expect(asText(readObject(objectsMap(doc).get("b")!)).groupId).toBeUndefined();
    expect([...expandGroups(doc, ["a"])]).toEqual(["a"]);
  });

  it("re-grouping moves members into the new group", () => {
    const doc = new Y.Doc();
    seed(doc, ["a", "b"]);
    const g1 = groupObjects(doc, ["a", "b"]);
    const g2 = groupObjects(doc, ["a"]); // re-group a into a fresh group
    expect(g2).not.toBe(g1);
    expect(asText(readObject(objectsMap(doc).get("a")!)).groupId).toBe(g2);
  });

  it("expandGroups skips a locked sibling but keeps a directly-targeted locked id", () => {
    const doc = new Y.Doc();
    seed(doc, ["a", "b", "c"]);
    groupObjects(doc, ["a", "b", "c"]);
    setLocked(doc, ["b"], true);
    // Selecting unlocked `a` pulls in unlocked `c` but NOT locked `b` (so the group stays movable).
    expect([...expandGroups(doc, ["a"])].sort()).toEqual(["a", "c"]);
    // Clicking the locked member directly still selects it (to unlock it).
    expect([...expandGroups(doc, ["b"])]).toContain("b");
  });
});

describe("locking", () => {
  it("setLocked toggles the flag", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("a"));
    setLocked(doc, ["a"], true);
    expect(asText(readObject(objectsMap(doc).get("a")!)).locked).toBe(true);
    setLocked(doc, ["a"], false);
    expect(asText(readObject(objectsMap(doc).get("a")!)).locked).toBeUndefined();
  });

  it("deleteObjects skips a locked object (lock protects against delete/erase)", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("a"));
    addText(doc, textObj("b"));
    setLocked(doc, ["a"], true);
    deleteObjects(doc, ["a", "b"]);
    expect(objectsMap(doc).get("a")).toBeDefined(); // locked → survived
    expect(objectsMap(doc).get("b")).toBeUndefined(); // unlocked → deleted
    expect(orderArray(doc).toArray()).toEqual(["a"]);
  });

  // Mutator-level lock guards (defence-in-depth: a locked object never moves/resizes/rotates no matter
  // which UI path reaches the commit). These close the connector / group-rotate / ⌘A-drag bypasses.
  it("translateObjects does not move a locked object", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("a", { x: 100, y: 50 }));
    setLocked(doc, ["a"], true);
    translateObjects(doc, ["a"], 30, 40);
    const a = asText(readObject(objectsMap(doc).get("a")!));
    expect([a.x, a.y]).toEqual([100, 50]); // unmoved
  });

  it("setTextGeometry no-ops on a locked box", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("a", { x: 0, y: 0 }));
    setLocked(doc, ["a"], true);
    setTextGeometry(doc, "a", { x: 999, rotation: 45 });
    const a = asText(readObject(objectsMap(doc).get("a")!));
    expect(a.x).toBe(0);
    expect(a.rotation ?? null).toBeNull();
  });

  it("setConnectorEnds no-ops on a locked connector (closes the connector lock bypass)", () => {
    const doc = new Y.Doc();
    addConnector(doc, connector("c", { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }));
    setLocked(doc, ["c"], true);
    setConnectorEnds(doc, "c", { to: { x: 999, y: 999 } });
    expect(asConnector(readObject(objectsMap(doc).get("c")!)).to).toMatchObject({ x: 10, y: 0 });
  });

  it("locking a host locks its attached stamps (unlocking unlocks them)", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("host"));
    addStamp(doc, {
      id: "st",
      type: "stamp",
      x: 10,
      y: 10,
      size: 30,
      src: "emoji:2705",
      authorId: "u",
      attachedTo: "host",
    });
    setLocked(doc, ["host"], true);
    expect(readObject(objectsMap(doc).get("st")!)!.locked).toBe(true); // attached sticker follows
    setLocked(doc, ["host"], false);
    expect(readObject(objectsMap(doc).get("st")!)!.locked).toBeUndefined();
  });

  it("a locked attached stamp survives deletion of its (unlocked) host", () => {
    const doc = new Y.Doc();
    addText(doc, textObj("host"));
    addStamp(doc, {
      id: "st",
      type: "stamp",
      x: 10,
      y: 10,
      size: 30,
      src: "emoji:2705",
      authorId: "u",
      attachedTo: "host",
    });
    setLocked(doc, ["st"], true);
    deleteObjects(doc, ["host"]);
    expect(objectsMap(doc).get("host")).toBeUndefined(); // host deleted
    expect(objectsMap(doc).get("st")).toBeDefined(); // locked sticker survived the cascade
  });
});
