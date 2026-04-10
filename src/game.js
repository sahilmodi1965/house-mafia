import { assignRoles } from './roles.js';
import { showRoleReveal, updateReadyStatus } from './ui/screens.js';

/**
 * Game loop orchestration.
 * The game host's client runs role assignment and broadcasts
 * each player's role via targeted Supabase messages.
 */

/** Game state — authoritative on the host's client */
let gameState = null;

/**
 * Start the game. Called when game:start is triggered.
 * The game host runs assignment and broadcasts roles.
 * Non-host clients wait for their targeted role message.
 *
 * @param {Object} opts
 * @param {Object} opts.channel - Supabase Realtime channel
 * @param {Array}  opts.players - Array of { id, name, isHost }
 * @param {Object} opts.currentPlayer - { id, name, isHost }
 * @param {boolean} opts.isHost - Whether this client is the game host
 * @param {HTMLElement} opts.app - Root app element
 */
export function startGame({ channel, players, currentPlayer, isHost, app }) {
  const readySet = new Set();
  const totalPlayers = players.length;

  // Listen for role assignment targeted to this player
  channel.on('broadcast', { event: 'role:assign' }, (msg) => {
    const payload = msg.payload;
    // Only process messages targeted to this player
    if (payload.targetPlayerId !== currentPlayer.id) return;

    const roleData = payload.roleData;

    showRoleReveal(app, roleData, currentPlayer.name, () => {
      // Player tapped Ready — broadcast to all
      channel.send({
        type: 'broadcast',
        event: 'player:ready',
        payload: { playerId: currentPlayer.id },
      });
    });
  });

  // Listen for ready acknowledgements
  channel.on('broadcast', { event: 'player:ready' }, (msg) => {
    readySet.add(msg.payload.playerId);
    updateReadyStatus(readySet.size, totalPlayers);

    if (readySet.size >= totalPlayers) {
      // All players ready — transition to Night (not yet implemented)
      console.log('All players ready. Transitioning to Night phase...');
    }
  });

  if (isHost) {
    // Host runs role assignment
    const assignments = assignRoles(players);

    // Initialize game state on host
    gameState = {
      phase: 'role-reveal',
      players: players.map((p) => ({
        id: p.id,
        name: p.name,
        role: assignments[p.id].role,
        alive: true,
      })),
      roles: assignments,
    };

    // Broadcast each player's role via targeted messages
    // CRITICAL: each player only receives their own role
    for (const player of players) {
      const roleData = assignments[player.id];
      channel.send({
        type: 'broadcast',
        event: 'role:assign',
        payload: {
          targetPlayerId: player.id,
          roleData,
        },
      });
    }
  }
}

/** Get the current game state (host only) */
export function getGameState() {
  return gameState;
}
