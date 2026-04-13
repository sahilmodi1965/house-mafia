import { assignRoles } from './roles.js';
import { showRoleReveal, updateReadyStatus } from './ui/screens.js';
import { showDayDiscussion } from './phases/day.js';
import { showVoting } from './phases/vote.js';
import { DEV_MODE, scheduleStubAction } from './dev.js';
import { subscribeToPrivate } from './curator.js';
import { showGameOver } from './ui/game-over.js';

/**
 * Game loop orchestration.
 * The game host's client runs role assignment and broadcasts
 * each player's role on that player's PRIVATE channel, so secrets
 * never traverse the shared room channel. See src/curator.js.
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
 * Start the Day phase (discussion + voting).
 * @param {Object} opts
 * @param {Object} opts.channel - Supabase Realtime channel
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {boolean} opts.isHost
 * @param {HTMLElement} opts.app
 * @param {string|null} opts.nightEliminatedName - Name eliminated during night
 * @param {Function} opts.onReturnToTitle - Called to navigate back to title screen
 */
function startDayPhase({ channel, currentPlayer, isHost, app, nightEliminatedName, onReturnToTitle }) {
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
      startVotePhase({ channel, currentPlayer, isHost, app, onReturnToTitle });
    },
  });

  // Non-host listens for vote transition
  if (!isHost) {
    channel.on('broadcast', { event: 'phase:day-vote' }, () => {
      startVotePhase({ channel, currentPlayer, isHost, app, onReturnToTitle });
    });
  }
}

/**
 * Transition every client to the game-over screen.
 * Called on both host and non-host clients.
 *
 * @param {Object} opts
 * @param {string} opts.winner - 'mafia' | 'guests'
 * @param {Array}  opts.players - Full player list with roles
 * @param {Object} opts.channel
 * @param {Object} opts.currentPlayer
 * @param {boolean} opts.isHost
 * @param {HTMLElement} opts.app
 * @param {Function} opts.onReturnToTitle - Called when the player leaves to title
 */
function transitionToGameOver({ winner, players, channel, currentPlayer, isHost, app, onReturnToTitle }) {
  showGameOver(app, {
    winner,
    players,
    isHost,
    onPlayAgain: () => {
      // Host broadcasts return-to-lobby; resets state locally
      if (isHost) {
        channel.send({
          type: 'broadcast',
          event: 'game:return-lobby',
          payload: {},
        });
      }
      // Reset game state so a fresh game can start
      gameState = null;
      // Return to lobby by navigating to the title screen.
      // Players will need to re-create / re-join a room.
      // Limitation: full lobby reset over Supabase channel is not yet
      // implemented, so the simplest safe path is returning everyone
      // to the title screen (which already handles channel teardown via
      // the Leave flow in room.js).
      if (onReturnToTitle) onReturnToTitle();
    },
    onLeave: () => {
      gameState = null;
      if (onReturnToTitle) onReturnToTitle();
    },
  });

  // Non-host: also listen for host's Play Again broadcast
  if (!isHost) {
    channel.on('broadcast', { event: 'game:return-lobby' }, () => {
      gameState = null;
      if (onReturnToTitle) onReturnToTitle();
    });
  }
}

/**
 * Start the voting sub-phase of Day.
 */
function startVotePhase({ channel, currentPlayer, isHost, app, onReturnToTitle }) {
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
        if (isHost) {
          // Broadcast end-game with full player+role list so all clients
          // can render the same reveal.
          channel.send({
            type: 'broadcast',
            event: 'game:end',
            payload: {
              winner,
              players: gameState.players,
            },
          });
        }
        transitionToGameOver({
          winner,
          players: gameState.players,
          channel,
          currentPlayer,
          isHost,
          app,
          onReturnToTitle,
        });
      } else {
        // Transition to next Night (not yet implemented)
        console.log('Day phase complete. Transitioning to Night phase...');
      }
    },
  });
}

/**
 * Start the game. Called when game:start is triggered.
 * The game host runs role assignment and publishes each role on the
 * recipient's PRIVATE channel. Non-host clients listen on their own
 * private channel for their role — the shared channel never carries
 * secrets.
 *
 * @param {Object} opts
 * @param {Object} opts.channel - Shared Supabase Realtime channel (public events only)
 * @param {Object} opts.privateChannel - This client's own per-player private channel
 * @param {Object} opts.supabase - Supabase client (host needs it to subscribe to peers' private channels)
 * @param {string} opts.roomCode - Room code (for computing private channel names)
 * @param {Array}  opts.players - Array of { id, name, isHost }
 * @param {Object} opts.currentPlayer - { id, name, isHost }
 * @param {boolean} opts.isHost - Whether this client is the game host
 * @param {HTMLElement} opts.app - Root app element
 * @param {Function} [opts.onReturnToTitle] - Called to navigate back to the title screen
 */
