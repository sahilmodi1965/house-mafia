import { assignRoles } from './roles.js';
import { showRoleReveal, updateReadyStatus, showGameOver, showSpectatorBanner, hideSpectatorBanner } from './ui/screens.js';
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
 * Handle game over — broadcast result and show game over screen.
 * Called by the host after a win condition is detected.
 */
function handleGameOver({ winner, channel, currentPlayer, isHost, app, onPlayAgain }) {
  if (isHost) {
    channel.send({
      type: 'broadcast',
      event: 'game:over',
      payload: {
        winner,
        players: gameState.players,
        roundNumber: gameState.roundNumber,
        eliminatedCount: gameState.eliminatedCount,
      },
    });
  }

  hideSpectatorBanner();
  showGameOver(app, {
    winner,
    players: gameState.players,
    roundNumber: gameState.roundNumber,
    eliminatedCount: gameState.eliminatedCount,
    isHost,
    onPlayAgain,
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
 * @param {Function} opts.onPlayAgain - Called for play-again flow
 */
function startDayPhase({ channel, currentPlayer, isHost, app, nightEliminatedName, onPlayAgain }) {
  const currentPlayerData = gameState.players.find(p => p.id === currentPlayer.id);
  const isAlive = currentPlayerData ? currentPlayerData.alive : false;

  // Show spectator banner for eliminated players
  if (!isAlive) {
    showSpectatorBanner();
  }

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
      startVotePhase({ channel, currentPlayer, isHost, app, onPlayAgain });
    },
  });

  // Non-host listens for vote transition
  if (!isHost) {
    channel.on('broadcast', { event: 'phase:day-vote' }, () => {
      startVotePhase({ channel, currentPlayer, isHost, app, onPlayAgain });
    });
  }
}

/**
 * Start the voting sub-phase of Day.
 */
function startVotePhase({ channel, currentPlayer, isHost, app, onPlayAgain }) {
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
      // Only the host runs game logic after a vote
      if (!isHost) return;

      if (result.eliminatedPlayer) {
        const target = gameState.players.find(p => p.id === result.eliminatedPlayer.id);
        if (target) {
          target.alive = false;
          gameState.eliminatedCount++;
        }
      }

      // Check win condition after day vote elimination
      const winner = checkWinCondition();
      if (winner) {
        handleGameOver({ winner, channel, currentPlayer, isHost, app, onPlayAgain });
      } else {
        // Increment round and transition to next phase
        gameState.roundNumber++;
        // Night phase not yet implemented — go back to Day for now
        startDayPhase({
          channel,
          currentPlayer,
          isHost,
          app,
          nightEliminatedName: null,
          onPlayAgain,
        });
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
 * @param {Function} opts.onPlayAgain - Called to return to lobby for play-again
 */
export function startGame({ channel, players, currentPlayer, isHost, app, onPlayAgain }) {
  const readySet = new Set();
  const totalPlayers = players.length;

  hideSpectatorBanner();

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
      // All players ready — transition to Day (Night not yet implemented)
      startDayPhase({
        channel,
        currentPlayer,
        isHost,
        app,
        nightEliminatedName: null,
        onPlayAgain,
      });
    }
  });

  // Non-host: listen for Day phase broadcast from host
  if (!isHost) {
    channel.on('broadcast', { event: 'phase:day-discuss' }, (msg) => {
      // Update local game state from host broadcast
      if (msg.payload.players) {
        gameState = {
          phase: 'day-discuss',
          players: msg.payload.players,
          roles: {},
          roundNumber: gameState ? gameState.roundNumber : 1,
          eliminatedCount: gameState ? gameState.eliminatedCount : 0,
        };
      }
      startDayPhase({
        channel,
        currentPlayer,
        isHost,
        app,
        nightEliminatedName: msg.payload.eliminatedName,
        onPlayAgain,
      });
    });

    // Non-host: listen for game over from host
    channel.on('broadcast', { event: 'game:over' }, (msg) => {
      const { winner, players: allPlayers, roundNumber, eliminatedCount } = msg.payload;
      gameState = {
        phase: 'gameover',
        players: allPlayers,
        roles: {},
        roundNumber,
        eliminatedCount,
      };
      hideSpectatorBanner();
      showGameOver(app, {
        winner,
        players: allPlayers,
        roundNumber,
        eliminatedCount,
        isHost,
        onPlayAgain,
      });
    });

    // Non-host: listen for vote results to update local state
    channel.on('broadcast', { event: 'phase:day-result' }, (msg) => {
      if (msg.payload.eliminatedPlayerId && gameState) {
        const target = gameState.players.find(p => p.id === msg.payload.eliminatedPlayerId);
        if (target) {
          target.alive = false;
          gameState.eliminatedCount = (gameState.eliminatedCount || 0) + 1;
        }
      }
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
      roundNumber: 1,
      eliminatedCount: 0,
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

/** Reset game state (used by play-again) */
export function resetGameState() {
  gameState = null;
}
