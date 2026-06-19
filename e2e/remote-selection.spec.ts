import { expect, test } from "@playwright/test";

/** Minimal shape of the window.__coboard test hook exposed by the client. */
type BoardWindow = {
  __coboard: {
    doc: {
      getMap(name: string): {
        size: number;
        keys(): IterableIterator<string>;
      };
    };
    provider: { wsconnected: boolean };
    awareness: {
      clientID: number;
      getLocalState(): { selection?: string[] } | null;
      getStates(): Map<number, { selection?: string[] }>;
    };
    canvas?: { remoteSelectionCount(): number };
  };
};

test("a peer's selection is broadcast and rendered on the other client", async ({ browser }) => {
  const room = `e2e-sel-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await a.goto(`/?room=${room}`);
  await b.goto(`/?room=${room}`);
  await a.waitForFunction(
    () => (window as unknown as BoardWindow).__coboard?.provider?.wsconnected,
  );
  await b.waitForFunction(
    () => (window as unknown as BoardWindow).__coboard?.provider?.wsconnected,
  );

  // A draws a stroke with the pen, then B's doc converges to include it.
  await a.keyboard.press("p");
  const box = await a.locator("#board").boundingBox();
  if (!box) throw new Error("canvas not found");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await a.mouse.move(cx - 80, cy);
  await a.mouse.down();
  await a.mouse.move(cx - 20, cy - 40);
  await a.mouse.move(cx + 40, cy + 10);
  await a.mouse.move(cx + 90, cy - 30);
  await a.mouse.up();

  await expect
    .poll(
      () =>
        b.evaluate(() => (window as unknown as BoardWindow).__coboard.doc.getMap("objects").size),
      {
        timeout: 10_000,
      },
    )
    .toBeGreaterThan(0);
  const strokeId = await b.evaluate(
    () => [...(window as unknown as BoardWindow).__coboard.doc.getMap("objects").keys()][0],
  );
  expect(strokeId).toBeTruthy();

  // A selects the stroke (⌘/Ctrl+A → selectAll → publishSelection over awareness).
  await a.keyboard.press("Control+a");

  // A's own awareness now advertises the selected id.
  await expect
    .poll(
      () =>
        a.evaluate(
          () =>
            (window as unknown as BoardWindow).__coboard.awareness.getLocalState()?.selection ??
            null,
        ),
      { timeout: 5_000 },
    )
    .toEqual([strokeId]);

  // B receives A's selection on the awareness channel (excluding B's own state).
  await expect
    .poll(
      () =>
        b.evaluate(() => {
          const aw = (window as unknown as BoardWindow).__coboard.awareness;
          for (const [id, st] of aw.getStates()) {
            if (id !== aw.clientID && st.selection?.length) return st.selection;
          }
          return null;
        }),
      { timeout: 5_000 },
    )
    .toEqual([strokeId]);

  // ...and B actually RENDERS an outline for it (the new presence chrome).
  await expect
    .poll(
      () =>
        b.evaluate(
          () => (window as unknown as BoardWindow).__coboard.canvas?.remoteSelectionCount() ?? 0,
        ),
      {
        timeout: 5_000,
      },
    )
    .toBe(1);

  // A's cursor activity fires frequent awareness ticks; the render-side dedup must NOT
  // drop B's outline (the rebuild is skipped, the existing rect stays).
  await a.mouse.move(cx + 12, cy + 12);
  await a.mouse.move(cx - 12, cy - 12);
  await a.mouse.move(cx + 24, cy - 6);
  await expect
    .poll(
      () =>
        b.evaluate(
          () => (window as unknown as BoardWindow).__coboard.canvas?.remoteSelectionCount() ?? -1,
        ),
      {
        timeout: 3_000,
      },
    )
    .toBe(1);

  // When A clears its selection (Escape), B's outline goes away.
  await a.keyboard.press("Escape");
  await expect
    .poll(
      () =>
        b.evaluate(
          () => (window as unknown as BoardWindow).__coboard.canvas?.remoteSelectionCount() ?? -1,
        ),
      {
        timeout: 5_000,
      },
    )
    .toBe(0);

  // Re-selecting after a clear must render again — i.e. the render cache transitions
  // ""→ids→""→ids and never gets stuck on a stale signature.
  await a.keyboard.press("Control+a");
  await expect
    .poll(
      () =>
        b.evaluate(
          () => (window as unknown as BoardWindow).__coboard.canvas?.remoteSelectionCount() ?? -1,
        ),
      {
        timeout: 5_000,
      },
    )
    .toBe(1);

  // Marquee selection (the rate-capped broadcast path): A drags a rubber-band over the
  // stroke. Broadcasts are throttled mid-drag, but endMarquee flushes the settled
  // selection, so B must still converge to the outline.
  await a.keyboard.press("Escape");
  await a.keyboard.press("v"); // select tool (A was on pen from drawing)
  await a.mouse.move(cx - 150, cy - 110);
  await a.mouse.down();
  await a.mouse.move(cx - 40, cy - 40);
  await a.mouse.move(cx + 60, cy + 20);
  await a.mouse.move(cx + 150, cy + 110);
  await a.mouse.up();
  await expect
    .poll(
      () =>
        b.evaluate(
          () => (window as unknown as BoardWindow).__coboard.canvas?.remoteSelectionCount() ?? -1,
        ),
      {
        timeout: 5_000,
      },
    )
    .toBe(1);

  await ctxA.close();
  await ctxB.close();
});
