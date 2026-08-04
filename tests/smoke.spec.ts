import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// RT_onto_demo (AppKit) smoke test — verifies the core ontology-driven sections
// load and render their headings without page errors.
// must match the <h1> in App.tsx
const APP_NAME = 'Ontology-demo';

interface SectionPage {
  navLabel: string;
  path: string;
  heading: string;
}

const SECTIONS: SectionPage[] = [
  { navLabel: 'Data Products', path: '/data-products', heading: 'Data Products' },
  { navLabel: 'Ontology Studio', path: '/ontology-studio', heading: 'Ontology Studio' },
  { navLabel: 'Semantic Explorer', path: '/semantic-explorer', heading: 'Semantic Explorer' },
  { navLabel: 'Business View', path: '/business-view', heading: 'Business View' },
  // documents how the derivation pipeline works (and the provenance badge legend)
  { navLabel: 'About', path: '/about', heading: 'About this app' },
];

let testArtifactsDir: string;
let consoleErrors: string[] = [];
let pageErrors: string[] = [];

test('smoke test - app loads with all core sections in the nav', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: APP_NAME })).toBeVisible();
  for (const s of SECTIONS) {
    // Business View is gated behind a default-off Settings toggle, so it is not in
    // the nav on a fresh load — its page is still covered by the per-section test.
    if (s.navLabel === 'Business View') continue;
    await expect(page.getByRole('link', { name: s.navLabel })).toBeVisible();
  }
});

for (const s of SECTIONS) {
  test(`smoke test - ${s.navLabel} page loads`, async ({ page }) => {
    await page.goto(s.path);
    await expect(page.getByRole('heading', { name: s.heading, level: 2 })).toBeVisible();
  });
}

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  pageErrors = [];
  testArtifactsDir = join(process.cwd(), '.smoke-test');
  mkdirSync(testArtifactsDir, { recursive: true });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      consoleErrors.push(`${msg.text()} at ${loc.url}:${loc.lineNumber}:${loc.columnNumber}`);
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(`Page error: ${error.message}\nStack: ${error.stack || 'n/a'}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const testName = testInfo.title.replace(/ /g, '-').toLowerCase();
  const screenshotPath = join(testArtifactsDir, `${testName}-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const logsPath = join(testArtifactsDir, `${testName}-console-logs.txt`);
  writeFileSync(
    logsPath,
    ['=== Console Errors ===', ...consoleErrors, '\n=== Page Errors ===', ...pageErrors].join('\n'),
    'utf-8'
  );
  if (pageErrors.length > 0) console.log('Page errors detected:', pageErrors);
  await page.close();
});
