import { expect, test } from "@playwright/test";
import { type BoardWindow, connectPeer, objectIds, uniqueRoom } from "./helpers";

/**
 * Guards the incremental `renderObjects()` fast path: a move/resize updates the existing
 * Konva node in place (resetting its transient transform), and add/delete fall back to a
 * full rebuild. The key regression risk is a move rendering at double the offset because the
 * node kept its drag transform on top of the now-baked points.
 */

test("incremental render: a move repositions the node in place (no double offset)", async ({
  browser,
}) => {
  const { page, close } = await connectPeer(browser, uniqueRoom("inc"));

  // Draw a roughly horizontal stroke through the canvas centre (so we can click-drag it).
  await page.keyboard.press("p");
  const box = await page.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 110, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 40, cy);
  await page.mouse.move(cx + 30, cy);
  await page.mouse.move(cx + 110, cy);
  await page.mouse.up();

  const [id] = await objectIds(page);
  expect(id).toBeTruthy();
  const scale = await page.evaluate(
    () => (window as unknown as BoardWindow).__coboard.canvas!.getZoomPercent() / 100,
  );

  await page.keyboard.press("v"); // select tool
  const r0 = await page.evaluate(
    (id) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(id),
    id,
  );
  expect(r0).not.toBeNull();

  // Click-drag the stroke itself by a known screen delta (start on the line at the centre).
  const dxScreen = 64;
  const dyScreen = 40;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dxScreen / 2, cy + dyScreen / 2);
  await page.mouse.move(cx + dxScreen, cy + dyScreen);
  await page.mouse.up();

  const r1 = await page.evaluate(
    (id) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(id),
    id,
  );
  expect(r1).not.toBeNull();

  // Moved by exactly the world-space delta (screen / zoom) — not 2× it (a missing
  // transform-reset), and not resized.
  const wdx = dxScreen / scale;
  const wdy = dyScreen / scale;
  expect(Math.abs(r1!.x - r0!.x - wdx)).toBeLessThan(3);
  expect(Math.abs(r1!.y - r0!.y - wdy)).toBeLessThan(3);
  expect(Math.abs(r1!.width - r0!.width)).toBeLessThan(2);
  expect(Math.abs(r1!.height - r0!.height)).toBeLessThan(2);

  await close();
});

test("incremental render: add then delete-all rebuild correctly", async ({ browser }) => {
  const { page, close } = await connectPeer(browser, uniqueRoom("inc"));

  const box = await page.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Two separate strokes (each addStroke → structural rebuild).
  await page.keyboard.press("p");
  await page.mouse.move(cx - 120, cy - 60);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.move(cx - 20, cy - 70);
  await page.mouse.up();
  await page.mouse.move(cx + 40, cy + 30);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 60);
  await page.mouse.move(cx + 130, cy + 20);
  await page.mouse.up();

  const ids = await objectIds(page);
  expect(ids.length).toBe(2);
  for (const id of ids) {
    const r = await page.evaluate(
      (id) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(id),
      id,
    );
    expect(r, `stroke ${id} should be rendered`).not.toBeNull();
  }

  // Select all + delete → structural rebuild down to empty.
  await page.keyboard.press("v");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");

  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as BoardWindow).__coboard.doc.getMap("objects").size),
    )
    .toBe(0);
  for (const id of ids) {
    const r = await page.evaluate(
      (id) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(id),
      id,
    );
    expect(r, `stroke ${id} should be gone`).toBeNull();
  }

  await close();
});
