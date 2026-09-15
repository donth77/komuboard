import { expect, test } from "@playwright/test";

import { connectPeer, hasSelection, objJSON, uniqueRoom, type BoardWindow } from "./helpers";

/**
 * Shape rendering guards: every catalog shape fills solidly (a second subpath drawn against the
 * body's winding punches a hole under it — the cylinder's rim, once); a tool-placed cylinder shows
 * its fill under the rim in dark mode too; catalog shapes place at their natural size; and circle
 * symbols stay square through a corner-handle resize.
 */

const FILL = "#a5d8ff";
const FILL_RGB = [165, 216, 255];
const PAPER_DARK = [14, 17, 22];

const near = (px: number[], rgb: number[], tol = 6): boolean =>
  px.length >= 3 && rgb.every((v, i) => Math.abs(px[i]! - v) <= tol);

/** Points (fractions of the box) that must be filled, per shape — the centre for everything that
 *  has a fill, plus the rim lenses that used to be holes. Braces are stroke-only. */
function mustFill(kind: string): Array<[number, number]> {
  if (kind === "braceLeft" || kind === "braceRight") return [];
  // Symbols whose centre lies ON an interior stroke (the "+", the "×", the hourglass pinch, the
  // sort divider) or on a page edge are sampled just off it, inside the fill.
  const offCentre: Record<string, [number, number]> = {
    or: [0.3, 0.3],
    summing: [0.5, 0.25],
    collate: [0.5, 0.25],
    sort: [0.5, 0.3],
    documents: [0.4, 0.55],
  };
  const pts: Array<[number, number]> = [offCentre[kind] ?? [0.5, 0.5]];
  if (kind === "cylinder") pts.push([0.5, 0.19]); // under the front rim
  if (kind === "directAccess") pts.push([0.81, 0.5]); // inside the right rim
  return pts;
}

test("every catalog shape fills solidly (no winding holes) through the rasterizer", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("shapes-raster"));
  const page = a.page;
  // The catalog ids, read from the panel itself (Lines are connectors, not boxes).
  await page.keyboard.press("r");
  await page.locator("komu-shape-menu .sm-more").click();
  const kinds = await page
    .locator(
      '.sp-section[data-section="basic"] .sp-tile, .sp-section[data-section="flowchart"] .sp-tile',
    )
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-kind") ?? ""));
  expect(kinds.length).toBeGreaterThan(40);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  const holes = await page.evaluate(
    async ({ kinds, FILL, checks }) => {
      const doc = (window as unknown as BoardWindow).__komuboard.doc;
      const objects = doc.getMap("objects");
      const order = doc.getArray("order");
      const YMap = objects.constructor as new () => { set(k: string, v: unknown): void };
      const COLS = 8;
      const SIZE = 100;
      const GAP = 120;
      doc.transact(() => {
        kinds.forEach((k, i) => {
          const m = new YMap();
          m.set("id", `r${i}`);
          m.set("type", "text");
          m.set("shape", k);
          m.set("x", (i % COLS) * GAP);
          m.set("y", Math.floor(i / COLS) * GAP);
          m.set("width", SIZE);
          m.set("height", SIZE);
          m.set("bg", FILL);
          m.set("runs", []);
          m.set("fontFamily", "Inter");
          m.set("fontSize", 16);
          m.set("align", "center");
          m.set("authorId", "e2e");
          (objects as unknown as { set(k: string, v: unknown): void }).set(`r${i}`, m);
          (order as unknown as { push(v: unknown[]): void }).push([`r${i}`]);
        });
      });
      const raster = (await import("/src/vr/board-raster.ts")) as {
        drawBoardRegion(
          ctx: CanvasRenderingContext2D,
          d: unknown,
          rect: { x: number; y: number; width: number; height: number },
          opts: { background: string },
        ): void;
      };
      const rows = Math.ceil(kinds.length / COLS);
      const c = document.createElement("canvas");
      c.width = COLS * GAP;
      c.height = rows * GAP;
      const ctx = c.getContext("2d")!;
      raster.drawBoardRegion(
        ctx,
        doc,
        { x: 0, y: 0, width: c.width, height: c.height },
        {
          background: "#0e1116",
        },
      );
      const bad: string[] = [];
      kinds.forEach((k, i) => {
        for (const [fx, fy] of checks[k] ?? []) {
          const x = Math.round((i % COLS) * GAP + fx * SIZE);
          const y = Math.round(Math.floor(i / COLS) * GAP + fy * SIZE);
          const px = [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
          if (px.some((v, j) => Math.abs(v - [165, 216, 255][j]!) > 6))
            bad.push(`${k}@${fx},${fy}=${px}`);
        }
      });
      return bad;
    },
    { kinds, FILL, checks: Object.fromEntries(kinds.map((k) => [k, mustFill(k)])) },
  );
  expect(holes).toEqual([]);
  await a.close();
});

