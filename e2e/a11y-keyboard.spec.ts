import { expect, test } from "@playwright/test";

import { connectPeer, uniqueRoom } from "./helpers";

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