export function startGame({
  channel,
  privateChannel,
  supabase,
  roomCode,
  players,
  currentPlayer,
  isHost,
  app,
  onReturnToTitle,
}) {
  const readySet = new Set();
  const totalPlayers = players.length;

  // Handle this player's role assignment. It arrives on their OWN private
  // channel. The shared `channel` never carries role data.
  const handleRoleAssign = (payload) => {
    const roleData = payload && payload.roleData;
    if (!roleData) return;

    showRoleReveal(app, roleData, currentPlayer.name, () => {
      // Player tapped Ready — broadcast to everyone on the shared channel.
      // "Ready" is not a secret.
      channel.send({
        type: 'broadcast',
        event: 'player:ready',
        payload: { playerId: currentPlayer.id },
      });
    });
  };

  if (privateChannel) {
    // Drain any role:assign buffered by curator.subscribeToPrivate before
    // this listener was attached (avoids host-sends-before-joiner-listens
    // race).
    if (privateChannel.__bufferedRoleAssign) {
      const buffered = privateChannel.__bufferedRoleAssign;
      privateChannel.__bufferedRoleAssign = null;
      handleRoleAssign(buffered);
    }
    privateChannel.on('broadcast', { event: 'role:assign' }, (msg) => {
      handleRoleAssign(msg.payload);
    });
  } else {
    console.error('No private channel available — cannot receive role assignment');
  }

  // Listen for ready acknowledgements
  channel.on('broadcast', { event: 'player:ready' }, (msg) => {
    readySet.add(msg.payload.playerId);
    updateReadyStatus(readySet.size, totalPlayers);

    if (readySet.size >= totalPlayers) {
      // All players ready — transition to Day (Night not yet implemented)
      startDayPhase({ channel, currentPlayer, isHost, app, nightEliminatedName: null, onReturnToTitle });
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
        };
      }
      startDayPhase({
        channel,
        currentPlayer,
        isHost,
        app,
        nightEliminatedName: msg.payload.eliminatedName,
        onReturnToTitle,
      });
    });

    // Non-host: listen for host's end-game broadcast
    channel.on('broadcast', { event: 'game:end' }, (msg) => {
      const { winner, players: endPlayers } = msg.payload;
      // Update local state with the authoritative player list from host
      if (gameState) {
        gameState.players = endPlayers;
      } else {
        gameState = { phase: 'game-over', players: endPlayers, roles: {} };
      }
      transitionToGameOver({
        winner,
        players: endPlayers,
        channel,
        currentPlayer,
        isHost,
        app,
        onReturnToTitle,
      });
    });
  }

  if (isHost) {
    // Host runs role assignment
    const assignments = assignRoles(players);
    const stubPlayers = DEV_MODE ? players.filter(p => p.isStub) : [];

    // Initialize game state on host
    gameState = {
      phase: 'role-reveal',
      players: players.map((p) => ({
        id: p.id,
        name: p.name,
        role: assignments[p.id].role,
        alive: true,
        isStub: !!p.isStub,
      })),
      roles: assignments,
    };

    // Publish each REAL player's role on THAT player's private channel.
    // Stubs have no client and no private channel — skip them. The host
    // reuses its own already-subscribed private channel; for peers, the
    // host opens a send-capable handle to their per-player channel.
    (async () => {
      for (const player of players) {
        if (player.isStub) continue; // stubs have no client to receive
        const roleData = assignments[player.id];

        let sendChannel;
        if (player.id === currentPlayer.id) {
          sendChannel = privateChannel;
        } else {
          try {
            sendChannel = await subscribeToPrivate(supabase, roomCode, player.id);
          } catch (err) {
            console.error(`Host: failed to open private channel for ${player.id}`, err);
            continue;
          }
        }

        if (!sendChannel) continue;

        await sendChannel.send({
          type: 'broadcast',
          event: 'role:assign',
          payload: { roleData },
        });
      }
    })();

    // Auto-schedule stub ready-acks — stubs "acknowledge" their roles after a delay.
    // Lives outside the role-publish loop because stubs never receive role:assign.
    if (DEV_MODE && stubPlayers.length > 0) {
      for (const stub of stubPlayers) {
        scheduleStubAction('ready', {
          stubId: stub.id,
          delayMs: 800 + Math.random() * 700,
          onResolve: ({ stubId }) => {
            readySet.add(stubId);
            updateReadyStatus(readySet.size, totalPlayers);
            if (readySet.size >= totalPlayers) {
              startDayPhase({ channel, currentPlayer, isHost, app, nightEliminatedName: null });
            }
          },
        });
      }
    }
  }
}

/** Get the current game state (host only) */
export function getGameState() {
  return gameState;
}
