import { describe, expect, it } from "vitest";

import {
  CUSTOM_SHAPE,
  customShapeIconSvg,
  customShapeOf,
  MAX_CUSTOM_SHAPE_SVG_CHARS,
  normalizeQuery,
  parseViewBox,
  SHAPE_CATALOG,
  SHAPE_KINDS,
  shapeDef,
  shapeIconSvg,
  shapeMatches,
  shapeOutlineSvg,
} from "./shapes";

/** Tokenize an SVG path into commands + numbers; throws on anything else (a typo'd path). */
function tokenize(d: string): { cmds: string[]; nums: number[] } {
  const cmds: string[] = [];
  const nums: number[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)|(\s+|,)/gy;
  let i = 0;
  while (i < d.length) {
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m || m.index !== i) throw new Error(`bad path token at ${i} in ${d}`);
    if (m[1]) cmds.push(m[1]);
    else if (m[2]) nums.push(Number(m[2]));
    i = re.lastIndex;
  }
  return { cmds, nums };
}

describe("shape catalog", () => {
  it("has unique ids, valid sections, and the four legacy kinds", () => {
    const ids = SHAPE_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of SHAPE_CATALOG) expect(["basic", "flowchart"]).toContain(d.section);
    for (const legacy of ["rectangle", "ellipse", "rhombus", "triangle"])
      expect(ids).toContain(legacy);
    expect(SHAPE_KINDS).toEqual([...ids, CUSTOM_SHAPE]);
    expect(shapeDef("cylinder")?.section).toBe("basic");
    expect(shapeDef(CUSTOM_SHAPE)).toBeUndefined();
    expect(shapeDef("nope")).toBeUndefined();
  });

  it("every path (and icon) is valid path syntax that stays inside the 0..100 box", () => {
    for (const d of SHAPE_CATALOG) {
      for (const path of [d.path, d.icon ?? d.path]) {
        const { cmds, nums } = tokenize(path);
        expect(cmds[0]).toBe("M");
        expect(cmds.every((c) => c === c.toUpperCase())).toBe(true); // absolute commands only
        // Literal coordinates live in the box (a curve's control points may poke out a little).
        for (const n of nums) expect(n).toBeGreaterThanOrEqual(-10);
        for (const n of nums) expect(n).toBeLessThanOrEqual(110);
      }
      expect(d.aliases.length).toBeGreaterThan(0);
      expect(d.aliases.every((a) => a === a.toLowerCase())).toBe(true);
      if (d.inset) for (const f of d.inset) expect(f >= 0 && f < 0.5).toBe(true);
    }
  });

  it("natural sizes are sane and circle symbols place square", () => {
    for (const d of SHAPE_CATALOG) {
      if (d.size) {
        const [w, h] = d.size;
        expect(w).toBeGreaterThanOrEqual(80);
        expect(h).toBeGreaterThanOrEqual(80);
        expect(w).toBeLessThanOrEqual(260);
        expect(h).toBeLessThanOrEqual(260);
      }
      if (d.lockAspect) expect(d.size?.[0]).toBe(d.size?.[1]);
    }
    for (const id of ["or", "summing", "sequentialData"])
      expect(shapeDef(id)?.lockAspect).toBe(true);
    // the four legacy kinds keep the default box (their tests + existing boards assume it)
    for (const id of ["rectangle", "ellipse", "rhombus", "triangle"])
      expect(shapeDef(id)?.size).toBeUndefined();
  });

  it("rim details (cylinders) wind the same way as the body so the fill has no hole under them", () => {
    // A second subpath drawn against the body's direction cancels the fill under it (nonzero rule).
    // The body arcs use sweep=1; the rim arc must too.
    for (const id of ["cylinder", "directAccess"]) {
      const subpaths = shapeDef(id)!.path.split(/\s+(?=M)/);
      expect(subpaths).toHaveLength(2);
      const rim = subpaths[1]!;
      expect(rim).toMatch(/A[\d. ]+ 0 0 1 /); // clockwise, like the body
    }
  });

  it("closed shapes end with Z on their first subpath (fill works); braces are stroke-only", () => {
    for (const d of SHAPE_CATALOG) {
      const first = d.path.split(/\s+M/)[0]!;
      if (d.noFill) expect(first.endsWith("Z")).toBe(false);
      else expect(first.endsWith("Z")).toBe(true);
    }
  });
});

