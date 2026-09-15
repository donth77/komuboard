import { expect, test } from "@playwright/test";

import {
  calibrate,
  connectPeer,
  hasSelection,
  injectShape,
  objJSON,
  uniqueRoom,
  worldToScreen,
  type BoardWindow,
} from "./helpers";

/**
 * Shapes panel coverage: "More shapes" opens the searchable library; a pick arms the tool (mirrored
 * on the menu's More row) and places a catalog shape; an uploaded SVG is sanitized into "Your
 * shapes" and placed as a custom shape that a peer renders; a rejected upload toasts; the text bar's
 * shape popover switches an existing box's kind; on a phone the panel is a sheet that closes on pick.
 */

const PHONE = { width: 390, height: 844 };

// An SVG carrying everything the sanitizer must strip (script / handlers / style / text / image /
// defs / colours) around three geometry elements it must keep.
const FIXTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" onload="alert(1)">
  <script>alert('x')</script>
  <style>path{fill:red}</style>
  <defs><linearGradient id="g"/></defs>
  <text x="1" y="1">hi</text>
  <image href="https://example.com/x.png"/>
  <g transform="translate(4 4)">
    <path d="M0 0H40V40H0Z" fill="red" stroke="blue" onclick="alert(2)"/>
    <rect x="10" y="10" width="20" height="20" fill="#00f" style="fill:green"/>
    <circle cx="50" cy="50" r="8" fill="none"/>
  </g>
</svg>`;
const TEXT_ONLY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>no outline</text></svg>`;

/** The first text object with the given shape kind (its JSON), or null. */
function shapeObject(
  page: import("@playwright/test").Page,
  kind: string,
): Promise<Record<string, unknown> | null> {
  return page.evaluate((k) => {
    const doc = (window as unknown as BoardWindow).__komuboard.doc;
    for (const m of doc.getMap("objects").values()) {
      if (m.get("type") === "text" && m.get("shape") === k) {
        const o: Record<string, unknown> = {};
        for (const key of ["id", "shape", "shapeSvg", "shapeViewBox", "width", "height"])
          o[key] = m.get(key);
        return o;
      }
    }
    return null;
  }, kind);
}

test("More shapes → search → pick → the menu's More row reflects it → tap places a cylinder", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("shapes-panel"));
  const page = a.page;
  const menu = page.locator("komu-shape-menu");
  const panel = page.locator("komu-shape-panel");

  await page.keyboard.press("r");
  await expect(menu).toBeVisible();
  await menu.locator(".sm-more").click();
  await expect(panel).toBeVisible();
  await expect(menu).toBeHidden(); // the panel stands in for the menu while open
  const search = panel.locator(".sp-search input");
  await expect(search).toBeFocused();

  await search.fill("cyl");
  const tiles = panel.locator(".sp-tile");
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toHaveAttribute("data-kind", "cylinder");
  await expect(tiles.first()).toHaveAttribute("aria-label", "Cylinder");
  await tiles.first().click();
  await expect(tiles.first()).toHaveClass(/\bon\b/);
  await expect(panel).toBeVisible(); // desktop: the panel stays open after a pick

  await page.keyboard.press("Escape"); // closes the panel, not the tool
  await expect(panel).toBeHidden();
  await expect(menu).toBeVisible();
  const more = menu.locator(".sm-more");
  await expect(more).toHaveClass(/\bon\b/);
  await expect(more.locator(".sm-label")).toHaveText("Cylinder");

  // A tap on the board places the armed cylinder and opens its label editor.
  const box = await page.locator("#board").boundingBox();
  if (!box) throw new Error("board not found");
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height / 2);
  await expect(page.locator(".komu-text-editor.shape-cylinder")).toBeVisible();
  await page.keyboard.type("DB");
  await page.keyboard.press("Escape"); // commit
  await expect.poll(() => shapeObject(page, "cylinder")).not.toBeNull();
  const placed = page.locator(".komu-text.shape-cylinder.shape-path");
  await expect(placed).toHaveCount(1);
  await expect(placed).toHaveText("DB");
  const bg = await placed.evaluate((el) => (el as HTMLElement).style.backgroundImage);
  expect(bg).toContain("data:image/svg+xml");
  await a.close();
});

