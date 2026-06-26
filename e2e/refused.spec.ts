import { expect, test } from "@playwright/test";
import { type BoardWindow, connectPeer, uniqueRoom } from "./helpers";

/**
 * Refused-connection UX (M2): when the room DO deliberately closes us (room full = 4503 / rate-limited
 * = 4429), the client stops its auto-retry loop and shows a clear dialog instead of an endless
 * "Reconnecting…". We simulate the close by emitting the provider's own `connection-close` event so we
 * don't need a real 51-client room or a flood. See main.ts + ui/refused-dialog.ts.
 */

test("refused: a room-full (4503) close shows a dialog and stops auto-retrying", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("refused"));

  await a.page.evaluate(() => {
    const p = (window as unknown as BoardWindow).__komuboard.provider;
    p.emit("connection-close", [{ code: 4503, reason: "Room is full" }, p]);
  });

  const body = a.page.locator(".refused-body");
  await expect(body).toBeVisible();
  await expect(body).toContainText("full");
  await a.page.screenshot({ path: "test-results/refused-room-full.png" });

  // The provider stopped its reconnect loop (shouldConnect = false), so no endless "Reconnecting…".
  await expect
    .poll(() =>
      a.page.evaluate(() => (window as unknown as BoardWindow).__komuboard.provider.shouldConnect),
    )
    .toBe(false);
  // "Try again" re-arms the connection.
  await a.page.locator(".refused-footer .btn-primary").click();
  await expect(body).toBeHidden();
  await expect
    .poll(() =>
      a.page.evaluate(() => (window as unknown as BoardWindow).__komuboard.provider.shouldConnect),
    )
    .toBe(true);

  await a.close();
});

test("refused: a rate-limit (4429) close shows the disconnected dialog", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("refused2"));

  await a.page.evaluate(() => {
    const p = (window as unknown as BoardWindow).__komuboard.provider;
    p.emit("connection-close", [{ code: 4429, reason: "Rate limit exceeded" }, p]);
  });

  await expect(a.page.locator(".refused-body")).toContainText("disconnected");

  await a.close();
});
