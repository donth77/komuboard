import { type Browser, type Page } from "@playwright/test";

/** Canonical shape of the `window.__komuboard` test hook exposed by the client (see main.ts). */
export type BoardWindow = {
  __komuboard: {
    doc: {
      getMap(name: string): {
        size: number;
        keys(): IterableIterator<string>;
        values(): IterableIterator<{ get(key: string): unknown }>;
        get(key: string): { toJSON(): Record<string, unknown> } | undefined;
      };
      getArray(name: string): { toArray(): string[] };
      transact(fn: () => void): void;
    };
    provider: { wsconnected: boolean; connect(): void; disconnect(): void };
    awareness: {
      clientID: number;
      getLocalState(): { selection?: string[]; cursor?: { x: number; y: number } } | null;
      getStates(): Map<number, { selection?: string[]; cursor?: { x: number; y: number } }>;
    };
    canvas?: {
      hasSelection(): boolean;
      remoteSelectionCount(): number;
      remoteSelectionRectX(): number | null;
      remoteGroupLabelCount(): number;
      remoteDrawCount(): number;
      transformerAnchorPos(name: string): { x: number; y: number } | null;
      nodeContentRect(id: string): { x: number; y: number; width: number; height: number } | null;
      getZoomPercent(): number;
      point(): { x: number; y: number };
      rotationCornerOf(w: { x: number; y: number }): string | null;
      selectionUnionRect(): { x: number; y: number; width: number; height: number } | null;
      setStamp(src: string): void;
      setShape(kind: string): void;
      setTool(tool: string): void;
      textLayer: { selectedIds(): string[]; selectedCount(): number };
    };
  };
};

export type Peer = { page: Page; close: () => Promise<void> };

/** A fresh room id for a test, e.g. "e2e-3f9a1b". */
export function uniqueRoom(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Open a page in its own browser context, join `room`, and wait until it's connected.
 *
 * Each context starts with empty storage, so the first-run identity nudge would otherwise pop up in
 * every test (and can overlap the top-right chrome). It's suppressed by default; pass
 * `{ showNudge: true }` in the dedicated nudge test to see it.
 */
export async function connectPeer(
  browser: Browser,
  room: string,
  opts?: { showNudge?: boolean },
): Promise<Peer> {
  const ctx = await browser.newContext();
  if (!opts?.showNudge) {
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("komuboard-identity-nudged", "1");
      } catch {
        /* storage blocked — nudge is harmless anyway */
      }
    });
  }
  const page = await ctx.newPage();
  await page.goto(`/?room=${room}`);
  await page.waitForFunction(
    () => (window as unknown as BoardWindow).__komuboard?.provider?.wsconnected,
  );
  return { page, close: () => ctx.close() };
}

/** Switch to the pen and draw a short freehand stroke centred on the canvas. Returns the centre. */
export async function drawStroke(page: Page): Promise<{ cx: number; cy: number }> {
  await page.keyboard.press("p");
  const box = await page.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 20, cy - 40);
  await page.mouse.move(cx + 40, cy + 10);
  await page.mouse.move(cx + 90, cy - 30);
  await page.mouse.up();
  return { cx, cy };
}

/** Object ids in a page's Yjs doc, in z-order. */
export function objectIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as BoardWindow).__komuboard.doc.getMap("objects").keys(),
  ]);
}

/** Number of remote-peer selection outlines currently rendered on a page (-1 if canvas not ready). */
export function remoteSelectionCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as BoardWindow).__komuboard.canvas?.remoteSelectionCount() ?? -1,
  );
}

/** Whether a page currently holds its own (local) selection — i.e. shows the transform box. */
export function hasSelection(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as BoardWindow).__komuboard.canvas?.hasSelection() ?? false,
  );
}

// ── ADR-0009 Phase 3 coverage helpers (connectors + group transform) ──────────────────────────
// The shapes/arrow flyout is flaky under synthetic input, so shapes/connectors are injected
// straight into the Yjs doc via its own Y types; geometry is asserted in world space.

/** Maps world→screen. Calibrated from the board centre (assumes the default 100% zoom). */
export type Cal = { ox: number; oy: number; scale: number };

export async function calibrate(page: Page): Promise<Cal> {
  const box = await page.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const sx = Math.round(box.x + box.width / 2);
  const sy = Math.round(box.y + box.height / 2);
  await page.mouse.move(sx, sy);
  const r = await page.evaluate(() => {
    const c = (window as unknown as BoardWindow).__komuboard.canvas!;
    const p = c.point();
    return { wx: p.x, wy: p.y, scale: c.getZoomPercent() / 100 };
  });
  return { ox: sx - r.wx * r.scale, oy: sy - r.wy * r.scale, scale: r.scale };
}

export function worldToScreen(cal: Cal, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cal.scale + cal.ox, y: wy * cal.scale + cal.oy };
}

/** An object's plain JSON from a page's doc (or null if absent). */
export function objJSON(page: Page, id: string): Promise<Record<string, unknown> | null> {
  return page.evaluate((i) => {
    const v = (window as unknown as BoardWindow).__komuboard.doc.getMap("objects").get(i);
    return v ? v.toJSON() : null;
  }, id);
}

// Loose view of the doc for injecting Y types (the YMap ctor isn't on the typed surface).
type InjectDoc = {
  getMap(n: string): { constructor: new () => { set(k: string, v: unknown): void } } & {
    set(k: string, v: unknown): void;
  };
  getArray(n: string): { push(v: unknown[]): void };
  transact(fn: () => void): void;
};
export type ConnectorEnd = { x: number; y: number; shapeId?: string; side?: string };

