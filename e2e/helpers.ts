import { type Browser, type Page } from "@playwright/test";

/** Canonical shape of the `window.__coboard` test hook exposed by the client (see main.ts). */
export type BoardWindow = {
  __coboard: {
    doc: {
      getMap(name: string): {
        size: number;
        keys(): IterableIterator<string>;
        values(): IterableIterator<{ get(key: string): unknown }>;
      };
    };
    provider: { wsconnected: boolean };
    awareness: {
      clientID: number;
      getLocalState(): { selection?: string[] } | null;
      getStates(): Map<number, { selection?: string[] }>;
    };
    canvas?: {
      remoteSelectionCount(): number;
      nodeContentRect(id: string): { x: number; y: number; width: number; height: number } | null;
      getZoomPercent(): number;
    };
  };
};

export type Peer = { page: Page; close: () => Promise<void> };

/** A fresh room id for a test, e.g. "e2e-3f9a1b". */
export function uniqueRoom(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Open a page in its own browser context, join `room`, and wait until it's connected. */
export async function connectPeer(browser: Browser, room: string): Promise<Peer> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/?room=${room}`);
  await page.waitForFunction(
    () => (window as unknown as BoardWindow).__coboard?.provider?.wsconnected,
  );
  return { page, close: () => ctx.close() };
}

/** Switch to the pen and draw a short freehand stroke centred on the canvas. Returns the centre. */
export async function drawStroke(page: Page): Promise<{ cx: number; cy: number }> {
  await page.keyboard.press("p");
  const box = await page.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 20, cy - 40);
  await page.mouse.move(cx + 40, cy + 10);
  await page.mouse.move(cx + 90, cy - 30);
  await page.mouse.up();
  return { cx, cy };
}

/** Object ids in a page's Yjs doc, in z-order. */
export function objectIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as BoardWindow).__coboard.doc.getMap("objects").keys(),
  ]);
}

/** Number of remote-peer selection outlines currently rendered on a page (-1 if canvas not ready). */
export function remoteSelectionCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as BoardWindow).__coboard.canvas?.remoteSelectionCount() ?? -1,
  );
}
