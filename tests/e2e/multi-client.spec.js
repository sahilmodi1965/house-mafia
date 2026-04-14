// @ts-check
/**
 * Sprint 2a E2E — multi-client Playwright harness. #100
 *
 * The sprint-1 spec runs everything inside a single browser context with
 * ?dev=1 stubs, which is perfect for covering the phase machine and UI
 * but cannot catch Supabase-wire bugs (presence races, broadcast
 * ordering, private-channel delivery to real peer clients). This spec
 * closes that gap by spawning N independent browser contexts — each is
 * an isolated incognito session — and walking them through a real game
 * against one shared Supabase room.
 *
 * Budget: 1 channel, 4 presence slots per run. Free tier is 200
 * concurrent. Safe.
 *
 * Skip conditions: if VITE_SUPABASE_URL is missing (CI has no secrets),
 * we bail out with a clear reason instead of failing red.
 */

import { test, expect, chromium } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function hasSupabaseCreds() {
  // Prefer process.env (CI), fall back to the local .env file which the
  // factory's dev loop keeps populated. We only need to KNOW that the
  // URL is set — the browser bundle reads it from import.meta.env at
  // build time, so this is just a skip guard.
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

test('sprint-2a: multi-client N=4 real-Supabase round (#100)', async () => {
  test.setTimeout(240_000);

  if (!hasSupabaseCreds()) {
    test.skip(true, 'VITE_SUPABASE_URL not set — cannot run multi-client real-wire test');
    return;
  }

  const consoleErrorsByPage = [];

  const browser = await chromium.launch();
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((ctx) => ctx.newPage()));

  // Each page gets its own console-error sink. Fail the test if ANY
  // page logs an error at any point in the run.
  pages.forEach((page, i) => {
    const errs = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errs.push(`[p${i}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => errs.push(`[p${i}] pageerror: ${err.message}`));
    consoleErrorsByPage.push(errs);
  });

  try {
    // 1. All pages load the title screen. NO ?dev=1 — this test is
    //    specifically about real multi-client presence, not stubs.
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

    // 3. Read the room code.
    const roomCode = ((await host.locator('#lobby-code').textContent()) || '').trim();
    expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);
    console.log(`[multi-client] room code = ${roomCode}`);

    // 4. Pages 1..3 join the room one after another.
    for (let i = 1; i < pages.length; i++) {
      const p = pages[i];
      await p.locator('#btn-join').click();
      await expect(p.locator('#join-code')).toBeVisible();
      await p.locator('#join-code').fill(roomCode);
      await p.locator('#join-name').fill(`Player${i}`);
      await p.locator('#btn-do-join').click();
      await expect(p.locator('#screen-lobby')).toBeVisible({ timeout: 20_000 });
    }

    // 5. Every page should see the full 4/16 count once presence
    //    converges. Give the host a little longer since its render
    //    waits on the presence-sync callback for all four peers.
    for (const p of pages) {
      await expect(p.locator('#lobby-count')).toHaveText(/^4\//, { timeout: 20_000 });
    }
    console.log('[multi-client] all 4 pages see 4/16 in lobby');

    // 6a. Host shrinks phase timers via Settings modal so the test
    //     fits inside its 240s budget even if the round loops once or
    //     twice (30s night + 40s discuss + 20s vote = 90s/round default;
    //     15 + 30 + 15 = 60s/round here → 3+ rounds comfortably land).
    await host.locator('#btn-settings').click();
    await expect(host.locator('.settings-modal__overlay')).toBeVisible();
    await host.locator('input[name="nightDuration"][value="15"]').check();
    await host.locator('input[name="discussionDuration"][value="30"]').check();
    await host.locator('input[name="voteDuration"][value="15"]').check();
    await host.locator('#settings-save').click();
    await expect(host.locator('.settings-modal__overlay')).toHaveCount(0);

    // 6b. Host clicks Start Game. The peers should transition to
    //    role-reveal as the host's game:start broadcast fires.
    await host.locator('#btn-start-game').click();

    // 7. Wait for every page to reach role-reveal.
    for (const p of pages) {
      await expect(p.locator('#screen-role-reveal')).toBeVisible({ timeout: 25_000 });
    }
    console.log('[multi-client] all 4 pages on role-reveal');

    // 8. Click Ready on each page. The ready button on role-reveal
    //    enables itself a short delay after the role animation settles
    //    (see ui/screens.js showRoleReveal), so we wait for it to be
    //    enabled before clicking. Use noWaitAfter=false so Playwright
    //    settles the click into the event loop.
    for (const p of pages) {
      const readyBtn = p.locator('#btn-ready');
      await expect(readyBtn).toBeEnabled({ timeout: 10_000 });
      await readyBtn.click();
    }

    // 9. Every page advances to the Night screen once everyone is ready.
    for (const p of pages) {
      await expect(p.locator('#screen-night')).toBeVisible({ timeout: 25_000 });
    }
    console.log('[multi-client] all 4 pages on night');

    // 10. Start a per-page auto-clicker. Whenever a page renders a
    //     night-action picker (.night-btn) OR a vote picker (.vote-btn),
    //     it clicks the first button. The loop persists across rounds
    //     because the win condition may take 2+ cycles to converge:
    //     if actors stop picking, the host's tally sees zero picks,
    //     nobody dies, and the round loops without advancing state.
    //
    //     Fire-and-forget: exits once its own page reaches game-over.
    //     Tracks the phase it last clicked in (by instance id) so it
    //     doesn't spam the same tally. Errors from races with phase
    //     swaps are swallowed — they're expected.
    const nightClickers = pages.map((p, idx) => (async () => {
      let lastNightClickedRound = -1;
      let lastVoteClickedRound = -1;
      let roundCursor = 0;
      let prevPhase = null;
      /* eslint-disable no-constant-condition */
      while (true) {
        if (await p.locator('#screen-game-over').isVisible().catch(() => false)) {
          return;
        }
        // Bump a logical "round cursor" every time the observed phase
        // flips back into Night or Vote from somewhere else. This
        // prevents us from re-clicking within the same tally window
        // (which would just overwrite a pick we already made).
        let phase = null;
        if (await p.locator('#screen-night').isVisible().catch(() => false)) phase = 'night';
        else if (await p.locator('#screen-day-vote').isVisible().catch(() => false)) phase = 'vote';
        else if (await p.locator('#screen-day-discuss').isVisible().catch(() => false)) phase = 'discuss';

        if (phase && phase !== prevPhase) {
          if (phase === 'night' || phase === 'vote') roundCursor += 1;
          prevPhase = phase;
        }

        if (phase === 'night' && lastNightClickedRound !== roundCursor) {
          const btns = p.locator('.night-btn');
          const count = await btns.count().catch(() => 0);
          if (count > 0) {
            try {
              await btns.first().click({ timeout: 1000 });
              lastNightClickedRound = roundCursor;
              console.log(`[multi-client] p${idx} clicked night-btn (round ${roundCursor})`);
            } catch (_) {
              // retry next tick
            }
          }
        } else if (phase === 'vote' && lastVoteClickedRound !== roundCursor) {
          const btns = p.locator('.vote-btn');
          const count = await btns.count().catch(() => 0);
          if (count > 0) {
            try {
              await btns.first().click({ timeout: 1000 });
              lastVoteClickedRound = roundCursor;
              console.log(`[multi-client] p${idx} clicked vote-btn (round ${roundCursor})`);
            } catch (_) {
              // retry next tick
            }
          }
        }
        await p.waitForTimeout(250);
      }
    })());

    // 11. All four pages must reach Day Discuss once the Night timer
    //     expires and the host resolves the kill. This is the proof
    //     that the mafia-kill broadcast reached every client.
    for (const p of pages) {
      await expect(p.locator('#screen-day-discuss')).toBeVisible({ timeout: 90_000 });
    }
    console.log('[multi-client] all 4 pages reached day-discuss');

    // 12. The full phase machine must survive to game-over on every
    //     page within the test budget. With shrunken timers (60s/round)
    //     we comfortably fit 3+ full cycles inside 200s.
    for (const p of pages) {
      await expect(p.locator('#screen-game-over')).toBeVisible({ timeout: 200_000 });
    }

    // Drain the night-clicker tasks so they don't leak past the test.
    await Promise.all(nightClickers).catch(() => {});
    console.log('[multi-client] all 4 pages reached game-over');

    // Winner consistency across clients — the .game-over__banner
    // text must match on every page. If the end-game broadcast lost
    // a peer, this catches it.
    const banners = await Promise.all(
      pages.map(async (p) => ((await p.locator('.game-over__banner').first().textContent()) || '').trim())
    );
    const first = banners[0];
    for (let i = 1; i < banners.length; i++) {
      expect(banners[i], `page ${i} banner mismatch`).toBe(first);
    }
    console.log(`[multi-client] all pages show banner = "${first}"`);

    // Finally: no console errors on any page across the whole run.
    const allErrs = consoleErrorsByPage.flat();
    expect(
      allErrs,
      `console errors during multi-client round:\n${allErrs.join('\n')}`
    ).toHaveLength(0);
  } finally {
    for (const ctx of contexts) {
      try {
        await ctx.close();
      } catch (_) {
        // ignore
      }
    }
    try {
      await browser.close();
    } catch (_) {
      // ignore
    }
  }
});
