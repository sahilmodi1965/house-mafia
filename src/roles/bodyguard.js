/**
 * Bodyguard role descriptor (town faction — one-shot protect power).
 *
 * Once per Night, picks one player to protect. If the Mafia target that
 * player, the Bodyguard dies in the target's place: the protected player
 * lives, the Bodyguard is eliminated, and they're out for the rest of
 * the game. One-shot — after the sacrifice, the role has done its job.
 *
 * Unlocks at 13 players (see ROLE_PRESETS.classic in src/config.js).
 */
export default {
  id: 'bodyguard',
  name: 'Bodyguard',
  faction: 'town',
  color: 'var(--neon-blue, #4a9eff)',
  emoji: '🛡️',
  description:
    'Once per Night, protect one player. If Mafia target them, you die instead — they live, you are out.',
  spawnWeight: 1,
  minPlayers: 13,
  nightActionKind: 'protect',
  nightAction: null,
  dayAction: null,
  onElimination: null,
  checkWin: null,
  ui: {
    lobbyBadge: { color: 'var(--neon-blue, #4a9eff)', label: 'Bodyguard' },
    nightScreen: null,
    dayBadge: null,
  },
};
