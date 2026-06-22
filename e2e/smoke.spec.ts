import { expect, test } from "@playwright/test";
import { type BoardWindow, connectPeer, drawStroke, uniqueRoom } from "./helpers";

test("two clients converge: A draws a stroke, B receives it; presence is shared", async ({
  browser,
}) => {
  const room = uniqueRoom("e2e");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);

  await drawStroke(a.page);

  // B's document converges to include the stroke (the single-source-of-truth invariant).
  await expect
    .poll(
      () =>
        b.page.evaluate(
          () => (window as unknown as BoardWindow).__komuboard.doc.getMap("objects").size,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  const type = await b.page.evaluate(() => {
    const objs = (window as unknown as BoardWindow).__komuboard.doc.getMap("objects");
    const first = [...objs.values()][0];
    return first ? first.get("type") : null;
  });
  expect(type).toBe("stroke");

  // Presence: each client sees two awareness states (itself + the peer).
  await expect
    .poll(
      () =>
        b.page.evaluate(
          () => (window as unknown as BoardWindow).__komuboard.awareness.getStates().size,
        ),
      { timeout: 10_000 },
    )
    .toBe(2);

  await a.close();
  await b.close();
});
