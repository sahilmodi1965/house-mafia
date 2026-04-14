/**
 * Pure game-resolution primitives. DOM-free, Supabase-free, side-effect-free.
 * Single source of truth for:
 *   - resolveMafiaKill(mafiaVotes)
 *   - resolveNightKill({ killedId, nightSaves, nightProtects, players })
 *   - checkWinCondition(players)
 *
 * game.js imports these at runtime; tests/engine-sim.js imports them in Node
 * to simulate thousands of games without a browser. Never add DOM or
 * Supabase imports to this file — the Node simulator depends on it being
 * pure.
 */

/**
 * Tally mafia votes and pick the kill target.
 * Majority wins. On a tie, the FIRST mafia's vote (insertion order) decides.
 * Returns null if no votes were recorded.
 *
 * @param {Map<string,string>} mafiaVotes - voterId → targetId (insertion order matters)
 * @returns {string|null} targetId or null
 */
export function resolveMafiaKill(mafiaVotes) {
  if (!mafiaVotes || mafiaVotes.size === 0) return null;

  const counts = new Map();
  for (const targetId of mafiaVotes.values()) {
    if (!targetId) continue;
    counts.set(targetId, (counts.get(targetId) || 0) + 1);
  }
  if (counts.size === 0) return null;

  let topCount = 0;
  for (const c of counts.values()) if (c > topCount) topCount = c;

  const tied = [];
  for (const [tid, c] of counts.entries()) if (c === topCount) tied.push(tid);

  if (tied.length === 1) return tied[0];

  for (const targetId of mafiaVotes.values()) {
    if (targetId && tied.includes(targetId)) return targetId;
  }
  return tied[0];
}

/**
 * Apply Doctor saves and Bodyguard protects to a kill target.
 * Mutates `players` in place (sets `alive = false` on whoever actually dies).
 *
 * Order of precedence:
 *   1. Doctor save — if the target is in nightSaves, no one dies.
 *   2. Bodyguard protect — if the target was protected, the Bodyguard dies
 *      instead; the protected player lives. First matching protector wins.
 *   3. Otherwise — the target dies.
 *
 * @param {Object} opts
 * @param {string|null} opts.killedId     - output of resolveMafiaKill
 * @param {Set<string>} opts.nightSaves   - Set of player ids saved by a Doctor
 * @param {Map<string,string>} opts.nightProtects - bodyguardId → protectedId
 * @param {Array<{id:string,name:string,alive:boolean,role?:{id:string}}>} opts.players
 * @returns {{id:string,name:string}|null} eliminated player (or null if kill blocked/no target)
 */
export function resolveNightKill({ killedId, nightSaves, nightProtects, players }) {
  if (!killedId) return null;
  if (nightSaves && nightSaves.has(killedId)) return null;

  let protectorId = null;
  if (nightProtects) {
    for (const [bgId, protectedId] of nightProtects.entries()) {
      if (protectedId === killedId) {
        const bg = players.find((p) => p.id === bgId);
        if (bg && bg.alive) {
          protectorId = bgId;
          break;
        }
      }
    }
  }

  if (protectorId) {
    const bg = players.find((p) => p.id === protectorId);
    if (bg && bg.alive) {
      bg.alive = false;
      return { id: bg.id, name: bg.name };
    }
  }

  const target = players.find((p) => p.id === killedId);
  if (target && target.alive) {
    target.alive = false;
    return { id: target.id, name: target.name };
  }
  return null;
}

/**
 * Issue #95 grace-window decision for the Host/Detective investigator.
 *
 * When the Night timer fires, the investigator's result may have been
 * painted to the screen only a fraction of a second ago. This helper
 * decides whether to fire `endNight()` immediately or defer it by
 * `graceMs - elapsed` so the investigator can actually read the result.
 *
 * Pure: no DOM, no setTimeout, no Date.now(). The caller supplies `nowMs`.
 *
 * @param {Object} opts
 * @param {string|null|undefined} opts.nightActionKind - role.nightActionKind
 * @param {number} opts.investigationResultShownAt - ms timestamp when result was painted (0 = never)
 * @param {number} opts.nowMs - current wall clock in ms
 * @param {number} opts.graceMs - total grace window in ms (e.g. 3000)
 * @returns {{ delay: boolean, waitMs: number }} — delay=false means fire now;
 *          delay=true means schedule endNight() in waitMs milliseconds.
 */
export function shouldDelayEndNight({ nightActionKind, investigationResultShownAt, nowMs, graceMs }) {
  const isInvestigator =
    nightActionKind === 'investigate' || nightActionKind === 'investigate-inverted';
  if (!isInvestigator) return { delay: false, waitMs: 0 };
  if (!investigationResultShownAt || investigationResultShownAt <= 0) return { delay: false, waitMs: 0 };
  const elapsed = nowMs - investigationResultShownAt;
  if (elapsed < 0) return { delay: false, waitMs: 0 }; // clock went backwards — fail safe
  const remaining = graceMs - elapsed;
  if (remaining <= 0) return { delay: false, waitMs: 0 };
  return { delay: true, waitMs: remaining };
}

/**
 * Evaluate win conditions from the current player snapshot.
 *   - 'guests' if no living Mafia
 *   - 'mafia'  if living Mafia count >= living non-Mafia count
 *   - null     otherwise (game continues)
 *
 * @param {Array<{alive:boolean, role:{id:string}}>} players
 * @returns {'mafia'|'guests'|null}
 */
export function checkWinCondition(players) {
  if (!players) return null;
  const alive = players.filter((p) => p.alive);
  const mafiaAlive = alive.filter((p) => p.role && p.role.id === 'mafia').length;
  const nonMafiaAlive = alive.length - mafiaAlive;
  if (mafiaAlive === 0) return 'guests';
  if (mafiaAlive >= nonMafiaAlive) return 'mafia';
  return null;
}
