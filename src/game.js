import { GAME } from './config.js';
import { assignRoles } from './roles.js';
import { showRoleReveal, updateReadyStatus } from './ui/screens.js';
import { showNightPhase } from './phases/night.js';
import { showDayDiscussion } from './phases/day.js';
import { showVoting } from './phases/vote.js';
import { DEV_MODE, scheduleStubAction } from './dev.js';
import { subscribeToPrivate } from './curator.js';
import { showGameOver } from './ui/game-over.js';
import {
  resolveMafiaKill as pureResolveMafiaKill,
  resolveNightKill,
  checkWinCondition as pureCheckWinCondition,
  shouldDelayEndNight,
} from './engine/resolve.js';

/**
 * Game loop orchestration.
 * The game host's client runs role assignment and broadcasts
 * each player's role on that player's PRIVATE channel, so secrets
 * never traverse the shared room channel. See src/curator.js.
 */

/** Game state — authoritative on the host's client */
let gameState = null;

function checkWinCondition() {
  return gameState ? pureCheckWinCondition(gameState.players) : null;
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
      // Host-only: the host's local timer fires this callback when
      // discussion ends. The non-host transition to voting is driven
      // by the host's phase:day-vote broadcast, which is handled by a
      // one-time listener attached at game-start in startGame().
      if (isHost) {
        startVotePhase({ channel, currentPlayer, isHost, app, onReturnToTitle });
      }
    },
  });
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
        // No winner yet — loop back to a fresh Night. The host
        // re-broadcasts phase:night-start from inside startNightPhase
        // (via the public players list) so joiners re-enter Night too.
        // Non-host clients reach here via phase:day-result → onVoteResult
        // but they simply wait — startNightPhase is a no-op for them
        // until the host's phase:night-start broadcast fires below.
        if (isHost) {
          hostStartNextNight();
        }
      }
    },
  });
}

/**
 * Host-only: kick off the next Night round. Updates gameState.phase,
 * broadcasts phase:night-start to every joiner with the latest player
 * list (alive flags refreshed), and runs the Night locally. Per-round
 * tally state (mafiaVotes) is reset inside startNightPhase itself.
 *
 * Set inside startGame() because it closes over channel/currentPlayer/etc.
 */
