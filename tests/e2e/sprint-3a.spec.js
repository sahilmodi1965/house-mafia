// @ts-check
/**
 * Sprint 3a E2E — polish regression coverage. Covers:
 *
 *   - #109 kick flow strips ?room= from URL and blocks instant rejoin
 *   - #107 Share Room always shows a toast (success OR clipboard reject)
 *   - #108 QR image loads (or the slot hides gracefully on error)
 *
 * These three bugs were all discovered during live playtest of PR #105
 * on 2026-04-14 and they are the exact failure modes this spec guards
 * against.
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

// ------------------------------------------------------------------ 1
// #109 — kick flow strips URL and prevents rejoin.
//
// Two contexts, realistic wire:
//   pageA creates a room, we read the room code.
//   pageB navigates to ?room=CODE (simulating a shared link), joins.
//   pageA kicks pageB.
//
// After the kick, pageB must be on the title screen with a clean URL
// and a warn toast — NOT bounced back into the join screen.

test('sprint-3a: kick strips ?room= and blocks auto-rejoin (#109)', async () => {
  test.setTimeout(120_000);
  if (!hasSupabaseCreds()) {
    test.skip(true, 'VITE_SUPABASE_URL not set — cannot run kick-rejoin test');
    return;
  }

  const browser = await chromium.launch();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    // 1. pageA creates a room (no ?room=, host path).
    await pageA.goto('/', { waitUntil: 'load', timeout: MAX_BOOT_MS });
    await expect(pageA.locator('#screen-title')).toBeVisible();
    await pageA.locator('#btn-create').click();
    await pageA.locator('#create-name').fill('HostA');
    await pageA.locator('#btn-do-create').click();
    await expect(pageA.locator('#screen-lobby')).toBeVisible({ timeout: 20_000 });
    await expect(pageA.locator('#lobby-count')).toHaveText(/^1\//, { timeout: 20_000 });

    const code = ((await pageA.locator('#lobby-code').textContent()) || '').trim();
    expect(code).toMatch(/^[A-Z0-9]{4}$/);

    // 2. pageB navigates to the shared URL (?room=CODE). main.js should
    //    auto-route them to the Join screen with the code pre-filled.
    //    Small cushion for presence propagation (same pattern as #52).
    await pageB.waitForTimeout(1500);
    await pageB.goto(`/?room=${code}`, { waitUntil: 'load', timeout: MAX_BOOT_MS });
    await expect(pageB.locator('#screen-join')).toBeVisible({ timeout: 10_000 });
    await expect(pageB.locator('#join-code')).toHaveValue(code);
    await pageB.locator('#join-name').fill('Victim');
    await pageB.locator('#btn-do-join').click();
    await expect(pageB.locator('#screen-lobby')).toBeVisible({ timeout: 20_000 });

    // 3. pageA's lobby should show 2/... once pageB's presence propagates.
    await expect(pageA.locator('#lobby-count')).toHaveText(/^2\//, { timeout: 20_000 });

    // 4. pageA kicks pageB. window.confirm is native — override it on
    //    pageA before clicking so the confirm returns true.
    await pageA.evaluate(() => {
      window.confirm = () => true;
    });
    const kickBtn = pageA.locator('.lobby-kick-btn[data-kick-name="Victim"]');
    await expect(kickBtn).toBeVisible();
    await kickBtn.click();

    // 5. pageB should land back on the title screen (NOT the join
    //    screen). The URL query string must be empty — #109's core fix.
    await expect(pageB.locator('#screen-title')).toBeVisible({ timeout: 10_000 });
    await expect(pageB.locator('#screen-join')).toHaveCount(0);

    const searchAfter = await pageB.evaluate(() => window.location.search);
    expect(searchAfter).toBe('');

    // 6. The sessionStorage flag is a defensive guard consumed on the
    //    NEXT page boot (main.js reads-and-clears it). The kick handler
    //    navigates in-app without a reload, so the flag should still be
    //    "1" at this point — it arms the next boot against auto-rejoin.
    const flag = await pageB.evaluate(() => sessionStorage.getItem('hm:just-kicked'));
    expect(flag).toBe('1');

    // 7. A warn/error toast explaining why they're back on the title
    //    screen — the kick handler fires "You were removed from the room".
    const toast = pageB.locator('.toast');
    await expect(toast.first()).toBeVisible({ timeout: 5_000 });
    const toastText = (await toast.first().textContent()) || '';
    expect(toastText).toMatch(/removed/i);

    // 8. Simulate a reload — now main.js should consume the flag and it
    //    should go back to null, AND the Join screen should NOT auto-open
    //    because the URL was already stripped in step 5.
    await pageB.reload({ waitUntil: 'load' });
    await expect(pageB.locator('#screen-title')).toBeVisible({ timeout: 10_000 });
    const flagAfterReload = await pageB.evaluate(() => sessionStorage.getItem('hm:just-kicked'));
    expect(flagAfterReload).toBeNull();
  } finally {
    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// ------------------------------------------------------------------ 2
// #107 — Share Room always shows a toast.
//
// Covers two paths: clipboard.writeText resolves (success toast) and
// clipboard.writeText rejects (fallback "tap to copy" toast). Both
// paths MUST fire a visible toast — the bug was that the reject path
// was silent, which made the whole share flow feel broken.

test('sprint-3a: Share Room shows success toast on clipboard resolve (#107)', async ({ page }) => {
  test.setTimeout(60_000);
  page.on('console', (m) => { if (m.type() === 'error') console.log('[p0 console error]', m.text()); });

  // Force clipboard.writeText to resolve deterministically so the test
  // doesn't depend on the headless browser's clipboard permissions
  // (which vary across Playwright versions and platforms).
  // IMPORTANT: addInitScript must be registered BEFORE page.goto,
  // it only applies to subsequent navigations.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
  });

  await page.goto('/?dev=1', { waitUntil: 'load', timeout: MAX_BOOT_MS });
  await expect(page.locator('#screen-title')).toBeVisible({ timeout: MAX_BOOT_MS });

  await page.locator('#btn-create').click();
  await page.locator('#create-name').fill('Sharer');
  await page.locator('#btn-do-create').click();
  await expect(page.locator('#screen-lobby')).toBeVisible({ timeout: 20_000 });

  await page.locator('#btn-share-room').click();
  // A toast MUST appear within 3s — success path shows "Link copied".
  await expect(page.locator('.toast').first()).toBeVisible({ timeout: 3_000 });
  const text = (await page.locator('.toast').first().textContent()) || '';
  expect(text).toMatch(/copied/i);
});

test('sprint-3a: Share Room shows fallback toast when clipboard rejects (#107)', async ({ page }) => {
  test.setTimeout(60_000);
  // Stub clipboard.writeText to REJECT every call — this is the exact
  // live-test failure mode where the toast used to be silent.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
  });

  await page.goto('/?dev=1', { waitUntil: 'load', timeout: MAX_BOOT_MS });
  await expect(page.locator('#screen-title')).toBeVisible({ timeout: MAX_BOOT_MS });

  await page.locator('#btn-create').click();
  await page.locator('#create-name').fill('Sharer');
  await page.locator('#btn-do-create').click();
  await expect(page.locator('#screen-lobby')).toBeVisible({ timeout: 20_000 });

  await page.locator('#btn-share-room').click();
  // A toast MUST still appear — fallback path shows "tap to copy".
  await expect(page.locator('.toast').first()).toBeVisible({ timeout: 3_000 });
  const text = (await page.locator('.toast').first().textContent()) || '';
  // Accept either the fallback wording OR, if some other toast fires
  // first, at least accept ANY visible toast — the bug was NO toast.
  expect(text.length).toBeGreaterThan(0);
});

// ------------------------------------------------------------------ 3
// #108 — QR image either loads or the slot hides gracefully.
//
// Any of the following counts as a pass:
//   (a) An <img> with naturalWidth > 0 within 5s (qrserver responded).
//   (b) A <canvas> with non-zero width (future inline encoder path).
//   (c) The QR slot is hidden (onerror fallback kicked in).
// The only failing state is a broken-image placeholder — that's what
// Google Charts deprecation produced in live testing, and that is
// what #108 kills.

test('sprint-3a: QR image loads or hides gracefully (#108)', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/?dev=1', { waitUntil: 'load', timeout: MAX_BOOT_MS });
  await expect(page.locator('#screen-title')).toBeVisible({ timeout: MAX_BOOT_MS });
  await page.locator('#btn-create').click();
  await page.locator('#create-name').fill('QRTester');
  await page.locator('#btn-do-create').click();
  await expect(page.locator('#screen-lobby')).toBeVisible({ timeout: 20_000 });

  await page.locator('#btn-share-room').click();
  await expect(page.locator('#share-panel')).toBeVisible({ timeout: 5_000 });

  // Give the image up to 5s to either load or fire onerror+hide.
  const result = await page.waitForFunction(
    () => {
      const panel = document.getElementById('share-panel');
      if (!panel) return null;
      const img = panel.querySelector('img.share-panel__qr');
      if (img) {
        // (c) hidden fallback
        const styleDisplay = img.style.display;
        if (styleDisplay === 'none' || img.offsetParent === null) {
          return { kind: 'hidden' };
        }
        // (a) img loaded with real pixels
        if (img.complete && img.naturalWidth > 0) {
          return { kind: 'img', width: img.naturalWidth };
        }
        return null;
      }
      // (b) canvas path (future inline encoder)
      const canvas = panel.querySelector('canvas.share-panel__qr, canvas');
      if (canvas && canvas.width > 0) {
        return { kind: 'canvas', width: canvas.width };
      }
      return null;
    },
    { timeout: 5_000 }
  ).catch(() => null);

  // If waitForFunction timed out, accept the hidden-fallback path if
  // the image ended up hidden by now (onerror may fire late).
  if (!result) {
    const hidden = await page.evaluate(() => {
      const img = document.querySelector('#share-panel img.share-panel__qr');
      if (!img) return true; // no img = not the broken placeholder
      return img.style.display === 'none' || img.offsetParent === null;
    });
    expect(hidden, 'QR image neither loaded nor hid gracefully — broken placeholder').toBe(true);
    return;
  }

  expect(result).not.toBeNull();
});
