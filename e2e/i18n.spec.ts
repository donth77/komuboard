import { expect, test, type Browser } from "@playwright/test";

import { uniqueRoom } from "./helpers";

// Load the app under a given browser UI locale and wait for the tool dock (the sweep has run by then).
async function loadWithLocale(browser: Browser, locale: string) {
  const ctx = await browser.newContext({ locale });
  const page = await ctx.newPage();
  await page.goto(`/?room=${uniqueRoom("i18n")}`);
  await expect(page.locator('komu-tool-dock [data-tool="select"]')).toBeVisible();
  return { ctx, page };
}

test("ko-KR → Korean UI via the data-i18n sweep (exact translation)", async ({ browser }) => {
  const { ctx, page } = await loadWithLocale(browser, "ko-KR");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.locator('komu-tool-dock [data-tool="select"]')).toHaveAttribute(
    "aria-label",
    "선택",
  );
  await ctx.close();
});

test("regional variants collapse — zh-TW maps to the Simplified Chinese localization", async ({
  browser,
}) => {
  const { ctx, page } = await loadWithLocale(browser, "zh-TW");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  const label = await page
    .locator('komu-tool-dock [data-tool="select"]')
    .getAttribute("aria-label");
  expect(label).toBeTruthy();
  expect(label).not.toBe("Select"); // translated, not the English source
  await ctx.close();
});

test("an unshipped language falls back to English", async ({ browser }) => {
  const { ctx, page } = await loadWithLocale(browser, "sv-SE"); // Swedish — not a shipped locale
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator('komu-tool-dock [data-tool="select"]')).toHaveAttribute(
    "aria-label",
    "Select",
  );
  await ctx.close();
});
