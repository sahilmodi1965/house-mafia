import { GAME } from '../config.js';
import mafia from './mafia.js';
import host from './host.js';
import guest from './guest.js';
import detective from './detective.js';
import doctor from './doctor.js';
import bodyguard from './bodyguard.js';

/**
 * Central role registry. Engine code should only ever touch this file — never
 * import individual role modules directly.
 *
 * Adding a new role: drop a file like ./detective.js, default-export a
 * descriptor of the same shape, import it here, and push it into ALL_ROLES.
 * No engine edits required — the phase machine iterates the registry and
 * calls role.nightAction?.(ctx) / dayAction?.(ctx) / checkWin?.(state).
 *
 * Registration order matters for checkWin: each role's checkWin(state) runs
 * in ALL_ROLES order after every elimination, with a default fallback when
 * none match.
 *
 * Night-action contract extension (Sprint 1, #55):
 * Every descriptor now also carries `nightActionKind`:
 *   - 'mafia-kill'           — mafia pick a target to eliminate
 *   - 'investigate'          — learn if target is Mafia (Host)
 *   - 'investigate-inverted' — learn if target is Mafia, result INVERTED (Detective)
 *   - 'save'                 — block the Mafia kill on target (Doctor)
 *   - 'protect'              — intercept the Mafia kill, actor dies instead (Bodyguard)
 *   - null                   — no Night action (Guest)
 *
 * night.js branches on this field to render the correct button list and
 * prompt; game.js routes the resulting pick on the appropriate private
 * channel event. The full `nightAction(ctx)` function-hook slot is still
 * reserved for a future refactor — we only added the declarative field
 * because the engine needed to know what UI and routing to use.
 */
export const ALL_ROLES = [mafia, host, detective, doctor, bodyguard, guest];

/** Lookup table: role.id → descriptor. */
export const rolesById = Object.fromEntries(ALL_ROLES.map((r) => [r.id, r]));

/** Lookup table: faction → [role, ...]. */
export const rolesByFaction = ALL_ROLES.reduce((acc, r) => {
  (acc[r.faction] ||= []).push(r);
  return acc;
}, {});

/** Fisher-Yates shuffle (in-place). */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build the role slot list for a given player count, using a named preset
 * from GAME.ROLE_PRESETS. The preset is an array indexed by player count
 * whose entries are objects mapping role id → count (see src/config.js).
 *
 * Enforces these invariants at runtime (throws on violation):
 *   - the preset has a row for `playerCount`
 *   - Mafia >= 1
 *   - Guests > Mafia
 *   - sum(row) === playerCount
 *   - every role id in the row corresponds to a registered descriptor
 *   - every role that actually appears in the row meets its descriptor's
 *     `minPlayers` gate for the requested playerCount
 *
 * Returns an unshuffled array of role descriptors with length === playerCount.
 *
 * @param {number} playerCount
 * @param {string} [preset='classic']
 * @returns {Array<object>} role descriptors, one per player slot
 */
export function distributeRoles(playerCount, preset = 'classic') {
  const presets = GAME.ROLE_PRESETS || {};
  const table = presets[preset];
  if (!Array.isArray(table)) {
    throw new Error(`distributeRoles: unknown preset "${preset}"`);
  }
  const row = table[playerCount];
  if (!row) {
    throw new Error(
      `distributeRoles: no role row for playerCount=${playerCount} in preset "${preset}"`
    );
  }

  const slots = [];
  let mafiaSeen = 0;
  let guestSeen = 0;
  const isDevOnlyRow = row.devOnly === true;

  for (const [roleId, count] of Object.entries(row)) {
    if (roleId === 'devOnly') continue;
    if (count === 0) continue;
    const descriptor = rolesById[roleId];
    if (!descriptor) {
      throw new Error(
        `distributeRoles: preset "${preset}" row N=${playerCount} references unknown role id "${roleId}"`
      );
    }
    // Gate: specials cannot appear in a row below their minPlayers.
    if (descriptor.minPlayers && playerCount < descriptor.minPlayers) {
      throw new Error(
        `distributeRoles: preset "${preset}" row N=${playerCount} includes "${roleId}" which requires minPlayers=${descriptor.minPlayers}`
      );
    }
    for (let i = 0; i < count; i++) slots.push(descriptor);
    if (roleId === 'mafia') mafiaSeen += count;
    if (roleId === 'guest') guestSeen += count;
  }

  if (mafiaSeen < 1) {
    throw new Error(
      `distributeRoles: preset "${preset}" row N=${playerCount} has no Mafia`
    );
  }
  if (!isDevOnlyRow && guestSeen <= mafiaSeen) {
    throw new Error(
      `distributeRoles: preset "${preset}" row N=${playerCount} violates Guests > Mafia (${guestSeen} <= ${mafiaSeen})`
    );
  }
  if (slots.length !== playerCount) {
    throw new Error(
      `distributeRoles: preset "${preset}" row N=${playerCount} sums to ${slots.length}, expected ${playerCount}`
    );
  }

  return slots;
}