describe("search", () => {
  it("normalizes case and diacritics", () => {
    expect(normalizeQuery("  DÉCISION ")).toBe("decision");
  });
  it("matches the localized label, the id, and aliases", () => {
    const rhombus = shapeDef("rhombus")!;
    expect(shapeMatches(rhombus, "decision", "Rhombus")).toBe(true); // alias
    expect(shapeMatches(rhombus, "rhomb", "Losange")).toBe(true); // id
    expect(shapeMatches(rhombus, "losan", "Losange")).toBe(true); // localized label
    expect(shapeMatches(rhombus, "cylinder", "Rhombus")).toBe(false);
    expect(shapeMatches(rhombus, "", "Rhombus")).toBe(true); // empty query matches all
  });
});

describe("custom shape validation", () => {
  it("parses a viewBox and rejects a degenerate one", () => {
    expect(parseViewBox("0 0 100 50")).toEqual([0, 0, 100, 50]);
    expect(parseViewBox("-2.5, 1 10 10")).toEqual([-2.5, 1, 10, 10]);
    expect(parseViewBox("0 0 0 10")).toBeNull();
    expect(parseViewBox("0 0 10")).toBeNull();
    expect(parseViewBox("a b c d")).toBeNull();
    expect(parseViewBox(42)).toBeNull();
  });
  it("accepts markup within the cap and rejects empty / oversized / bad-viewBox input", () => {
    const svg = '<path d="M0 0H10V10H0Z" vector-effect="non-scaling-stroke"/>';
    expect(customShapeOf(svg, "0 0 10 10")).toEqual({ svg, viewBox: "0 0 10 10" });
    expect(customShapeOf("", "0 0 10 10")).toBeNull();
    expect(customShapeOf("x".repeat(MAX_CUSTOM_SHAPE_SVG_CHARS + 1), "0 0 10 10")).toBeNull();
    expect(customShapeOf(svg, "0 0 -1 10")).toBeNull();
    expect(customShapeOf(null, "0 0 10 10")).toBeNull();
  });
});

describe("svg builders", () => {
  it("builds a stretched outline with fill, stroke, and an optional dash", () => {
    const out = shapeOutlineSvg(shapeDef("triangle")!, "#ff0000", "#000000", true);
    expect(out).toContain('preserveAspectRatio="none"');
    expect(out).toContain('fill="#ff0000"');
    expect(out).toContain('stroke="#000000"');
    expect(out).toContain("stroke-dasharray");
    expect(out).toContain('vector-effect="non-scaling-stroke"');
    expect(shapeOutlineSvg(shapeDef("rhombus")!, "#fff", "#000", false)).not.toContain("dasharray");
  });
  it("braces ignore the fill", () => {
    expect(shapeOutlineSvg(shapeDef("braceLeft")!, "#ff0000", "#000", false)).toContain(
      'fill="none"',
    );
  });
  it("wraps custom markup in the box's colours and escapes attribute values", () => {
    const out = shapeOutlineSvg(
      { svg: "<path d='M0 0H1'/>", viewBox: "0 0 1 1" },
      '"x',
      "#000",
      false,
    );
    expect(out).toContain('viewBox="0 0 1 1"');
    expect(out).toContain("<path d='M0 0H1'/>");
    expect(out).toContain('fill="&quot;x"');
  });
  it("icons draw in currentColor with a non-scaling stroke", () => {
    const ico = shapeIconSvg(shapeDef("pill")!);
    expect(ico).toContain('stroke="currentColor"');
    expect(ico).toContain(shapeDef("pill")!.icon);
    const custom = customShapeIconSvg({ svg: "<rect/>", viewBox: "0 0 10 10" }, "x");
    expect(custom).toContain('class="x"');
    expect(custom).toContain("<rect/>");
  });
});
