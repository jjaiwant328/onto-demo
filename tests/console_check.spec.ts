import { test } from "@playwright/test";

test("Check console errors during all operations", async ({ page }) => {
  const errors: string[] = [];
  const warnings: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    } else if (msg.type() === "warning") {
      warnings.push(msg.text());
    }
  });

  // Open and clear
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(500);

  // Switch to QSR
  const customerBtn = page.locator("button").filter({ hasText: /Retailer|QSR/ }).first();
  await customerBtn.click();
  await page.waitForTimeout(300);

  const qsrOption = page.locator("[role='option']").filter({ hasText: "QSR" }).first();
  await qsrOption.click();
  await page.waitForTimeout(800);

  // Navigate
  const tabs = ["Data Products", "Ontology Studio", "Semantic Explorer", "Graph Explorer", "Business View"];
  for (const tabName of tabs) {
    const tabBtn = page.locator("button").filter({ hasText: tabName }).first();
    const isVisible = await tabBtn.isVisible({ timeout: 1000 }).catch(() => false);
    if (isVisible) {
      await tabBtn.click();
      await page.waitForTimeout(1200);
    }
  }

  // Reload
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1200);

  // Go to Data Products and click Reset
  await page.goto("/data-products", { waitUntil: "load" });
  await page.waitForTimeout(500);

  const resetBtn = page.locator("button:has-text('Reset')").first();
  if (await resetBtn.isVisible()) {
    await resetBtn.click();
    await page.waitForTimeout(1500);
  }

  console.log("\n=== CONSOLE ERRORS ===");
  console.log(`Total errors: ${errors.length}`);
  errors.forEach((e, i) => {
    console.log(`${i + 1}. ${e}`);
  });

  console.log("\n=== CONSOLE WARNINGS ===");
  console.log(`Total warnings: ${warnings.length}`);
  warnings.slice(0, 10).forEach((w, i) => {
    console.log(`${i + 1}. ${w}`);
  });
});