test("uploaded SVG is sanitized into Your shapes and places a custom shape a peer renders", async ({
  browser,
}) => {
  const room = uniqueRoom("shapes-upload");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);
  const page = a.page;
  const panel = page.locator("komu-shape-panel");

  await page.keyboard.press("r");
  await page.locator("komu-shape-menu .sm-more").click();
  await expect(panel).toBeVisible();
  await panel.locator("input.sp-file").setInputFiles({
    name: "badge.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(FIXTURE_SVG),
  });
  const yours = panel.locator('.sp-section[data-section="yours"] .sp-tile');
  await expect(yours).toHaveCount(1);
  await expect(yours.first()).toHaveAttribute("aria-label", "badge");

  // The device library holds only allow-listed geometry — colours, script, handlers, text gone.
  const stored = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("komuboard-shapes") ?? "[]") as {
      svg: string;
      viewBox: string;
    }[];
    return raw[0] ?? null;
  });
  expect(stored).not.toBeNull();
  const svg = stored!.svg;
  for (const banned of [
    "script",
    "onclick",
    "onload",
    "red",
    "blue",
    "green",
    "#00f",
    "<text",
    "<image",
    "style",
  ])
    expect(svg).not.toContain(banned);
  expect(svg).toContain("<path");
  expect(svg).toContain("<rect");
  expect(svg).toContain('fill="none"'); // the open circle stays unfilled
  expect((svg.match(/vector-effect="non-scaling-stroke"/g) ?? []).length).toBe(3);
  expect(svg).toContain('transform="translate(4 4)"');
  expect(stored!.viewBox.split(" ")).toHaveLength(4);

  // Picking the upload arms a custom shape; a tap places it with the geometry embedded.
  await yours.first().click();
  const box = await page.locator("#board").boundingBox();
  if (!box) throw new Error("board not found");
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
  await expect(page.locator(".komu-text-editor.shape-custom")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => shapeObject(page, "custom")).not.toBeNull();
  const obj = (await shapeObject(page, "custom"))!;
  expect(obj.shapeSvg).toBe(svg);
  expect(obj.shapeViewBox).toBe(stored!.viewBox);

  // The peer renders it from the doc (no library on that device) as a background-image shape.
  const remote = b.page.locator(".komu-text.shape-custom.shape-path");
  await expect(remote).toHaveCount(1);
  const remoteBg = await remote.evaluate((el) => (el as HTMLElement).style.backgroundImage);
  expect(remoteBg).toContain("data:image/svg+xml");
  expect(decodeURIComponent(remoteBg)).toContain("<path");

  // Committing the label reverted the tool to Select, which closed the panel. Reopen it and remove
  // the library entry: the placed shape (geometry embedded) is untouched.
  await page.keyboard.press("r");
  await page.locator("komu-shape-menu .sm-more").click();
  await expect(panel).toBeVisible();
  await page.locator('.sp-section[data-section="yours"] .sp-tilewrap').first().hover();
  await page.locator('.sp-section[data-section="yours"] .sp-remove').first().click();
  await expect(yours).toHaveCount(0);
  await expect(remote).toHaveCount(1);
  await a.close();
  await b.close();
});

test("an SVG with no usable outline is refused with a toast and adds nothing", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("shapes-reject"));
  const page = a.page;
  const panel = page.locator("komu-shape-panel");
  await page.keyboard.press("r");
  await page.locator("komu-shape-menu .sm-more").click();
  await panel.locator("input.sp-file").setInputFiles({
    name: "words.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(TEXT_ONLY_SVG),
  });
  await expect(page.locator(".komu-toast")).toContainText("no outline");
  await expect(panel.locator('.sp-section[data-section="yours"] .sp-tile')).toHaveCount(0);
  await a.close();
});

test("text bar: the shape popover switches a selected box to any catalog shape", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("shapes-switch"));
  const page = a.page;
  await injectShape(page, { id: "sw1", x: 0, y: 0, width: 160, height: 120 });
  await expect(page.locator(".komu-text.shape-rectangle")).toHaveCount(1);
  const cal = await calibrate(page);
  await page.keyboard.press("v");
  const c = worldToScreen(cal, 80, 60);
  await page.mouse.click(c.x, c.y);
  await expect.poll(() => hasSelection(page)).toBe(true);

  await page.locator('.komu-text-bar [data-act="shape-kind"]').click();
  const pop = page.locator(".ctb-shape-pop");
  await expect(pop).toBeVisible();
  await pop.locator(".ctb-shape-search").fill("docu");
  await expect(pop.locator(".sp-tile")).toHaveCount(2); // Document + Multiple documents
  await pop.locator('.sp-tile[data-kind="document"]').click();
  await expect.poll(async () => (await objJSON(page, "sw1"))?.shape).toBe("document");
  await expect(page.locator(".komu-text.shape-document.shape-path")).toHaveCount(1);
  await a.close();
});

test("phone: the panel is a bottom sheet that closes on pick and arms the shape", async ({
  browser,
}) => {
  const a = await connectPeer(browser, uniqueRoom("shapes-phone"), {
    touch: true,
    viewport: PHONE,
  });
  const page = a.page;
  await page.locator('komu-tool-dock [data-tool="insert"]').click();
  await page.locator('.insert-sheet [data-insert="shapes"]').click();
  const menu = page.locator("komu-shape-menu");
  await expect(menu).not.toHaveClass(/\bhidden\b/);
  await menu.locator(".sm-more").click();
  const panel = page.locator("komu-shape-panel");
  await expect(panel).toBeVisible();
  await expect(menu).toHaveClass(/\bhidden\b/);
  await panel.locator('.sp-tile[data-kind="hexagon"]').click();
  await expect(panel).toBeHidden(); // a pick closes the sheet on phones
  await expect(menu).not.toHaveClass(/\bhidden\b/);
  await expect(menu.locator(".sm-more")).toHaveClass(/\bon\b/);
  await expect(menu.locator(".sm-more .sm-label")).toHaveText("Hexagon");
  await a.close();
});
