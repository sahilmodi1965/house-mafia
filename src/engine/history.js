/**
 * Local game history (#51).
 *
 * CLAUDE.md forbids server-side persistence — issue #51 was originally
 * spec'd against a Supabase table but this repo's hard rule is "no
 * persistent backend". Implementation uses the browser's localStorage,
 * which means history is PER-DEVICE: a friend who played in the same
 * game will only see it in THEIR history if they also played to
 * completion on their own client. Multi-device history would require
 * a backend and is tracked separately if/when needed.
 *
 * Storage key: 'hm:history'. Shape: an array of summary objects,
 * newest-first. Capped at 20 entries via LRU eviction at save time.
 *
 * buildGameSummary is a pure function so it can be tested in Node
 * without a browser (tests/engine-sim.js uses an in-memory stub).
 */

const STORAGE_KEY = 'hm:history';
export const HISTORY_MAX_ENTRIES = 20;

/**
 * Pure — turn an in-game state snapshot into a serializable summary.
 * Never writes to storage; the caller (game.js transitionToGameOver)
 * is responsible for passing the result to saveGameSummary.
 *
 * @param {Object} gameState - { players, nightEliminations?, dayEliminations?, roomCode, startedAt }
 * @param {'mafia'|'guests'|string} winner
 * @param {number} endedAt - ms timestamp when the game ended
 * @returns {Object} summary
 */
export function buildGameSummary(gameState, winner, endedAt) {
  const state = gameState || {};
  const players = Array.isArray(state.players) ? state.players : [];
  return {
    roomCode: state.roomCode || '',
    startedAt: typeof state.startedAt === 'number' ? state.startedAt : 0,
    endedAt: typeof endedAt === 'number' ? endedAt : 0,
    winner: winner || null,
    players: players.map((p) => ({
      name: (p && p.name) || '',
      role: (p && p.role && p.role.id) || null,
      alive: p && p.alive !== false,
      isStub: !!(p && p.isStub),
    })),
    nightEliminations: Array.isArray(state.nightEliminations)
      ? state.nightEliminations.slice()
      : [],
    dayEliminations: Array.isArray(state.dayEliminations)
      ? state.dayEliminations.slice()
      : [],
  };
}

function readStore() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (_err) {
    return [];
  }
}

function writeStore(entries) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (_err) {
    // Storage full / private mode — silently drop. History is a
    // nice-to-have; never break the game over it.
  }
}

/**
 * Save one game summary to localStorage, newest-first, capped at
 * HISTORY_MAX_ENTRIES via LRU eviction.
 *
 * @param {Object} summary - from buildGameSummary()
 */
export function saveGameSummary(summary) {
  if (!summary || typeof summary !== 'object') return;
  const current = readStore();
  const next = [summary, ...current].slice(0, HISTORY_MAX_ENTRIES);
  writeStore(next);
}

/**
 * Load the full history (newest-first). Returns [] if storage is
 * empty or corrupt.
 *
 * @returns {Array<Object>}
 */
export function loadGameHistory() {
  return readStore();
}

/**
 * Wipe the history store.
 */
export function clearGameHistory() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
  } catch (_err) {
    // Ignore — the worst case is history stays on disk. User can
    // clear via browser storage UI.
  }
}
