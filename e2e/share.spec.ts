import { expect, test } from "@playwright/test";
import { connectPeer, uniqueRoom } from "./helpers";

/**
 * Share flow (M2): the topbar Share button opens a "Share this board" dialog with the room link, a
 * locally-generated QR code (join on mobile/VR), a Copy-link control, and the no-signup helper.
 */
test("share: the topbar button opens a dialog with the room link, a QR, and Copy-link", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("share"));

  // Open the Share dialog from the topbar.
  await a.page.locator('[data-testid="share"]').click();
  await expect(a.page.locator(".share-body")).toBeVisible();

  // The room link is shown (and is the current room URL).
  const room = new URL(a.page.url()).searchParams.get("room");
  expect(room).toBeTruthy();
  await expect(a.page.locator(".share-url")).toHaveValue(new RegExp(`room=${room}`));

  // A QR code is rendered locally (an SVG), plus the join caption + no-signup helper.
  expect(await a.page.locator(".share-qr svg").count()).toBe(1);
  await expect(a.page.locator(".share-cap")).toContainText("Scan to join");
  await expect(a.page.locator(".share-helper")).toContainText("anyone with the link can edit");

  await a.page.screenshot({ path: "test-results/share-dialog.png" });

  // Copy link → confirmation.
  await a.page.locator(".share-copy").click();
  await expect(a.page.locator(".share-copy")).toHaveText("Copied!");

  // Esc closes the dialog (reusable <komu-dialog> behaviour).
  await a.page.keyboard.press("Escape");
  await expect(a.page.locator(".share-body")).toBeHidden();

  await a.close();
});
