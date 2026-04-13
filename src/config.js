/**
 * Authoritative role distribution table for the 'classic' preset.
 *
 * Each row is indexed by player count N (N === 0..3 have null rows because
 * the game never starts below MIN_PLAYERS). The row is an object with one
 * field per role id. `distributeRoles(n, 'classic')` in src/roles/index.js
 * reads this table; it MUST remain the single source of truth for role
 * counts. Do NOT hardcode role counts in game logic.
 *
 * Invariants enforced at runtime by distributeRoles():
 *   - Guest > Mafia                            (town-majority baseline)
 *   - Mafia >= 1                               (there must be mafia)
 *   - sum(row) === N                           (table integrity)
 *   - every non-{mafia,host,guest} slot respects its role's minPlayers gate
 *
 * Non-mafia, non-host, non-guest roles only unlock at higher N:
 *   - Detective at N >= 9
 *   - Doctor    at N >= 11
 *   - Bodyguard at N >= 13
 */
const CLASSIC_DISTRIBUTION = [
  null, // 0
  // N=1..3 exist ONLY for dev mode (?dev=1 permits 1 real player + stubs).
  // These rows intentionally violate the Guests > Mafia invariant because
  // the game isn't meaningful at these sizes; distributeRoles() skips the
  // invariant check for rows tagged with devOnly: true.
  { mafia: 1, host: 0, detective: 0, doctor: 0, bodyguard: 0, guest: 0, devOnly: true }, //  1
  { mafia: 1, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 0, devOnly: true }, //  2
  { mafia: 1, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 1, devOnly: true }, //  3
  { mafia: 1, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 2 }, //  4
  { mafia: 1, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 3 }, //  5
  { mafia: 2, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 3 }, //  6
  { mafia: 2, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 4 }, //  7
  { mafia: 2, host: 1, detective: 0, doctor: 0, bodyguard: 0, guest: 5 }, //  8
  { mafia: 2, host: 1, detective: 1, doctor: 0, bodyguard: 0, guest: 5 }, //  9
  { mafia: 3, host: 1, detective: 1, doctor: 0, bodyguard: 0, guest: 5 }, // 10
  { mafia: 3, host: 1, detective: 1, doctor: 1, bodyguard: 0, guest: 5 }, // 11
  { mafia: 3, host: 1, detective: 1, doctor: 1, bodyguard: 0, guest: 6 }, // 12
  { mafia: 3, host: 1, detective: 1, doctor: 1, bodyguard: 1, guest: 6 }, // 13
  { mafia: 4, host: 1, detective: 1, doctor: 1, bodyguard: 1, guest: 6 }, // 14
  { mafia: 4, host: 1, detective: 1, doctor: 1, bodyguard: 1, guest: 7 }, // 15
  { mafia: 4, host: 1, detective: 1, doctor: 1, bodyguard: 1, guest: 8 }, // 16
];

export const GAME = {
  MIN_PLAYERS: 4,
  MAX_PLAYERS: 16,
  DEV_MIN_PLAYERS: 1,
  NIGHT_DURATION: 30,
  DAY_DURATION: 60,
  DISCUSSION_DURATION: 40,
  VOTE_DURATION: 20,
  ROOM_CODE_LENGTH: 4,
  ROOM_CODE_CHARS: 'BCDFGHJLMNPQRSTVWXYZ23456789',
  MAX_ROOM_CODE_ATTEMPTS: 50,
  ROOM_CREATE_COOLDOWN_MS: 8000,
  MAX_SUBSCRIBE_RETRIES: 2,
  SUBSCRIBE_RETRY_BACKOFF_MS: 500,
  ROOM_GC_CHECK_INTERVAL_MS: 30000,
  ROOM_GC_ABANDON_THRESHOLD_MS: 120000,
  MAX_SPECTATORS: 25,
  ROLE_PRESETS: {
    classic: CLASSIC_DISTRIBUTION,
  },
};
