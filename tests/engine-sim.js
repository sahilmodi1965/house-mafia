/**
 * Engine simulator for house-mafia. Pure Node, zero Supabase, zero DOM.
 *
 * Run with:  node tests/engine-sim.js
 *
 * Validates:
 *   1. Role composer — distributeRoles(n, 'classic') produces the exact
 *      13-row table from config.js for every N in [MIN_PLAYERS..MAX_PLAYERS],
 *      enforcing composer invariants on every row.
 *   2. resolveMafiaKill — majority wins, tie → first voter's pick.
 *   3. resolveNightKill — Doctor saves block, Bodyguard protects redirect
 *      the kill to the bodyguard, unprotected kills land on target.
 *   4. checkWinCondition — 'mafia' when mafia >= non-mafia, 'guests' when
 *      zero mafia, null otherwise.
 *   5. Full-game simulations — randomized games at N=4, 8, 12, 16, every
 *      game terminates with a valid winner and no invariant violations.
 *
 * What this DOES NOT cover: UI, timers (#95-class races), Supabase wire,
 * multi-client presence. Those need Playwright + real browser contexts and
 * are filed separately.
 */

import { GAME } from '../src/config.js';
import {
  ALL_ROLES,
  rolesById,
  distributeRoles,
  shuffle,
} from '../src/roles/index.js';
import {
  resolveMafiaKill,
  resolveNightKill,
  checkWinCondition,
} from '../src/engine/resolve.js';

// ---------------------------------------------------------------- harness

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, label, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  console.log(`\n▸ ${name}`);
}

// ---------------------------------------------------------------- fixtures

const EXPECTED_CLASSIC_COUNTS = {
  4:  { mafia: 1, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 2 },
  5:  { mafia: 1, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 3 },
  6:  { mafia: 2, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 3 },
  7:  { mafia: 2, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 4 },
  8:  { mafia: 2, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 5 },
  9:  { mafia: 2, host: 1, detective: 1, doctor: 0, bodyguard: 0, guest: 5 },
  10: { mafia: 3, host: 1, detective: 1, doctor: 0, bodyguard: 0, guest: 5 },
  11: { mafia: 3, host: 1, detective: 1, doctor: 1, bodyguard: 0, guest: 5 },
  12: { mafia: 3, host: 1, detective: 1, doctor: 1, bodyguard: 0, guest: 6 },
  13: { mafia: 3, host: 1, detective: 1, doctor: 1, bodyguard: 1, guest: 6 },
  14: { mafia: 4, host: 1, detective: 1, doctor: 1, bodyguard: 1, guest: 6 },
  15: { mafia: 4, host: 1, detective: 1, doctor: 1, bodyguard: 1, guest: 7 },
  16: { mafia: 4, host: 1, detective: 1, doctor: 1, bodyguard: 1, guest: 8 },
};

function countByRole(slots) {
  const counts = { mafia: 0, host: 0, detective: 0, doctor: 0, bodyguard: 0, guest: 0 };
  for (const r of slots) counts[r.id] = (counts[r.id] || 0) + 1;
  return counts;
}

function makePlayers(n, roleSlots) {
  // Shuffle a copy so role-order doesn't bias which player-id gets which role
  const slots = [...roleSlots];
  shuffle(slots);
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({
      id: `p${i + 1}`,
      name: `Player${i + 1}`,
      alive: true,
      role: slots[i],
    });
  }
  return players;
}

function idsByRole(players, roleId) {
  return players.filter((p) => p.alive && p.role.id === roleId).map((p) => p.id);
}

// ---------------------------------------------------------------- 1. composer

section('1. Role composer — distributeRoles(n, "classic")');

assertEq(GAME.MIN_PLAYERS, 4, 'GAME.MIN_PLAYERS is 4');
assertEq(GAME.MAX_PLAYERS, 16, 'GAME.MAX_PLAYERS is 16 (sprint-1 target)');
assert(GAME.ROLE_PRESETS && GAME.ROLE_PRESETS.classic, 'GAME.ROLE_PRESETS.classic exists');

