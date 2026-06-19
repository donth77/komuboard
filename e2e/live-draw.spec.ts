import { expect, test } from "@playwright/test";
import { type BoardWindow, connectPeer, objectIds, uniqueRoom } from "./helpers";

/**
 * A freehand stroke must stream to peers *while* it's being drawn — not only when finished.
 * The drawer broadcasts an ephemeral `draw` (points + style) over awareness; peers render a
 * live preview keyed by the eventual stroke id, and the doc commits once via addStroke on
 * pointer-up. The preview is dropped the moment the committed node appears (clean handoff).
 */
test("a peer's stroke is visible live, before it's finished", async ({ browser }) => {
  const room = uniqueRoom("livedraw");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);

  const remoteDrawCount = (): Promise<number> =>
    b.page.evaluate(
      () => (window as unknown as BoardWindow).__coboard.canvas?.remoteDrawCount() ?? -1,
    );
  const docSize = (page = a.page): Promise<number> =>
    page.evaluate(() => (window as unknown as BoardWindow).__coboard.doc.getMap("objects").size);

  // A starts drawing — pointer DOWN + several MOVES, but does NOT release yet.
  await a.page.keyboard.press("p");
  const box = await a.page.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await a.page.mouse.move(cx - 120, cy);
  await a.page.mouse.down();
  await a.page.mouse.move(cx - 50, cy - 30);
  await a.page.waitForTimeout(60); // let a throttled draw broadcast go out
  await a.page.mouse.move(cx + 30, cy + 20);
  await a.page.waitForTimeout(60);
  await a.page.mouse.move(cx + 110, cy - 10);
  await a.page.waitForTimeout(60);

  // ★ B sees the in-progress stroke as a live preview, while it's still uncommitted.
  await expect.poll(remoteDrawCount).toBe(1);
  expect(await docSize()).toBe(0); // not committed to the doc yet (ephemeral preview only)

  // Release → the stroke commits once; B's preview is replaced by the real, synced node.
  await a.page.mouse.up();

  const [id] = await objectIds(a.page);
  expect(id).toBeTruthy();
  await expect
    .poll(() =>
      b.page.evaluate(
        (i) => (window as unknown as BoardWindow).__coboard.canvas!.nodeContentRect(i) !== null,
        id,
      ),
    )
    .toBe(true);
  await expect.poll(remoteDrawCount).toBe(0); // preview gone (handed off to the committed node)
  expect(await docSize(b.page)).toBe(1);

  await a.close();
  await b.close();
});
