/**
 * navigator.vibrate wrapper. Issue #58.
 *
 * Usage:
 *   import { haptic, HAPTIC_VOTE } from './haptic.js';
 *   haptic(HAPTIC_VOTE);
 *
 * No-op on desktops / browsers without vibration API. Never throws.
 *
 * Mute hook:
 *   localStorage.setItem('hm:haptic-muted', '1')  → all haptics suppressed
 */

export const HAPTIC_TAP = [20];
export const HAPTIC_VOTE = [30];
export const HAPTIC_ELIMINATE = [60, 40, 60];
export const HAPTIC_WARNING = [30, 30, 30];

const MUTE_KEY = 'hm:haptic-muted';

function isMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

/**
 * Fire a vibration pattern. Safe on all platforms.
 * @param {number | number[]} pattern
 */
export function haptic(pattern) {
  try {
    if (isMuted()) return;
    if (typeof navigator === 'undefined') return;
    if (typeof navigator.vibrate !== 'function') return;
    navigator.vibrate(pattern);
  } catch (_) {
    // Swallow — haptics are cosmetic.
  }
}
