/**
 * Host role descriptor (the party host, a special Guest with an investigate power).
 *
 * Not to be confused with the "game host" — the player who created the room.
 * Role-as-data: engine code never references this file directly.
 */
export default {
  id: 'host',
  name: 'Host',
  faction: 'town',
  color: 'var(--neon-cyan)',
  emoji: '🔍',
  description:
    'Once per Night, investigate one player and learn whether they are Mafia.',
  spawnWeight: 1,
  minPlayers: 4,
  nightAction: null,
  dayAction: null,
  onElimination: null,
  checkWin: null,
  ui: {
    lobbyBadge: { color: 'var(--neon-cyan)', label: 'Host' },
    nightScreen: null,
    dayBadge: null,
  },
};
