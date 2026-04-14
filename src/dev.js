/**
 * Dev mode utilities — activated via ?dev=1 in the URL.
 *
 * When DEV_MODE is true:
 *  - MIN_PLAYERS check in the lobby is lowered to 1.
 *  - Host sees an "Add Stub Player" button in the lobby.
 *  - Stub players run entirely in the host's browser; they are never published
 *    to Supabase presence/broadcast.
 *  - Player identity uses sessionStorage instead of localStorage so multiple
 *    tabs can run as different identities without collision.
 *  - Stubs auto-ack ready, auto-vote randomly, auto-pick random Mafia targets.
 */

/** Whether dev mode is active for this page load. */
export const DEV_MODE = new URLSearchParams(window.location.search).get('dev') === '1';

// #103: base names — kept bare (no "Stub-" prefix) so we can compose
// unique display names as "Stub-<base>" for the first wrap, then
// "Stub-<base>-2", "Stub-<base>-3", ... for each subsequent wrap. This
// scales uniquely to any N the lobby permits (MAX_PLAYERS = 16 today).
const STUB_NAMES = [
  'Alex', 'Blake', 'Casey', 'Dana',
  'Ellis', 'Fran', 'Glen', 'Harper',
];

let _stubIndex = 0;

/**
 * Generate a fresh stub player object.
 * @returns {{ id: string, name: string, isHost: false, isStub: true }}
 */
export function createStubPlayer() {
  const wrap = Math.floor(_stubIndex / STUB_NAMES.length);
  const base = STUB_NAMES[_stubIndex % STUB_NAMES.length];
  const name = wrap === 0 ? `Stub-${base}` : `Stub-${base}-${wrap + 1}`;
  _stubIndex++;
  return {
    id: `stub-${crypto.randomUUID()}`,
    name,
    isHost: false,
    isStub: true,
  };
}

/**
 * Storage helpers that respect dev mode.
 * In dev mode, sessionStorage is used so multiple tabs don't share identity.
 */
export const devStorage = {
  getItem(key) {
    return DEV_MODE ? sessionStorage.getItem(key) : localStorage.getItem(key);
  },
  setItem(key, value) {
    if (DEV_MODE) {
      sessionStorage.setItem(key, value);
    } else {
      localStorage.setItem(key, value);
    }
  },
  removeItem(key) {
    if (DEV_MODE) {
      sessionStorage.removeItem(key);
    } else {
      localStorage.removeItem(key);
    }
  },
};

// #102: chatter templates. Kept short so the dev chatter strip in
// day.js stacks readably at N=16. The {name} / {target} placeholders
// are replaced at emit time.
const CHATTER_TEMPLATES = [
  '{name}: I think {target} is sus.',
  '{name}: Something feels off about {target}.',
  "{name}: I'm voting {target} today.",
  '{name}: {target} is way too quiet.',
];

/**
 * #102 — Schedule one stub to emit a chatter line during Day Discussion.
 *
 * Dev-mode only. The caller provides an `onChat` callback that renders
 * { stubId, stubName, text } into the local DOM; no Supabase, no
 * persistence, no broadcast. This exists solely so a solo dev-mode
 * host has something to react to during Discussion when testing
 * vote-adjacent features (#47, #52, #53) without a real party.
 *
 * Role-aware suspect selection:
 *   - mafia stub: deflects onto a random non-mafia alive player.
 *   - town stub: 40% accuracy — 40% chance to suspect an actual mafia,
 *     60% chance to suspect a random non-self non-mafia alive player.
 *
 * @param {Object} opts
 * @param {string} opts.stubId
 * @param {string} opts.stubName
 * @param {string} opts.stubRole - role id ('mafia'|'host'|'detective'|...)
 * @param {Array}  opts.allPlayers - [{ id, name, alive, role: { id } }, ...]
 * @param {Function} opts.onChat - called with { stubId, stubName, text }
 * @param {number} [opts.delayMs] - delay before emit (default: 1500-4500ms random)
 */
export function scheduleStubChatter({ stubId, stubName, stubRole, allPlayers, onChat, delayMs }) {
  if (!DEV_MODE) return;
  if (!Array.isArray(allPlayers) || allPlayers.length === 0) return;

  const alive = allPlayers.filter((p) => p.alive !== false && p.id !== stubId);
  if (alive.length === 0) return;

  let target = null;
  if (stubRole === 'mafia') {
    // Deflect: pick a random non-mafia alive player as "suspect".
    const candidates = alive.filter((p) => p.role?.id !== 'mafia');
    if (candidates.length === 0) return;
    target = candidates[Math.floor(Math.random() * candidates.length)];
  } else {
    // Town: 40% accurate, 60% noise.
    const mafia = alive.filter((p) => p.role?.id === 'mafia');
    const nonMafia = alive.filter((p) => p.role?.id !== 'mafia');
    if (Math.random() < 0.4 && mafia.length > 0) {
      target = mafia[Math.floor(Math.random() * mafia.length)];
    } else if (nonMafia.length > 0) {
      target = nonMafia[Math.floor(Math.random() * nonMafia.length)];
    } else if (mafia.length > 0) {
      target = mafia[Math.floor(Math.random() * mafia.length)];
    }
  }

  if (!target) return;

  const template = CHATTER_TEMPLATES[Math.floor(Math.random() * CHATTER_TEMPLATES.length)];
  const text = template.replace('{name}', stubName).replace('{target}', target.name);
  const wait = typeof delayMs === 'number' ? delayMs : 1500 + Math.random() * 3000;

  const handle = setTimeout(() => {
    try {
      onChat({ stubId, stubName, text });
    } catch (err) {
      console.error('scheduleStubChatter onChat threw', err);
    }
  }, wait);
  return handle;
}

/**
 * Schedule stub auto-resolution for a specific game action.
 *
 * @param {string} action - 'ready' | 'vote' | 'mafia-pick'
 * @param {Object} opts
 * @param {string} opts.stubId  - The stub player's id
 * @param {Array}  opts.targets - Valid target player objects to pick from
 * @param {Function} opts.onResolve - Called with { stubId, targetId? }
 * @param {number}  [opts.delayMs=1500] - Delay before auto-resolve fires
 */
export function scheduleStubAction(action, { stubId, targets = [], onResolve, delayMs = 1500 }) {
  setTimeout(() => {
    if (action === 'ready') {
      onResolve({ stubId });
    } else {
      // Pick a random valid target
      if (targets.length === 0) {
        onResolve({ stubId, targetId: null });
        return;
      }
      const target = targets[Math.floor(Math.random() * targets.length)];
      onResolve({ stubId, targetId: target.id });
    }
  }, delayMs);
}
