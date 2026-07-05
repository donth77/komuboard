import { expect, test } from "@playwright/test";

import { connectPeer, hasSelection, injectSticky, objectIds, uniqueRoom } from "./helpers";

// a11y audit #6: an open draw popover used to ignore Escape, so the global handler fell through and
// cancelled the whole tool (yanking the draw bar). Escape must now dismiss just the popover.
test("Escape closes a draw popover without cancelling the pen tool", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("drawesc"));

  await a.page.locator('komu-tool-dock [data-tool="pen"]').click();
  const drawBar = a.page.locator("komu-draw-bar");
  await expect(drawBar).toBeVisible();

  // Open the line-style popover.
  await a.page.locator('komu-draw-bar [data-pop="style"]').click();
  await expect(a.page.locator(".db-popover")).toBeVisible();

  // Escape dismisses the popover …
  await a.page.keyboard.press("Escape");
  await expect(a.page.locator(".db-popover")).toHaveCount(0);
  // … and the pen tool (its bar) is still active — Escape no longer yanks the whole tool.
  await expect(drawBar).toBeVisible();

  await a.close();
});

// a11y audit #2: the canvas was pointer-only to select, so every object shortcut (delete/nudge/…)
// was dead for keyboard users. The offscreen mirror's items are now focusable and select on the
// canvas, so the shortcuts work.
test("keyboard selection via the a11y mirror: focus an item selects it, Delete removes it", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("kbdsel"));
  await injectSticky(a.page, { id: "s1", x: 220, y: 220, bg: "#ffd43b" });
  await injectSticky(a.page, { id: "s2", x: 520, y: 220, bg: "#a5d8ff" });

  // The mirror rebuilds (debounced) into one focusable button per object.
  const item = a.page.locator('#board-a11y-mirror button[data-object-id="s1"]');
  await expect(item).toHaveCount(1);

  // Focusing the item selects that object on the canvas …
  await item.focus();
  await expect.poll(() => hasSelection(a.page)).toBe(true);

  // … so the existing Delete shortcut removes it (and leaves the other one).
  await a.page.keyboard.press("Delete");
  await expect.poll(async () => (await objectIds(a.page)).includes("s1")).toBe(false);
  expect(await objectIds(a.page)).toContain("s2");

  await a.close();
});
