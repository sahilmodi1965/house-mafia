// @ts-check
/**
 * Hardened multi-client Playwright harness. #113 #114 #115
 *
 * Spawns 4 real browser contexts against Supabase and walks a full
 * round to game-over. Every click is deterministic (no random pickers)
 * and every phase boundary asserts mount-count invariants:
 *   - showRoleReveal mounted exactly 1 time per page
 *   - showDayDiscussion mounted at most 1 time per completed Day
 *   - showVoting mounted exactly 1 time per vote phase
 *   - Timer warning fires at most 1 time per phase per client
 *
 * The counters are read via window.__hm_debug__, which the source
 * increments from its mount entry points (vote.js / day.js / screens.js
 * / timer.js). The bag is only present when this test addInitScripts
 * it, so the instrumentation is zero-cost in production.
 *
 * Skip conditions: VITE_SUPABASE_URL missing → test.skip with a clear
 * reason (CI without secrets).
 */

import { test, expect, chromium } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

/**
 * Install the window.__hm_debug__ counter bag before any app script runs.
 * Source modules increment these counters from their mount entry points
 * (see vote.js / day.js / screens.js / timer.js). The bag is opt-in so
 * production bundles carry zero cost when this init script is absent.
 */
async function installDebugBag(page) {
  await page.addInitScript(() => {
    // @ts-ignore — injected into the page global for test observability
    window.__hm_debug__ = {
      voteMounts: 0,
      dayMounts: 0,
      roleMounts: 0,
      warningFires: 0,
    };
  });
}

async function readDebug(page) {
  return await page.evaluate(() => {
    // @ts-ignore
    return { ...(window.__hm_debug__ || {}) };
  });
}

