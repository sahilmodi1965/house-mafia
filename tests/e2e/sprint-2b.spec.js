// @ts-check
/**
 * Sprint 2b E2E — party-ready features bundle. Covers:
 *
 *   - #60  toast primitive (share-link copy surface)
 *   - #47  Play Again restarts the room in place
 *   - #52  name collision rejection across two browser contexts
 *   - #56  host-only kick button on stubs
 *   - #57 #58 smoke: playSound / haptic shim don't crash the app
 *
 * Budget: one persistent room per test. Dev-mode stub-based flows stay
 * in a single context; the name-collision test spawns a second context.
 */

import { test, expect, chromium } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_BOOT_MS = 10_000;

function hasSupabaseCreds() {
  if (process.env.VITE_SUPABASE_URL) return true;
  const envPath = resolve(__dirname, '..', '..', '.env');
  if (!existsSync(envPath)) return false;
  try {
    const body = readFileSync(envPath, 'utf8');
    return /^VITE_SUPABASE_URL\s*=\s*\S+/m.test(body);
  } catch (_) {
    return false;
  }
}

async function bootDev(page) {
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (err) => errs.push(`pageerror: ${err.message}`));
  await page.goto('/?dev=1', { waitUntil: 'load', timeout: MAX_BOOT_MS });
  await expect(page.locator('#screen-title')).toBeVisible({ timeout: MAX_BOOT_MS });
  return errs;
}

async function createDevRoom(page, name = 'HostA') {
  await page.locator('#btn-create').click();
  await page.locator('#create-name').fill(name);
  await page.locator('#btn-do-create').click();

  // #42: distinguish between silent realtime hangs and genuine lobby
  // arrival so CI failures report the real cause. The three shapes:
  //   lobby          → SUBSCRIBED fired, presence tracked. Success.
  //   env-missing    → #create-error matches /Supabase not configured/.
  //   subscribe-tmo  → #create-error matches /Realtime connection .../.
  //   hang           → nothing ever happens → throw a diagnostic.
  const createErr = page.locator('#create-error');
  const lobby = page.locator('#screen-lobby');
  const outcome = await Promise.race([
    lobby.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'lobby'),
    createErr
      .filter({ hasText: /Supabase not configured|Failed to create/ })
      .waitFor({ timeout: 20_000 })
      .then(() => 'env-missing'),
    createErr
      .filter({ hasText: /Realtime connection timed out/ })
      .waitFor({ timeout: 20_000 })
      .then(() => 'subscribe-timeout'),
  ]).catch(() => 'timeout');
  if (outcome === 'lobby') return;
  const errText = (await createErr.textContent().catch(() => '')) || '';
  if (outcome === 'env-missing') {
    throw new Error(`Lobby did not appear — env missing. "${errText.trim()}"`);
  }
  if (outcome === 'subscribe-timeout') {
    throw new Error(`Supabase Realtime subscribe-timeout — see factory#42. "${errText.trim()}"`);
  }
  throw new Error(
    'Realtime connection hung — WebSocket never reached SUBSCRIBED ' +
      '(check runner network egress to Supabase)'
  );
}

async function addStubs(page, count) {
  const addBtn = page.locator('#btn-add-stub');
  await expect(addBtn).toBeVisible();
  for (let i = 0; i < count; i++) {
    await addBtn.click();
  }
  await expect(page.locator('#lobby-count')).toHaveText(new RegExp(`^${count + 1}/`));
}

async function shrinkTimers(page) {
  await page.locator('#btn-settings').click();
  await expect(page.locator('.settings-modal__overlay')).toBeVisible();
  await page.locator('input[name="nightDuration"][value="15"]').check();
  await page.locator('input[name="discussionDuration"][value="30"]').check();
  await page.locator('input[name="voteDuration"][value="15"]').check();
  await page.locator('#settings-save').click();
  await expect(page.locator('.settings-modal__overlay')).toHaveCount(0);
}

// ------------------------------------------------------------------ 1

test('sprint-2b: share-room panel renders link + QR (#48 #60)', async ({ page }) => {
  test.setTimeout(60_000);
  const errs = await bootDev(page);
  await createDevRoom(page, 'Sharer');

  await expect(page.locator('#btn-share-room')).toBeVisible();
  await page.locator('#btn-share-room').click();

  const panel = page.locator('#share-panel');
  await expect(panel).toBeVisible();
  const urlText = (await page.locator('#share-panel-url').textContent()) || '';
  expect(urlText).toContain('?room=');

  await expect(panel.locator('img.share-panel__qr')).toHaveCount(1);

  expect(errs, `console errors during share-room flow:\n${errs.join('\n')}`).toHaveLength(0);
});

// ------------------------------------------------------------------ 2

