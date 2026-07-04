import { expect, test } from "@playwright/test";

import { connectPeer, uniqueRoom } from "./helpers";

// Regression guard for the "toolbar completely missing on tall phones" bug: the mobile tool dock is
// bottom-anchored inside #app. When #app used 100vh (the LARGE viewport) the dock was pushed below the
// fold behind the browser's URL bar on devices like the Pixel 8 Pro. #app now uses 100dvh (the
// visible viewport). Headless Chromium has no dynamic URL bar (100vh == 100dvh), so this can't
// reproduce the exact overshoot — but it locks in that the dock renders fully ON-SCREEN at a
// phone-sized viewport, catching any future rule that pushes it off the bottom/top.
test("mobile tool dock is fully within the viewport on a tall phone", async ({ browser }) => {
  const height = 892; // Pixel 8 Pro portrait CSS height
  const width = 412;
  const a = await connectPeer(browser, uniqueRoom("mdock"), {
    touch: true,
    viewport: { width, height },
  });
  const dock = a.page.locator(".dock");
  await expect(dock).toBeVisible();
  const box = (await dock.boundingBox())!;
  expect(box).toBeTruthy();
  // Fully on-screen: not clipped off the bottom (the reported failure) or the top.
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
  // And it carries actual tool buttons (not an empty/zero-size shell).
  expect(box.height).toBeGreaterThan(20);
  expect(await a.page.locator(".dock .tool").count()).toBeGreaterThan(0);

  // The Hand (pan) tool is present on the phone dock (two-finger pan isn't discoverable), and the
  // topbar carries the on-screen Reset-view (zoom-to-fit) button next to undo/redo.
  await expect(a.page.locator('.dock .tool[data-tool="hand"]')).toBeVisible();
  await expect(a.page.locator('[data-testid="reset-view"]')).toBeVisible();
  await a.close();
});
