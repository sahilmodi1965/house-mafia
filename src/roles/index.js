import { GAME } from '../config.js';
import mafia from './mafia.js';
import host from './host.js';
import guest from './guest.js';

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
 */
export const ALL_ROLES = [mafia, host, guest];

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
 * Build the role slot list for a given player count.
 *
 * Mirrors the original src/roles.js logic verbatim to preserve behavior:
 *   - 1 Mafia per GAME.MAFIA_PER_N players (minimum 1)
 *   - exactly 1 Host
 *   - remainder are Guests
 *
 * Returns an unshuffled array of role descriptors with length === playerCount.
 *
 * @param {number} playerCount
 * @returns {Array<object>} role descriptors, one per player slot
 */
export function distributeRoles(playerCount) {
  const mafiaCount = Math.max(1, Math.floor(playerCount / GAME.MAFIA_PER_N));
  const hostCount = 1;
  const guestCount = playerCount - mafiaCount - hostCount;

  const slots = [];
  for (let i = 0; i < mafiaCount; i++) slots.push(rolesById.mafia);
  for (let i = 0; i < hostCount; i++) slots.push(rolesById.host);
  for (let i = 0; i < guestCount; i++) slots.push(rolesById.guest);
  return slots;
}