const seenExact = {};
for (let n = GAME.MIN_PLAYERS; n <= GAME.MAX_PLAYERS; n++) {
  const slots = distributeRoles(n, 'classic');
  assertEq(slots.length, n, `distributeRoles(${n}) produces ${n} slots`);

  const counts = countByRole(slots);
  seenExact[n] = counts;
  assertEq(counts, EXPECTED_CLASSIC_COUNTS[n], `N=${n} matches classic table`);

  // Invariants
  assert(counts.mafia >= 1, `N=${n} has ≥1 mafia`, `got ${counts.mafia}`);
  assert(counts.host === 1, `N=${n} has exactly 1 host`, `got ${counts.host}`);
  assert(counts.guest > counts.mafia, `N=${n} guest > mafia`, `guest=${counts.guest}, mafia=${counts.mafia}`);
  const sum = counts.mafia + counts.host + counts.detective + counts.doctor + counts.bodyguard + counts.guest;
  assertEq(sum, n, `N=${n} sum of roles === N`);

  // minPlayers gates — specialty roles only spawn at/above their threshold
  if (counts.detective > 0) {
    assert(n >= rolesById.detective.minPlayers, `detective minPlayers honored at N=${n}`);
  }
  if (counts.doctor > 0) {
    assert(n >= rolesById.doctor.minPlayers, `doctor minPlayers honored at N=${n}`);
  }
  if (counts.bodyguard > 0) {
    assert(n >= rolesById.bodyguard.minPlayers, `bodyguard minPlayers honored at N=${n}`);
  }
}

// Out-of-range player counts should not silently produce empty or garbage
// distributions. At MIN-1 and MAX+1 the composer must throw or return an
// invalid-but-throwing shape — we test that it does NOT return a row that
// passes the invariants (since there is no valid row).
let threwOnOutOfRange = false;
try {
  const over = distributeRoles(GAME.MAX_PLAYERS + 1, 'classic');
  const overCounts = countByRole(over);
  if (overCounts.guest <= overCounts.mafia || over.length !== GAME.MAX_PLAYERS + 1) {
    threwOnOutOfRange = true;
  }
} catch (_e) {
  threwOnOutOfRange = true;
}
assert(threwOnOutOfRange, 'distributeRoles rejects N > MAX_PLAYERS');

// ---------------------------------------------------------------- 2. resolveMafiaKill

section('2. resolveMafiaKill — vote tally + tie break');

// single vote
{
  const votes = new Map([['m1', 'g1']]);
  assertEq(resolveMafiaKill(votes), 'g1', 'single mafia vote wins');
}

// majority wins
{
  const votes = new Map([['m1', 'g1'], ['m2', 'g1'], ['m3', 'g2']]);
  assertEq(resolveMafiaKill(votes), 'g1', 'majority wins over single dissent');
}

// tie → first voter's pick wins
{
  const votes = new Map([['m1', 'g1'], ['m2', 'g2']]);
  assertEq(resolveMafiaKill(votes), 'g1', 'tie → first voter (m1) pick wins');
}

// tie where first voter picked NEITHER tied target — falls through to first tied
{
  const votes = new Map([['m1', 'g3'], ['m2', 'g1'], ['m3', 'g2']]);
  // Each gets 1 vote; tied = [g3, g1, g2]; first voter (m1) picked g3 which is in tied → g3
  assertEq(resolveMafiaKill(votes), 'g3', 'three-way tie → first voter pick wins');
}

// empty
assertEq(resolveMafiaKill(new Map()), null, 'empty votes → null');
assertEq(resolveMafiaKill(null), null, 'null votes → null');

// null targets skipped
{
  const votes = new Map([['m1', null], ['m2', 'g1']]);
  assertEq(resolveMafiaKill(votes), 'g1', 'null targets skipped, non-null wins');
}

// ---------------------------------------------------------------- 3. resolveNightKill

section('3. resolveNightKill — Doctor save + Bodyguard protect');

function freshPlayers() {
  return [
    { id: 'm1', name: 'M1', alive: true, role: rolesById.mafia },
    { id: 'g1', name: 'G1', alive: true, role: rolesById.guest },
    { id: 'd1', name: 'D1', alive: true, role: rolesById.doctor },
    { id: 'b1', name: 'B1', alive: true, role: rolesById.bodyguard },
  ];
}

// no kill → no elimination
{
  const players = freshPlayers();
  const eliminated = resolveNightKill({ killedId: null, nightSaves: new Set(), nightProtects: new Map(), players });
  assertEq(eliminated, null, 'null killedId → no elimination');
  assert(players.every((p) => p.alive), 'all players still alive');
}

// unprotected kill → target dies
{
  const players = freshPlayers();
  const eliminated = resolveNightKill({ killedId: 'g1', nightSaves: new Set(), nightProtects: new Map(), players });
  assertEq(eliminated && eliminated.id, 'g1', 'unprotected kill → target dies');
  assert(!players.find((p) => p.id === 'g1').alive, 'g1 is dead');
}

