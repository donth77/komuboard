import { expect, test } from "@playwright/test";
import { calibrate, connectPeer, drawStroke, injectSticky, objectIds, uniqueRoom } from "./helpers";

/**
 * Tablet / touch support (M2 mobile): the touch chrome is gated on input type (`pointer: coarse`),
 * not just width — so a tablet (wide but coarse-pointer, no keyboard) gets the selection action
 * sheet and on-screen undo/redo. See platform.ts TOUCH_MEDIA + topbar.ts.
 */

const TABLET = { width: 900, height: 1200 }; // wide (>640px) but coarse-pointer → input-gated touch chrome

test("tablet: a coarse-pointer device gets the touch chrome even at a wide width", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("tablet"), { viewport: TABLET, touch: true });

  // On-screen undo/redo show (the keyboard substitute) despite the wide, non-mobile-width viewport.
  await expect(a.page.locator('[data-testid="undo"]')).toBeVisible();
  await expect(a.page.locator('[data-testid="redo"]')).toBeVisible();

  // The selection action sheet activates on selection at 900px — proving it's input-gated, not width.
  const box = (await a.page.locator("#board").boundingBox())!;
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  const cal = await calibrate(a.page);
  const wx = (sx - cal.ox) / cal.scale;
  const wy = (sy - cal.oy) / cal.scale;
  await injectSticky(a.page, { id: "s1", x: wx - 60, y: wy - 60, size: 120 });
  await a.page.mouse.click(sx, sy);
  await expect(a.page.locator(".selection-actions")).not.toHaveClass(/\bhidden\b/);
  await a.page.screenshot({ path: "test-results/tablet-touch.png" });

  await a.close();
});

test("touch: the on-screen undo/redo buttons undo and redo an edit", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("undo"), { viewport: TABLET, touch: true });

  await drawStroke(a.page); // a real, undo-tracked action → one object
  await expect.poll(() => objectIds(a.page).then((ids) => ids.length)).toBe(1);

  await a.page.locator('[data-testid="undo"]').click();
  await expect.poll(() => objectIds(a.page).then((ids) => ids.length)).toBe(0);

  await a.page.locator('[data-testid="redo"]').click();
  await expect.poll(() => objectIds(a.page).then((ids) => ids.length)).toBe(1);

  await a.close();
});
