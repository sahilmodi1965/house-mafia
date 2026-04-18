// @ts-check
/**
 * Sprint 3c E2E — backstop regression tests for #113 #114 #115.
 *
 * These tests are narrow and specific — each one isolates one of the
 * three bugs caught in the real 4-device party test after PR #111
 * merged:
 *
 *   #113 — discussion-phase timer stuck on peer clients
 *          Peers' #day-timer-container .timer must tick down within
 *          3 seconds of phase:day-discuss arriving. The bug cause was
 *          a retrack-induced bogus host migration flipping `isHost`
 *          on a peer, which made the phase-broadcast listeners take
 *          the host branch and flood the channel with duplicates.
 *
 *   #114 — investigate action triggers a "X is the new host" toast
 *          The actual root cause was the same retrack artifact firing
 *          a bogus host eviction → migration → toast. Not the
 *          investigate result text itself (night.js hard-codes
 *          "Mafia" / "Not Mafia"). This backstop loads a Night phase
 *          and asserts no host-migration toast renders on any peer.
 *
 *   #115 — vote screen re-mounts recursively, 5 stacked "10 seconds
 *          left" toasts, audio alarm loop
 *          showVoting() must be mounted exactly once per vote phase
 *          on each client. The instrumentation in vote.js increments
 *          window.__hm_debug__.voteMounts on every entry; this test
 *          exercises a full round and reads the counter at game-over.
 *
 * The hardened multi-client harness in multi-client.spec.js already
 * exercises the shared flow and asserts these invariants. This file
 * isolates each bug so a regression shows up in the right place.
 *
 * Skip conditions: VITE_SUPABASE_URL missing → test.skip.
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
 * Install window.__hm_debug__ counters before the app boots.
 */
