import { expect, test } from "@playwright/test";
import {
  calibrate,
  connectPeer,
  hasSelection,
  injectStamp,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

/**
 * A peer's IN-PROGRESS stamp rotation must show on the other client in realtime (not only after the
 * release commit). Regression for the bug where relayoutBox — which applies a peer's live rotation —
 * bailed on stamps (its `type !== "text"` guard excluded them), so a remote stamp spin never streamed.
 */
test("a peer's live stamp rotation streams in realtime", async ({ browser }) => {
  const room = uniqueRoom("rotrt");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);
  await injectStamp(a.page, { id: "st", x: 100, y: 100, size: 90 });
  await expect.poll(() => b.page.locator('[data-id="st"]').count()).toBe(1);

  // A selects the stamp and starts rotating it, holding mid-gesture (no release).
  const cal = await calibrate(a.page);
  const c = worldToScreen(cal, 100, 100);
  await a.page.keyboard.press("v");
  await a.page.mouse.click(c.x, c.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  const zoneLoc = a.page.locator(".co-text-rotate.r-se");
  expect(await zoneLoc.count()).toBe(1); // a stamp has the same rotate zones as any box
  const z = (await zoneLoc.boundingBox())!;
  const gx = z.x + z.width / 2;
  const gy = z.y + z.height / 2;
  const r = Math.hypot(gx - c.x, gy - c.y);
  const a0 = Math.atan2(gy - c.y, gx - c.x);
  const aT = a0 + Math.PI / 2; // swing +90°
  await zoneLoc.hover();
  await a.page.mouse.down();
  await a.page.mouse.move(c.x + r * Math.cos(aT), c.y + r * Math.sin(aT), { steps: 12 });

  // B applies the live rotation to the stamp box (inline transform set by applyRotation) — the fix.
  await expect
    .poll(() =>
      b.page.evaluate(() => {
        const el = document.querySelector('[data-id="st"]') as HTMLElement | null;
        return el?.style.transform ?? "";
      }),
    )
    .toContain("rotate");

  await a.page.mouse.up();
  await a.close();
  await b.close();
});
