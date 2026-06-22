import { expect, test, type Page } from "@playwright/test";
import { connectPeer, uniqueRoom } from "./helpers";

/**
 * On (re)load, the presence row hydrates from awareness over a few ticks. The avatars of
 * people already in the room must appear *in place* — not replay the join (enter) animation —
 * so a reload doesn't look like everyone just walked in. A peer who joins later still animates.
 *
 * Detection is animator-agnostic: during the enter spring an avatar has a running Web Animation
 * AND its opacity fades up from 0; at rest it has neither (no running animation, opacity 1).
 */

const PEER_AVATAR = "komu-avatar-presence-row .avatar:not(.self):not(.more)";

/** Wait for more than `beforeCount` peer avatars, then watch them for ~700ms (covers the spring). */
function sampleAvatars(
  page: Page,
  sel: string,
  beforeCount: number,
): Promise<{ count: number; sawAnim: boolean; minOpacity: number }> {
  return page.evaluate(
    async ({ sel, beforeCount }) => {
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const t0 = performance.now();
      while (performance.now() - t0 < 4000) {
        if (document.querySelectorAll(sel).length > beforeCount) break;
        await sleep(16);
      }
      let sawAnim = false;
      let minOpacity = 1;
      const s0 = performance.now();
      while (performance.now() - s0 < 700) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.getAnimations().length > 0) sawAnim = true;
          const op = parseFloat(getComputedStyle(el).opacity);
          if (Number.isFinite(op) && op < minOpacity) minOpacity = op;
        }
        await sleep(16);
      }
      return { count: document.querySelectorAll(sel).length, sawAnim, minOpacity };
    },
    { sel, beforeCount },
  );
}

test("presence avatars do NOT replay the join animation on load (hydration)", async ({
  browser,
}) => {
  const room = uniqueRoom("e2e-hydrate");
  const a = await connectPeer(browser, room);
  await a.page.waitForTimeout(200); // let A's awareness register on the relay

  // B loads into a room where A is already present — the "reload into an occupied room" case.
  // Sample immediately so we'd catch an enter animation if one (wrongly) ran.
  const b = await connectPeer(browser, room);
  const obs = await sampleAvatars(b.page, PEER_AVATAR, 0);

  expect(obs.count).toBeGreaterThan(0); // A's avatar showed up on B
  expect(obs.sawAnim).toBe(false); // …with no running enter/FLIP animation
  expect(obs.minOpacity).toBeGreaterThan(0.95); // …and never faded in (at rest the whole time)

  await a.close();
  await b.close();
});

test("a peer that joins AFTER hydration animates in", async ({ browser }) => {
  const room = uniqueRoom("e2e-hydrate-join");
  const a = await connectPeer(browser, room);
  const b = await connectPeer(browser, room);

  // Let B finish its hydration window (HYDRATION_MS = 1500ms) so later joins animate again.
  await b.page.waitForTimeout(1800);
  const before = await b.page.evaluate((sel) => document.querySelectorAll(sel).length, PEER_AVATAR);

  // A third peer joins now — B should animate its avatar in (proving hydration didn't disable
  // animations forever, and that the detector above actually detects animations).
  const c = await connectPeer(browser, room);
  const obs = await sampleAvatars(b.page, PEER_AVATAR, before);

  expect(obs.count).toBeGreaterThan(before); // C's avatar appeared
  expect(obs.sawAnim || obs.minOpacity < 0.95).toBe(true); // …and it animated in

  await a.close();
  await b.close();
  await c.close();
});
