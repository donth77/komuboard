import { expect, test } from "@playwright/test";

import { connectPeer, uniqueRoom } from "./helpers";

// Regression: on a phone the stamp wheel inherits pointer-events:none from .sheet-wrap (which keeps
// the canvas interactive around the bottom sheets). The outer wedges re-enable pe:auto themselves,
// but the inner buttons (recent emojis + "+") did not — so tapping "+" fell through to the canvas
// and never opened the emoji picker. See .komu-stamp-wheel button { pointer-events: auto }.
test("mobile: tapping the wheel's + opens the emoji picker", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("emoji-mobile"), {
    viewport: { width: 390, height: 844 },
    touch: true,
  });
  // Phone: the insert tools collapse behind the "+" launcher → open it, pick Stamp.
  await a.page.locator('komu-tool-dock [data-tool="insert"]').tap();
  await a.page.locator('.insert-sheet [data-insert="stamp"]').tap();
  await expect(a.page.locator("komu-stamp-wheel")).toBeVisible();
  await a.page.waitForTimeout(1000); // let the wheel's entrance animation finish

  await expect(a.page.locator("komu-emoji-picker")).toBeHidden();
  await a.page.locator(".sw-plus").tap();
  await expect(a.page.locator("komu-emoji-picker")).toBeVisible();

  await a.close();
});