let hostStartNextNight = () => {};

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
  roomConfig, // #54: { preset, disabledRoles, ...durations }
}) {
  const readySet = new Set();
  const totalPlayers = players.length;
  // Stash the local player's role data once it arrives on the private
  // channel — needed later to route the Night phase to the correct screen.
  let currentRoleData = null;
  // Local copy of the player list used by the Night phase on non-host
  // clients. Joiners first learn the full list from the host's
  // phase:night-start broadcast.
  let nightPlayerList = players;

  // Cache of peer private-channel write handles, keyed by playerId.
  // Populated by the host during role-assign (it already subscribes to
  // every real player's private channel there) and reused during Night
  // so the host can deliver host:investigate-result point-to-point.
  // Non-host clients cache one entry: the GAME host's private channel,
  // used to send their own mafia:pick / host:investigate.
  const peerPrivateChannels = new Map();

  // Host-owned night tally state. Reset at the start of each Night.
  // Key: voterId (mafia player). Value: targetId.
  let mafiaVotes = new Map();
  // Town-power picks, reset every Night. #55.
  // Doctor: set of saved playerIds this Night.
  let nightSaves = new Set();
  // Bodyguard: map of protectorId → protectedId, so we can kill the
  // protector instead of the target when Mafia hit the protected id.
  let nightProtects = new Map();
  // Persistent across Nights: doctor's last saved target id, to enforce
  // "cannot save same player on consecutive Nights". Map doctorId→lastTargetId.
  const lastDoctorSave = new Map();

  // Handle to the active Night screen so the host:investigate-result
  // listener can push the result into the UI asynchronously.
  let nightHandle = null;

  // Resolve the game host's player id from the known player list.
  // Joiners need this to open a write-handle to the host's private
  // channel for sending mafia:pick / host:investigate.
  function getGameHostId() {
    const hostRow = (nightPlayerList || players).find((p) => p.isHost);
    return hostRow ? hostRow.id : null;
  }

  const resolveMafiaKill = () => pureResolveMafiaKill(mafiaVotes);

  /**
   * Host-side: record a mafia vote, de-duping per voter.
   * Accepts stub injections too (no-op if voter isn't actually mafia
   * or target isn't alive — light safety net).
   */
  function recordMafiaVote(voterId, targetId) {
    if (!gameState) return;
    const voter = gameState.players.find((p) => p.id === voterId);
    if (!voter || !voter.alive) return;
    if (!voter.role || voter.role.id !== 'mafia') return;
    const target = gameState.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return;
    // Re-insert to preserve "first pick" semantics per voter.
    // We keep whatever was first for tie-break on PICK order, but the
    // latest target per voter. Use Map.delete + set to achieve that.
    const existed = mafiaVotes.has(voterId);
    if (!existed) {
      mafiaVotes.set(voterId, targetId);
    } else {
      // Update in place without changing insertion order.
      mafiaVotes.set(voterId, targetId);
    }
  }

  /**
   * Host-side: record a Doctor save. Enforces:
   *   - actor must be alive and have doctor role
   *   - target must be alive
   *   - target cannot be the same player the doctor saved last Night
   */
  function handleDoctorSave(doctorId, targetId) {
    if (!gameState) return;
    const doctor = gameState.players.find((p) => p.id === doctorId);
    if (!doctor || !doctor.alive || doctor.role?.id !== 'doctor') return;
    const target = gameState.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return;
    if (lastDoctorSave.get(doctorId) === targetId) return; // consecutive block
    nightSaves.add(targetId);
    lastDoctorSave.set(doctorId, targetId);
  }

  /**
   * Host-side: record a Bodyguard protect. Enforces:
   *   - actor must be alive and have bodyguard role
   *   - target must be alive and not self
   */
  function handleBodyguardProtect(bodyguardId, targetId) {
    if (!gameState) return;
    const bg = gameState.players.find((p) => p.id === bodyguardId);
    if (!bg || !bg.alive || bg.role?.id !== 'bodyguard') return;
    const target = gameState.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return;
    if (bodyguardId === targetId) return;
    nightProtects.set(bodyguardId, targetId);
  }

  /**
   * Host-side: handle a Host-role or Detective investigation request.
   * Looks up the target's role and returns the result privately to the
   * investigator. Detective results are INVERTED (#55).
   */
  async function handleHostInvestigate(investigatorId, targetId) {
    if (!gameState) return;
    const investigator = gameState.players.find((p) => p.id === investigatorId);
    const investigatorRoleId = investigator && investigator.role && investigator.role.id;
    if (investigatorRoleId !== 'host' && investigatorRoleId !== 'detective') return;
    const target = gameState.players.find((p) => p.id === targetId);
    if (!target) return;

    const isMafia = target.role?.id === 'mafia';
    const result =
      investigatorRoleId === 'detective'
        ? isMafia ? 'not-mafia' : 'mafia' // inverted
        : isMafia ? 'mafia' : 'not-mafia';

    // Stubs have no client to hear the result — just drop it.
    if (investigator.isStub) return;

    // If the investigator is the game host themself, push directly to
    // the local night screen (their private channel self-echo would
    // also work, but we already have the UI handle on this client).
    if (investigator.id === currentPlayer.id) {
      if (nightHandle && nightHandle.showInvestigationResult) {
        nightHandle.showInvestigationResult(result, target.name);
      }
      return;
    }

    // Peer: use cached private-channel write handle, opening one if
    // it wasn't cached during role-assign (should be rare).
    let sendChannel = peerPrivateChannels.get(investigatorId);
    if (!sendChannel) {
      try {
        sendChannel = await subscribeToPrivate(supabase, roomCode, investigatorId);
        peerPrivateChannels.set(investigatorId, sendChannel);
      } catch (err) {
        console.error('Host: failed to open investigator private channel', err);
        return;
      }
    }
    try {
      await sendChannel.send({
        type: 'broadcast',
        event: 'host:investigate-result',
        payload: { targetId, targetName: target.name, result },
      });
    } catch (err) {
      console.error('Host: failed to send investigation result', err);
    }
  }

  /**
   * Run the Night phase locally, then advance to Day on completion.
   * Each client runs its own 30s timer. At timer expiry the game host
   * resolves the kill, applies it to gameState, and broadcasts
   * phase:night-end on the shared channel so all joiners transition
   * to Day with the same eliminated-player announcement.
   */
  function startNightPhase({ eliminatedName = null } = {}) {
    // On the host, refresh nightPlayerList from the authoritative
    // gameState so each new round reflects the latest alive flags
    // (round 2+ after a Day elimination), and re-broadcast the list
    // to joiners so their Night screens match. The round-1 entry
    // happens from the player:ready / stub-ready handlers which
    // already seeded nightPlayerList; this block is a no-op there
    // (same list, same broadcast already sent) but cheap, and makes
    // re-entry from hostStartNextNight() self-sufficient.
    if (isHost && gameState) {
      const publicPlayers = gameState.players.map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        isStub: !!p.isStub,
      }));
      nightPlayerList = publicPlayers;
      gameState.phase = 'night';
      channel.send({
        type: 'broadcast',
        event: 'phase:night-start',
        payload: { players: publicPlayers },
      });
    }

    // Defensive: with fewer than MIN_PLAYERS there's nothing to night over.
    if (!nightPlayerList || nightPlayerList.length < GAME.MIN_PLAYERS) {
      startDayPhase({
        channel,
        currentPlayer,
        isHost,
        app,
        nightEliminatedName: eliminatedName,
        onReturnToTitle,
      });
      return;
    }

    // Fresh tally each Night. Cleared on every client call but only
    // the host actually consumes these — joiners never touch them.
    mafiaVotes = new Map();
    nightSaves = new Set();
    nightProtects = new Map();

    const localRoleId = currentRoleData && currentRoleData.role && currentRoleData.role.id;
    const gameHostId = getGameHostId();

    // Ensure we can send mafia:pick / host:investigate to the game host.
    // The GAME host sends to itself (its own private channel has
    // self-echo enabled) via its already-subscribed privateChannel.
    // Non-host clients need a write-handle to the game host's private
    // channel — lazily open one now if their role will actually need it.
    async function ensureHostPrivateWriteHandle() {
      if (!gameHostId) return null;
      if (isHost) return privateChannel; // own channel, self-echo on
      let ch = peerPrivateChannels.get(gameHostId);
      if (ch) return ch;
      try {
        ch = await subscribeToPrivate(supabase, roomCode, gameHostId);
        peerPrivateChannels.set(gameHostId, ch);
        return ch;
      } catch (err) {
        console.error('Client: failed to open host private channel', err);
        return null;
      }
    }

    // Pre-warm the write handle for mafia/host-role clients so that
    // the first tap during Night doesn't race the channel subscribe.
    if (localRoleId === 'mafia' || localRoleId === 'host') {
      ensureHostPrivateWriteHandle();
    }

    nightHandle = showNightPhase({
      app,
      channel,
      players: nightPlayerList,
      currentPlayer,
      currentRole: currentRoleData ? currentRoleData.role : null,
      mafiaPartners: currentRoleData ? currentRoleData.mafiaPartners || [] : [],
      isHost,
      onTargetSelected: async (target) => {
        // Route the Mafia pick to the game host on the host's private
        // channel. Sending on the shared channel would leak the fact
        // that this player is Mafia to everyone listening.
        const ch = await ensureHostPrivateWriteHandle();
        if (!ch) return;
        try {
          await ch.send({
            type: 'broadcast',
            event: 'mafia:pick',
            payload: { voterId: currentPlayer.id, targetId: target.id },
          });
        } catch (err) {
          console.error('Failed to send mafia:pick', err);
        }
      },
      onInvestigateSelected: async (target) => {
        const ch = await ensureHostPrivateWriteHandle();
        if (!ch) return;
        try {
          await ch.send({
            type: 'broadcast',
            event: 'host:investigate',
            payload: { investigatorId: currentPlayer.id, targetId: target.id },
          });
        } catch (err) {
          console.error('Failed to send host:investigate', err);
        }
      },
      onNightActionSelected: async ({ kind, target }) => {
        // Detective/Doctor/Bodyguard route their picks on a single
        // generic 'night:action' event so game.js on the game host
        // can dispatch to the right handler. The event name stays
        // private (sent on the game host's private channel).
        const ch = await ensureHostPrivateWriteHandle();
        if (!ch) return;
        try {
          await ch.send({
            type: 'broadcast',
            event: 'night:action',
            payload: {
              kind, // 'investigate-inverted' | 'save' | 'protect'
              actorId: currentPlayer.id,
              targetId: target.id,
            },
          });
        } catch (err) {
          console.error('Failed to send night:action', err);
        }
      },
      onNightEnd: () => {
        if (isHost) {
          // Host tallies the Mafia pick, then applies town-power
          // mitigations (#55):
          //   1. Doctor save — if the target is in nightSaves, the
          //      kill is blocked and no one dies that Night.
          //   2. Bodyguard protect — if the target was protected by
          //      any Bodyguard, the Bodyguard dies instead. The
          //      protected player lives.
          // Both mitigations run even if the composer disabled the
          // corresponding role — the sets are just empty.
          const killedId = resolveMafiaKill();
          const eliminatedPlayer = resolveNightKill({
            killedId,
            nightSaves,
            nightProtects,
            players: gameState.players,
          });
          gameState.phase = 'night-end';
          channel.send({
            type: 'broadcast',
            event: 'phase:night-end',
            payload: {
              eliminatedPlayerId: eliminatedPlayer ? eliminatedPlayer.id : null,
              eliminatedPlayerName: eliminatedPlayer ? eliminatedPlayer.name : null,
              players: gameState.players.map((p) => ({
                id: p.id,
                name: p.name,
                alive: p.alive,
                isStub: !!p.isStub,
              })),
            },
          });
          nightHandle = null;

          // Win check after the Night kill — if Mafia just reached
          // parity or wiped the Guests, skip Day and go straight to
          // game-over. Otherwise proceed to Day.
          const nightWinner = checkWinCondition();
          if (nightWinner) {
            channel.send({
              type: 'broadcast',
              event: 'game:end',
              payload: {
                winner: nightWinner,
                players: gameState.players,
              },
            });
            transitionToGameOver({
              winner: nightWinner,
              players: gameState.players,
              channel,
              currentPlayer,
              isHost,
              app,
              onReturnToTitle,
            });
            return;
          }

          startDayPhase({
            channel,
            currentPlayer,
            isHost,
            app,
            nightEliminatedName: eliminatedPlayer ? eliminatedPlayer.name : null,
            onReturnToTitle,
          });
        }
        // Non-host clients wait for phase:night-end from the host
        // before transitioning — handled below.
      },
    });

    // Auto-fire stub Mafia / stub Host actions on the host's own
    // client. Stubs have no real client so their picks are injected
    // directly into mafiaVotes (for Mafia stubs) or run through the
    // local investigate handler (for Host stubs) without touching the
    // broadcast channel at all.
    if (isHost && DEV_MODE && gameState) {
      const alive = gameState.players.filter((p) => p.alive);
      for (const stub of gameState.players.filter((p) => p.isStub && p.alive)) {
        const stubRoleId = stub.role && stub.role.id;
        if (stubRoleId === 'mafia') {
          // Valid targets: alive, not self, not a mafia partner.
          const targets = alive.filter(
            (p) => p.id !== stub.id && p.role?.id !== 'mafia'
          );
          scheduleStubAction('mafia-pick', {
            stubId: stub.id,
            targets,
            delayMs: 1500 + Math.random() * 3000,
            onResolve: ({ stubId, targetId }) => {
              if (targetId) recordMafiaVote(stubId, targetId);
            },
          });
        } else if (stubRoleId === 'host' || stubRoleId === 'detective') {
          const targets = alive.filter((p) => p.id !== stub.id);
          scheduleStubAction(`${stubRoleId}-investigate`, {
            stubId: stub.id,
            targets,
            delayMs: 1500 + Math.random() * 3000,
            onResolve: ({ stubId, targetId }) => {
              if (targetId) handleHostInvestigate(stubId, targetId);
            },
          });
        } else if (stubRoleId === 'doctor') {
          const targets = alive.filter((p) => p.id !== stub.id);
          scheduleStubAction('doctor-save', {
            stubId: stub.id,
            targets,
            delayMs: 1500 + Math.random() * 3000,
            onResolve: ({ stubId, targetId }) => {
              if (targetId) handleDoctorSave(stubId, targetId);
            },
          });
        } else if (stubRoleId === 'bodyguard') {
          const targets = alive.filter((p) => p.id !== stub.id);
          scheduleStubAction('bodyguard-protect', {
            stubId: stub.id,
            targets,
            delayMs: 1500 + Math.random() * 3000,
            onResolve: ({ stubId, targetId }) => {
              if (targetId) handleBodyguardProtect(stubId, targetId);
            },
          });
        }
      }
    }
  }

  // Expose startNightPhase to module-level startVotePhase so that on
  // Day vote resolution (no winner) the host can loop back into Night.
  // There is only one active game session per module, same as
  // gameState, so a single module-level ref is safe.
  hostStartNextNight = () => startNightPhase();

  // Handle this player's role assignment. It arrives on their OWN private
  // channel. The shared `channel` never carries role data.
  const handleRoleAssign = (payload) => {
    const roleData = payload && payload.roleData;
    if (!roleData) return;
    currentRoleData = roleData;

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

    // Host-role players receive investigation results on their own
    // private channel. The game host sends one frame per request.
    privateChannel.on('broadcast', { event: 'host:investigate-result' }, (msg) => {
      const { result, targetName } = msg.payload || {};
      if (nightHandle && nightHandle.showInvestigationResult) {
        nightHandle.showInvestigationResult(result, targetName);
      }
    });

    // The game host also listens on its OWN private channel for
    // incoming mafia:pick / host:investigate requests from peers.
    // Self-echo is already enabled on private channels, so the host's
    // own picks land here too (stubs bypass the channel and inject
    // directly into mafiaVotes / handleHostInvestigate).
    if (isHost) {
      privateChannel.on('broadcast', { event: 'mafia:pick' }, (msg) => {
        const { voterId, targetId } = msg.payload || {};
        if (voterId && targetId) recordMafiaVote(voterId, targetId);
      });
      privateChannel.on('broadcast', { event: 'host:investigate' }, (msg) => {
        const { investigatorId, targetId } = msg.payload || {};
        if (investigatorId && targetId) {
          handleHostInvestigate(investigatorId, targetId);
        }
      });
      privateChannel.on('broadcast', { event: 'night:action' }, (msg) => {
        const { kind, actorId, targetId } = msg.payload || {};
        if (!actorId || !targetId) return;
        switch (kind) {
          case 'investigate-inverted':
            handleHostInvestigate(actorId, targetId);
            break;
          case 'save':
            handleDoctorSave(actorId, targetId);
            break;
          case 'protect':
            handleBodyguardProtect(actorId, targetId);
            break;
          default:
            break;
        }
      });
    }
  } else {
    console.error('No private channel available — cannot receive role assignment');
  }

  // Listen for ready acknowledgements
  channel.on('broadcast', { event: 'player:ready' }, (msg) => {
    readySet.add(msg.payload.playerId);
    updateReadyStatus(readySet.size, totalPlayers);

    if (readySet.size >= totalPlayers && isHost) {
      // Host kicks off Night. The broadcast of phase:night-start and
      // the refresh of nightPlayerList happen inside startNightPhase
      // itself so round 1 and subsequent rounds go through the same
      // code path.
      startNightPhase();
    }
  });

  // Non-host: listen for Night phase start broadcast from host
  if (!isHost) {
    channel.on('broadcast', { event: 'phase:night-start' }, (msg) => {
      if (msg.payload && Array.isArray(msg.payload.players)) {
        nightPlayerList = msg.payload.players;
      }
      startNightPhase();
    });

    // Non-host: listen for the Night tally result from host. The host
    // has applied the kill and broadcasts the updated player list.
    // This broadcast is informational — the actual transition to Day
    // is driven by the host's subsequent phase:day-discuss broadcast
    // (which already carries the updated players). We just refresh
    // our local copy so any UI between frames stays consistent.
    channel.on('broadcast', { event: 'phase:night-end' }, (msg) => {
      const payload = msg.payload || {};
      if (Array.isArray(payload.players)) {
        nightPlayerList = payload.players;
      }
      nightHandle = null;
    });
  }

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

      const doTransition = () => {
        startDayPhase({
          channel,
          currentPlayer,
          isHost,
          app,
          nightEliminatedName: msg.payload.eliminatedName,
          onReturnToTitle,
        });
      };

      // Issue #95: if we're a non-host Host-role client and an
      // investigation result was just painted (within the night.js
      // grace window), hold the day transition so the investigator
      // can read it before the screen swaps.
      if (nightHandle && typeof nightHandle.getInvestigationShownAt === 'function') {
        const shownAt = nightHandle.getInvestigationShownAt();
        const { delay, waitMs } = shouldDelayEndNight({
          nightActionKind: 'investigate', // shownAt > 0 only for investigators
          investigationResultShownAt: shownAt,
          nowMs: Date.now(),
          graceMs: nightHandle.HOST_INVESTIGATE_GRACE_MS || 3000,
        });
        if (delay) {
          setTimeout(doTransition, waitMs);
          return;
        }
      }
      doTransition();
    });

    // Non-host: listen for the host's transition from Discussion → Vote.
    // Attached once at game-start to avoid listener accumulation across
    // rounds. Fires on every Day cycle.
    channel.on('broadcast', { event: 'phase:day-vote' }, () => {
      startVotePhase({ channel, currentPlayer, isHost, app, onReturnToTitle });
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
    // Host runs role assignment. #54: honor the host's custom settings
    // (preset + disabled optional roles) picked in the lobby modal.
    const assignments = assignRoles(players, {
      preset: (roomConfig && roomConfig.preset) || 'classic',
      disabledRoles: (roomConfig && roomConfig.disabledRoles) || [],
    });
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
            // Cache for reuse during Night (host:investigate-result).
            peerPrivateChannels.set(player.id, sendChannel);
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
              // Same path as real-player ready: broadcast + refresh
              // happen inside startNightPhase.
              startNightPhase();
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
