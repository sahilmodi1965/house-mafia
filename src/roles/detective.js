/**
 * Detective role descriptor (town faction — counter-intel variant).
 *
 * Once per Night, investigates one player. The result is INVERTED relative
 * to the Host's investigate: if the target is Mafia, the Detective sees
 * "not Mafia"; if the target is town, the Detective sees "Mafia". This
 * makes the Detective a high-risk counter-intel tool — if the Detective
 * publicly clears a player, Mafia knows that player is one of them, and
 * if the Detective accuses a "clean" player the town should pause.
 *
 * Borrows the variance-seer idea from TheOtherRoles (Among Us mod).
 * Unlocks at 9 players (see ROLE_PRESETS.classic in src/config.js).
 */
export default {
  id: 'detective',
  name: 'Detective',
  faction: 'town',
  color: 'var(--neon-purple, #b46bff)',
  emoji: '🔍',
  description:
    'Once per Night, investigate one player. Result is INVERTED — Mafia reads as "not Mafia" and vice versa.',
  spawnWeight: 1,
  minPlayers: 9,
  nightActionKind: 'investigate-inverted',
  nightAction: null,
  dayAction: null,
  onElimination: null,
  checkWin: null,
  ui: {
    lobbyBadge: { color: 'var(--neon-purple, #b46bff)', label: 'Detective' },
    nightScreen: null,
    dayBadge: null,
  },
};
