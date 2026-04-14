// @ts-check
/**
 * Sprint 1 E2E — validates the UI + phase flow that the Node engine
 * simulator cannot reach: Settings modal (#54), role reveal rendering,
 * night screen + investigate action, day transition, game termination.
 *
 * Runs in a SINGLE browser context with ?dev=1 — stub players are
 * local-only per dev.js and never touch Supabase presence. The game host
 * itself still subscribes to one real Supabase channel, which is the only
 * credit spent against the free-tier budget per test run.
 *
 * Run with:  npm run test:e2e
 */

import { test, expect } from '@playwright/test';

const MAX_BOOT_MS = 10_000;
const PHASE_TIMEOUT_MS = 20_000;

async function bootDevMode(page) {
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto('/?dev=1', { waitUntil: 'load', timeout: MAX_BOOT_MS });
  await expect(page.locator('#screen-title')).toBeVisible({ timeout: MAX_BOOT_MS });
  return { consoleErrors };
}

async function createRoom(page, name = 'TestHost') {
  await page.locator('#btn-create').click();
  await expect(page.locator('#create-name')).toBeVisible();
  await page.locator('#create-name').fill(name);
  await page.locator('#btn-do-create').click();

  // Wait for the lobby screen — this implies the Supabase channel
  // subscription landed and presence is tracking. If env creds are
  // missing, an error text appears in #create-error instead.
  const createErr = page.locator('#create-error');
  const lobby = page.locator('#screen-lobby');

  const outcome = await Promise.race([
    lobby.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'lobby'),
    createErr
      .filter({ hasText: /Supabase not configured|Failed to create/ })
      .waitFor({ timeout: 15_000 })
      .then(() => 'error'),
  ]).catch(() => 'timeout');

  if (outcome !== 'lobby') {
    const errText = (await createErr.textContent().catch(() => '')) || '';
    throw new Error(
      `Lobby did not appear (outcome=${outcome}). Create error: "${errText.trim()}". ` +
        `Check that .env has VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY set.`
    );
  }
}

async function addStubs(page, count) {
  const addBtn = page.locator('#btn-add-stub');
  await expect(addBtn).toBeVisible();
  for (let i = 0; i < count; i++) {
    await addBtn.click();
  }
  // lobby-count text is like "4/16" — wait until we see our expected count.
  await expect(page.locator('#lobby-count')).toHaveText(new RegExp(`^${count + 1}/`));
}

// ---------------------------------------------------------------- test 1

async function openSettingsAndSetMinimumTimers(page) {
  await page.locator('#btn-settings').click();
  await expect(page.locator('.settings-modal__overlay')).toBeVisible();
  await page.locator('input[name="nightDuration"][value="15"]').check();
  await page.locator('input[name="discussionDuration"][value="30"]').check();
  await page.locator('input[name="voteDuration"][value="15"]').check();
  await page.locator('#settings-save').click();
  await expect(page.locator('.settings-modal__overlay')).toHaveCount(0);
}

test('sprint-1: Settings modal opens, adjusts timers to 15/30/15, and closes (#54 #101)', async ({ page }) => {
  const { consoleErrors } = await bootDevMode(page);
  await createRoom(page, 'SettingsTest');
  await addStubs(page, 3);

  await page.locator('#btn-settings').click();
  await expect(page.locator('.settings-modal__overlay')).toBeVisible();

  await expect(page.locator('input[name="nightDuration"]')).toHaveCount(4);
  await expect(page.locator('input[name="discussionDuration"]')).toHaveCount(3);
  await expect(page.locator('input[name="voteDuration"]')).toHaveCount(3);

  // #101 regression gate — before clicking, the default Night radio
  // should be 30, NOT 15. This catches a future bug where the initial
  // render and the post-save round-trip silently agree on the wrong
  // value.
  await expect(page.locator('input[name="nightDuration"][value="30"]')).toBeChecked();

  await page.locator('input[name="nightDuration"][value="15"]').check();
  await page.locator('input[name="discussionDuration"][value="30"]').check();
  await page.locator('input[name="voteDuration"][value="15"]').check();

  // #101 regression gate — assert the DOM actually reflects the click
  // before we hit Save. If radioGroup() rendering ever breaks, this
  // fails loudly instead of the lobby-config string match silently
  // passing on a coincidental number.
  await expect(page.locator('input[name="nightDuration"][value="15"]')).toBeChecked();
  await expect(page.locator('input[name="nightDuration"][value="30"]')).not.toBeChecked();

  const roleCheckboxes = page.locator('.settings-modal__role input[type="checkbox"]');
  await expect(roleCheckboxes).toHaveCount(6);

  await page.locator('#settings-save').click();
  await expect(page.locator('.settings-modal__overlay')).toHaveCount(0);
  await expect(page.locator('#screen-lobby')).toBeVisible();

  // #101 — assert the lobby-config line renders the NEW values in the
  // specific 'Night 15s · Discuss 30s · Vote 15s' format. The earlier
  // /15/ + /30/ regex pair passed even when the post-save draft was
  // stale (Vote defaults include enough digits to accidentally match).
  // This check is unique to a working radio → draft propagation.
  const configLine = (await page.locator('#lobby-config').textContent()) || '';
  expect(configLine).toContain('Night 15s');
  expect(configLine).toContain('Discuss 30s');
  expect(configLine).toContain('Vote 15s');

  // #101 — round-trip check: reopen Settings and the radios we just
  // saved should now be the checked defaults. If the draft never made
  // it back into roomConfig, the second-opened modal would re-render
  // the original 30/40/20 selection and this assertion would fail.
  await page.locator('#btn-settings').click();
  await expect(page.locator('.settings-modal__overlay')).toBeVisible();
  await expect(page.locator('input[name="nightDuration"][value="15"]')).toBeChecked();
  await expect(page.locator('input[name="discussionDuration"][value="30"]')).toBeChecked();
  await expect(page.locator('input[name="voteDuration"][value="15"]')).toBeChecked();
  await page.locator('#settings-cancel').click();
  await expect(page.locator('.settings-modal__overlay')).toHaveCount(0);

  expect(consoleErrors, `console errors during settings flow:\n${consoleErrors.join('\n')}`).toHaveLength(0);
});

