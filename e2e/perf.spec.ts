import { expect, test } from "@playwright/test";

import { connectPeer, uniqueRoom } from "./helpers";

/**
 * Dense-board performance regression gate (ADR-0009 Phase 4).
 *
 * Injects a 3,000-object board (2,400 stickies/shapes, half with text + 600 strokes) and measures
 * rAF frame times while pumping wheel gestures (wheel = zoom here, so the sweeps cross the whole
 * zoom range — the worst case: mount/unmount churn + full-board relayout at far zoom).
 *
 * Thresholds are ~10-20× today's measured numbers (p50 ~17ms, p95 ~50ms locally) so machine
 * variance never flakes, yet ~6× below the pre-optimization disaster (p50 2-6 s, p95 5.9 s from
 * per-wheel-event sync chains + readObject storms + per-element forced reflows). A regression to
 * any of those patterns trips this gate immediately.
 */

/** Bulk-inject a dense mixed board in one transaction. */
async function injectDenseBoard(
  page: import("@playwright/test").Page,
  boxes: number,
  strokes: number,
): Promise<void> {
  await page.evaluate(
    ({ boxes, strokes }) => {
      const doc = (
        window as unknown as {
          __komuboard: {
            doc: {
              getMap(n: string): { set(k: string, v: unknown): void; constructor: new () => never };
              getArray(n: string): { push(v: string[]): void };
              transact(f: () => void): void;
            };
          };
        }
      ).__komuboard.doc;
      const objects = doc.getMap("objects");
      const order = doc.getArray("order");
      const YMap = objects.constructor as new () => { set(k: string, v: unknown): void };
      const cols = Math.ceil(Math.sqrt(boxes + strokes));
      doc.transact(() => {
        for (let i = 0; i < boxes; i++) {
          const m = new YMap();
          const shape = i % 3 === 2;
          m.set("id", "b" + i);
          m.set("type", "text");
          if (shape) m.set("shape", i % 2 ? "rectangle" : "ellipse");
          m.set("x", (i % cols) * 240);
          m.set("y", Math.floor(i / cols) * 240);
          m.set("width", 180);
          m.set("height", shape ? 120 : 180);
          m.set("bg", ["#ffec99", "#b2f2bb", "#a5d8ff", "#ffc9c9"][i % 4]);
          m.set("runs", i % 2 === 0 ? [{ text: "Note " + i + "\nsecond line" }] : []);
          m.set("fontFamily", "Inter");
          m.set("fontSize", 16);
          m.set("align", "left");
          m.set("authorId", "e2e");
          objects.set("b" + i, m);
          order.push(["b" + i]);
        }
        for (let i = 0; i < strokes; i++) {
          const j = boxes + i;
          const ox = (j % cols) * 240;
          const oy = Math.floor(j / cols) * 240;
          const pts: number[] = [];
          for (let k = 0; k < 24; k++) pts.push(ox + k * 8, oy + 60 + Math.sin(k / 2) * 50);
          const m = new YMap();
          m.set("id", "s" + i);
          m.set("type", "stroke");
          m.set("points", pts);
          m.set("color", "#0e1116");
          m.set("width", 6);
          m.set("style", "solid");
          m.set("opacity", 1);
          m.set("authorId", "e2e");
          objects.set("s" + i, m);
          order.push(["s" + i]);
        }
      });
    },
    { boxes, strokes },
  );
}

interface FrameStats {
  frames: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
  over33ms: number;
}

/** Pump oscillating wheel gestures (~125/s, flipping every `flipEvery` ticks) for `ms` while
 *  sampling rAF frame deltas in-page. `ctrl` adds ctrlKey (pinch-zoom path). */
