/**
 * Chat profanity filter (#50).
 *
 * Pure helper — no DOM, no network. Consumed by src/ui/chat.js to scrub
 * player messages before they render, and by tests/engine-sim.js for
 * coverage. Exports a small inline wordlist so the whole thing stays in
 * one file with zero runtime dependencies.
 *
 * Design notes:
 *   - Word-boundary regex (\b...\b). "classic" is NOT filtered even
 *     though "ass" appears as a substring — that's the point of the
 *     regression test in engine-sim.js.
 *   - Case-insensitive. Original casing of surrounding text preserved;
 *     only the profane word itself is replaced with a star string the
 *     same length as the matched word.
 *   - Pure: same input → same output, no side effects.
 */

export const PROFANITY_LIST = Object.freeze([
  'damn',
  'darn',
  'hell',
  'crap',
  'suck',
  'jerk',
  'idiot',
  'stupid',
  'shut',
  'ugly',
  'loser',
  'dumb',
  'hate',
  'noob',
  'trash',
]);

// Precompile the regex once. Escaped only for safety even though all
// entries above are plain ASCII word characters.
function escapeRegex(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

const PROFANITY_REGEX = new RegExp(
  `\\b(${PROFANITY_LIST.map(escapeRegex).join('|')})\\b`,
  'gi'
);

/**
 * Replace every profane word in `text` with an asterisk string of the
 * same length. Empty/non-string input returns the empty string.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function filterProfanity(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text.replace(PROFANITY_REGEX, (match) => '*'.repeat(match.length));
}
