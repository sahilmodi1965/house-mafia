import { assignRoles } from './roles.js';
import { showRoleReveal, updateReadyStatus } from './ui/screens.js';
import { showNight, setupNightListeners, resetNightActions } from './phases/night.js';
import { showDayDiscussion } from './phases/day.js';
import { showVoting } from './phases/vote.js';

/**
 * Game loop orchestration.
 * The game host's client runs role assignment and broadcasts
 * each player's role via targeted Supabase messages.
 */

/** Game state — authoritative on the host's client */
let gameState = null;

/**
 * Check win conditions after an elimination.
 * @returns {string|null} 'mafia' | 'guests' | null
 */
function checkWinCondition() {
  if (!gameState) return null;
  const alive = gameState.players.filter(p => p.alive);
  const mafiaAlive = alive.filter(p => p.role.id === 'mafia').length;
  const nonMafiaAlive = alive.length - mafiaAlive;

  if (mafiaAlive === 0) return 'guests';
  if (mafiaAlive >= nonMafiaAlive) return 'mafia';
  return null;
}

/**
 * Start the Night phase.
 * @param {Object} opts
 * @param {Object} opts.channel - Supabase Realtime channel
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {boolean} opts.isHost
 * @param {HTMLElement} opts.app
 */
function startNightPhase({ channel, currentPlayer, isHost, app }) {
  if (isHost) {
    gameState.phase = 'night';
    resetNightActions();
    setupNightListeners(channel, gameState.players);
    channel.send({
      type: 'broadcast',
      event: 'phase:night',
      payload: { players: gameState.players },
    });
  }

  // Determine this player's role and partners
  const playerState = gameState.players.find(p => p.id === currentPlayer.id);
  const currentRole = playerState?.role || { id: 'guest', name: 'Guest', emoji: '', color: '' };
  const mafiaPartners = currentRole.id === 'mafia'
    ? gameState.players.filter(p => p.role.id === 'mafia' && p.id !== currentPlayer.id && p.alive)
        .map(p => ({ id: p.id, name: p.name }))
    : [];

  showNight({
    app,
    channel,
    players: gameState.players,
    currentPlayer,
    currentRole,
    isHost,
    mafiaPartners,
    onNightEnd: ({ eliminatedName, players: updatedPlayers }) => {
      // Non-host: sync game state from host broadcast
      if (!isHost && updatedPlayers) {
        gameState.players = updatedPlayers;
      }
      // Check win conditions BEFORE transitioning to Day
      const winner = checkWinCondition();
      if (winner) {
        if (isHost) {
          channel.send({
            type: 'broadcast',
            event: 'game:over',
            payload: { winner, players: gameState.players },
          });
        }
        console.log(`Game over! ${winner} win.`);
        return;
      }
      startDayPhase({ channel, currentPlayer, isHost, app, nightEliminatedName: eliminatedName });
    },
  });
}

/**
 * Start the Day phase (discussion + voting).
 * @param {Object} opts
 * @param {Object} opts.channel - Supabase Realtime channel
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {boolean} opts.isHost
 * @param {HTMLElement} opts.app
 * @param {string|null} opts.nightEliminatedName - Name eliminated during night
 */
function startDayPhase({ channel, currentPlayer, isHost, app, nightEliminatedName }) {
  if (isHost) {
    gameState.phase = 'day-discuss';
    channel.send({
      type: 'broadcast',
      event: 'phase:day-discuss',
      payload: {
        eliminatedName: nightEliminatedName,
        players: gameState.players,
      },
    });
  }

  showDayDiscussion({
    app,
    channel,
    players: gameState.players,
    currentPlayer,
    isHost,
    eliminatedName: nightEliminatedName,
    onDiscussionEnd: () => {
      startVotePhase({ channel, currentPlayer, isHost, app });
    },
  });

  // Non-host listens for vote transition
  if (!isHost) {
    channel.on('broadcast', { event: 'phase:day-vote' }, () => {
      startVotePhase({ channel, currentPlayer, isHost, app });
    });
  }
}

/**
 * Start the voting sub-phase of Day.
 */
function startVotePhase({ channel, currentPlayer, isHost, app }) {
  if (isHost) {
    gameState.phase = 'day-vote';
  }

  showVoting({
    app,
    channel,
    players: gameState.players,
    currentPlayer,
    isHost,
    onVoteResult: (result) => {
      if (result.eliminatedPlayer) {
        const target = gameState.players.find(p => p.id === result.eliminatedPlayer.id);
        if (target) target.alive = false;
      }

      const winner = checkWinCondition();
      if (winner) {
        if (isHost) {
          channel.send({
            type: 'broadcast',
            event: 'game:over',
            payload: { winner, players: gameState.players },
          });
        }
        console.log(`Game over! ${winner} win.`);
      } else if (isHost) {
        // Host drives next Night; non-host will receive phase:night broadcast
        startNightPhase({ channel, currentPlayer, isHost, app });
      }
    },
  });
}

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
      // All players ready — transition to Night phase
      startNightPhase({ channel, currentPlayer, isHost, app });
    }
  });

  // Non-host: listen for Night phase broadcast from host
  if (!isHost) {
    channel.on('broadcast', { event: 'phase:night' }, (msg) => {
      // Update local game state from host broadcast
      if (msg.payload.players) {
        gameState = {
          phase: 'night',
          players: msg.payload.players,
          roles: {},
        };
      }
      startNightPhase({ channel, currentPlayer, isHost, app });
    });
  }

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