async function sweep(
  page: import("@playwright/test").Page,
  opts: { ms: number; flipEvery: number; ctrl: boolean },
): Promise<FrameStats> {
  return (await page.evaluate(
    async ({ ms, flipEvery, ctrl }) => {
      const el = document.elementFromPoint(640, 360);
      if (!el) throw new Error("nothing at viewport centre");
      let dir = 1;
      let n = 0;
      const pump = (): void => {
        if (++n % flipEvery === 0) dir = -dir;
        el.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: 24 * dir,
            deltaY: (ctrl ? 12 : 18) * dir,
            ctrlKey: ctrl,
            bubbles: true,
            cancelable: true,
            clientX: 640,
            clientY: 360,
          }),
        );
      };
      const deltas: number[] = [];
      await new Promise<void>((done) => {
        let last: number | undefined;
        let stop = false;
        const loop = (t: number): void => {
          if (last !== undefined) deltas.push(t - last);
          last = t;
          if (stop) done();
          else requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        const iv = setInterval(pump, 8);
        setTimeout(() => {
          stop = true;
          clearInterval(iv);
        }, ms);
      });
      deltas.sort((a, b) => a - b);
      const q = (p: number): number =>
        deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))] ?? 0;
      return {
        frames: deltas.length,
        avg: +(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(1),
        p50: +q(0.5).toFixed(1),
        p95: +q(0.95).toFixed(1),
        max: +Math.max(...deltas).toFixed(1),
        over33ms: deltas.filter((d) => d > 33).length,
      };
    },
    { ms: opts.ms, flipEvery: opts.flipEvery, ctrl: opts.ctrl },
  )) as FrameStats;
}

const P50_LIMIT = 100; // ms — typical frame must stay interactive (today ~17ms)
const P95_LIMIT = 1000; // ms — even mount-storm frames must stay sub-second (today ~50ms)

test("perf: a 3000-object board stays interactive through full-range zoom sweeps", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const a = await connectPeer(browser, uniqueRoom("perf"));
  const page = a.page;

  const t0 = Date.now();
  await injectDenseBoard(page, 2400, 600);
  await page.waitForFunction(() => document.querySelectorAll(".text-layer > *").length > 0);
  const mountMs = Date.now() - t0;
  console.log("inject+first-mount ms:", mountMs);
  expect(mountMs).toBeLessThan(15_000);

  const counts = () =>
    page.evaluate(() => ({
      mounted: document.querySelectorAll(".text-layer > *").length,
    }));

  // Culling: at 100% over a corner of the board only a small fraction is mounted.
  const near = await counts();
  console.log("mounted @100%:", JSON.stringify(near));
  expect(near.mounted).toBeLessThan(300);
  expect(near.mounted).toBeGreaterThan(0);

  // Wheel sweep at 100% (wheel = zoom → crosses the zoom range; worst-case mount churn).
  const wheelNear = await sweep(page, { ms: 3000, flipEvery: 60, ctrl: false });
  console.log("wheel sweep from 100%:", JSON.stringify(wheelNear));
  expect(wheelNear.p50).toBeLessThan(P50_LIMIT);
  expect(wheelNear.p95).toBeLessThan(P95_LIMIT);

  // Zoom to fit → EVERYTHING mounts (culling off-screen set is empty at fit).
  await page.evaluate(() => {
    (
      window as unknown as { __komuboard: { canvas: { zoomToFit(): void } } }
    ).__komuboard.canvas.zoomToFit();
  });
  await page.waitForTimeout(1200);
  const fit = await counts();
  console.log(
    "mounted @fit:",
    JSON.stringify(fit),
    "zoom:",
    await page.evaluate(() => document.getElementById("zoom-pill")?.textContent ?? "?"),
  );
  expect(fit.mounted).toBeGreaterThanOrEqual(3000); // all 2400 boxes + 600 strokes are in the DOM

  // Sweeps with the whole board mounted — per-frame relayout of every element.
  const wheelFit = await sweep(page, { ms: 3000, flipEvery: 60, ctrl: false });
  console.log("wheel sweep from fit:", JSON.stringify(wheelFit));
  expect(wheelFit.p50).toBeLessThan(P50_LIMIT);
  expect(wheelFit.p95).toBeLessThan(P95_LIMIT);

  const pinchFit = await sweep(page, { ms: 3000, flipEvery: 40, ctrl: true });
  console.log("ctrl-wheel sweep from fit:", JSON.stringify(pinchFit));
  expect(pinchFit.p50).toBeLessThan(P50_LIMIT);
  expect(pinchFit.p95).toBeLessThan(P95_LIMIT);

  await a.close();
});
