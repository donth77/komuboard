import { expect, test } from "@playwright/test";

import { connectPeer, injectSticky, objectIds, uniqueRoom } from "./helpers";

// Minimal structural types for the browser-side Yjs doc used inside page.evaluate (types are erased,
// so this stays framework-free without pulling `yjs` into the evaluate closure).
interface YMapLike {
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
interface YDocLike {
  getMap(name: string): YMapLike;
  getArray(name: string): { push(items: unknown[]): void };
  transact(fn: () => void): void;
}

// The offscreen semantic mirror makes the opaque canvas navigable to screen readers (docs/07 §5.1):
// each board object becomes a labelled list item, kept in sync with the Yjs doc, and the board <main>
// carries descriptive roles.
test("board a11y: the semantic mirror lists + labels objects and updates on change", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("a11y"));

  // The board <main> is described for AT.
  const board = a.page.locator("#board");
  await expect(board).toHaveAttribute("aria-roledescription", "whiteboard");
  await expect(board).toHaveAttribute("aria-label", /whiteboard/i);
  await expect(board).toHaveAttribute("aria-describedby", "board-a11y-mirror-hint");

  // The live-region announcer exists (polite status).
  const announcer = a.page.locator('[role="status"][aria-live="polite"]');
  await expect(announcer).toHaveCount(1);

  // Empty board → the hint says so.
  await expect(a.page.locator("#board-a11y-mirror-hint")).toHaveText(/empty/i);

  // Add a sticky with text + a rectangle shape + a freehand stroke.
  await injectSticky(a.page, { id: "s1", x: 100, y: 100, bg: "#ffd43b" });
  await a.page.evaluate(() => {
    const doc = (window as unknown as { __komuboard: { doc: YDocLike } }).__komuboard.doc;
    const mk = (id: string, patch: Record<string, unknown>) => {
      const objects = doc.getMap("objects");
      const m = new (objects.constructor as new () => YMapLike)();
      doc.transact(() => {
        objects.set(id, m);
        for (const [k, v] of Object.entries(patch)) m.set(k, v);
        doc.getArray("order").push([id]);
      });
    };
    mk("s1r", {
      id: "s1",
      type: "text",
      x: 100,
      y: 100,
      width: 180,
      height: 180,
      fontSize: 16,
      fontFamily: "Inter",
      align: "left",
      bg: "#ffd43b",
      runs: [{ text: "Quarterly goals" }],
    });
    mk("sh1", {
      id: "sh1",
      type: "text",
      x: 400,
      y: 100,
      width: 200,
      height: 120,
      fontSize: 16,
      fontFamily: "Inter",
      align: "center",
      shape: "rectangle",
      runs: [{ text: "Roadmap" }],
    });
    mk("st1", {
      id: "st1",
      type: "stroke",
      points: [0, 0, 10, 10],
      color: "#000",
      width: 4,
      style: "solid",
      opacity: 1,
      authorId: "x",
    });
  });

  const items = a.page.locator("#board-a11y-mirror ul li");
  await expect.poll(async () => items.count()).toBeGreaterThanOrEqual(3);
  const texts = (await items.allTextContents()).join(" | ");
  expect(texts).toMatch(/sticky note: Quarterly goals/i);
  expect(texts).toMatch(/rectangle: Roadmap/i);
  expect(texts).toMatch(/freehand drawing/i);
  await expect(a.page.locator("#board-a11y-mirror-hint")).toHaveText(/object/i);

  // Delete one → the mirror shrinks.
  const before = (await objectIds(a.page)).length;
  await a.page.evaluate(() => {
    const doc = (window as unknown as { __komuboard: { doc: YDocLike } }).__komuboard.doc;
    doc.transact(() => doc.getMap("objects").delete("st1"));
  });
  await expect.poll(async () => items.count()).toBeLessThan(before);
  await a.close();
});
