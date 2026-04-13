/**
 * Mafia role descriptor.
 *
 * Role-as-data: engine code never references this file directly. The registry
 * in ./index.js discovers it and the engine iterates the registry.
 */
export default {
  id: 'mafia',
  name: 'Mafia',
  faction: 'mafia',
  color: 'var(--neon-pink)',
  emoji: '🔪',
  description:
    'Eliminate guests at night. Win when living Mafia ≥ living non-Mafia.',
  spawnWeight: 1,
  minPlayers: 4,
  // Lifecycle hooks — schema reserved, wiring is a follow-up.
  nightAction: null,
  dayAction: null,
  onElimination: null,
  checkWin: null,
  ui: {
    lobbyBadge: { color: 'var(--neon-pink)', label: 'Mafia' },
    nightScreen: null,
    dayBadge: null,
  },
};
