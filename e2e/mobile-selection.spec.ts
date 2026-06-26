import { expect, type Page, test } from "@playwright/test";
import {
  calibrate,
  connectPeer,
  injectSticky,
  objectIds,
  objJSON,
  orderIds,
  uniqueRoom,
} from "./helpers";

/**
 * Mobile selection action bar (M2 mobile): on the phone layout, selecting an object reveals an
 * action bar in the bottom tool-sheet slot — Duplicate / Rotate / Bring-front / Send-back /
 * Group / Ungroup / Lock / Delete, the actions otherwise reachable only by keyboard. Hidden on
 * desktop. See ui/selection-bar.ts.
 */

const PHONE = { width: 390, height: 844 }; // ≤640px → mobile chrome

/** Inject a sticky under the board centre and tap it (select tool is default) → it's selected. */
async function placeAndSelectCentre(page: Page): Promise<void> {
  const box = (await page.locator("#board").boundingBox())!;
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  const cal = await calibrate(page);
  const wx = (sx - cal.ox) / cal.scale;
  const wy = (sy - cal.oy) / cal.scale;
  await injectSticky(page, { id: "s1", x: wx - 60, y: wy - 60, size: 120 });
  await page.mouse.click(sx, sy);
}

test("mobile selection bar: appears on selection; Delete removes the object + tucks the sheet away", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("selbar"), { viewport: PHONE });
  await placeAndSelectCentre(a.page);

  const bar = a.page.locator(".selection-actions");
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveClass(/\bhidden\b/); // the mini-sheet is out
  await a.page.screenshot({ path: "test-results/mobile-selection-bar.png" });

  await bar.locator('[data-act="delete"]').click();
  await expect.poll(() => objectIds(a.page)).not.toContain("s1");
  await expect(bar).toHaveClass(/\bhidden\b/); // selection gone → the sheet tucks back into the dock

  await a.close();
});

test("mobile selection bar: Duplicate makes a second copy", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("selbar2"), { viewport: PHONE });
  await placeAndSelectCentre(a.page);

  const bar = a.page.locator(".selection-actions");
  await expect(bar).toBeVisible();
  await bar.locator('[data-act="duplicate"]').click();
  await expect.poll(() => objectIds(a.page).then((ids) => ids.length)).toBe(2);

  await a.close();
});

test("desktop: the mobile selection bar stays hidden", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("selbar-desktop")); // default (desktop) viewport
  await placeAndSelectCentre(a.page);
  await expect(a.page.locator(".selection-actions")).toBeHidden(); // CSS display:none off-mobile
  await a.close();
});

test("mobile selection bar: Lock sets the object locked and the button flips to Unlock", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("sellock"), { viewport: PHONE });
  await placeAndSelectCentre(a.page);
  const bar = a.page.locator(".selection-actions");
  const lock = bar.locator('[data-act="lock"]');

  await lock.click();
  await expect.poll(() => objJSON(a.page, "s1").then((o) => o?.locked)).toBe(true);
  await expect(lock).toHaveAttribute("aria-label", "Unlock"); // the toggle now offers Unlock
  await lock.click();
  await expect.poll(() => objJSON(a.page, "s1").then((o) => o?.locked ?? false)).toBe(false);

  await a.close();
});

test("mobile selection bar: Group / Ungroup are hidden for a single selection", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("selgrp1"), { viewport: PHONE });
  await placeAndSelectCentre(a.page); // exactly one sticky selected
  const bar = a.page.locator(".selection-actions");
  await expect(bar).toBeVisible();
  await expect(bar.locator('[data-act="group"]')).toBeHidden(); // needs 2+ nodes
  await expect(bar.locator('[data-act="ungroup"]')).toBeHidden(); // needs a group
  await a.close();
});

test("mobile selection bar: Bring to front / Send to back reorder z", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("selz"), { viewport: PHONE });
  const box = (await a.page.locator("#board").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cal = await calibrate(a.page);
  const wx = (cx - cal.ox) / cal.scale;
  const wy = (cy - cal.oy) / cal.scale;
  // s1 (centre) + s2 OVERLAPPING it to the right (so z-order is meaningful → front/back show). s2 is
  // offset enough that the board centre is over s1 only. Order array reflects z (later = on top).
  await injectSticky(a.page, { id: "s1", x: wx - 60, y: wy - 60, size: 120 });
  await injectSticky(a.page, { id: "s2", x: wx + 30, y: wy - 60, size: 120 });
  expect(await orderIds(a.page)).toEqual(["s1", "s2"]);

  await a.page.mouse.click(cx, cy); // select s1 (only it is under the centre)
  const bar = a.page.locator(".selection-actions");
  await expect(bar).toBeVisible();
  await expect(bar.locator('[data-act="front"]')).toBeVisible(); // overlaps → reorder offered
  await a.page.screenshot({ path: "test-results/mobile-zorder-bar.png" });
  await bar.locator('[data-act="front"]').click();
  await expect.poll(() => orderIds(a.page)).toEqual(["s2", "s1"]); // s1 → front (end)
  await bar.locator('[data-act="back"]').click();
  await expect.poll(() => orderIds(a.page)).toEqual(["s1", "s2"]); // s1 → back (start)

  await a.close();
});

test("mobile selection bar: Bring-front / Send-back are hidden when the node overlaps nothing", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("selz0"), { viewport: PHONE });
  await placeAndSelectCentre(a.page); // a lone sticky — nothing to restack against
  const bar = a.page.locator(".selection-actions");
  await expect(bar).toBeVisible();
  await expect(bar.locator('[data-act="front"]')).toBeHidden();
  await expect(bar.locator('[data-act="back"]')).toBeHidden();
  await a.close();
});

test("mobile selection bar: Group shows with 2+ selected and groups them; Ungroup reverses", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("selgrp"), { viewport: PHONE });
  const box = (await a.page.locator("#board").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cal = await calibrate(a.page);
  const wx = (cx - cal.ox) / cal.scale;
  const wy = (cy - cal.oy) / cal.scale;
  await injectSticky(a.page, { id: "g1", x: wx - 90, y: wy - 35, size: 70 });
  await injectSticky(a.page, { id: "g2", x: wx + 20, y: wy - 35, size: 70 });

  // Marquee-drag a box around both (start on empty canvas above-left of the pair).
  await a.page.mouse.move(cx - 135, cy - 95);
  await a.page.mouse.down();
  await a.page.mouse.move(cx + 135, cy + 95, { steps: 6 });
  await a.page.mouse.up();

  const bar = a.page.locator(".selection-actions");
  await expect(bar.locator('[data-act="group"]')).toBeVisible(); // ≥2 selected → Group offered
  await bar.locator('[data-act="group"]').click();

  const g1 = await objJSON(a.page, "g1");
  const g2 = await objJSON(a.page, "g2");
  expect(g1?.groupId).toBeTruthy();
  expect(g2?.groupId).toBe(g1?.groupId);

  await expect(bar.locator('[data-act="ungroup"]')).toBeVisible(); // now grouped → Ungroup offered
  await expect(bar.locator('[data-act="group"]')).toBeHidden();
  await bar.locator('[data-act="ungroup"]').click();
  await expect.poll(() => objJSON(a.page, "g1").then((o) => o?.groupId ?? null)).toBeNull();

  await a.close();
});
