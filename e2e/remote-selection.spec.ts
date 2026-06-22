import { expect, test } from "@playwright/test";
import {
  type BoardWindow,
  connectPeer,
  drawStroke,
  objectIds,
  remoteSelectionCount,
  uniqueRoom,
} from "./helpers";

test("a peer's selection is broadcast and rendered on the other client", async ({ browser }) => {
  const room = uniqueRoom("e2e-sel");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);

  // A draws a stroke; B's doc converges to include it.
  const { cx, cy } = await drawStroke(a.page);
  await expect
    .poll(
      () =>
        b.page.evaluate(
          () => (window as unknown as BoardWindow).__komuboard.doc.getMap("objects").size,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  const [strokeId] = await objectIds(b.page);
  expect(strokeId).toBeTruthy();

  // A selects the stroke (⌘/Ctrl+A → selectAll → publishSelection over awareness).
  await a.page.keyboard.press("Control+a");

  // A's own awareness now advertises the selected id.
  await expect
    .poll(
      () =>
        a.page.evaluate(
          () =>
            (window as unknown as BoardWindow).__komuboard.awareness.getLocalState()?.selection ??
            null,
        ),
      { timeout: 5_000 },
    )
    .toEqual([strokeId]);

  // B receives A's selection on the awareness channel (excluding B's own state).
  await expect
    .poll(
      () =>
        b.page.evaluate(() => {
          const aw = (window as unknown as BoardWindow).__komuboard.awareness;
          for (const [id, st] of aw.getStates()) {
            if (id !== aw.clientID && st.selection?.length) return st.selection;
          }
          return null;
        }),
      { timeout: 5_000 },
    )
    .toEqual([strokeId]);

  // ...and B actually RENDERS an outline for it (the new presence chrome).
  await expect.poll(() => remoteSelectionCount(b.page), { timeout: 5_000 }).toBe(1);

  // A's cursor activity fires frequent awareness ticks; the render-side dedup must NOT
  // drop B's outline (the rebuild is skipped, the existing rect stays).
  await a.page.mouse.move(cx + 12, cy + 12);
  await a.page.mouse.move(cx - 12, cy - 12);
  await a.page.mouse.move(cx + 24, cy - 6);
  await expect.poll(() => remoteSelectionCount(b.page), { timeout: 3_000 }).toBe(1);

  // When A clears its selection (Escape), B's outline goes away.
  await a.page.keyboard.press("Escape");
  await expect.poll(() => remoteSelectionCount(b.page), { timeout: 5_000 }).toBe(0);

  // Re-selecting after a clear must render again — the render cache transitions
  // ""→ids→""→ids and never gets stuck on a stale signature.
  await a.page.keyboard.press("Control+a");
  await expect.poll(() => remoteSelectionCount(b.page), { timeout: 5_000 }).toBe(1);

  // Marquee selection (the rate-capped broadcast path): A drags a rubber-band over the
  // stroke. Broadcasts are throttled mid-drag, but endMarquee flushes the settled
  // selection, so B must still converge to the outline.
  await a.page.keyboard.press("Escape");
  await a.page.keyboard.press("v"); // select tool (A was on pen from drawing)
  await a.page.mouse.move(cx - 150, cy - 110);
  await a.page.mouse.down();
  await a.page.mouse.move(cx - 40, cy - 40);
  await a.page.mouse.move(cx + 60, cy + 20);
  await a.page.mouse.move(cx + 150, cy + 110);
  await a.page.mouse.up();
  await expect.poll(() => remoteSelectionCount(b.page), { timeout: 5_000 }).toBe(1);

  await a.close();
  await b.close();
});

test("a peer's selection ring follows a stroke being dragged (not frozen at the start)", async ({
  browser,
}) => {
  const room = uniqueRoom("e2e-selglide");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);

  // A draws a horizontal stroke through the canvas centre (so a click at the centre hits it).
  await a.page.keyboard.press("p");
  const box = (await a.page.locator("#board").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await a.page.mouse.move(cx - 110, cy);
  await a.page.mouse.down();
  await a.page.mouse.move(cx - 40, cy);
  await a.page.mouse.move(cx + 30, cy);
  await a.page.mouse.move(cx + 110, cy);
  await a.page.mouse.up();
  expect((await objectIds(a.page))[0]).toBeTruthy();

  const ringX = (): Promise<number | null> =>
    b.page.evaluate(() =>
      (window as unknown as BoardWindow).__komuboard.canvas!.remoteSelectionRectX(),
    );

  // A selects + drags the stroke in ONE gesture (the down selects, the moves drag — a separate click
  // first would register as a two-click). Hold mid-drag.
  await a.page.keyboard.press("v");
  await a.page.mouse.move(cx, cy);
  await a.page.mouse.down(); // selects the stroke → publishes A's selection
  await expect.poll(() => remoteSelectionCount(b.page)).toBeGreaterThan(0);
  const x0 = await ringX(); // ring at the drag-start position
  expect(x0).not.toBeNull();
  await a.page.mouse.move(cx + 120, cy, { steps: 10 }); // drag right, still holding
  await a.page.waitForTimeout(120);

  // ★ B's ring must have followed the drag (the bug: it stayed frozen at the start position).
  await expect
    .poll(async () => {
      const x = await ringX();
      return x !== null && x0 !== null ? Math.round(x - x0) : 0;
    })
    .toBeGreaterThan(60);

  await a.page.mouse.up();
  await a.close();
  await b.close();
});
