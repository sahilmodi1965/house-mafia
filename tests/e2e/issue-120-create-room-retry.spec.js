// @ts-check
/**
 * Issue #120 — Create Room button does nothing: presence callback race.
 *
 * Runtime-fidelity smoke per Stratos factory rule #9:
 *
 *   - Call the runtime entry the player actually clicks: btn-create →
 *     btn-do-create, via the real Supabase subscribe path.
 *   - Assert POSITIVE state: #screen-lobby visible AND #lobby-code text
 *     length ≥ ROOM_CODE_LENGTH (4). Never `not(title visible)`.
 *   - Exercise the specific failure mode from the bug report: repeated
 *     Create Room attempts from the same page session. The bug is
 *     intermittent because the first probe channel stays in the client
 *     topic cache and only races the second create. Two consecutive
 *     creates under the same browser context are enough to catch it.
 *   - Block on console errors — the bug's primary signal is the
 *     "cannot add 'presence' callbacks after 'subscribe()'" throw.
 *
 * Skips with a descriptive message if Supabase env is not configured
 * (factory preview runs without secrets).
 */

import { test, expect } from '@playwright/test';

const MAX_BOOT_MS = 10_000;
const LOBBY_TIMEOUT_MS = 15_000;
const CREATE_ATTEMPTS = 3;

async function createRoomOnce(page, name) {
  const createErr = page.locator('#create-error');
  const lobby = page.locator('#screen-lobby');

  await page.locator('#btn-create').click();
  await expect(page.locator('#create-name')).toBeVisible();
  await page.locator('#create-name').fill(name);
  await page.locator('#btn-do-create').click();

  const outcome = await Promise.race([
    lobby.waitFor({ state: 'visible', timeout: LOBBY_TIMEOUT_MS }).then(() => 'lobby'),
    createErr
      .filter({ hasText: /Supabase not configured/ })
      .waitFor({ timeout: 2_000 })
      .then(() => 'no-supabase'),
  ]).catch(() => 'timeout');

  if (outcome === 'no-supabase') return outcome;

  if (outcome !== 'lobby') {
    const errText = (await createErr.textContent().catch(() => '')) || '';
    throw new Error(
      `Lobby did not appear on attempt for "${name}" (outcome=${outcome}). ` +
        `Create error text: "${errText.trim()}".`
    );
  }

  // Positive-state assertion: lobby is active AND room code is populated.
  // This is the runtime contract the bug violated — Create silently
  // returned with no screen change and no code.
  await expect(lobby).toBeVisible();
  const code = ((await page.locator('#lobby-code').textContent()) || '').trim();
  expect(code.length, `room code must be populated, got "${code}"`).toBeGreaterThanOrEqual(4);

  return 'lobby';
}

test('issue-120: consecutive Create Room attempts succeed without presence errors', async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto('/?dev=1', { waitUntil: 'load', timeout: MAX_BOOT_MS });
  await expect(page.locator('#screen-title')).toBeVisible({ timeout: MAX_BOOT_MS });

  // Attempt 1
  const first = await createRoomOnce(page, 'Issue120Host1');
  test.skip(first === 'no-supabase', 'Supabase env not configured; cannot exercise real channel subscribe.');

  // Leave the lobby back to title, then create again. This is the
  // specific sequence that exposed the probe-channel cache race: the
  // first room's channel/probe entries are still in the client topic
  // registry when the second findAvailableRoomCode() runs.
  await page.locator('#btn-leave-lobby').click();
  await expect(page.locator('#screen-title')).toBeVisible({ timeout: 5_000 });

  for (let i = 2; i <= CREATE_ATTEMPTS; i++) {
    await createRoomOnce(page, `Issue120Host${i}`);
    await page.locator('#btn-leave-lobby').click();
    await expect(page.locator('#screen-title')).toBeVisible({ timeout: 5_000 });
  }

  // Filter the specific error signature from issue #120. We don't assert
  // zero console errors overall (Supabase prints benign info logs that
  // Playwright classifies as error type under some envs). We DO assert
  // the exact bug signatures never appear.
  const presenceRaceErrors = consoleErrors.filter((e) =>
    /cannot add .*presence.* callbacks.* after .*subscribe/i.test(e)
  );
  const nullIdErrors = consoleErrors.filter((e) =>
    /Cannot read properties of null .*reading .'id'./i.test(e)
  );

  expect(
    presenceRaceErrors,
    `presence-callback race errors seen:\n${presenceRaceErrors.join('\n')}`
  ).toHaveLength(0);
  expect(
    nullIdErrors,
    `null-id TypeErrors seen:\n${nullIdErrors.join('\n')}`
  ).toHaveLength(0);
});
