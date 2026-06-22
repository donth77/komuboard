import { type Page, expect, test } from "@playwright/test";
import {
  type BoardWindow,
  calibrate,
  connectPeer,
  injectSticky,
  objJSON,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

/**
 * Stamps stick to the sticky/shape they're dropped on (FigJam): the stamp attaches to that object so
 * it rides the host's moves and is deleted with it, while remaining its own individually-selectable
 * node. Covers placement (sets attachedTo), move propagation, and delete cascade through the real UI.
 */

const orderIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as BoardWindow).__komuboard.doc.getArray("order").toArray());

async function placeStampOnSticky(page: Page): Promise<string> {
  await injectSticky(page, { id: "s1", x: 0, y: 0, size: 180, bg: "#ffec99" });
  await expect.poll(() => page.locator('[data-id="s1"]').count()).toBe(1);
  const cal = await calibrate(page);
  await page.evaluate(() => {
    const c = (window as unknown as BoardWindow).__komuboard.canvas!;
    c.setStamp("emoji:2705");
    c.setTool("stamp");
  });
  const at = worldToScreen(cal, 90, 90); // centre of the sticky
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press("v"); // back to select
  const order = await orderIds(page);
  return order[order.length - 1]!; // the stamp, placed last
}

test("stamp dropped on a sticky attaches and rides the sticky's move", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("attachmove"));
  const stampId = await placeStampOnSticky(a.page);

  // Placement set attachedTo to the sticky underneath.
  const placed = await objJSON(a.page, stampId);
  expect(placed!.type).toBe("stamp");
  expect(placed!.attachedTo).toBe("s1");
  const x0 = placed!.x as number;

  // Drag the sticky by its top-left corner (not under the stamp) → the stamp must follow.
  const cal = await calibrate(a.page);
  const grab = worldToScreen(cal, 30, 30);
  await a.page.mouse.move(grab.x, grab.y);
  await a.page.mouse.down();
  await a.page.mouse.move(grab.x + 120, grab.y, { steps: 10 });
  await a.page.mouse.up();

  await expect
    .poll(async () => Math.round(((await objJSON(a.page, stampId))!.x as number) - x0))
    .toBeGreaterThan(90); // followed the sticky ~120px right
  // …and the sticky itself moved.
  expect((await objJSON(a.page, "s1"))!.x as number).toBeGreaterThan(90);

  await a.close();
});

test("deleting the host sticky deletes the attached stamp (but it's its own node)", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("attachdel"));
  const stampId = await placeStampOnSticky(a.page);
  expect((await objJSON(a.page, stampId))!.attachedTo).toBe("s1");

  // The stamp is independently selectable — clicking it selects the stamp, not the sticky.
  const cal = await calibrate(a.page);
  const onStamp = worldToScreen(cal, 90, 90);
  await a.page.mouse.click(onStamp.x, onStamp.y);
  await expect
    .poll(() =>
      a.page.evaluate(
        () => (window as unknown as BoardWindow).__komuboard.canvas!.textLayer.selectedIds().length,
      ),
    )
    .toBe(1);

  // Select the sticky by a corner (clear of the stamp) and delete it → the stamp goes with it.
  const corner = worldToScreen(cal, 25, 25);
  await a.page.mouse.click(corner.x, corner.y);
  await a.page.keyboard.press("Delete");

  await expect.poll(async () => (await objJSON(a.page, "s1")) === null).toBe(true);
  await expect.poll(async () => (await objJSON(a.page, stampId)) === null).toBe(true);

  await a.close();
});