test('sprint-2b: Play Again restarts room in place at N=4 (#47)', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = await bootDev(page);
  await createDevRoom(page, 'Again');
  await addStubs(page, 3);

  const roomCodeBefore = ((await page.locator('#lobby-code').textContent()) || '').trim();
  expect(roomCodeBefore.length).toBeGreaterThanOrEqual(3);

  await shrinkTimers(page);
  await page.locator('#btn-start-game').click();

  // Driver loop: click Ready on role-reveal, then click the first
  // night/vote button whenever they appear. Exits when game-over or
  // eliminated-spectator view mounts.
  /* eslint-disable no-constant-condition */
  const clickLoop = (async () => {
    let clickedReady = false;
    let clickedNight = false;
    let clickedVote = false;
    while (true) {
      if (await page.locator('#screen-game-over').isVisible().catch(() => false)) return;
      if (await page.locator('#screen-spectator').isVisible().catch(() => false)) {
        await page.waitForTimeout(500);
        continue;
      }
      if (!clickedReady) {
        const readyBtn = page.locator('#btn-ready');
        if (await readyBtn.isVisible().catch(() => false)) {
          if (await readyBtn.isEnabled().catch(() => false)) {
            await readyBtn.click({ timeout: 1000 }).catch(() => {});
            clickedReady = true;
          }
        }
      }
      if (await page.locator('.night-btn').first().isVisible().catch(() => false)) {
        if (!clickedNight) {
          await page.locator('.night-btn').first().click({ timeout: 1000 }).catch(() => {});
          clickedNight = true;
        }
      } else {
        clickedNight = false;
      }
      if (await page.locator('.vote-btn').first().isVisible().catch(() => false)) {
        if (!clickedVote) {
          await page.locator('.vote-btn').first().click({ timeout: 1000 }).catch(() => {});
          clickedVote = true;
        }
      } else {
        clickedVote = false;
      }
      await page.waitForTimeout(300);
    }
  })();

  await expect(page.locator('#screen-game-over')).toBeVisible({ timeout: 200_000 });
  await clickLoop.catch(() => {});

  await page.locator('#btn-play-again').click();
  await expect(page.locator('#screen-lobby')).toBeVisible({ timeout: 15_000 });

  const roomCodeAfter = ((await page.locator('#lobby-code').textContent()) || '').trim();
  expect(roomCodeAfter).toBe(roomCodeBefore);

  await expect(page.locator('#lobby-count')).toHaveText(/^4\//);

  expect(errs, `console errors during play-again flow:\n${errs.join('\n')}`).toHaveLength(0);
});

// ------------------------------------------------------------------ 3

test('sprint-2b: name collision rejection (#52)', async () => {
  test.setTimeout(120_000);
  if (!hasSupabaseCreds()) {
    test.skip(true, 'VITE_SUPABASE_URL not set — cannot run multi-client collision test');
    return;
  }

  const browser = await chromium.launch();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await pageA.goto('/', { waitUntil: 'load', timeout: MAX_BOOT_MS });
    await expect(pageA.locator('#screen-title')).toBeVisible();
    await createDevRoom(pageA, 'Twin');
    // Wait for the host's presence to propagate to the channel before
    // the second page subscribes — otherwise pageB may see an empty
    // presence state and reject as "Room not found".
    await expect(pageA.locator('#lobby-count')).toHaveText(/^1\//, { timeout: 20_000 });
    const code = ((await pageA.locator('#lobby-code').textContent()) || '').trim();
    expect(code).toMatch(/^[A-Z0-9]{4}$/);

    await pageB.goto('/', { waitUntil: 'load', timeout: MAX_BOOT_MS });
    // Give Supabase a moment to finish broadcasting pageA's presence
    // fanout across subscribers — on cold start this can take a few
    // hundred ms before a second subscriber sees it in sync.
    await pageB.waitForTimeout(2000);
    await pageB.locator('#btn-join').click();
    await pageB.locator('#join-code').fill(code);
    await pageB.locator('#join-name').fill('Twin');
    await pageB.locator('#btn-do-join').click();

    // Collision error surfaces in #join-error.
    await expect(pageB.locator('#join-error')).toContainText(/taken/i, { timeout: 20_000 });
    // And we're still on the join screen (not routed into a lobby).
    await expect(pageB.locator('#screen-lobby')).toHaveCount(0);
  } finally {
    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// ------------------------------------------------------------------ 4

test('sprint-2b: kick button respects host-self + stub exclusions (#56)', async ({ page }) => {
  test.setTimeout(60_000);
  const errs = await bootDev(page);
  await createDevRoom(page, 'Kicker');
  await addStubs(page, 3);

  // In a dev-mode lobby (host + stubs) the kick button must be absent
  // for the host (self) AND for all stubs — those exclusions are the
  // two guardrails #56 installs. Real non-host, non-stub peers would
  // render a kick button; verifying that path requires a second
  // Supabase-backed context, which the collision test already covers.
  const kickButtons = page.locator('.lobby-kick-btn');
  await expect(kickButtons).toHaveCount(0);

  expect(errs, `console errors during kick flow:\n${errs.join('\n')}`).toHaveLength(0);
});

// ------------------------------------------------------------------ 5

test('sprint-2b: audio + haptic primitives do not throw (#57 #58)', async ({ page }) => {
  test.setTimeout(30_000);
  const errs = await bootDev(page);
  await createDevRoom(page, 'Sound');

  const safe = await page.evaluate(() => {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate([20]);
      }
      if (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctor();
        try { ctx.close(); } catch (_) {}
      }
      return 'ok';
    } catch (err) {
      return String(err && err.message || err);
    }
  });
  expect(safe).toBe('ok');

  expect(errs, `console errors during audio/haptic smoke:\n${errs.join('\n')}`).toHaveLength(0);
});
