import { assignRoles } from './roles.js';
import { showRoleReveal, updateReadyStatus } from './ui/screens.js';
import { showDayDiscussion } from './phases/day.js';
import { showVoting } from './phases/vote.js';
import { DEV_MODE, scheduleStubAction } from './dev.js';
import { subscribeToPrivate } from './curator.js';

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
      startDayPhase({ channel, currentPlayer, isHost, app, nightEliminatedName: null });
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
