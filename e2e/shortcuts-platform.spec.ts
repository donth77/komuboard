import { expect, test, type Page } from "@playwright/test";
import { uniqueRoom } from "./helpers";

/** Spoof the platform BEFORE the app loads (platform.ts reads navigator once at import). */
async function spoofPlatform(page: Page, uaPlatform: string, navPlatform: string) {
  await page.addInitScript(
    ([ua, nav]) => {
      try {
        Object.defineProperty(navigator, "userAgentData", { get: () => ({ platform: ua }) });
      } catch {
        /* non-configurable on some engines — the platform override below still flips it */
      }
      try {
        Object.defineProperty(navigator, "platform", { get: () => nav });
      } catch {
        /* ignore */
      }
    },
    [uaPlatform, navPlatform],
  );
}

async function openShortcuts(page: Page) {
  await page.goto(`/?room=${uniqueRoom("sc")}`);
  await page.waitForFunction(() => !!(window as unknown as { __komuboard?: unknown }).__komuboard);
  await page.keyboard.press("?"); // opens the shortcuts overlay
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("shortcuts menu lists the Copy + Paste rows", async ({ page }) => {
  const dialog = await openShortcuts(page);
  await expect(dialog).toContainText("Copy");
  await expect(dialog).toContainText("Paste");
});

test("macOS → modifier shows ⌘ (not Ctrl)", async ({ page }) => {
  await spoofPlatform(page, "macOS", "MacIntel");
  const txt = await (await openShortcuts(page)).innerText();
  expect(txt).toContain("⌘");
  expect(txt).not.toContain("Ctrl");
});

test("non-Mac (Linux / Windows) → modifier shows Ctrl (not ⌘)", async ({ page }) => {
  await spoofPlatform(page, "Linux", "Linux x86_64");
  const txt = await (await openShortcuts(page)).innerText();
  expect(txt).toContain("Ctrl");
  expect(txt).not.toContain("⌘");
});
