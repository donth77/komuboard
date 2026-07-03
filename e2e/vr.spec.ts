import { expect, test } from "@playwright/test";

import { connectPeer, injectSticky, uniqueRoom } from "./helpers";

/**
 * VR entry flow (M4 stage 2): the drawer's "Enter VR" item lazy-loads the A-Frame scene showing the
 * board as a textured panel. Headless has no WebXR, so this exercises the magic-window 3D preview
 * path; Exit tears the scene down and the 2D app is untouched underneath.
 */
test("enter VR: drawer item opens the 3D preview with the board panel; Exit restores 2D", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const a = await connectPeer(browser, uniqueRoom("vr"));
  // Centre of the default camera's world viewport → lands dead-centre on the VR panel texture.
  await injectSticky(a.page, { id: "v1", x: -90, y: -90, bg: "#ffd43b" });
  await expect(a.page.locator(".komu-text")).toBeVisible();

  // Open the hamburger menu → Enter VR (the desktop hamburger opens the app menu; the same
  // data-act item lives in the mobile drawer).
  await a.page.locator("#nav-toggle").click();
  await a.page.locator('.app-menu [data-act="vr"]').click();

  // The A-Frame scene mounts (lazy bundle) with the board panel + our Exit control.
  await expect(a.page.locator("a-scene")).toBeVisible({ timeout: 30_000 });
  await expect(a.page.locator("#vr-board")).toBeAttached();
  await expect(a.page.locator(".vr-exit")).toBeVisible();

  // The texture canvas exists and actually has board pixels (the sticky's yellow).
  await expect
    .poll(
      () =>
        a.page.evaluate(() => {
          const cv = document.getElementById("vr-board-canvas") as HTMLCanvasElement | null;
          if (!cv) return false;
          const d = cv.getContext("2d")?.getImageData(0, 0, cv.width, cv.height).data;
          if (!d) return false;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i] as number;
            const g = d[i + 1] as number;
            const b = d[i + 2] as number;
            if (r > 200 && g > 150 && b < 120) return true; // sticky yellow
          }
          return false;
        }),
      { timeout: 15_000 },
    )
    .toBe(true);

  await a.page.screenshot({ path: "test-results/vr-preview.png" });

  // Exit → the scene + texture canvas are gone, the 2D board still shows the sticky.
  await a.page.locator(".vr-exit").click();
  await expect(a.page.locator("a-scene")).toHaveCount(0);
  await expect(a.page.locator("#vr-board-canvas")).toHaveCount(0);
  await expect(a.page.locator(".komu-text")).toBeVisible();
  await a.close();
});
