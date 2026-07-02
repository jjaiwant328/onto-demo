import { test } from "@playwright/test";

test("Debug: Take screenshots to inspect the app structure", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  
  // Dump the page structure to understand the UI
  const pageContent = await page.evaluate(() => {
    return {
      title: document.title,
      bodyText: document.body.innerText.slice(0, 2000),
      allText: Array.from(document.querySelectorAll('*')).map(el => ({
        tag: el.tagName,
        text: el.textContent?.slice(0, 50),
        id: el.id,
        classes: el.className
      })).filter(e => e.text && (e.text.includes('QSR') || e.text.includes('Retailer') || e.text.includes('Customer') || e.text.includes('Reset')))
    };
  });

  console.log("=== PAGE STRUCTURE ===");
  console.log("Title:", pageContent.title);
  console.log("\nRelevant elements:");
  pageContent.allText.slice(0, 20).forEach(el => {
    console.log(`${el.tag} (${el.classes}): ${el.text}`);
  });

  // Take full page screenshot
  await page.screenshot({ path: "/private/tmp/claude-502/-Users-Jaiwant-jonathan-DBXApps-onto-demo/9daef2a9-41e9-4c0d-a5c7-7d13dcc3be0f/scratchpad/debug_full.png", fullPage: true });
  console.log("\nScreenshot saved");
});