// ---------------------------------------------------------------- test 2

test('sprint-1: N=4 full round — role reveal → night → day-discuss → vote → result/game-over', async ({ page }) => {
  test.setTimeout(240_000); // generous: several phase transitions at 60s/round minimum

  const { consoleErrors } = await bootDevMode(page);
  await createRoom(page, 'FlowTest');
  await addStubs(page, 3); // N=4

  // Shrink phase timers so the test completes quickly. Also exercises
  // #54 end-to-end: the modal writes to GAME.* AND the new values have
  // to propagate into the actual phase machine.
  await openSettingsAndSetMinimumTimers(page);

  await page.locator('#btn-start-game').click();

  // Role reveal
  await expect(page.locator('#screen-role-reveal')).toBeVisible({ timeout: PHASE_TIMEOUT_MS });
  const readyBtn = page.locator(
    'button:has-text("Ready"), button:has-text("I\'m Ready"), #btn-ready, #role-reveal-ready'
  );
  if ((await readyBtn.count()) > 0) {
    await readyBtn.first().click().catch(() => {});
  }

  // Night screen
  const nightScreen = page.locator('#screen-night');
  await expect(nightScreen).toBeVisible({ timeout: PHASE_TIMEOUT_MS });

  const nightClasses = (await nightScreen.getAttribute('class')) || '';
  const roleMatch = nightClasses.match(/screen-night--(\w+)/);
  const localRole = roleMatch ? roleMatch[1] : 'unknown';
  console.log(`[sprint-1] local role=${localRole}`);

  // If we drew Mafia or Host, pick a target. This exercises #95 on the
  // host path. We pick mid-timer to give the result time to render.
  if (localRole === 'mafia' || localRole === 'host') {
    const buttons = page.locator('.night-btn');
    await expect(buttons.first()).toBeVisible();
    await page.waitForTimeout(1500);
    await buttons.first().click();

    if (localRole === 'host') {
      const status = page.locator('#night-status');
      await expect(status).toContainText(/Mafia|Not Mafia/, { timeout: 8000 });
      const statusText = (await status.textContent()) || '';
      console.log(`[sprint-1] #95 investigate result: "${statusText.trim()}"`);
    }
  }

  // Night → Day transition (#95 does not hang the game)
  await expect(page.locator('#screen-day-discuss')).toBeVisible({ timeout: 30_000 });
  console.log('[sprint-1] night → day-discuss');

  // Day-discuss → vote — prove the phase machine keeps advancing.
  // Use an any-of assertion: game may already be over if the night kill
  // triggered a mafia-win condition at N=4 (2 mafia vs 2 townies = mafia
  // wins per checkWinCondition's >= rule).
  const advanced = page.locator(
    '#screen-day-vote, #screen-day-result, #screen-game-over'
  );
  await expect(advanced.first()).toBeVisible({ timeout: 60_000 });
  const advancedId =
    (await advanced.first().getAttribute('id')) || '(none)';
  console.log(`[sprint-1] phase machine advanced past day-discuss → ${advancedId}`);

  // The game WILL reach game-over eventually. At N=4 with the 2-mafia
  // distribution, most games end within 1-2 rounds. Allow a cushion.
  const gameOver = page.locator('#screen-game-over');
  await gameOver.waitFor({ state: 'visible', timeout: 180_000 });
  console.log('[sprint-1] game-over reached');

  expect(consoleErrors, `console errors during full round:\n${consoleErrors.join('\n')}`).toHaveLength(0);
});
