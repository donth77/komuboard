import { expect, test } from "@playwright/test";

import {
  calibrate,
  connectPeer,
  hasSelection,
  injectSticky,
  objectIds,
  objJSON,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

/** Click the centre of the sticky injected at world (x, y, size 180) to select it. */
async function selectStickyAt(
  page: import("@playwright/test").Page,
  x: number,
  y: number,
): Promise<{ cx: number; cy: number }> {
  const cal = await calibrate(page);
  const c = worldToScreen(cal, x + 90, y + 90);
  await page.mouse.click(c.x, c.y);
  await expect.poll(() => hasSelection(page)).toBe(true);
  return { cx: c.x, cy: c.y };
}

test("nudge: arrows move the selection 1px, Shift+arrows 10px", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("nudge"));
  await injectSticky(a.page, { id: "n1", x: 300, y: 200 });
  await expect(a.page.locator(".komu-text")).toBeVisible();
  await selectStickyAt(a.page, 300, 200);

  await a.page.keyboard.press("ArrowRight");
  await a.page.keyboard.press("ArrowRight");
  await a.page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => (await objJSON(a.page, "n1")) as { x: number })
    .toMatchObject({
      x: 302,
      y: 201,
    });

  await a.page.keyboard.press("Shift+ArrowLeft");
  await a.page.keyboard.press("Shift+ArrowUp");
  await expect
    .poll(async () => (await objJSON(a.page, "n1")) as { x: number })
    .toMatchObject({
      x: 292,
      y: 191,
    });
  await a.close();
});

test("esc: reverts a non-select tool to Select, then a second Esc clears the selection", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("esc"));
  await injectSticky(a.page, { id: "e1", x: 300, y: 200 });
  await expect(a.page.locator(".komu-text")).toBeVisible();

  // Non-select tool active → Esc reverts to Select.
  await a.page.keyboard.press("p");
  await expect(a.page.locator('komu-tool-dock [data-tool="pen"]')).toHaveClass(/active/);
  await a.page.keyboard.press("Escape");
  await expect(a.page.locator('komu-tool-dock [data-tool="select"]')).toHaveClass(/active/);

  // With Select already active: Esc clears the selection.
  await selectStickyAt(a.page, 300, 200);
  await a.page.keyboard.press("Escape");
  await expect.poll(() => hasSelection(a.page)).toBe(false);
  await a.close();
});

test("alt-drag: duplicates the selection — the original stays, the copy moves", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("altdrag"));
  await injectSticky(a.page, { id: "d1", x: 300, y: 200 });
  await expect(a.page.locator(".komu-text")).toBeVisible();

  const cal = await calibrate(a.page);
  const c = worldToScreen(cal, 390, 290); // sticky centre
  await a.page.keyboard.down("Alt");
  await a.page.mouse.move(c.x, c.y);
  await a.page.mouse.down();
  await a.page.mouse.move(c.x + 120, c.y + 60, { steps: 8 });
  await a.page.mouse.up();
  await a.page.keyboard.up("Alt");

  await expect.poll(async () => (await objectIds(a.page)).length).toBe(2);
  // The original never moved; the copy carried the drag.
  expect(await objJSON(a.page, "d1")).toMatchObject({ x: 300, y: 200 });
  const ids = await objectIds(a.page);
  const copyId = ids.find((i) => i !== "d1");
  expect(copyId).toBeTruthy();
  const copy = (await objJSON(a.page, copyId as string)) as { x: number; y: number };
  expect(copy.x).toBeGreaterThan(360); // dragged ~120 screen px right at 100% zoom
  expect(copy.y).toBeGreaterThan(230);
  await a.close();
});

test("context menu: right-click an object → Delete removes it", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("ctxdel"));
  await injectSticky(a.page, { id: "c1", x: 300, y: 200 });
  await expect(a.page.locator(".komu-text")).toBeVisible();

  const cal = await calibrate(a.page);
  const c = worldToScreen(cal, 390, 290); // sticky centre
  await a.page.mouse.click(c.x, c.y, { button: "right" });
  await expect(a.page.locator(".ctx-menu")).toBeVisible();
  // Right-clicking an unselected object selects it (menu acts on the selection).
  expect(await hasSelection(a.page)).toBe(true);

  await a.page.locator('.ctx-item[data-act="remove"]').click();
  await expect(a.page.locator(".ctx-menu")).toHaveCount(0);
  await expect.poll(() => objectIds(a.page)).toEqual([]);
  await a.close();
});

test("context menu: object → Duplicate makes an offset copy", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("ctxdup"));
  await injectSticky(a.page, { id: "c2", x: 300, y: 200 });
  await expect(a.page.locator(".komu-text")).toBeVisible();

  const cal = await calibrate(a.page);
  const c = worldToScreen(cal, 390, 290);
  await a.page.mouse.click(c.x, c.y, { button: "right" });
  await a.page.locator('.ctx-item[data-act="duplicate"]').click();
  await expect.poll(async () => (await objectIds(a.page)).length).toBe(2);
  await a.close();
});

test("context menu: right-click empty canvas → Select all; Esc closes without clearing", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("ctxcanvas"));
  await injectSticky(a.page, { id: "c3", x: 300, y: 200 });
  await injectSticky(a.page, { id: "c4", x: 600, y: 500 });
  await expect.poll(async () => (await objectIds(a.page)).length).toBe(2);

  // Right-click the visible board centre — guaranteed on-screen and clear of both stickies
  // (sticky c3 spans world 300-480 × 200-380, c4 spans 600-780 × 500-680).
  const box = (await a.page.locator("#board").boundingBox())!;
  await a.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await expect(a.page.locator(".ctx-menu")).toBeVisible();
  // The canvas variant has Select all but no Delete.
  await expect(a.page.locator('.ctx-item[data-act="selectAll"]')).toBeVisible();
  await expect(a.page.locator('.ctx-item[data-act="remove"]')).toHaveCount(0);

  await a.page.locator('.ctx-item[data-act="selectAll"]').click();
  await expect.poll(() => hasSelection(a.page)).toBe(true);

  // Re-open on an object, then Escape: the menu closes but the selection survives (the menu
  // swallows that Escape).
  const cal = await calibrate(a.page);
  const c = worldToScreen(cal, 390, 290);
  await a.page.mouse.click(c.x, c.y, { button: "right" });
  await expect(a.page.locator(".ctx-menu")).toBeVisible();
  await a.page.keyboard.press("Escape");
  await expect(a.page.locator(".ctx-menu")).toHaveCount(0);
  expect(await hasSelection(a.page)).toBe(true);
  await a.close();
});
