import { expect, test } from "@playwright/test";
import { type BoardWindow, connectPeer, drawStroke, objectIds, uniqueRoom } from "./helpers";

const rectOf = (page: import("@playwright/test").Page, id: string) =>
  page.evaluate(
    (id) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(id),
    id,
  );

test("copy/paste: ⌘/Ctrl+C then +V duplicates the selection with a cascading offset", async ({
  browser,
}) => {
  const { page, close } = await connectPeer(browser, uniqueRoom("cp"));

  await drawStroke(page); // a pen stroke
  const before = await objectIds(page);
  expect(before.length).toBe(1);
  const origId = before[0]!;
  const r0 = await rectOf(page, origId);
  expect(r0).not.toBeNull();

  // Select it, copy, paste.
  await page.keyboard.press("v"); // select tool
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");

  await expect.poll(() => objectIds(page).then((ids) => ids.length)).toBe(2);
  const after = await objectIds(page);
  const newId = after.find((id) => id !== origId)!;
  expect(newId).toBeTruthy();

  const r1 = await rectOf(page, newId);
  expect(r1).not.toBeNull();
  // The copy is offset by ~+24,+24 canvas units from the original, and the same size.
  expect(Math.abs(r1!.x - (r0!.x + 24))).toBeLessThan(2);
  expect(Math.abs(r1!.y - (r0!.y + 24))).toBeLessThan(2);
  expect(Math.abs(r1!.width - r0!.width)).toBeLessThan(2);
  expect(Math.abs(r1!.height - r0!.height)).toBeLessThan(2);

  // A second paste cascades further (no exact stacking).
  await page.keyboard.press("Control+v");
  await expect.poll(() => objectIds(page).then((ids) => ids.length)).toBe(3);
  const third = (await objectIds(page)).find((id) => id !== origId && id !== newId)!;
  const r2 = await rectOf(page, third);
  expect(Math.abs(r2!.x - (r0!.x + 48))).toBeLessThan(2); // 24 × 2nd paste

  await close();
});

test("paste with an empty clipboard is a no-op", async ({ browser }) => {
  const { page, close } = await connectPeer(browser, uniqueRoom("cp-empty"));
  await drawStroke(page);
  expect((await objectIds(page)).length).toBe(1);
  await page.keyboard.press("v");
  await page.keyboard.press("Control+v"); // nothing copied yet
  await page.waitForTimeout(150);
  expect((await objectIds(page)).length).toBe(1);
  await close();
});
