// @ts-check
/**
 * House Mafia smoke test — the cheapest visual QA the factory can run.
 *
 * Asserts the built game actually loads and renders the title screen.
 * Catches: asset path errors, JS parse errors, missing DOM containers,
 * and console errors during startup.
 *
 * Deployed by the Stratos Games Factory — do not hand-edit.
 */

import { test, expect } from '@playwright/test';

test('game loads without console errors', async ({ page }) => {
  const consoleErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });

  const response = await page.goto('/', { waitUntil: 'load', timeout: 10_000 });
  expect(response, 'page response should exist').not.toBeNull();
  expect(response?.status(), 'HTTP status should be < 400').toBeLessThan(400);

  // Give the app ~2s to finish its boot sequence.
  await page.waitForTimeout(2000);

  // --- Title assertion ---
  const title = await page.title();
  expect(title.trim(), 'page title must not be empty').not.toBe('');

  // --- Container assertion ---
  // House Mafia renders into #app. The title screen should be visible.
  const appVisible = await page.locator('#app').isVisible().catch(() => false);
  expect(appVisible, 'expected #app to be visible after boot').toBe(true);

  // --- Screenshot for the PR comment ---
  await page.screenshot({
    path: 'playwright-report/house-mafia-smoke.png',
    fullPage: true,
  });

  // --- Console-error assertion comes LAST so the screenshot is always taken ---
  expect(
    consoleErrors,
    `console errors during boot:\n${consoleErrors.join('\n')}`
  ).toHaveLength(0);
});
