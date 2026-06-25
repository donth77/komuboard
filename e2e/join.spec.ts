import { expect, test } from "@playwright/test";
import {
  calibrate,
  connectPeer,
  injectSticky,
  objectIds,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

/**
 * Share → join loop (M2): a link/QR joiner lands zoomed-to-fit on the board's content (instead of
 * staring at empty canvas at the default viewport), and people already in the room see a
 * "<name> joined" toast when someone new arrives.
 */

test("join: a link-joiner lands zoomed-to-fit on off-origin content", async ({ browser }) => {
  const room = uniqueRoom("joinfit");
  // Author places content far from the origin — at the default 100% viewport it's off-screen.
  const a = await connectPeer(browser, room);
  await injectSticky(a.page, { id: "s1", x: 3000, y: 2500, size: 220 });
  await injectSticky(a.page, { id: "s2", x: 3400, y: 2800, size: 220 });

  // A fresh joiner with auto-fit enabled should frame that content into view.
  const b = await connectPeer(browser, room, { autoFit: true });
  await expect.poll(() => objectIds(b.page)).toContain("s1"); // synced

  // After the fit, the off-origin sticky's centre maps onto B's viewport — at the default 100% it
  // would be thousands of px off-screen. calibrate() reads B's *current* (post-fit) transform, so we
  // poll until the fit has reframed the viewport onto the content.
  const vp = b.page.viewportSize()!;
  await expect
    .poll(async () => {
      const cal = await calibrate(b.page);
      const c = worldToScreen(cal, 3110, 2610); // centre of s1 (top-left 3000,2500 + half of 220)
      return c.x >= 0 && c.x <= vp.width && c.y >= 0 && c.y <= vp.height;
    })
    .toBe(true);
  await b.page.screenshot({ path: "test-results/join-fit.png" });

  await b.close();
  await a.close();
});

test("join: existing peers get a toast when someone new joins", async ({ browser }) => {
  const room = uniqueRoom("jointoast");
  const a = await connectPeer(browser, room);
  // Wait past A's join-settle window (first sync + 800ms) so B counts as a genuine join rather than
  // part of the initial roster A saw on connect.
  await a.page.waitForTimeout(1300);

  const b = await connectPeer(browser, room);

  const toast = a.page.locator(".join-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("joined");
  await a.page.screenshot({ path: "test-results/join-toast.png" });

  await b.close();
  await a.close();
});
