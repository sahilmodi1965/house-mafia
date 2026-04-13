/**
 * Legacy compatibility shim.
 *
 * The real role definitions now live in `src/roles/` as role-as-data
 * descriptors (see src/roles/index.js). This file re-exports the original
 * `ROLES` object and `assignRoles()` function with their historical shapes
 * so that existing consumers (src/game.js, src/ui/screens.js, and any
 * in-flight PRs) keep working without edits.
 *
 * New code should import from `./roles/index.js` directly.
 */
import {
  rolesById,
  distributeRoles,
  shuffle,
} from './roles/index.js';

/**
 * Legacy ROLES object. Keys are SHOUT_CASE ids; values are the registry
 * descriptors, which additively include the original {id, name, emoji, color}
 * fields plus new ones (faction, description, spawnWeight, minPlayers, ui,
 * lifecycle hooks). Code that reads ROLES.MAFIA.color / .name / .emoji / .id
 * continues to work unchanged.
 */
export const ROLES = {
  MAFIA: rolesById.mafia,
  HOST: rolesById.host,
  GUEST: rolesById.guest,
};

/**
 * Assign roles to a list of players.
 *
 * Output shape is unchanged from the pre-registry implementation:
 *   { [playerId]: { role, mafiaPartners } }
 * where `role` is a registry descriptor (quacks like the old
 * {id, name, emoji, color} shape, with extra fields) and `mafiaPartners`
 * is an array of { id, name } for every OTHER Mafia player.
 *
 * @param {Array<{id: string, name: string}>} playerList
 * @returns {Object} Map of playerId → { role, mafiaPartners }
 */
export function assignRoles(playerList) {
  const roleSlots = distributeRoles(playerList.length);
  shuffle(roleSlots);

  const shuffledPlayers = shuffle([...playerList]);
  const assignments = {};

  shuffledPlayers.forEach((player, i) => {
    assignments[player.id] = {
      role: roleSlots[i],
      mafiaPartners: [],
    };
  });

  // Populate mafia partners — each Mafia player sees the other Mafia.
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
