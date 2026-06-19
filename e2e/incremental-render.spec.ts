import { expect, test } from "@playwright/test";

/**
 * Guards the incremental `renderObjects()` fast path: a move/resize updates the existing
 * Konva node in place (resetting its transient transform), and add/delete fall back to a
 * full rebuild. The key regression risk is a move rendering at double the offset because the
 * node kept its drag transform on top of the now-baked points.
 */
type BoardWindow = {
  __coboard: {
    doc: { getMap(name: string): { size: number; keys(): IterableIterator<string> } };
    provider: { wsconnected: boolean };
    canvas?: {
      nodeContentRect(id: string): { x: number; y: number; width: number; height: number } | null;
      getZoomPercent(): number;
    };
  };
};

test("incremental render: a move repositions the node in place (no double offset)", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/?room=inc-${Math.random().toString(36).slice(2, 8)}`);
  await p.waitForFunction(() => !!(window as unknown as BoardWindow).__coboard?.canvas);

  // Draw a roughly horizontal stroke through the canvas centre.
  await p.keyboard.press("p");
  const box = await p.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.mouse.move(cx - 110, cy);
  await p.mouse.down();
  await p.mouse.move(cx - 40, cy);
  await p.mouse.move(cx + 30, cy);
  await p.mouse.move(cx + 110, cy);
  await p.mouse.up();

  const { id, scale } = await p.evaluate(() => {
    const cb = (window as unknown as BoardWindow).__coboard;
    return {
      id: [...cb.doc.getMap("objects").keys()][0],
      scale: cb.canvas!.getZoomPercent() / 100,
    };
  });
  expect(id).toBeTruthy();

  await p.keyboard.press("v"); // select tool
  const r0 = await p.evaluate(
    (id) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(id),
    id,
  );
  expect(r0).not.toBeNull();

  // Click-drag the stroke itself by a known screen delta (start on the line at the centre).
  const dxScreen = 64;
  const dyScreen = 40;
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  await p.mouse.move(cx + dxScreen / 2, cy + dyScreen / 2);
  await p.mouse.move(cx + dxScreen, cy + dyScreen);
  await p.mouse.up();

  const r1 = await p.evaluate(
    (id) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(id),
    id,
  );
  expect(r1).not.toBeNull();

  // The node should have moved by exactly the world-space delta (screen / zoom) — not 2× it
  // (which is what a missing transform-reset would produce), and not changed size.
  const wdx = dxScreen / scale;
  const wdy = dyScreen / scale;
  expect(Math.abs(r1!.x - r0!.x - wdx)).toBeLessThan(3);
  expect(Math.abs(r1!.y - r0!.y - wdy)).toBeLessThan(3);
  expect(Math.abs(r1!.width - r0!.width)).toBeLessThan(2);
  expect(Math.abs(r1!.height - r0!.height)).toBeLessThan(2);

  await ctx.close();
});

test("incremental render: add then delete-all rebuild correctly", async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/?room=inc-${Math.random().toString(36).slice(2, 8)}`);
  await p.waitForFunction(() => !!(window as unknown as BoardWindow).__coboard?.canvas);

  const box = await p.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Two separate strokes (each addStroke → structural rebuild).
  await p.keyboard.press("p");
  await p.mouse.move(cx - 120, cy - 60);
  await p.mouse.down();
  await p.mouse.move(cx - 60, cy - 40);
  await p.mouse.move(cx - 20, cy - 70);
  await p.mouse.up();
  await p.mouse.move(cx + 40, cy + 30);
  await p.mouse.down();
  await p.mouse.move(cx + 90, cy + 60);
  await p.mouse.move(cx + 130, cy + 20);
  await p.mouse.up();

  const ids = await p.evaluate(() => [
    ...(window as unknown as BoardWindow).__coboard.doc.getMap("objects").keys(),
  ]);
  expect(ids.length).toBe(2);
  for (const id of ids) {
    const r = await p.evaluate(
      (id) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(id),
      id,
    );
    expect(r, `stroke ${id} should be rendered`).not.toBeNull();
  }

  // Select all + delete → structural rebuild down to empty.
  await p.keyboard.press("v");
  await p.keyboard.press("Control+a");
  await p.keyboard.press("Delete");

  await expect
    .poll(() =>
      p.evaluate(() => (window as unknown as BoardWindow).__coboard.doc.getMap("objects").size),
    )
    .toBe(0);
  for (const id of ids) {
    const r = await p.evaluate(
      (id) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(id),
      id,
    );
    expect(r, `stroke ${id} should be gone`).toBeNull();
  }

  await ctx.close();
});
