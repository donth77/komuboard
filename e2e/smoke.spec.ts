import { expect, test } from "@playwright/test";

/** Minimal shape of the window.__coboard test hook exposed by the client. */
type BoardWindow = {
  __coboard: {
    doc: {
      getMap(name: string): {
        size: number;
        values(): IterableIterator<{ get(key: string): unknown }>;
      };
    };
    provider: { wsconnected: boolean };
    awareness: { getStates(): Map<number, unknown> };
  };
};

test("two clients converge: A draws a stroke, B receives it; presence is shared", async ({
  browser,
}) => {
  const room = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await a.goto(`/?room=${room}`);
  await b.goto(`/?room=${room}`);

  // Both clients connect to the room's Durable Object.
  await a.waitForFunction(
    () => (window as unknown as BoardWindow).__coboard?.provider?.wsconnected,
  );
  await b.waitForFunction(
    () => (window as unknown as BoardWindow).__coboard?.provider?.wsconnected,
  );

  // A draws a freehand stroke. Select is the default tool, so switch to the pen first.
  await a.keyboard.press("p");
  const box = await a.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await a.mouse.move(cx - 80, cy);
  await a.mouse.down();
  await a.mouse.move(cx - 20, cy - 40);
  await a.mouse.move(cx + 40, cy + 10);
  await a.mouse.move(cx + 90, cy - 30);
  await a.mouse.up();

  // B's document converges to include the stroke (the single-source-of-truth invariant).
  await expect
    .poll(
      () =>
        b.evaluate(() => (window as unknown as BoardWindow).__coboard.doc.getMap("objects").size),
      {
        timeout: 10_000,
      },
    )
    .toBeGreaterThan(0);

  const type = await b.evaluate(() => {
    const objs = (window as unknown as BoardWindow).__coboard.doc.getMap("objects");
    const first = [...objs.values()][0];
    return first ? first.get("type") : null;
  });
  expect(type).toBe("stroke");

  // Presence: each client sees two awareness states (itself + the peer).
  await expect
    .poll(
      () =>
        a.evaluate(() => (window as unknown as BoardWindow).__coboard.awareness.getStates().size),
      {
        timeout: 10_000,
      },
    )
    .toBe(2);

  await ctxA.close();
  await ctxB.close();
});
