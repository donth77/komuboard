import { type Page, expect, test } from "@playwright/test";
import {
  type BoardWindow,
  calibrate,
  connectPeer,
  hasSelection,
  injectShape,
  objJSON,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

/**
 * A host's rotate/resize carries its attached stamps (FigJam): the stamp scales + repositions with a
 * resize and orbits + spins with a rotate. Driven through the real selection handles / rotate zones.
 */

const orderIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as BoardWindow).__coboard.doc.getArray("order").toArray());

async function shapeWithStamp(page: Page, stampWorld: { x: number; y: number }): Promise<string> {
  await injectShape(page, { id: "sh", x: 0, y: 0, width: 200, height: 160, bg: "#a5d8ff" });
  await expect.poll(() => page.locator('[data-id="sh"]').count()).toBe(1);
  const cal = await calibrate(page);
  await page.evaluate(() => {
    const c = (window as unknown as BoardWindow).__coboard.canvas!;
    c.setStamp("emoji:2705");
    c.setTool("stamp");
  });
  const at = worldToScreen(cal, stampWorld.x, stampWorld.y);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press("v");
  const stampId = (await orderIds(page)).at(-1)!;
  expect((await objJSON(page, stampId))!.attachedTo).toBe("sh");
  return stampId;
}

test("resizing a host shape scales + repositions its attached stamp", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("attachresize"));
  const stampId = await shapeWithStamp(a.page, { x: 150, y: 120 }); // off-centre, lower-right
  const before = (await objJSON(a.page, stampId))!;

  const cal = await calibrate(a.page);
  // Select the shape by a corner clear of the stamp, then drag its SE handle outward.
  const tl = worldToScreen(cal, 18, 18);
  await a.page.mouse.click(tl.x, tl.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  const h = await a.page.locator(".co-text-handle.h-se").boundingBox();
  expect(h).not.toBeNull();
  await a.page.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2);
  await a.page.mouse.down();
  await a.page.mouse.move(h!.x + 170, h!.y + 140, { steps: 12 });
  await a.page.mouse.up();

  const after = (await objJSON(a.page, stampId))!;
  expect(after.size as number).toBeGreaterThan((before.size as number) + 5); // the stamp grew
  expect(after.x as number).toBeGreaterThan((before.x as number) + 5); // …and moved outward
  await a.close();
});

test("rotating a host shape orbits + spins its attached stamp", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("attachrotate"));
  const stampId = await shapeWithStamp(a.page, { x: 170, y: 80 }); // off-centre so the orbit shows
  const before = (await objJSON(a.page, stampId))!;
  const x0 = before.x as number;
  const y0 = before.y as number;

  const cal = await calibrate(a.page);
  const tl = worldToScreen(cal, 18, 18);
  await a.page.mouse.click(tl.x, tl.y); // select the shape
  await expect.poll(() => hasSelection(a.page)).toBe(true);

  // Grab the bottom-right rotate zone (clear of the left tool dock) and swing it ~90° about the
  // shape centre (100,80).
  const zoneLoc = a.page.locator(".co-text-rotate.r-se");
  const zone = await zoneLoc.boundingBox();
  expect(zone).not.toBeNull();
  const centre = worldToScreen(cal, 100, 80);
  const gx = zone!.x + zone!.width / 2;
  const gy = zone!.y + zone!.height / 2;
  const r = Math.hypot(gx - centre.x, gy - centre.y);
  const a0 = Math.atan2(gy - centre.y, gx - centre.x);
  const aT = a0 + Math.PI / 2; // +90°
  await zoneLoc.hover();
  await a.page.mouse.down();
  await a.page.mouse.move(centre.x + r * Math.cos(aT), centre.y + r * Math.sin(aT), { steps: 16 });
  await a.page.mouse.up();

  const after = (await objJSON(a.page, stampId))!;
  // The stamp gained rotation and its centre moved (orbited the shape centre).
  expect(Math.round((after.rotation as number) ?? 0)).toBeGreaterThan(20);
  const moved = Math.hypot((after.x as number) - x0, (after.y as number) - y0);
  expect(moved).toBeGreaterThan(20);
  await a.close();
});
