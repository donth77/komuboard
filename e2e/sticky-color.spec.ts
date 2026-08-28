import { expect, test } from "@playwright/test";

import { type BoardWindow, connectPeer, uniqueRoom } from "./helpers";

/**
 * Sticky-note colour, on the touch layout. Two separate holes, both reported as "colour selection
 * doesn't work on mobile":
 *  1. the palette claimed to recolour the note being typed, but pressing a swatch moved focus →
 *     blurred the editor → committed the note, so the pick landed on nothing (it only changed the
 *     colour of the NEXT note). Worse on a phone, where the palette collapses to a tab on placement
 *     and re-opening it (the grab handle) committed the note too;
 *  2. once committed, a note's colour was unreachable — the palette only follows the Sticky tool,
 *     and the selection bar / text bar had no fill control for notes.
 */

const PHONE = { width: 390, height: 844 };

/** Every object's `bg` in the doc. */
const bgs = (page: import("@playwright/test").Page): Promise<unknown[]> =>
  page.evaluate(() => {
    const out: unknown[] = [];
    for (const v of (window as unknown as BoardWindow).__komuboard.doc.getMap("objects").values())
      out.push(v.toJSON().bg);
    return out;
  });

test("phone: the palette recolours the note you're typing, not just the next one", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("sticky-recolor"), {
    touch: true,
    viewport: PHONE,
  });
  await a.page.locator('komu-tool-dock [data-tool="insert"]').tap();
  await a.page.locator('.insert-btn[data-insert="sticky"]').tap();
  const bar = a.page.locator("komu-sticky-bar");
  await expect(bar).not.toHaveClass(/\bhidden\b/);

  // Place a note — the sheet collapses to its grab tab while you type the label.
  await a.page.touchscreen.tap(195, 320);
  await expect(bar).toHaveClass(/\bcollapsed\b/);
  await expect(a.page.locator(".komu-text-editor")).toHaveCount(1);

  // Re-open the palette and pick green. Neither the handle nor the swatch may steal focus: losing it
  // commits the note, and the pick would then have nothing to recolour.
  await bar.locator(".sheet-handle").tap();
  await expect(bar).not.toHaveClass(/\bcollapsed\b/);
  await expect(a.page.locator(".komu-text-editor")).toHaveCount(1);
  await bar.locator('.sw[data-color="#b2f2bb"]').tap();
  await expect(a.page.locator(".komu-text-editor")).toHaveCount(1); // still typing
  await expect(bar.locator(".sw.on")).toHaveAttribute("data-color", "#b2f2bb");

  await a.page.keyboard.press("Escape"); // commit
  await expect.poll(() => bgs(a.page)).toEqual(["#b2f2bb"]);
  await a.close();
});

test("phone: a committed sticky can be recoloured from its toolbar", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("sticky-refill"), {
    touch: true,
    viewport: PHONE,
  });
  await a.page.locator('komu-tool-dock [data-tool="insert"]').tap();
  await a.page.locator('.insert-btn[data-insert="sticky"]').tap();
  await a.page.touchscreen.tap(195, 320);
  await a.page.locator('komu-tool-dock [data-tool="select"]').tap(); // commits, back to select
  await expect.poll(() => bgs(a.page)).toEqual(["#ffec99"]); // the default yellow

  await a.page.touchscreen.tap(195, 320); // select the note → its toolbar appears
  const fill = a.page.locator(".komu-text-bar .ctb-fill");
  await expect(fill).toBeVisible();
  await expect(fill).toHaveAttribute("data-tip", "Sticky note colors");
  await fill.tap();
  // A note's fill is its paper: the sticky palette, with no "no fill" option.
  await expect(a.page.locator(".ctb-color-pop .sw-none")).toHaveCount(0);
  await a.page.locator('.ctb-color-pop .sw[data-color="#d0bfff"]').tap();
  await expect.poll(() => bgs(a.page)).toEqual(["#d0bfff"]);
  await a.close();
});

