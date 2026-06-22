import { expect, test } from "@playwright/test";
import {
  type BoardWindow,
  connectPeer,
  drawStroke,
  hasSelection,
  objectIds,
  remoteSelectionCount,
  uniqueRoom,
} from "./helpers";

/**
 * Last-writer-wins selection ownership: when a second user selects a node the first user
 * already had selected, the newer selection takes it over and the first user's transform box
 * is released. This is what stops the original user's box from lingering at the old spot while
 * the new user drags the node away.
 */
test("a newer selection overrides an older one (last-writer-wins ownership)", async ({
  browser,
}) => {
  const room = uniqueRoom("e2e-override");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);

  // A draws a stroke; B's doc converges to include it.
  await drawStroke(a.page);
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

  // A selects it → A owns it; B renders A's outline.
  await a.page.keyboard.press("Control+a");
  await expect.poll(() => hasSelection(a.page), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => remoteSelectionCount(b.page), { timeout: 5_000 }).toBe(1);

  // B selects the SAME stroke. B is the newer selector, so A must yield it: A's transform
  // box detaches and A stops advertising the selection.
  await b.page.keyboard.press("Control+a");
  await expect.poll(() => hasSelection(b.page), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => hasSelection(a.page), { timeout: 5_000 }).toBe(false); // ← the override

  // Presence flips: A now sees B's outline; B sees none (A released the node).
  await expect.poll(() => remoteSelectionCount(a.page), { timeout: 5_000 }).toBe(1);
  await expect.poll(() => remoteSelectionCount(b.page), { timeout: 5_000 }).toBe(0);

  // …and A's awareness no longer carries the selection.
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
    .toBeNull();

  await a.close();
  await b.close();
});
