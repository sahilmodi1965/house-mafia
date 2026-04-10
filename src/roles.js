import { GAME } from './config.js';

/**
 * Role definitions and assignment algorithm.
 * Assignment runs on the game host's client only.
 */

export const ROLES = {
  MAFIA: {
    id: 'mafia',
    name: 'Mafia',
    emoji: '🔪',
    color: 'var(--neon-pink)',
  },
  HOST: {
    id: 'host',
    name: 'Host',
    emoji: '🔍',
    color: 'var(--neon-cyan)',
  },
  GUEST: {
    id: 'guest',
    name: 'Guest',
    emoji: '🎉',
    color: 'var(--neon-yellow)',
  },
};

/** Fisher-Yates shuffle (in-place) */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Assign roles to a list of players.
 * @param {Array<{id: string, name: string}>} playerList
 * @returns {Object} Map of playerId → { role, mafiaPartners }
 */
export function assignRoles(playerList) {
  const count = playerList.length;
  const mafiaCount = Math.max(1, Math.floor(count / GAME.MAFIA_PER_N));
  const hostCount = 1;
  const guestCount = count - mafiaCount - hostCount;

  // Build a role array and shuffle it
  const roleSlots = [];
  for (let i = 0; i < mafiaCount; i++) roleSlots.push(ROLES.MAFIA);
  for (let i = 0; i < hostCount; i++) roleSlots.push(ROLES.HOST);
  for (let i = 0; i < guestCount; i++) roleSlots.push(ROLES.GUEST);

  shuffle(roleSlots);

  // Map shuffled roles to shuffled players
  const shuffledPlayers = shuffle([...playerList]);
  const assignments = {};

  shuffledPlayers.forEach((player, i) => {
    assignments[player.id] = {
      role: roleSlots[i],
      mafiaPartners: [],
    };
  });

  // Populate mafia partners — each Mafia player sees the other Mafia
  const mafiaPlayerIds = Object.keys(assignments).filter(
    (pid) => assignments[pid].role.id === 'mafia'
  );

  for (const pid of mafiaPlayerIds) {
    assignments[pid].mafiaPartners = mafiaPlayerIds
      .filter((otherId) => otherId !== pid)
      .map((otherId) => {
        const partner = playerList.find((p) => p.id === otherId);
        return { id: otherId, name: partner ? partner.name : 'Unknown' };
      });
  }

  return assignments;
}