// Doctor save blocks the kill entirely
{
  const players = freshPlayers();
  const eliminated = resolveNightKill({ killedId: 'g1', nightSaves: new Set(['g1']), nightProtects: new Map(), players });
  assertEq(eliminated, null, 'Doctor save → no elimination');
  assert(players.find((p) => p.id === 'g1').alive, 'saved g1 survives');
}

// Bodyguard protects → bodyguard dies, target lives
{
  const players = freshPlayers();
  const eliminated = resolveNightKill({
    killedId: 'g1',
    nightSaves: new Set(),
    nightProtects: new Map([['b1', 'g1']]),
    players,
  });
  assertEq(eliminated && eliminated.id, 'b1', 'Bodyguard dies in target place');
  assert(players.find((p) => p.id === 'g1').alive, 'protected g1 survives');
  assert(!players.find((p) => p.id === 'b1').alive, 'b1 is dead');
}

// Save trumps protect — if both apply, no one dies (Doctor precedence)
{
  const players = freshPlayers();
  const eliminated = resolveNightKill({
    killedId: 'g1',
    nightSaves: new Set(['g1']),
    nightProtects: new Map([['b1', 'g1']]),
    players,
  });
  assertEq(eliminated, null, 'Doctor save beats Bodyguard protect');
  assert(players.find((p) => p.id === 'g1').alive, 'g1 survives via save');
  assert(players.find((p) => p.id === 'b1').alive, 'b1 survives (save fired first)');
}

// Dead Bodyguard cannot protect anymore
{
  const players = freshPlayers();
  players.find((p) => p.id === 'b1').alive = false;
  const eliminated = resolveNightKill({
    killedId: 'g1',
    nightSaves: new Set(),
    nightProtects: new Map([['b1', 'g1']]),
    players,
  });
  assertEq(eliminated && eliminated.id, 'g1', 'dead bodyguard cannot intercept → target dies');
}

// ---------------------------------------------------------------- 4. checkWinCondition

section('4. checkWinCondition');

{
  const players = [
    { alive: true, role: rolesById.mafia },
    { alive: true, role: rolesById.guest },
    { alive: true, role: rolesById.guest },
    { alive: true, role: rolesById.host },
  ];
  assertEq(checkWinCondition(players), null, '4p 1m3t → game continues');
}

{
  const players = [
    { alive: false, role: rolesById.mafia },
    { alive: true, role: rolesById.guest },
    { alive: true, role: rolesById.host },
  ];
  assertEq(checkWinCondition(players), 'guests', 'all mafia dead → guests win');
}

{
  const players = [
    { alive: true, role: rolesById.mafia },
    { alive: true, role: rolesById.guest },
  ];
  assertEq(checkWinCondition(players), 'mafia', '1 mafia vs 1 guest → mafia wins (>=)');
}

{
  const players = [
    { alive: true, role: rolesById.mafia },
    { alive: true, role: rolesById.mafia },
    { alive: true, role: rolesById.guest },
    { alive: true, role: rolesById.guest },
    { alive: true, role: rolesById.host },
  ];
  assertEq(checkWinCondition(players), null, '2m 3t → game continues');
}

{
  const players = [
    { alive: true, role: rolesById.mafia },
    { alive: true, role: rolesById.mafia },
    { alive: true, role: rolesById.guest },
    { alive: true, role: rolesById.host },
  ];
  assertEq(checkWinCondition(players), 'mafia', '2m 2t → mafia wins (>=)');
}

// ---------------------------------------------------------------- 5. full-game sims

section('5. Full-game simulations — randomized N=4, 8, 12, 16');

/**
 * Run one randomized game at the given size. Returns:
 *   { winner, nights, dayEliminations, finalAlive }
 * Game loop (pure):
 *   - Night: each living mafia votes for a random living non-mafia target;
 *            each living doctor saves a random living player (not self,
 *            not consecutive same target); each living bodyguard protects
 *            a random living non-self player; kill resolution runs.
 *   - Day: a random living non-mafia is voted out (50% chance — simulating
 *          imperfect townie voting; other 50% the game continues without
 *          an elimination).
 *   - After each elimination check win condition. Cap at 20 rounds to
 *     detect infinite loops.
 */