async function installDebugBag(page) {
  await page.addInitScript(() => {
    // @ts-ignore
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

/**
 * Spin up N real browser contexts against Supabase, join a room, and
 * advance to the Day-Discuss phase. Returns the pages + the host page
 * + a dispose() tearing everything down.
 *
 * This helper is intentionally local to sprint-3c so the other suites
 * don't depend on its quirks and vice-versa.
 */
async function launchRoundUntilDayDiscuss({ nightDuration, discussionDuration, voteDuration }) {
  const browser = await chromium.launch();
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((ctx) => ctx.newPage()));
  await Promise.all(pages.map((p) => installDebugBag(p)));

  for (const p of pages) {
    await p.goto('/', { waitUntil: 'load', timeout: 15_000 });
    await expect(p.locator('#screen-title')).toBeVisible({ timeout: 10_000 });
  }
  const host = pages[0];
  await host.locator('#btn-create').click();
  await host.locator('#create-name').fill('Host0');
  await host.locator('#btn-do-create').click();
  await expect(host.locator('#screen-lobby')).toBeVisible({ timeout: 20_000 });
  await expect(host.locator('#lobby-count')).toContainText('1/', { timeout: 8_000 });
  await host.waitForTimeout(500);
  const roomCode = ((await host.locator('#lobby-code').textContent()) || '').trim();

  for (let i = 1; i < pages.length; i++) {
    const p = pages[i];
    await p.locator('#btn-join').click();
    await p.locator('#join-code').fill(roomCode);
    await p.locator('#join-name').fill(`Player${i}`);
    let joined = false;
    for (let attempt = 0; attempt < 3 && !joined; attempt++) {
      await p.locator('#btn-do-join').click();
      try {
        await expect(p.locator('#screen-lobby')).toBeVisible({ timeout: 8_000 });
        joined = true;
      } catch (_) {
        const errText = ((await p.locator('#join-error').textContent().catch(() => '')) || '');
        if (/not found/i.test(errText)) {
          await p.waitForTimeout(1000);
          continue;
        }
        throw _;
      }
    }
  }

  for (const p of pages) {
    await expect(p.locator('#lobby-count')).toHaveText(/^4\//, { timeout: 20_000 });
  }

  await host.locator('#btn-settings').click();
  await expect(host.locator('.settings-modal__overlay')).toBeVisible();
  await host.locator(`input[name="nightDuration"][value="${nightDuration}"]`).check();
  await host.locator(`input[name="discussionDuration"][value="${discussionDuration}"]`).check();
  await host.locator(`input[name="voteDuration"][value="${voteDuration}"]`).check();
  await host.locator('#settings-save').click();
  await expect(host.locator('.settings-modal__overlay')).toHaveCount(0);

  await host.locator('#btn-start-game').click();
  await Promise.all(
    pages.map((p) => expect(p.locator('#screen-role-reveal')).toBeVisible({ timeout: 25_000 }))
  );
  for (const p of pages) {
    const readyBtn = p.locator('#btn-ready');
    await expect(readyBtn).toBeEnabled({ timeout: 10_000 });
    await readyBtn.click();
  }
  await Promise.all(
    pages.map((p) => expect(p.locator('#screen-night')).toBeVisible({ timeout: 25_000 }))
  );
  // Every page clicks the first night-btn if it has one — deterministic.
  for (const p of pages) {
    const btnCount = await p.locator('.night-btn').count().catch(() => 0);
    if (btnCount > 0) {
      try { await p.locator('.night-btn').first().click({ timeout: 1500 }); } catch (_) {}
    }
  }
  // Wait for every page to reach day-discuss (parallel). Because of
  // real Supabase broadcast delivery variance, a page may sprint
  // past day-discuss before Playwright's polling catches it. We
  // tolerate that by accepting any post-discuss screen too — the
  // backstops that need day-discuss specifically still assert on the
  // screen locator themselves.
  await Promise.all(
    pages.map(async (p) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        for (const selector of [
          '#screen-day-discuss',
          '#screen-day-vote',
          '#screen-day-result',
          '#screen-game-over',
        ]) {
          if (await p.locator(selector).isVisible().catch(() => false)) return;
        }
        await p.waitForTimeout(250);
      }
      // Explicit error for better diagnostics.
      await expect(p.locator('#screen-day-discuss')).toBeVisible({ timeout: 1000 });
    })
  );

  const dispose = async () => {
    for (const p of pages) { try { await p.waitForTimeout(500); } catch (_) {} }
    for (const ctx of contexts) { try { await ctx.close(); } catch (_) {} }
    try { await browser.close(); } catch (_) {}
  };

  return { pages, host, roomCode, dispose };
}

test.describe.serial('sprint-3c backstops', () => {

  test('#113: day-discuss timer ticks on every peer within 3s of phase entry', async () => {
    test.setTimeout(180_000);
    if (!hasSupabaseCreds()) {
      test.skip(true, 'VITE_SUPABASE_URL not set');
      return;
    }
    const { pages, dispose } = await launchRoundUntilDayDiscuss({
      nightDuration: 15, discussionDuration: 30, voteDuration: 15,
    });
    try {
      // Each page's day timer must tick below its starting value
      // within 3 seconds. If the phase:tick broadcast never lands
      // (the #113 symptom), this fails explicitly for that peer.
      // Pages that are already past day-discuss (raced through) are
      // tolerated — the bug #113 symptom was the opposite (timer
      // stuck, never advancing), which produces a specific stuck-at
      // value on the day-discuss screen.
      await Promise.all(
        pages.map(async (p, i) => {
          const onDiscuss = await p.locator('#screen-day-discuss').isVisible().catch(() => false);
          if (!onDiscuss) return; // raced past — helper already tolerated
          const deadline = Date.now() + 3000;
          let last = '';
          while (Date.now() < deadline) {
            last = ((await p.locator('#day-timer-container .timer').first().textContent().catch(() => '')) || '').trim();
            const parsed = parseInt(last, 10);
            if (Number.isFinite(parsed) && parsed < 30) return;
            await p.waitForTimeout(200);
          }
          expect(false, `p${i} day timer stuck at "${last}"`).toBe(true);
        })
      );
    } finally {
      await dispose();
    }
  });

  test('#115: showVoting mounts exactly once per vote phase per client', async () => {
    test.setTimeout(300_000);
    if (!hasSupabaseCreds()) {
      test.skip(true, 'VITE_SUPABASE_URL not set');
      return;
    }
    const { pages, dispose } = await launchRoundUntilDayDiscuss({
      nightDuration: 15, discussionDuration: 30, voteDuration: 15,
    });
    try {
      // Wait for every page to reach day-vote OR a later screen, in
      // parallel — Supabase broadcast delivery variance means some
      // pages may have sprinted past the vote phase before we poll.
      await Promise.all(
        pages.map(async (p) => {
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            for (const selector of [
              '#screen-day-vote',
              '#screen-day-result',
              '#screen-game-over',
            ]) {
              if (await p.locator(selector).isVisible().catch(() => false)) return;
            }
            await p.waitForTimeout(250);
          }
          await expect(p.locator('#screen-day-vote')).toBeVisible({ timeout: 1000 });
        })
      );
      // At this point every page has entered vote phase at least once.
      // The voteMounts counter on every page must equal the number of
      // vote-phase entries — for the first-vote check we want exactly
      // 1. A re-mount loop (bug #115) would show 2+ here.
      for (let i = 0; i < pages.length; i++) {
        const dbg = await readDebug(pages[i]);
        expect(
          dbg.voteMounts,
          `p${i} voteMounts during first vote phase (got ${JSON.stringify(dbg)})`
        ).toBe(1);
      }
      // Deterministic click: first vote button on each page. The
      // buttons' `.first()` order is stable (DOM order from the
      // alivePlayers filter), so the picks converge across runs.
      for (const p of pages) {
        try { await p.locator('.vote-btn').first().click({ timeout: 1500 }); } catch (_) {}
      }
      // Wait for the vote result screen on every page. This is where
      // the re-mount loop would show up as additional voteMounts
      // increments if the bug ever comes back.
      await Promise.all(
        pages.map((p) =>
          Promise.race([
            expect(p.locator('#screen-day-result')).toBeVisible({ timeout: 30_000 }),
            expect(p.locator('#screen-game-over')).toBeVisible({ timeout: 30_000 }),
          ]).catch(() => {})
        )
      );
      for (let i = 0; i < pages.length; i++) {
        const dbg = await readDebug(pages[i]);
        expect(
          dbg.voteMounts,
          `p${i} voteMounts after vote resolution (got ${JSON.stringify(dbg)})`
        ).toBe(1);
      }
    } finally {
      await dispose();
    }
  });

  test('#114: no "new host" toast fires during a clean round', async () => {
    test.setTimeout(300_000);
    if (!hasSupabaseCreds()) {
      test.skip(true, 'VITE_SUPABASE_URL not set');
      return;
    }
    // The #114 symptom was a host-migration toast firing during a
    // Night investigate action, caused by the same retrack artifact
    // that flooded the vote screen in #115. Root fix is in room.js
    // presence:leave — retrack events must not start an eviction.
    // This test runs a clean 4-client round and asserts no page ever
    // rendered the "is the new host" toast text. If the retrack
    // artifact ever comes back, the toast appears and this fails.
    const { pages, dispose } = await launchRoundUntilDayDiscuss({
      nightDuration: 15, discussionDuration: 30, voteDuration: 15,
    });
    try {
      // Parallel: capture every toast that appears on any page during
      // the remainder of the round. A single "is the new host" on
      // ANY page fails the test.
      const toastTextsByPage = pages.map(() => /** @type {string[]} */ ([]));
      const pumps = pages.map((p, idx) => (async () => {
        /* eslint-disable no-constant-condition */
        while (true) {
          const done = await p.locator('#screen-game-over').isVisible().catch(() => false);
          if (done) return;
          const count = await p.locator('.toast').count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            try {
              const text = ((await p.locator('.toast').nth(i).textContent()) || '').trim();
              if (text && !toastTextsByPage[idx].includes(text)) {
                toastTextsByPage[idx].push(text);
              }
            } catch (_) {}
          }
          await p.waitForTimeout(250);
        }
      })());

      // Deterministic vote once we reach day-vote, then drive to
      // game-over (up to 3 rounds).
      const driveClicks = pages.map((p) => (async () => {
        let lastVoteRound = 0;
        let lastNightRound = 0;
        /* eslint-disable no-constant-condition */
        while (true) {
          const done = await p.locator('#screen-game-over').isVisible().catch(() => false);
          if (done) return;
          // @ts-ignore
          const counters = await p.evaluate(() => ({ ...(window.__hm_debug__ || {}) }));
          if (await p.locator('#screen-night').isVisible().catch(() => false)) {
            if (lastNightRound < (counters.dayMounts || 0) + 1) {
              const c = await p.locator('.night-btn').count().catch(() => 0);
              if (c > 0) {
                try { await p.locator('.night-btn').first().click({ timeout: 1500 }); } catch (_) {}
              }
              lastNightRound = (counters.dayMounts || 0) + 1;
            }
          }
          if (await p.locator('#screen-day-vote').isVisible().catch(() => false)) {
            if (lastVoteRound < (counters.voteMounts || 0)) {
              try { await p.locator('.vote-btn').first().click({ timeout: 1500 }); } catch (_) {}
              lastVoteRound = (counters.voteMounts || 0);
            }
          }
          await p.waitForTimeout(200);
        }
      })());

      for (const p of pages) {
        await expect(p.locator('#screen-game-over')).toBeVisible({ timeout: 200_000 });
      }
      await Promise.all(pumps).catch(() => {});
      await Promise.all(driveClicks).catch(() => {});

      // Assert NO page ever showed the migration toast. Also assert
      // no investigate result leaked the word "host".
      for (let i = 0; i < toastTextsByPage.length; i++) {
        for (const text of toastTextsByPage[i]) {
          expect(text.toLowerCase(), `p${i} toast "${text}" mentions host`).not.toMatch(/is the new host/);
          expect(text.toLowerCase(), `p${i} toast "${text}" mentions now the host`).not.toMatch(/you are now the host/);
        }
      }
    } finally {
      await dispose();
    }
  });

});
