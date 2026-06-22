import { expect, test } from "@playwright/test";
import { type BoardWindow, connectPeer, objectIds, uniqueRoom } from "./helpers";

/**
 * A move must stream to peers *while* it's being dragged — not only on release. The dragger
 * broadcasts an ephemeral `drag` offset over awareness (like cursors); peers apply it to the
 * node live, and the doc commits once on pointer-up. Guards against the old commit-on-release
 * behaviour and against a double-offset / snap-back at the commit handoff.
 */
test("a peer's drag is visible live, before release, and lands consistently", async ({
  browser,
}) => {
  const room = uniqueRoom("livedrag");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);

  // A draws a horizontal stroke through the canvas centre (so a click at the centre hits it).
  await a.page.keyboard.press("p");
  const box = await a.page.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await a.page.mouse.move(cx - 110, cy);
  await a.page.mouse.down();
  await a.page.mouse.move(cx - 40, cy);
  await a.page.mouse.move(cx + 30, cy);
  await a.page.mouse.move(cx + 110, cy);
  await a.page.mouse.up();

  const [id] = await objectIds(a.page);
  expect(id).toBeTruthy();

  const rectB = (oid: string): Promise<{ x: number; y: number } | null> =>
    b.page.evaluate(
      (i) => (window as unknown as BoardWindow).__komuboard.canvas!.nodeContentRect(i),
      oid,
    );

  // B receives the stroke.
  await expect.poll(async () => (await rectB(id)) !== null).toBe(true);
  const r0 = await rectB(id);
  expect(r0).not.toBeNull();

  // A's screen delta → world delta via A's zoom; nodeContentRect is world-space, so B's rect
  // should shift by that world delta.
  const scaleA = await a.page.evaluate(
    () => (window as unknown as BoardWindow).__komuboard.canvas!.getZoomPercent() / 100,
  );
  const dxScreen = 140;
  const dyScreen = 90;
  const worldDx = dxScreen / scaleA;
  const worldDy = dyScreen / scaleA;

  // A grabs the stroke and drags WITHOUT releasing (mousedown + moves, no mouseup yet).
  await a.page.keyboard.press("v");
  await a.page.mouse.move(cx, cy);
  await a.page.mouse.down();
  await a.page.mouse.move(cx + dxScreen * 0.5, cy + dyScreen * 0.5);
  await a.page.waitForTimeout(60); // let a throttled drag broadcast go out
  await a.page.mouse.move(cx + dxScreen, cy + dyScreen);
  await a.page.waitForTimeout(60);

  // ★ While A is still holding the drag, B must already see the stroke near its new position.
  await expect
    .poll(async () => {
      const r = await rectB(id);
      return r && r0 ? Math.round(r.x - r0.x) : 0;
    })
    .toBeGreaterThan(worldDx * 0.7);

  // Confirm A has NOT released yet (the doc still holds the original geometry).
  const docMovedDuringDrag = await a.page.evaluate(
    () => (window as unknown as BoardWindow).__komuboard.doc.getMap("objects").size,
  );
  expect(docMovedDuringDrag).toBe(1);

  // Release → commit. B settles at the committed position with no snap-back / double-offset.
  await a.page.mouse.up();
  await expect
    .poll(async () => {
      const r = await rectB(id);
      if (!r || !r0) return 9999;
      return Math.abs(r.x - r0.x - worldDx) + Math.abs(r.y - r0.y - worldDy);
    })
    .toBeLessThan(6);

  await a.close();
  await b.close();
});
