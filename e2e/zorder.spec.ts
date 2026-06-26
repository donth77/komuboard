import { expect, test } from "@playwright/test";
import { calibrate, connectPeer, injectSticky, orderIds, uniqueRoom } from "./helpers";

/**
 * Z-order keyboard shortcuts (desktop): ⌘⇧] brings the selection to the front of the order array
 * (rendered last = on top), ⌘⇧[ sends it to the back. See main.ts + schema bringToFront/sendToBack.
 */
test("z-order: cmd-shift-] brings to front, cmd-shift-[ sends to back", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("zkbd"));
  const box = (await a.page.locator("#board").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cal = await calibrate(a.page);
  const wx = (cx - cal.ox) / cal.scale;
  const wy = (cy - cal.oy) / cal.scale;
  await injectSticky(a.page, { id: "s1", x: wx - 60, y: wy - 60, size: 120 });
  await injectSticky(a.page, { id: "s2", x: wx + 80, y: wy - 60, size: 120 });
  expect(await orderIds(a.page)).toEqual(["s1", "s2"]);

  await a.page.mouse.click(cx, cy); // select s1 (the back one)
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  await a.page.keyboard.press(`${mod}+Shift+BracketRight`); // bring to front
  await expect.poll(() => orderIds(a.page)).toEqual(["s2", "s1"]);

  await a.page.keyboard.press(`${mod}+Shift+BracketLeft`); // send to back
  await expect.poll(() => orderIds(a.page)).toEqual(["s1", "s2"]);

  await a.close();
});
