/**
 * Doctor role descriptor (town faction — save power).
 *
 * Once per Night, picks one player to save. If the Mafia target that
 * player, the kill is blocked and no one dies that Night. To prevent
 * self-save spiral, the Doctor cannot pick the same player on two
 * consecutive Nights (tracked by game.js via lastSaveTargetId on the
 * doctor's player state).
 *
 * Unlocks at 11 players (see ROLE_PRESETS.classic in src/config.js).
 */
export default {
  id: 'doctor',
  name: 'Doctor',
  faction: 'town',
  color: 'var(--neon-green, #4cff8f)',
  emoji: '💊',
  description:
    'Once per Night, save one player. If Mafia target them, the kill is blocked. No back-to-back same-target saves.',
  spawnWeight: 1,
  minPlayers: 11,
  nightActionKind: 'save',
  nightAction: null,
  dayAction: null,
  onElimination: null,
  checkWin: null,
  ui: {
    lobbyBadge: { color: 'var(--neon-green, #4cff8f)', label: 'Doctor' },
    nightScreen: null,
    dayBadge: null,
  },
};
