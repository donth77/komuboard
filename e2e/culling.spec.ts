import { type Page, expect, test } from "@playwright/test";
import {
  type BoardWindow,
  calibrate,
  connectPeer,
  hasSelection,
  injectShape,
  injectStickyGrid,
  uniqueRoom,
  worldToScreen,
} from "./helpers";

/** Pan a page's camera by setting the Konva stage position, then nudge the viewport listener. */
async function panStage(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    (p) => {
      const stage = (
        window as unknown as {
          Konva: {
            stages: Array<{ position(v: { x: number; y: number }): void; fire(e: string): void }>;
          };
        }
      ).Konva.stages[0]!;
      stage.position({ x: p.x, y: p.y });
      stage.fire("dragmove");
    },
    { x, y },
  );
}

/**
 * Viewport culling (ADR-0009 Phase 4 R1): only objects in/near the viewport are mounted as DOM nodes,
 * so on-screen node count tracks visible — not total — board size. Guards both the perf win (node
 * count stays bounded on a large board) and correctness (off-screen objects mount on pan; ⌘A still
 * selects everything even though most objects have no element).
 */

const mountedCount = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelectorAll(".text-layer > [data-id]").length);

const isMounted = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((i) => !!document.querySelector(`[data-id="${i}"]`), id);

test("a large board mounts only ~viewport-many nodes (culling)", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("cull"));
  await injectStickyGrid(a.page, 1000);
  await expect.poll(() => mountedCount(a.page)).toBeGreaterThan(0);
  const mounted = await mountedCount(a.page);
  expect(mounted).toBeLessThan(200); // ≈ visible + margin, NOT ~1000
  await a.close();
});

test("an off-screen object is unmounted, then mounts when panned into view", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("cullpan"));
  await injectStickyGrid(a.page, 1000);
  await expect.poll(() => mountedCount(a.page)).toBeGreaterThan(0);

  // p0 is at world (0,0) — near the initial view; a far one is off-screen.
  const farId = "p900";
  expect(await isMounted(a.page, farId)).toBe(false); // off-screen → not mounted

  // Pan the camera to centre the far object's world position; it must then mount.
  const far = await a.page.evaluate(
    (i) => (window as unknown as BoardWindow).__komuboard.doc.getMap("objects").get(i)!.toJSON(),
    farId,
  );
  await a.page.evaluate(
    (p) => {
      // No direct camera-pan API on the hook; drive the Konva stage position to centre the far object.
      const stage = (
        window as unknown as {
          Konva: {
            stages: Array<{
              scaleX(): number;
              position(pos: { x: number; y: number }): void;
              fire(evt: string): void;
            }>;
          };
        }
      ).Konva.stages[0]!;
      const scale = stage.scaleX();
      stage.position({
        x: window.innerWidth / 2 - (p.x as number) * scale,
        y: window.innerHeight / 2 - (p.y as number) * scale,
      });
      stage.fire("dragmove"); // nudge the viewport listener → syncTransform → recull
    },
    far as { x: number; y: number },
  );

  await expect.poll(() => isMounted(a.page, farId)).toBe(true); // scrolled into view → mounted
  await a.close();
});

test("select-all selects every object, including culled (unmounted) ones", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("cullselectall"));
  await injectStickyGrid(a.page, 1000);
  await expect.poll(() => mountedCount(a.page)).toBeGreaterThan(0);
  expect(await mountedCount(a.page)).toBeLessThan(200); // most are culled

  await a.page.keyboard.press("v");
  await a.page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");

  const selected = await a.page.evaluate(
    () =>
      (window as unknown as BoardWindow).__komuboard.awareness.getLocalState()?.selection?.length ??
      0,
  );
  expect(selected).toBe(1000); // all selected, not just the mounted handful
  await a.close();
});

test("a peer's live drag of an off-screen object mounts it on the viewer (remote-gesture culling fix)", async ({
  browser,
}) => {
  const room = uniqueRoom("cullremote");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);
  await injectShape(a.page, { id: "o", x: 0, y: 0, width: 160, height: 120, bg: "#a5d8ff" });
  await expect.poll(() => b.page.locator('[data-id="o"]').count(), { timeout: 10_000 }).toBe(1);

  // Pan B far away so the object is culled (unmounted) on B.
  await panStage(b.page, -6000, -6000);
  await expect.poll(() => isMounted(b.page, "o")).toBe(false);

  // A (object on-screen) selects it and starts a drag, holding mid-gesture.
  const cal = await calibrate(a.page);
  const c = worldToScreen(cal, 80, 60);
  await a.page.keyboard.press("v");
  await a.page.mouse.click(c.x, c.y);
  await expect.poll(() => hasSelection(a.page)).toBe(true);
  await a.page.mouse.move(c.x, c.y);
  await a.page.mouse.down();
  await a.page.mouse.move(c.x + 60, c.y + 40, { steps: 8 });

  // B's camera is still off the object, but A's live drag streams over awareness; the fix filters that
  // gesture on doc-existence (not mount state), so recull() mounts the exempt off-screen object and B
  // can render the peer's drag. Before the fix the mounted-only filter dropped it → invisible until commit.
  await expect.poll(() => isMounted(b.page, "o"), { timeout: 5_000 }).toBe(true);

  await a.page.mouse.up();
  await a.close();
  await b.close();
});