test("phone: a newly placed sticky can be recoloured from its text toolbar", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("sticky-edit-fill"), {
    touch: true,
    viewport: PHONE,
  });
  await a.page.locator('komu-tool-dock [data-tool="insert"]').tap();
  await a.page.locator('.insert-btn[data-insert="sticky"]').tap();
  await a.page.touchscreen.tap(195, 320);
  await a.page.keyboard.type("hello");

  const fill = a.page.locator(".komu-text-bar .ctb-fill");
  await expect(fill).toBeVisible();
  await fill.tap();
  await a.page.locator('.ctb-color-pop .sw[data-color="#a5d8ff"]').tap();
  await expect(a.page.locator(".komu-text-editor")).toHaveCSS(
    "background-color",
    "rgb(165, 216, 255)",
  );

  // Edit-mode reflection uses the browser's execCommand state rather than stored runs. Exercise it
  // separately so both the live editor and a later whole-box selection keep the indicator current.
  await a.page.locator(".komu-text-editor").evaluate((editor) => {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const highlight = a.page.locator(".komu-text-bar .ctb-hl");
  await highlight.tap();
  await a.page.locator('.ctb-color-pop .sw[data-color="#fcc2d7"]').tap();
  await expect(highlight.locator("[data-hlswatch]")).toHaveCSS(
    "background-color",
    "rgb(252, 194, 215)",
  );

  await a.page.keyboard.press("Escape");
  await expect.poll(() => bgs(a.page)).toEqual(["#a5d8ff"]);
  await a.close();
});

test("phone: a sticky's selected text-highlight color is reflected by its toolbar", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("sticky-highlight-state"), {
    touch: true,
    viewport: PHONE,
  });
  await a.page.locator('komu-tool-dock [data-tool="insert"]').tap();
  await a.page.locator('.insert-btn[data-insert="sticky"]').tap();
  await a.page.touchscreen.tap(195, 320);
  await a.page.keyboard.type("highlight me");
  await a.page.keyboard.press("Escape");
  await a.page.touchscreen.tap(195, 320); // select the committed note

  const highlight = a.page.locator(".komu-text-bar .ctb-hl");
  await highlight.tap();
  await a.page.locator('.ctb-color-pop .sw[data-color="#b2f2bb"]').tap();

  // The formatting itself worked before; the bug was stale toolbar state. The indicator must show
  // the chosen green, and reopening the palette must ring that same swatch as active.
  await expect(a.page.locator(".komu-text.sticky span").first()).toHaveCSS(
    "background-color",
    "rgb(178, 242, 187)",
  );
  await expect(highlight.locator("[data-hlswatch]")).toHaveCSS(
    "background-color",
    "rgb(178, 242, 187)",
  );
  await highlight.tap();
  await expect(a.page.locator('.ctb-color-pop .sw.on[data-color="#b2f2bb"]')).toBeVisible();
  await a.close();
});

test("the fill control belongs to notes and shapes only — not plain text", async ({ browser }) => {
  const a = await connectPeer(browser, uniqueRoom("sticky-fillscope"), {
    viewport: { width: 1280, height: 800 },
  });
  const fill = a.page.locator(".komu-text-bar .ctb-fill");

  await a.page.locator('komu-tool-dock [data-tool="text"]').click();
  await a.page.mouse.click(560, 300);
  await expect(a.page.locator(".komu-text-bar")).toBeVisible();
  await expect(fill).toBeHidden();

  // A shape keeps the full shape-mode row (kind + fill + border + align).
  await a.page.locator('komu-tool-dock [data-tool="shapes"]').click();
  await a.page.locator('komu-shape-menu [data-kind="rectangle"]').click();
  await a.page.mouse.click(760, 500);
  await expect(fill).toBeVisible();
  await expect(a.page.locator(".komu-text-bar .ctb-shape-kind")).toBeVisible();

  // A sticky gets the fill control on its own — no shape kind / border / alignment.
  await a.page.locator('komu-tool-dock [data-tool="sticky"]').click();
  await a.page.mouse.click(400, 500);
  await expect(fill).toBeVisible();
  await expect(a.page.locator(".komu-text-bar .ctb-shape-kind")).toBeHidden();
  await a.close();
});