test("dark mode: a tool-placed cylinder is filled under its rim (DOM render)", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem("komuboard-identity-nudged", "1");
    localStorage.setItem("komuboard-theme", "dark");
    (window as unknown as { __komuboardAutoFit?: boolean }).__komuboardAutoFit = false;
  });
  const page = await ctx.newPage();
  await page.goto(`/?room=${uniqueRoom("shapes-dark")}`);
  await page.waitForFunction(
    () => (window as unknown as BoardWindow).__komuboard?.provider?.wsconnected,
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.keyboard.press("r");
  await page.locator("komu-shape-menu .sm-more").click();
  await page.locator('.sp-tile[data-kind="cylinder"]').click();
  await page.keyboard.press("Escape");
  const board = await page.locator("#board").boundingBox();
  if (!board) throw new Error("board not found");
  await page.mouse.click(board.x + board.width * 0.65, board.y + board.height / 2);
  await expect(page.locator(".komu-text-editor.shape-cylinder")).toBeVisible();
  await page.keyboard.press("Escape"); // commit (an empty shape persists)
  const el = page.locator(".komu-text.shape-cylinder");
  await expect(el).toHaveCount(1);
  const box = await el.boundingBox();
  if (!box) throw new Error("cylinder not rendered");
  const png = await page.screenshot({ clip: box });
  const px = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    const at = (fx: number, fy: number): number[] =>
      [...g.getImageData(Math.round(fx * bmp.width), Math.round(fy * bmp.height), 1, 1).data].slice(
        0,
        3,
      );
    return { lens: at(0.5, 0.19), body: at(0.5, 0.6) };
  }, png.toString("base64"));
  // The default fill is white; the board paper is near-black. Neither point may show the paper.
  expect(near(px.body, [255, 255, 255])).toBe(true);
  expect(near(px.lens, [255, 255, 255])).toBe(true);
  expect(near(px.lens, PAPER_DARK)).toBe(false);
  await ctx.close();
});

test("catalog shapes place at their natural size; circle symbols stay square when resized", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("shapes-size"));
  const page = a.page;
  const board = await page.locator("#board").boundingBox();
  if (!board) throw new Error("board not found");
  const place = async (kind: string, fx: number): Promise<{ x: number; y: number }> => {
    await page.keyboard.press("r");
    await page.locator("komu-shape-menu .sm-more").click();
    await page.locator(`.sp-tile[data-kind="${kind}"]`).click();
    await page.keyboard.press("Escape");
    const at = { x: board.x + board.width * fx, y: board.y + board.height / 2 };
    await page.mouse.click(at.x, at.y);
    await expect(page.locator(`.komu-text-editor.shape-${kind}`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(`.komu-text.shape-${kind}`)).toHaveCount(1);
    return at;
  };
  const sizeOf = (kind: string): Promise<{ id: string; width: number; height: number } | null> =>
    page.evaluate((k) => {
      const doc = (window as unknown as BoardWindow).__komuboard.doc;
      for (const m of doc.getMap("objects").values())
        if (m.get("shape") === k)
          return {
            id: String(m.get("id")),
            width: m.get("width") as number,
            height: m.get("height") as number,
          };
      return null;
    }, kind);

  const orAt = await place("or", 0.45);
  await expect
    .poll(() => sizeOf("or"))
    .toEqual(expect.objectContaining({ width: 130, height: 130 }));
  await place("document", 0.8);
  await expect
    .poll(() => sizeOf("document"))
    .toEqual(expect.objectContaining({ width: 150, height: 160 }));

  // Select the circle and drag its bottom-right handle diagonally but unevenly → it stays square.
  await page.keyboard.press("v");
  await page.mouse.click(orAt.x, orAt.y);
  await expect.poll(() => hasSelection(page)).toBe(true);
  await expect(page.locator(".komu-text-resize .komu-text-handle.h-e")).toBeHidden(); // corners only
  const handle = await page.locator(".komu-text-resize .komu-text-handle.h-se").boundingBox();
  if (!handle) throw new Error("no corner handle");
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 30, hy + 5);
  await page.mouse.move(hx + 60, hy + 10);
  await page.mouse.up();
  const id = (await sizeOf("or"))!.id;
  await expect.poll(async () => (await objJSON(page, id))?.width).toBeGreaterThan(150);
  const o = (await objJSON(page, id))!;
  expect(o.width).toBe(o.height);
  await a.close();
});
