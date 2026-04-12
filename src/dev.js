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

const STUB_NAMES = [
  'Stub-Alex', 'Stub-Blake', 'Stub-Casey', 'Stub-Dana',
  'Stub-Ellis', 'Stub-Fran', 'Stub-Glen', 'Stub-Harper',
];

let _stubIndex = 0;

/**
 * Generate a fresh stub player object.
 * @returns {{ id: string, name: string, isHost: false, isStub: true }}
 */
export function createStubPlayer() {
  const name = STUB_NAMES[_stubIndex % STUB_NAMES.length];
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
