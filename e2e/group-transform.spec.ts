import { type Page, expect, test } from "@playwright/test";
import {
  type BoardWindow,
  calibrate,
  connectPeer,
  drawStroke,
  injectShape,
  objJSON,
  objectIds,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

/**
 * Multi-select group-transform coverage (ADR-0009 Phase 3). No other spec exercises a group of 2+
 * objects being resized/rotated together — the exact path that runs through the group proxy today
 * and must keep working when the Konva ink/transformer is retired. A stroke + an injected shape are
 * marquee-selected, then scaled as one unit; both must grow.
 */

const rectW = (page: Page, id: string): Promise<number | null> =>
  page.evaluate((i) => {
    const r = (window as unknown as BoardWindow).__komuboard.canvas!.nodeContentRect(i);
    return r ? r.width : null;
  }, id);

const selectionSize = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (window as unknown as BoardWindow).__komuboard.awareness.getLocalState()?.selection?.length ??
      0,
  );

test("group transform: marquee a stroke + a shape, then group-resize scales both", async ({
  browser,
}) => {
  const room = uniqueRoom("grouptx");
  const a = await connectPeer(browser, room);

  // A stroke near the canvas centre; read its world bbox, then drop a shape just below it.
  await drawStroke(a.page);
  const strokeId = (await objectIds(a.page))[0];
  const sBox = await a.page.evaluate(
    (id) => (window as unknown as BoardWindow).__komuboard.canvas!.nodeContentRect(id),
    strokeId,
  );
  expect(sBox).not.toBeNull();
  const shapeY = Math.round(sBox!.y + sBox!.height + 50);
  await injectShape(a.page, {
    id: "sh1",
    x: Math.round(sBox!.x),
    y: shapeY,
    width: 140,
    height: 100,
  });
  await expect.poll(() => a.page.locator('[data-id="sh1"]').count()).toBe(1);

  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");

  // Marquee a rect (started on empty space) enclosing both objects.
  const minX = Math.min(sBox!.x, sBox!.x) - 40;
  const minY = sBox!.y - 40;
  const maxX = Math.max(sBox!.x + sBox!.width, sBox!.x + 140) + 40;
  const maxY = shapeY + 100 + 40;
  const tl = worldToScreen(cal, minX, minY);
  const br = worldToScreen(cal, maxX, maxY);
  await a.page.mouse.move(tl.x, tl.y);
  await a.page.mouse.down();
  await a.page.mouse.move(br.x, br.y, { steps: 14 });
  await a.page.mouse.up();
  await expect.poll(() => selectionSize(a.page)).toBe(2);

  // Grab the group's bottom-right handle and drag it outward → both objects scale up.
  const w0Stroke = await rectW(a.page, strokeId);
  const w0Shape = await rectW(a.page, "sh1");
  expect(w0Stroke).not.toBeNull();
  expect(w0Shape).not.toBeNull();

  // Grab the group's bottom-right corner via the union rect (chrome-agnostic: works for the Konva
  // proxy today and a DOM group chrome after the teardown), where the resize handle sits.
  const u = await a.page.evaluate(() =>
    (window as unknown as BoardWindow).__komuboard.canvas!.selectionUnionRect(),
  );
  expect(u).not.toBeNull();
  const handle = worldToScreen(cal, u!.x + u!.width, u!.y + u!.height);
  const ax = handle.x;
  const ay = handle.y;
  await a.page.mouse.move(ax, ay);
  await a.page.mouse.down();
  await a.page.mouse.move(ax + 130, ay + 100, { steps: 12 });
  await a.page.mouse.up();

  await expect
    .poll(async () => {
      const w = await rectW(a.page, strokeId);
      return w !== null && w0Stroke !== null ? Math.round(w - w0Stroke) : 0;
    })
    .toBeGreaterThan(15);
  await expect
    .poll(async () => {
      const w = await rectW(a.page, "sh1");
      return w !== null && w0Shape !== null ? Math.round(w - w0Shape) : 0;
    })
    .toBeGreaterThan(15);

  await a.close();
});

test("group transform: group-rotate spins both objects", async ({ browser }) => {
  const room = uniqueRoom("grouprot");
  const a = await connectPeer(browser, room);

  await drawStroke(a.page);
  const strokeId = (await objectIds(a.page))[0];
  const sBox = await a.page.evaluate(
    (id) => (window as unknown as BoardWindow).__komuboard.canvas!.nodeContentRect(id),
    strokeId,
  );
  expect(sBox).not.toBeNull();
  const shapeY = Math.round(sBox!.y + sBox!.height + 50);
  await injectShape(a.page, {
    id: "sh1",
    x: Math.round(sBox!.x),
    y: shapeY,
    width: 140,
    height: 100,
  });
  await expect.poll(() => a.page.locator('[data-id="sh1"]').count()).toBe(1);

  const cal = await calibrate(a.page);
  await a.page.keyboard.press("v");

  const tl = worldToScreen(cal, sBox!.x - 40, sBox!.y - 40);
  const br = worldToScreen(cal, sBox!.x + 140 + 40, shapeY + 100 + 40);
  await a.page.mouse.move(tl.x, tl.y);
  await a.page.mouse.down();
  await a.page.mouse.move(br.x, br.y, { steps: 14 });
  await a.page.mouse.up();
  await expect.poll(() => selectionSize(a.page)).toBe(2);

  const u = await a.page.evaluate(() =>
    (window as unknown as BoardWindow).__komuboard.canvas!.selectionUnionRect(),
  );
  expect(u).not.toBeNull();

  // A rotate-band grab point just outside the union bottom-right corner (chrome-agnostic via
  // rotationCornerOf — the DOM group chrome keeps that band detection working).
  let grab: { x: number; y: number } | null = null;
  const corner = worldToScreen(cal, u!.x + u!.width, u!.y + u!.height);
  for (let off = 12; off <= 44 && !grab; off += 4) {
    const cand = { x: corner.x + off, y: corner.y + off };
    await a.page.mouse.move(cand.x, cand.y);
    const hit = await a.page.evaluate(() => {
      const c = (window as unknown as BoardWindow).__komuboard.canvas!;
      return c.rotationCornerOf(c.point());
    });
    if (hit) grab = cand;
  }
  expect(grab).not.toBeNull();

  const strokePt0 = ((await objJSON(a.page, strokeId))!.points as number[]).slice(0, 2);

  // Rotate ~30° about the union centre → both objects spin.
  const centre = worldToScreen(cal, u!.x + u!.width / 2, u!.y + u!.height / 2);
  const r = Math.hypot(grab!.x - centre.x, grab!.y - centre.y);
  const a0 = Math.atan2(grab!.y - centre.y, grab!.x - centre.x);
  const aT = a0 + (30 * Math.PI) / 180;
  await a.page.mouse.move(grab!.x, grab!.y);
  await a.page.mouse.down();
  await a.page.mouse.move(centre.x + r * Math.cos(aT), centre.y + r * Math.sin(aT), { steps: 14 });
  await a.page.mouse.up();

  // The shape commits a rotation; the stroke's points rotate (its first point moves).
  await expect
    .poll(async () => Math.round(((await objJSON(a.page, "sh1"))?.rotation as number) ?? 0))
    .toBeGreaterThan(12);
  const strokePt1 = ((await objJSON(a.page, strokeId))!.points as number[]).slice(0, 2);
  expect(strokePt1[0] !== strokePt0[0] || strokePt1[1] !== strokePt0[1]).toBe(true);

  await a.close();
});
