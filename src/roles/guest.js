/**
 * Guest role descriptor.
 *
 * Role-as-data: engine code never references this file directly.
 */
export default {
  id: 'guest',
  name: 'Guest',
  faction: 'town',
  color: 'var(--neon-yellow)',
  emoji: '🎉',
  description: 'No special powers. Vote correctly by day to eliminate the Mafia.',
  spawnWeight: 1,
  minPlayers: 4,
  nightActionKind: null,
  nightAction: null,
  dayAction: null,
  onElimination: null,
  checkWin: null,
  ui: {
    lobbyBadge: { color: 'var(--neon-yellow)', label: 'Guest' },
    nightScreen: null,
    dayBadge: null,
  },
};