test.describe.serial('multi-client real-wire hardened', () => {

test('sprint-3c: hardened multi-client N=4 real-Supabase round (#113 #114 #115)', async () => {
  test.setTimeout(360_000);
  test.slow();

  if (!hasSupabaseCreds()) {
    test.skip(true, 'VITE_SUPABASE_URL not set — cannot run multi-client real-wire test');
    return;
  }

  const consoleErrorsByPage = [];

  const browser = await chromium.launch();
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((ctx) => ctx.newPage()));

  // Install the debug counter bag on every page BEFORE the app boots.
  await Promise.all(pages.map((p) => installDebugBag(p)));

  pages.forEach((page, i) => {
    const errs = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') errs.push(`[p${i}] ${text}`);
      // Forward hm-debug traces to the test log so we can see the bug.
      if (text.includes('[hm-debug]')) {
        // eslint-disable-next-line no-console
        console.log(`[p${i} trace] ${text}`);
      }
    });
    page.on('pageerror', (err) => errs.push(`[p${i}] pageerror: ${err.message}`));
    consoleErrorsByPage.push(errs);
  });

  try {
    // 1. All pages load the title screen.
    await Promise.all(
      pages.map(async (page) => {
        await page.goto('/', { waitUntil: 'load', timeout: 15_000 });
        await expect(page.locator('#screen-title')).toBeVisible({ timeout: 10_000 });
      })
    );

    // 2. Page 0 creates a room.
    const host = pages[0];
    await host.locator('#btn-create').click();
    await expect(host.locator('#create-name')).toBeVisible();
    await host.locator('#create-name').fill('Host0');
    await host.locator('#btn-do-create').click();
    await expect(host.locator('#screen-lobby')).toBeVisible({ timeout: 20_000 });

    await expect(host.locator('#lobby-count')).toContainText('1/', { timeout: 8_000 });
    await host.waitForTimeout(500);

    const roomCode = ((await host.locator('#lobby-code').textContent()) || '').trim();
    expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);
    console.log(`[hardened] room code = ${roomCode}`);

    // 3. Pages 1..3 join one after another with retry.
    for (let i = 1; i < pages.length; i++) {
      const p = pages[i];
      await p.locator('#btn-join').click();
      await expect(p.locator('#join-code')).toBeVisible();
      await p.locator('#join-code').fill(roomCode);
      await p.locator('#join-name').fill(`Player${i}`);

      let joined = false;
      for (let attempt = 0; attempt < 3 && !joined; attempt++) {
        await p.locator('#btn-do-join').click();
        try {
          await expect(p.locator('#screen-lobby')).toBeVisible({ timeout: 8_000 });
          joined = true;
          break;
        } catch (_err) {
          const err = p.locator('#join-error');
          const errText = (await err.textContent().catch(() => '')) || '';
          if (/not found/i.test(errText)) {
            console.log(`[hardened] p${i} join retry ${attempt + 1}/3`);
            await p.waitForTimeout(1000);
            continue;
          }
          throw _err;
        }
      }
      if (!joined) {
        await expect(p.locator('#screen-lobby')).toBeVisible({ timeout: 20_000 });
      }
    }

    for (const p of pages) {
      await expect(p.locator('#lobby-count')).toHaveText(/^4\//, { timeout: 20_000 });
    }

    // 4. Host shrinks phase timers: Night 15, Discuss 30, Vote 15.
    await host.locator('#btn-settings').click();
    await expect(host.locator('.settings-modal__overlay')).toBeVisible();
    await host.locator('input[name="nightDuration"][value="15"]').check();
    await host.locator('input[name="discussionDuration"][value="30"]').check();
    await host.locator('input[name="voteDuration"][value="15"]').check();
    await host.locator('#settings-save').click();
    await expect(host.locator('.settings-modal__overlay')).toHaveCount(0);

    // 5. Host clicks Start Game.
    await host.locator('#btn-start-game').click();

    // 6. All pages reach role-reveal (parallel).
    await Promise.all(
      pages.map((p) => expect(p.locator('#screen-role-reveal')).toBeVisible({ timeout: 25_000 }))
    );

    // Role-reveal must be mounted exactly once per page.
    for (let i = 0; i < pages.length; i++) {
      const dbg = await readDebug(pages[i]);
      expect(dbg.roleMounts, `p${i} roleMounts`).toBe(1);
    }

    // 7. Each page clicks Ready.
    for (const p of pages) {
      const readyBtn = p.locator('#btn-ready');
      await expect(readyBtn).toBeEnabled({ timeout: 10_000 });
      await readyBtn.click();
    }

    // 8. All pages reach Night (parallel). Deterministic click: every
    //    page clicks the FIRST visible night-btn once. Non-actors won't
    //    have any buttons and that's fine — the host's timer still
    //    advances regardless.
    await Promise.all(
      pages.map((p) => expect(p.locator('#screen-night')).toBeVisible({ timeout: 25_000 }))
    );
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const btnCount = await p.locator('.night-btn').count().catch(() => 0);
      if (btnCount > 0) {
        try {
          await p.locator('.night-btn').first().click({ timeout: 2000 });
        } catch (_) {
          // tolerated — picker races are not the regression under test here
        }
      }
    }

    // 9. All pages reach Day Discuss when host resolves Night. Wait on
    //    pages in parallel so the #113 timer-tick check below runs while
    //    the phase is still live on all 4 clients.
    await Promise.all(
      pages.map((p) => expect(p.locator('#screen-day-discuss')).toBeVisible({ timeout: 90_000 }))
    );

    // #113 assertion: on every page, #day-timer-container .timer must
    // show a number that is STRICTLY less than the configured discussion
    // duration within 4 seconds of phase entry. If the peer's timer
    // never ticks, this fails — that's the bug #113 regression gate.
    await Promise.all(
      pages.map(async (p, i) => {
        // Give the host's first phase:tick up to 4s to deliver. We poll
        // instead of waitForTimeout so we catch the tick immediately.
        const deadline = Date.now() + 4000;
        let lastText = '';
        while (Date.now() < deadline) {
          lastText = ((await p.locator('#day-timer-container .timer').first().textContent().catch(() => '')) || '').trim();
          const parsed = parseInt(lastText, 10);
          if (Number.isFinite(parsed) && parsed < 30) return;
          await p.waitForTimeout(250);
        }
        expect(false, `p${i} day timer stuck at "${lastText}" (expected <30 within 4s)`).toBe(true);
      })
    );

    // 10. Kick off a per-page click pump that deterministically votes
    //     for the FIRST vote button as soon as each vote phase renders.
    //     No randomness, no retries inside the vote phase — one click
    //     per voteMounts increment so stale listeners can't re-trigger
    //     votes. The pump exits when #screen-game-over appears.
    const clickPump = pages.map((p, idx) => (async () => {
      let clickedVoteCursor = 0;
      let clickedNightCursor = 0;
      /* eslint-disable no-constant-condition */
      while (true) {
        // Stop as soon as game-over is showing.
        const over = await p.locator('#screen-game-over').isVisible().catch(() => false);
        if (over) return;

        // @ts-ignore
        const counters = await p.evaluate(() => ({ ...(window.__hm_debug__ || {}) }));
        const voteMounts = counters.voteMounts || 0;
        const dayMounts = counters.dayMounts || 0; // unused but logged

        // Night: click exactly once per visible night phase.
        if (await p.locator('#screen-night').isVisible().catch(() => false)) {
          if (clickedNightCursor < dayMounts + 1) {
            const btnCount = await p.locator('.night-btn').count().catch(() => 0);
            if (btnCount > 0) {
              try {
                await p.locator('.night-btn').first().click({ timeout: 1500 });
              } catch (_) {}
            }
            clickedNightCursor = dayMounts + 1;
          }
        }

        // Vote: click exactly once per voteMounts tick.
        if (await p.locator('#screen-day-vote').isVisible().catch(() => false)) {
          if (clickedVoteCursor < voteMounts) {
            const btnCount = await p.locator('.vote-btn').count().catch(() => 0);
            if (btnCount > 0) {
              try {
                await p.locator('.vote-btn').first().click({ timeout: 1500 });
                console.log(`[hardened] p${idx} vote click, voteMounts=${voteMounts}`);
              } catch (_) {}
            }
            clickedVoteCursor = voteMounts;
          }
        }

        await p.waitForTimeout(200);
      }
    })());

    // 11. Wait for game-over on every page within the test budget.
    for (const p of pages) {
      await expect(p.locator('#screen-game-over')).toBeVisible({ timeout: 220_000 });
    }
    await Promise.all(clickPump).catch(() => {});

    // Final invariants — after game-over, the mount counters must be
    // within sane bounds. dayMounts and voteMounts must each be equal
    // to the number of completed rounds (1..3 expected), never more.
    // A voteMounts count > roundsPlayed is the exact symptom of
    // bug #115 (vote screen re-mount loop on non-host peers).
    const finalDebugs = [];
    for (let i = 0; i < pages.length; i++) {
      const dbg = await readDebug(pages[i]);
      finalDebugs.push(dbg);
      console.log(`[hardened] p${i} final debug: ${JSON.stringify(dbg)}`);
    }
    // Reference the host's counters as the source of truth for the
    // number of rounds actually played (host.voteMounts === roundsPlayed).
    const roundsPlayed = finalDebugs[0].voteMounts || 0;
    expect(roundsPlayed, 'host rounds played').toBeGreaterThanOrEqual(1);
    expect(roundsPlayed, 'host rounds played').toBeLessThanOrEqual(3);
    for (let i = 0; i < pages.length; i++) {
      const dbg = finalDebugs[i];
      expect(dbg.roleMounts, `p${i} roleMounts`).toBe(1);
      // Non-host peers must NEVER re-mount a phase more than the host
      // played. Equality is the #115 / #113 regression gate.
      expect(dbg.dayMounts, `p${i} dayMounts must equal roundsPlayed`).toBe(roundsPlayed);
      expect(dbg.voteMounts, `p${i} voteMounts must equal roundsPlayed`).toBe(roundsPlayed);
      // Warning fires once per phase per round. 3 phases per round
      // (night + discuss + vote) × roundsPlayed is the ceiling.
      expect(
        dbg.warningFires,
        `p${i} warningFires must be <= 3 * roundsPlayed`
      ).toBeLessThanOrEqual(3 * roundsPlayed);
    }

    // Winner consistency across clients.
    const banners = await Promise.all(
      pages.map(async (p) => ((await p.locator('.game-over__banner').first().textContent()) || '').trim())
    );
    const first = banners[0];
    for (let i = 1; i < banners.length; i++) {
      expect(banners[i], `page ${i} banner mismatch`).toBe(first);
    }

    // No console errors on any page.
    const allErrs = consoleErrorsByPage.flat();
    expect(
      allErrs,
      `console errors during hardened multi-client round:\n${allErrs.join('\n')}`
    ).toHaveLength(0);
  } finally {
    for (const page of pages) {
      try { await page.waitForTimeout(1000); } catch (_) {}
    }
    for (const ctx of contexts) {
      try { await ctx.close(); } catch (_) {}
    }
    try { await browser.close(); } catch (_) {}
  }
});

}); // end describe.serial
