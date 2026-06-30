import { expect, test } from "@playwright/test";

import { connectPeer, uniqueRoom } from "./helpers";

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 834, height: 1112 };

test("phone collapses the insert tools behind + (Hand dropped); tablet keeps all nine inline", async ({
  browser,
}) => {
  // Phone — only Select / Pen / Eraser / + show; the five insert tools and Hand are hidden.
  const phone = await connectPeer(browser, uniqueRoom("ins-phone"), {
    touch: true,
    viewport: PHONE,
  });
  await expect(phone.page.locator('komu-tool-dock [data-tool="insert"]')).toBeVisible();
  await expect(phone.page.locator('komu-tool-dock [data-tool="sticky"]')).toBeHidden();
  await expect(phone.page.locator('komu-tool-dock [data-tool="hand"]')).toBeHidden();
  await phone.close();

  // Tablet (coarse pointer, wide) — all nine inline, no + launcher (this is requested behaviour).
  const tablet = await connectPeer(browser, uniqueRoom("ins-tab"), {
    touch: true,
    viewport: TABLET,
  });
  await expect(tablet.page.locator('komu-tool-dock [data-tool="sticky"]')).toBeVisible();
  await expect(tablet.page.locator('komu-tool-dock [data-tool="hand"]')).toBeVisible();
  await expect(tablet.page.locator('komu-tool-dock [data-tool="insert"]')).toBeHidden();
  await tablet.close();
});

test("phone: + opens the insert sheet; picking Sticky activates it and the + shows it as active", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("ins-pick"), { touch: true, viewport: PHONE });
  const plus = a.page.locator('komu-tool-dock [data-tool="insert"]');
  const sheet = a.page.locator(".insert-sheet");

  await plus.click();
  await expect(sheet).not.toHaveClass(/\bhidden\b/); // launcher slid out

  await a.page.locator('.insert-btn[data-insert="sticky"]').click();
  await expect(sheet).toHaveClass(/\bhidden\b/); // launcher closed on pick
  // Sticky is now the active tool → its colour sheet is out, and the + stands in as the active marker.
  await expect(a.page.locator("komu-sticky-bar")).not.toHaveClass(/\bhidden\b/);
  await expect(plus).toHaveClass(/\bactive\b/);
  await a.close();
});

test("phone: tapping a placed shape's collapsed sheet handle re-expands it (keeps the shapes tool)", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("shp-exp"), { touch: true, viewport: PHONE });
  await a.page.locator('komu-tool-dock [data-tool="insert"]').click();
  await a.page.locator('.insert-btn[data-insert="shapes"]').click();
  const menu = a.page.locator("komu-shape-menu");

  // Place a shape (opens its label editor; onPlaced collapses the sheet).
  await a.page.mouse.click(195, 360);
  await expect(menu).toHaveClass(/\bcollapsed\b/);

  // Tapping the grab handle must EXPAND it — not commit-and-revert-to-select, which would hide it.
  // (The handle is focusable so the editor's blur keeps the tool; see ensureSheetHandle.)
  await a.page.locator("komu-shape-menu .sheet-handle").click();
  await expect(menu).not.toHaveClass(/\bcollapsed\b/); // expanded
  await expect(menu).not.toHaveClass(/\bhidden\b/); // …and still here (shapes tool kept)
  await a.close();
});

test("phone: the + stays + while the Stamp tool has nothing picked, then morphs once a stamp is armed", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("stmp-arm"), { touch: true, viewport: PHONE });
  const plus = a.page.locator('komu-tool-dock [data-tool="insert"]');
  await plus.click();
  await a.page.locator('.insert-btn[data-insert="stamp"]').click(); // stamp tool; wheel opens, nothing picked

  // Not armed → the + must NOT morph/activate into a stamp (it reverts to a plain +).
  await expect(plus).not.toHaveClass(/\bactive\b/);

  // Arm a stamp (as the wheel/picker does) → now the + morphs to the active marker.
  await a.page.evaluate(() =>
    document
      .querySelector("#app")
      ?.dispatchEvent(
        new CustomEvent("stamp-pick", { detail: { src: "emoji:128512" }, bubbles: true }),
      ),
  );
  await expect(plus).toHaveClass(/\bactive\b/);
  await a.close();
});
