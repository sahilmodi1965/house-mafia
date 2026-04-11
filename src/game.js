import { assignRoles } from './roles.js';
import { showRoleReveal, updateReadyStatus } from './ui/screens.js';
import { showDayDiscussion } from './phases/day.js';
import { showVoting } from './phases/vote.js';
import {
  canShowRewarded,
  showRewardedVideo,
  shouldShowInterstitial,
  showInterstitial,
  showBanner,
  hideBanner,
  recordGameCompleted,
} from './ads.js';

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
        recordGameCompleted();
        showGameOver({ app, winner, players: gameState.players, currentPlayer });
      } else {
        // Transition to next Night (not yet implemented)
        console.log('Day phase complete. Transitioning to Night phase...');
      }
    },
  });
}

/** Session-only gold text flair earned from rewarded video */
let hasGoldFlair = false;

/** @returns {boolean} Whether the player has the gold flair this session */
export function getHasGoldFlair() {
  return hasGoldFlair;
}

/**
 * Show the game over screen with role reveals and optional rewarded video button.
 */
function showGameOver({ app, winner, players, currentPlayer }) {
  const winnerLabel = winner === 'mafia' ? 'Mafia Wins!' : 'Guests Win!';

  const playerRows = players
    .map((p) => {
      const alive = p.alive ? '' : ' (eliminated)';
      const flairClass = hasGoldFlair && p.id === currentPlayer.id ? ' flair-gold' : '';
      return `<li class="player-item${flairClass}">${p.name} — ${p.role.name}${alive}</li>`;
    })
    .join('');

  const showRewardBtn = canShowRewarded() && !hasGoldFlair;

  app.innerHTML = `
    <div id="screen-game-over" class="screen active">
      <h1>${winnerLabel}</h1>
      <ul class="player-list">${playerRows}</ul>
      ${
        showRewardBtn
          ? '<button class="btn btn--rewarded" id="btn-rewarded">Watch ad for gold skin</button>'
          : ''
      }
      <button class="btn btn--pink" id="btn-play-again">Play Again</button>
    </div>
  `;

  if (showRewardBtn) {
    document.getElementById('btn-rewarded').addEventListener('click', () => {
      const btn = document.getElementById('btn-rewarded');
      if (btn) btn.disabled = true;
      showRewardedVideo(
        () => {
          // Reward: session-only gold text flair
          hasGoldFlair = true;
          if (btn) btn.remove();
          // Apply flair to current player's name in the list
          const items = app.querySelectorAll('.player-item');
          items.forEach((item) => {
            if (item.textContent.startsWith(currentPlayer.name)) {
              item.classList.add('flair-gold');
            }
          });
        },
        () => {
          // Skipped — re-enable button
          if (btn) btn.disabled = false;
        },
      );
    });
  }

  document.getElementById('btn-play-again').addEventListener('click', async () => {
    // Show interstitial before returning to lobby if due
    if (shouldShowInterstitial()) {
      await showInterstitial();
    }
    // Signal return to lobby — dispatch custom event that room.js can listen for
    window.dispatchEvent(new CustomEvent('game:return-to-lobby'));
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