function simulateGame(n) {
  const slots = distributeRoles(n, 'classic');
  const players = makePlayers(n, slots);
  const lastDoctorSave = new Map();
  let nights = 0;
  let dayEliminations = 0;

  for (let round = 0; round < 20; round++) {
    nights++;
    // ---- Night ----
    const aliveMafia = idsByRole(players, 'mafia');
    const aliveDoctors = idsByRole(players, 'doctor');
    const aliveBodyguards = idsByRole(players, 'bodyguard');
    const aliveNonMafia = players.filter((p) => p.alive && p.role.id !== 'mafia').map((p) => p.id);

    // Mafia votes (all on a random non-mafia → majority)
    const mafiaVotes = new Map();
    if (aliveNonMafia.length > 0) {
      const pick = aliveNonMafia[Math.floor(Math.random() * aliveNonMafia.length)];
      for (const mid of aliveMafia) mafiaVotes.set(mid, pick);
    }

    // Doctor saves
    const nightSaves = new Set();
    for (const did of aliveDoctors) {
      const candidates = players
        .filter((p) => p.alive && p.id !== did && lastDoctorSave.get(did) !== p.id)
        .map((p) => p.id);
      if (candidates.length > 0) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        nightSaves.add(target);
        lastDoctorSave.set(did, target);
      }
    }

    // Bodyguard protects
    const nightProtects = new Map();
    for (const bid of aliveBodyguards) {
      const candidates = players.filter((p) => p.alive && p.id !== bid).map((p) => p.id);
      if (candidates.length > 0) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        nightProtects.set(bid, target);
      }
    }

    const killedId = resolveMafiaKill(mafiaVotes);
    resolveNightKill({ killedId, nightSaves, nightProtects, players });

    let winner = checkWinCondition(players);
    if (winner) return { winner, nights, dayEliminations, finalAlive: players.filter((p) => p.alive).length };

    // ---- Day ----
    if (Math.random() < 0.5) {
      // Townies manage to lynch a random living non-mafia half the time.
      // (Worst-case assumption: they only find the real mafia 25% of the time.)
      const lynchPool =
        Math.random() < 0.25
          ? aliveMafia
          : players.filter((p) => p.alive && p.role.id !== 'mafia').map((p) => p.id);
      if (lynchPool.length > 0) {
        const target = lynchPool[Math.floor(Math.random() * lynchPool.length)];
        const p = players.find((x) => x.id === target);
        if (p) {
          p.alive = false;
          dayEliminations++;
        }
      }
    }

    winner = checkWinCondition(players);
    if (winner) return { winner, nights, dayEliminations, finalAlive: players.filter((p) => p.alive).length };
  }
  return { winner: 'DEADLOCK', nights, dayEliminations, finalAlive: players.filter((p) => p.alive).length };
}

const SIM_RUNS = 500;
for (const n of [4, 8, 12, 16]) {
  let mafiaWins = 0;
  let guestWins = 0;
  let deadlocks = 0;
  let totalNights = 0;
  for (let i = 0; i < SIM_RUNS; i++) {
    const result = simulateGame(n);
    if (result.winner === 'mafia') mafiaWins++;
    else if (result.winner === 'guests') guestWins++;
    else deadlocks++;
    totalNights += result.nights;
  }
  const avgNights = (totalNights / SIM_RUNS).toFixed(1);
  console.log(`  N=${n}: ${SIM_RUNS} games → mafia ${mafiaWins}, guests ${guestWins}, deadlock ${deadlocks}, avg ${avgNights} nights`);
  assertEq(deadlocks, 0, `N=${n}: no deadlocks across ${SIM_RUNS} runs`);
  assert(mafiaWins > 0, `N=${n}: mafia can win`);
  assert(guestWins > 0, `N=${n}: guests can win`);
}

// ---------------------------------------------------------------- composer coverage

section('6. Composer distribution coverage — observed counts');
console.log('  N  | M H D Doc BG G  | shape');
for (const n of Object.keys(seenExact)) {
  const c = seenExact[n];
  const pad = (x) => String(x).padStart(1);
  console.log(
    `  ${String(n).padStart(2)} | ${pad(c.mafia)} ${pad(c.host)} ${pad(c.detective)}  ${pad(c.doctor)}  ${pad(c.bodyguard)}  ${pad(c.guest)}  | ${c.mafia}+${c.host}+${c.detective}+${c.doctor}+${c.bodyguard}+${c.guest}=${n}`
  );
}

// ---------------------------------------------------------------- report

console.log('\n' + '─'.repeat(60));
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log('✓ All engine simulation checks passed.');