/** Inject a rectangle shape directly into the doc. */
export async function injectShape(
  page: Page,
  o: { id: string; x: number; y: number; width?: number; height?: number; bg?: string },
): Promise<void> {
  await page.evaluate((opts) => {
    const doc = (window as unknown as { __komuboard: { doc: InjectDoc } }).__komuboard.doc;
    const objects = doc.getMap("objects");
    const order = doc.getArray("order");
    const YMap = objects.constructor;
    doc.transact(() => {
      const r = new YMap();
      r.set("id", opts.id);
      r.set("type", "text");
      r.set("shape", "rectangle");
      r.set("x", opts.x);
      r.set("y", opts.y);
      r.set("width", opts.width ?? 160);
      r.set("height", opts.height ?? 120);
      r.set("bg", opts.bg ?? "#ffec99");
      r.set("runs", []); // PLAIN array — a Y.Array is rejected by readText
      r.set("fontFamily", "Inter");
      r.set("fontSize", 16);
      r.set("align", "center");
      r.set("authorId", "e2e");
      objects.set(opts.id, r);
      order.push([opts.id]);
    });
  }, o);
}

/** Inject a sticky note (a text box with a `bg`, no `shape`) directly into the doc. */
export async function injectSticky(
  page: Page,
  o: { id: string; x: number; y: number; size?: number; bg?: string },
): Promise<void> {
  await page.evaluate((opts) => {
    const doc = (window as unknown as { __komuboard: { doc: InjectDoc } }).__komuboard.doc;
    const objects = doc.getMap("objects");
    const order = doc.getArray("order");
    const YMap = objects.constructor;
    doc.transact(() => {
      const s = new YMap();
      s.set("id", opts.id);
      s.set("type", "text");
      s.set("x", opts.x);
      s.set("y", opts.y);
      s.set("width", opts.size ?? 180);
      s.set("height", opts.size ?? 180);
      s.set("bg", opts.bg ?? "#ffec99");
      s.set("runs", []); // PLAIN array — a Y.Array is rejected by readText
      s.set("fontFamily", "Inter");
      s.set("fontSize", 16);
      s.set("align", "left");
      s.set("authorId", "e2e");
      objects.set(opts.id, s);
      order.push([opts.id]);
    });
  }, o);
}

/** Inject a stamp (centre-anchored, square) directly into the doc — the exact shape `addStamp` writes. */
export async function injectStamp(
  page: Page,
  o: { id: string; x: number; y: number; size?: number; src?: string; rotation?: number },
): Promise<void> {
  await page.evaluate((opts) => {
    const doc = (window as unknown as { __komuboard: { doc: InjectDoc } }).__komuboard.doc;
    const objects = doc.getMap("objects");
    const order = doc.getArray("order");
    const YMap = objects.constructor;
    doc.transact(() => {
      const st = new YMap();
      st.set("id", opts.id);
      st.set("type", "stamp");
      st.set("x", opts.x);
      st.set("y", opts.y);
      st.set("size", opts.size ?? 64);
      st.set("src", opts.src ?? "emoji:2705");
      if (opts.rotation != null) st.set("rotation", opts.rotation);
      st.set("authorId", "e2e");
      objects.set(opts.id, st);
      order.push([opts.id]);
    });
  }, o);
}

/** Bulk-inject `n` stickies (ids `p0..p{n-1}`) on a wide grid much larger than the viewport — for the
 *  viewport-culling / perf tests. One transaction. Grid pitch 240, each 180×180. */
export async function injectStickyGrid(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => {
    const doc = (window as unknown as { __komuboard: { doc: InjectDoc } }).__komuboard.doc;
    const objects = doc.getMap("objects");
    const order = doc.getArray("order");
    const YMap = objects.constructor;
    const cols = Math.ceil(Math.sqrt(count));
    doc.transact(() => {
      for (let i = 0; i < count; i++) {
        const m = new YMap();
        m.set("id", "p" + i);
        m.set("type", "text");
        m.set("x", (i % cols) * 240);
        m.set("y", Math.floor(i / cols) * 240);
        m.set("width", 180);
        m.set("height", 180);
        m.set("bg", "#ffec99");
        m.set("runs", []);
        m.set("fontFamily", "Inter");
        m.set("fontSize", 16);
        m.set("align", "left");
        m.set("authorId", "e2e");
        objects.set("p" + i, m);
        order.push(["p" + i]);
      }
    });
  }, n);
}

/** Inject a straight connector directly into the doc. */
export async function injectConnector(
  page: Page,
  o: { id: string; from: ConnectorEnd; to: ConnectorEnd },
): Promise<void> {
  await page.evaluate((opts) => {
    const doc = (window as unknown as { __komuboard: { doc: InjectDoc } }).__komuboard.doc;
    const objects = doc.getMap("objects");
    const order = doc.getArray("order");
    const YMap = objects.constructor;
    doc.transact(() => {
      const c = new YMap();
      c.set("id", opts.id);
      c.set("type", "connector");
      c.set("from", opts.from);
      c.set("to", opts.to);
      c.set("kind", "straight");
      c.set("color", "#1f2933");
      c.set("width", 2);
      c.set("style", "solid");
      c.set("startCap", "none");
      c.set("endCap", "arrow");
      objects.set(opts.id, c);
      order.push([opts.id]);
    });
  }, o);
}
