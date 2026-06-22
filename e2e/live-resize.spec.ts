import { expect, test } from "@playwright/test";
import { type BoardWindow, connectPeer, hasSelection, objectIds, uniqueRoom } from "./helpers";

/**
 * A resize must stream to peers *while* a handle is being dragged — not only on release. The
 * resizer broadcasts each node's live transform (position + scale) over awareness; peers apply
 * it, and the doc commits the baked points once on transformend. Same handoff as drag/draw.
 */
test("a peer's resize is visible live, before release, and lands consistently", async ({
  browser,
}) => {
  const room = uniqueRoom("liveresize");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);

  // A draws a diagonal stroke (a tall bbox so the corner handle is easy to grab).
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

  const [id] = await objectIds(a.page);
  expect(id).toBeTruthy();

  const rectB = (): Promise<{ width: number; height: number } | null> =>
    b.page.evaluate(
      (i) => (window as unknown as BoardWindow).__komuboard.canvas!.nodeContentRect(i),
      id,
    );
  await expect.poll(async () => (await rectB()) !== null).toBe(true);
  const r0 = await rectB();
  expect(r0).not.toBeNull();

  // A selects the stroke (transform box attaches), then grabs its bottom-right handle.
  await a.page.keyboard.press("v");
  await a.page.mouse.click(cx, cy); // click on the diagonal to select it
  await expect.poll(() => hasSelection(a.page)).toBe(true);

  const anchor = await a.page.evaluate(() =>
    (window as unknown as BoardWindow).__komuboard.canvas!.transformerAnchorPos("bottom-right"),
  );
  expect(anchor).not.toBeNull();
  const ax = box.x + anchor!.x;
  const ay = box.y + anchor!.y;

  // Drag the handle outward WITHOUT releasing — scales the stroke up.
  await a.page.mouse.move(ax, ay);
  await a.page.mouse.down();
  await a.page.mouse.move(ax + 70, ay + 50);
  await a.page.waitForTimeout(60); // let a throttled resize broadcast go out
  await a.page.mouse.move(ax + 150, ay + 110);
  await a.page.waitForTimeout(60);

  // ★ B sees the stroke grow (scaled) while A is still holding the handle.
  await expect
    .poll(async () => {
      const r = await rectB();
      return r && r0 ? Math.round(r.width - r0.width) : 0;
    })
    .toBeGreaterThan(20);

  // Release → commit. B keeps the grown size (baked into points, no snap-back).
  await a.page.mouse.up();
  await expect
    .poll(async () => {
      const r = await rectB();
      return r && r0 ? Math.round(r.width - r0.width) : 0;
    })
    .toBeGreaterThan(20);

  await a.close();
  await b.close();
});
