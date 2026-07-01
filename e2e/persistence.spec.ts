import { expect, type Page, test } from "@playwright/test";
import { connectPeer, injectShape, injectSticky, objectIds, objJSON, uniqueRoom } from "./helpers";

/**
 * Persistence (M2): edits land in the room's Durable Object, which debounce-saves the full Yjs doc
 * to its co-located SQLite. A board must therefore survive a client reload and all clients leaving.
 *
 * Note on coverage: under `wrangler dev` the DO usually stays warm between connections, so these
 * assert the user-visible promise (the board comes back) — which exercises the save + re-serve
 * wiring, and the SQLite cold-load path opportunistically if the idle DO evicts. The encode↔decode
 * core of that cold load is unit-tested directly in packages/worker/src/persistence.test.ts.
 */

const POPULATE = async (page: Page) => {
  await injectSticky(page, { id: "p1", x: 100, y: 100, size: 180 });
  await injectShape(page, { id: "p2", x: 360, y: 220, width: 200, height: 140 });
  await injectSticky(page, { id: "p3", x: 640, y: 320, size: 180 });
  await expect.poll(() => objectIds(page)).toEqual(expect.arrayContaining(["p1", "p2", "p3"]));
};

test("persistence: a populated board is restored after the author reloads", async ({ browser }) => {
  const room = uniqueRoom("persist-reload");
  const a = await connectPeer(browser, room);
  await POPULATE(a.page);

  // Let the DO's debounced onSave (debounceWait 2s) flush to SQLite before we drop the client.
  await a.page.waitForTimeout(3000);

  // Reload → the local Yjs doc is wiped; the page reconnects fresh and must get the board back.
  await a.page.reload();
  await a.page.waitForFunction(
    () =>
      (window as unknown as { __komuboard?: { provider?: { wsconnected?: boolean } } }).__komuboard
        ?.provider?.wsconnected,
  );

  await expect.poll(() => objectIds(a.page)).toEqual(expect.arrayContaining(["p1", "p2", "p3"]));
  expect(await objJSON(a.page, "p1")).toMatchObject({ x: 100, y: 100 });
  expect(await objJSON(a.page, "p2")).toMatchObject({ x: 360, y: 220, width: 200, height: 140 });
  await a.page.screenshot({ path: "test-results/persistence-restored.png" });

  await a.close();
});

test("persistence: a board survives every client leaving and a fresh peer joining", async ({
  browser,
}) => {
  const room = uniqueRoom("persist-rejoin");
  const a = await connectPeer(browser, room);
  await POPULATE(a.page);

  await a.page.waitForTimeout(3000); // flush onSave
  await a.close(); // no connections left → the idle DO may hibernate/evict
  await new Promise((r) => setTimeout(r, 1500)); // give it an idle beat

  // A brand-new client (separate context, empty storage) joins the same room.
  const b = await connectPeer(browser, room);
  await expect.poll(() => objectIds(b.page)).toEqual(expect.arrayContaining(["p1", "p2", "p3"]));
  expect(await objJSON(b.page, "p3")).toMatchObject({ x: 640, y: 320 });

  await b.close();
});

test("persistence: the board is flushed on the last disconnect (no debounce wait)", async ({
  browser,
}) => {
  // The Board DO persists immediately when its last connection leaves (board.ts onClose), so a board
  // survives eviction even without waiting for the 2s autosave debounce. Here we populate, close the
  // sole client WITHOUT the 3s wait the tests above use, then rejoin and expect the board back.
  // (Like those tests, the cold SQLite path is only hit if the idle DO actually evicts under
  // `wrangler dev`; the flush wiring + encode/decode core are covered directly by the worker unit
  // tests. This guards the user-visible promise that leaving quickly doesn't drop the last edits.)
  const room = uniqueRoom("persist-flush");
  const a = await connectPeer(browser, room);
  await POPULATE(a.page);
  await a.close(); // no debounce wait — the last-disconnect flush must have persisted the board
  await new Promise((r) => setTimeout(r, 1000));

  const b = await connectPeer(browser, room);
  await expect.poll(() => objectIds(b.page)).toEqual(expect.arrayContaining(["p1", "p2", "p3"]));
  await b.close();
});
