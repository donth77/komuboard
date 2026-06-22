import { expect, test } from "@playwright/test";
import { type BoardWindow, connectPeer, hasSelection, objectIds, uniqueRoom } from "./helpers";

/**
 * A transformer-anchor drag captures the pointer, so the stage's normal pointermove (which
 * publishes the cursor) doesn't fire — the resizer's cursor must be published from the transform
 * handler too, else peers see it frozen at its pre-resize spot. This asserts the cursor tracks
 * the handle while resizing.
 */
test("the resizer's cursor keeps tracking the handle during a resize", async ({ browser }) => {
  const room = uniqueRoom("resizecursor");
  const a = await connectPeer(browser, room);

  // Draw a diagonal stroke and select it.
  await a.page.keyboard.press("p");
  const box = await a.page.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await a.page.mouse.move(cx - 100, cy - 60);
  await a.page.mouse.down();
  await a.page.mouse.move(cx, cy);
  await a.page.mouse.move(cx + 100, cy + 60);
  await a.page.mouse.up();

  expect((await objectIds(a.page))[0]).toBeTruthy();
  await a.page.keyboard.press("v");
  await a.page.mouse.click(cx, cy);
  await expect.poll(() => hasSelection(a.page)).toBe(true);

  const anchor = await a.page.evaluate(() =>
    (window as unknown as BoardWindow).__komuboard.canvas!.transformerAnchorPos("bottom-right"),
  );
  expect(anchor).not.toBeNull();
  const ax = box.x + anchor!.x;
  const ay = box.y + anchor!.y;
  const scaleA = await a.page.evaluate(
    () => (window as unknown as BoardWindow).__komuboard.canvas!.getZoomPercent() / 100,
  );

  const cursor = (): Promise<{ x: number; y: number } | undefined> =>
    a.page.evaluate(
      () => (window as unknown as BoardWindow).__komuboard.awareness.getLocalState()?.cursor,
    );

  // Begin the resize, then sample the cursor at two points BOTH during the drag — so the
  // baseline is itself published from the transform handler (avoids throttle staleness from the
  // earlier select-click). Before the fix, both samples are the frozen pre-resize position.
  await a.page.mouse.move(ax, ay);
  await a.page.mouse.down();
  await a.page.mouse.move(ax + 10, ay + 8); // first transform tick → publishes the cursor
  await a.page.waitForTimeout(50);
  const c0 = await cursor();
  expect(c0).toBeTruthy();

  const dx = 150;
  const dy = 110;
  await a.page.mouse.move(ax + dx, ay + dy);

  // ★ The cursor must follow the handle (move ~the world-space delta in BOTH axes), not freeze.
  const expDx = ((dx - 10) / scaleA) * 0.6;
  const expDy = ((dy - 8) / scaleA) * 0.6;
  await expect
    .poll(async () => {
      const c = await cursor();
      return c && c0 ? Math.round(c.x - c0.x) : 0;
    })
    .toBeGreaterThan(expDx);
  const cEnd = await cursor();
  expect(cEnd!.y - c0!.y).toBeGreaterThan(expDy);

  await a.page.mouse.up();
  await a.close();
});
