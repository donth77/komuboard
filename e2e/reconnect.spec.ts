import { expect, test } from "@playwright/test";
import { type BoardWindow, connectPeer, injectSticky, objectIds, uniqueRoom } from "./helpers";

/**
 * Reconnection UX (M2): a dropped-then-restored connection surfaces a top-center "Reconnecting…" →
 * "Back online" pill, and edits made while offline buffer in the local Yjs doc and resync on
 * reconnect with no data loss. We drive the socket deterministically via the provider's
 * connect()/disconnect() (a real network drop auto-reconnects with backoff).
 */

test("reconnect: a dropped connection shows a Reconnecting banner, then Back online", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("reconn-ui")); // helper waits until connected

  const banner = a.page.locator(".conn-banner");
  await expect(banner).toBeHidden(); // silent on the very first connect

  // Drop the socket → the banner appears (after a short anti-flash delay).
  await a.page.evaluate(() => {
    (window as unknown as BoardWindow).__komuboard.provider.disconnect();
  });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Reconnecting");
  await a.page.screenshot({ path: "test-results/reconnect-banner.png" });

  // Reconnect → "Back online", then it auto-hides.
  await a.page.evaluate(() => {
    (window as unknown as BoardWindow).__komuboard.provider.connect();
  });
  await expect(banner).toContainText("Back online");
  await expect(banner).toBeHidden({ timeout: 4000 });

  await a.close();
});

test("reconnect: edits made while offline buffer and resync on reconnect", async ({ browser }) => {
  const room = uniqueRoom("reconn-sync");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);

  // Baseline: an online edit from A reaches B.
  await injectSticky(a.page, { id: "online1", x: 0, y: 0 });
  await expect.poll(() => objectIds(b.page)).toContain("online1");

  // A goes offline.
  await a.page.evaluate(() => {
    (window as unknown as BoardWindow).__komuboard.provider.disconnect();
  });
  await a.page.waitForFunction(
    () => !(window as unknown as BoardWindow).__komuboard.provider.wsconnected,
  );

  // An edit made while offline lives only in A's local doc — B must not see it yet.
  await injectSticky(a.page, { id: "offline1", x: 100, y: 100 });
  await expect.poll(() => objectIds(b.page)).not.toContain("offline1");

  // A reconnects → the buffered edit resyncs to B with no loss.
  await a.page.evaluate(() => {
    (window as unknown as BoardWindow).__komuboard.provider.connect();
  });
  await expect.poll(() => objectIds(b.page), { timeout: 8000 }).toContain("offline1");
  await expect.poll(() => objectIds(b.page)).toContain("online1"); // earlier edit still present

  await b.close();
  await a.close();
});
