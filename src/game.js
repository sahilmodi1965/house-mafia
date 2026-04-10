import { assignRoles } from './roles.js';
import { showRoleReveal, updateReadyStatus } from './ui/screens.js';
import { showNight } from './phases/night.js';
import { showDayDiscussion } from './phases/day.js';
import { showVoting } from './phases/vote.js';

/**
 * Game loop orchestration.
 * The game host's client runs role assignment and broadcasts
 * each player's role via targeted Supabase messages.
 */

/** Game state — authoritative on the host's client */
let gameState = null;

/** Role assignment data for the current player (set during role:assign) */
let myRoleData = null;

/** The game host's player id (for night action targeting) */
let gameHostPlayerId = null;

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
    channel.send({
      type: 'broadcast',
      event: 'phase:night',
      payload: { players: gameState.players },
    });
  }

  showNight({
    app,
    channel,
    players: gameState.players,
    currentPlayer,
    roleData: myRoleData,
    isHost,
    gameHostPlayerId,
    onNightEnd: ({ eliminatedPlayer }) => {
      // Check win condition before transitioning to Day
      const winner = checkWinCondition();
      if (winner) {
        console.log(`Game over! ${winner} win.`);
        return;
      }

      const eliminatedName = eliminatedPlayer?.name || null;
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
      if (result.eliminatedPlayer && isHost) {
        const target = gameState.players.find(p => p.id === result.eliminatedPlayer.id);
        if (target) target.alive = false;
      }

      const winner = checkWinCondition();
      if (winner) {
        // Game over (game-over screen not yet implemented)
        console.log(`Game over! ${winner} win.`);
      } else {
        // Transition to next Night
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

  // Track the game host's player id for night action targeting
  gameHostPlayerId = players.find(p => p.isHost)?.id || null;

  // Listen for role assignment targeted to this player
  channel.on('broadcast', { event: 'role:assign' }, (msg) => {
    const payload = msg.payload;
    // Only process messages targeted to this player
    if (payload.targetPlayerId !== currentPlayer.id) return;

    const roleData = payload.roleData;
    myRoleData = roleData;

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
      // All players ready — transition to Night (first phase after role reveal)
      startNightPhase({ channel, currentPlayer, isHost, app });
    }
  });

  // Non-host: listen for phase broadcasts from host
  if (!isHost) {
    channel.on('broadcast', { event: 'phase:night' }, (msg) => {
      if (msg.payload.players) {
        gameState = {
          phase: 'night',
          players: msg.payload.players,
          roles: {},
        };
      }
      startNightPhase({ channel, currentPlayer, isHost, app });
    });

    channel.on('broadcast', { event: 'phase:day-discuss' }, (msg) => {
      // Update local game state from host broadcast
      if (msg.payload.players) {
        gameState = {
          phase: 'day-discuss',
          players: msg.payload.players,
          roles: {},
        };
      }
      startDayPhase({
        channel,
        currentPlayer,
        isHost,
        app,
        nightEliminatedName: msg.payload.eliminatedName,
      });
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

    // Store host's own role data for night phase
    myRoleData = assignments[currentPlayer.id];

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
