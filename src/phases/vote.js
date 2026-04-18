import { GAME } from '../config.js';
import { createTimer } from '../ui/timer.js';
import { DEV_MODE, scheduleStubAction } from '../dev.js';
import { playSound } from '../audio.js';
import { haptic, HAPTIC_VOTE } from '../haptic.js';
import { showToast } from '../ui/toast.js';

/**
 * Voting phase.
 * Shows alive players as vote buttons. 20-second timer.
 * Host tallies votes. Majority eliminates. Tie = no elimination.
 * Eliminated player's role IS revealed.
 */

/**
 * Show the voting screen.
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {Object} opts.channel - Supabase Realtime channel
 * @param {Array} opts.players - Array of { id, name, alive, role }
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {boolean} opts.isHost - Whether this client is the game host
 * @param {Function} opts.onVoteResult - Called with { eliminatedPlayer: {...}|null, votes: {} }
 */
export function showVoting({ app, channel, players, currentPlayer, isHost, onVoteResult }) {
  // #115: mount-counter debug hook for the hardened multi-client harness.
  // Always safe to no-op outside tests — the counter bag is opt-in.
  try {
    if (typeof window !== 'undefined' && window.__hm_debug__) {
      window.__hm_debug__.voteMounts = (window.__hm_debug__.voteMounts || 0) + 1;
    }
  } catch (_) {}
  const isAlive = players.find(p => p.id === currentPlayer.id)?.alive !== false;
  const alivePlayers = players.filter(p => p.alive);
  let hasVoted = false;

  // Build vote buttons (only alive players, can't vote self or dead)
  const votablePlayers = alivePlayers.filter(p => p.id !== currentPlayer.id);
  const voteButtonsHTML = isAlive
    ? votablePlayers.map(p =>
        `<button class="btn btn--pink vote-btn" data-player-id="${p.id}">${p.name}</button>`
      ).join('')
    : '<p class="vote-spectator">You are eliminated. Spectating.</p>';

  app.innerHTML = `
    <div id="screen-day-vote" class="screen active">
      <h1>Vote to Eliminate</h1>
      <div id="vote-timer-container"></div>
      <div class="vote-buttons" id="vote-buttons">
        ${voteButtonsHTML}
      </div>
      <p class="vote-status" id="vote-status"></p>
    </div>
  `;

  // Timer
  const timerContainer = document.getElementById('vote-timer-container');
  const timer = createTimer(GAME.VOTE_DURATION, null, null);
  timerContainer.appendChild(timer.el);

  // Vote tracking (host only tallies)
  const votes = {}; // playerId -> votedForPlayerId

  function updateVoteStatus() {
    const statusEl = document.getElementById('vote-status');
    if (!statusEl) return;
    const voteCount = Object.keys(votes).length;
    statusEl.textContent = `${voteCount}/${alivePlayers.length} votes cast`;
  }

  function disableAllButtons() {
    const btns = document.querySelectorAll('.vote-btn');
    btns.forEach(btn => {
      btn.disabled = true;
      btn.classList.add('vote-btn--disabled');
    });
  }

  function resolveVotes() {
    // Tally votes
    const tally = {};
    for (const voterId of Object.keys(votes)) {
      const target = votes[voterId];
      tally[target] = (tally[target] || 0) + 1;
    }

    // Find max
    let maxVotes = 0;
    let maxPlayer = null;
    let isTie = false;

    for (const [playerId, count] of Object.entries(tally)) {
      if (count > maxVotes) {
        maxVotes = count;
        maxPlayer = playerId;
        isTie = false;
      } else if (count === maxVotes) {
        isTie = true;
      }
    }

    // Majority required: >50% of alive voters
    const majorityThreshold = Math.floor(alivePlayers.length / 2) + 1;
    let eliminatedPlayer = null;

    if (!isTie && maxVotes >= majorityThreshold && maxPlayer) {
      eliminatedPlayer = players.find(p => p.id === maxPlayer) || null;
    }

    return { eliminatedPlayer, votes };
  }

  function showResult(eliminatedPlayer) {
    if (eliminatedPlayer) {
      // #57 #58 #53: vote-elimination feedback — single path runs on
      // host and non-host, so this fires exactly once per client per
      // round.
      try { playSound('elimination'); } catch (_) {}
      try { haptic([60, 40, 60]); } catch (_) {}
      try {
        showToast(`${eliminatedPlayer.name} was eliminated`, { type: 'warn', duration: 3000 });
      } catch (_) {}
      // #53: animated role reveal — every player (alive or eliminated)
      // sees the big role badge pop in via the CSS keyframe in
      // src/styles/role-reveal-tunables.css. The span inherits the
      // role color via the --reveal-color CSS variable.
      app.innerHTML = `
        <div id="screen-day-result" class="screen active">
          <h1>Eliminated</h1>
          <p class="vote-result-name">${eliminatedPlayer.name}</p>
          <p class="vote-result-role">Role:
            <span class="role-reveal-animate role-reveal-badge"
                  style="--reveal-color: ${eliminatedPlayer.role.color}; color: ${eliminatedPlayer.role.color}">
              ${eliminatedPlayer.role.emoji} ${eliminatedPlayer.role.name}
            </span>
          </p>
        </div>
      `;
      try { playSound('role-reveal'); } catch (_) {}
    } else {
      app.innerHTML = `
        <div id="screen-day-result" class="screen active">
          <h1>No Elimination</h1>
          <p class="vote-result-name">The vote was tied or no majority was reached.</p>
        </div>
      `;
    }
  }

  // Host handles vote tallying and timer
  if (isHost) {
    const hostTimer = createTimer(GAME.VOTE_DURATION, (remaining) => {
      channel.send({
        type: 'broadcast',
        event: 'phase:tick',
        payload: { phase: 'day-vote', remaining },
      });
      timer.sync(remaining);
    }, () => {
      timer.sync(0);
      // Time's up — resolve
      disableAllButtons();
      const result = resolveVotes();
      // Broadcast result
      channel.send({
        type: 'broadcast',
        event: 'phase:day-result',
        payload: {
          eliminatedPlayerId: result.eliminatedPlayer?.id || null,
          eliminatedPlayerName: result.eliminatedPlayer?.name || null,
          eliminatedPlayerRole: result.eliminatedPlayer?.role || null,
          votes: result.votes,
        },
      });
      showResult(result.eliminatedPlayer);
      setTimeout(() => {
        if (onVoteResult) onVoteResult(result);
      }, 3000);
    }, { fireWarnings: false });
    hostTimer.start();

    // In dev mode, auto-cast votes for stub players
    if (DEV_MODE) {
      const stubAlive = alivePlayers.filter(p => p.isStub);
      for (const stub of stubAlive) {
        // Stubs vote for a random alive non-stub player that isn't themselves
        const targets = alivePlayers.filter(p => p.id !== stub.id && !p.isStub);
        scheduleStubAction('vote', {
          stubId: stub.id,
          targets: targets.length > 0 ? targets : alivePlayers.filter(p => p.id !== stub.id),
          delayMs: 1000 + Math.random() * 1500,
          onResolve: ({ stubId, targetId }) => {
            if (!votes[stubId] && targetId) {
              votes[stubId] = targetId;
              updateVoteStatus();
              if (Object.keys(votes).length >= alivePlayers.length) {
                hostTimer.stop();
                timer.sync(0);
                disableAllButtons();
                const result = resolveVotes();
                channel.send({
                  type: 'broadcast',
                  event: 'phase:day-result',
                  payload: {
                    eliminatedPlayerId: result.eliminatedPlayer?.id || null,
                    eliminatedPlayerName: result.eliminatedPlayer?.name || null,
                    eliminatedPlayerRole: result.eliminatedPlayer?.role || null,
                    votes: result.votes,
                  },
                });
                showResult(result.eliminatedPlayer);
                setTimeout(() => {
                  if (onVoteResult) onVoteResult(result);
                }, 3000);
              }
            }
          },
        });
      }
    }

    // Listen for votes from other players
    channel.on('broadcast', { event: 'vote:cast' }, (msg) => {
      const { voterId, targetId } = msg.payload;
      if (!votes[voterId]) {
        votes[voterId] = targetId;
        updateVoteStatus();

        // Check if all alive players have voted
        if (Object.keys(votes).length >= alivePlayers.length) {
          hostTimer.stop();
          timer.sync(0);
          disableAllButtons();
          const result = resolveVotes();
          channel.send({
            type: 'broadcast',
            event: 'phase:day-result',
            payload: {
              eliminatedPlayerId: result.eliminatedPlayer?.id || null,
              eliminatedPlayerName: result.eliminatedPlayer?.name || null,
              eliminatedPlayerRole: result.eliminatedPlayer?.role || null,
              votes: result.votes,
            },
          });
          showResult(result.eliminatedPlayer);
          setTimeout(() => {
            if (onVoteResult) onVoteResult(result);
          }, 3000);
        }
      }
    });
  } else {
    // Non-host: listen for ticks
    channel.on('broadcast', { event: 'phase:tick' }, (msg) => {
      if (msg.payload.phase === 'day-vote') {
        timer.sync(msg.payload.remaining);
      }
    });

    // Listen for result from host
    channel.on('broadcast', { event: 'phase:day-result' }, (msg) => {
      disableAllButtons();
      const { eliminatedPlayerId, eliminatedPlayerName, eliminatedPlayerRole } = msg.payload;
      let eliminatedPlayer = null;
      if (eliminatedPlayerId) {
        eliminatedPlayer = {
          id: eliminatedPlayerId,
          name: eliminatedPlayerName,
          role: eliminatedPlayerRole,
        };
      }
      showResult(eliminatedPlayer);
      if (onVoteResult) {
        setTimeout(() => {
          onVoteResult({
            eliminatedPlayer: eliminatedPlayer
              ? players.find(p => p.id === eliminatedPlayerId) || eliminatedPlayer
              : null,
            votes: msg.payload.votes,
          });
        }, 3000);
      }
    });
  }

  // Click handlers for vote buttons
  if (isAlive) {
    const buttonsContainer = document.getElementById('vote-buttons');
    buttonsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.vote-btn');
      if (!btn || hasVoted) return;

      hasVoted = true;
      const targetId = btn.dataset.playerId;

      // #57 #58: gameplay feedback for the local voter.
      try { playSound('vote'); } catch (_) {}
      try { haptic(HAPTIC_VOTE); } catch (_) {}
      try { showToast('Vote locked in', { type: 'info', duration: 1500 }); } catch (_) {}

      // Highlight selected
      btn.classList.add('vote-btn--selected');
      disableAllButtons();

      // Broadcast vote
      channel.send({
        type: 'broadcast',
        event: 'vote:cast',
        payload: { voterId: currentPlayer.id, targetId },
      });

      // If host, also record locally (broadcast doesn't echo)
      if (isHost) {
        votes[currentPlayer.id] = targetId;
        updateVoteStatus();

        if (Object.keys(votes).length >= alivePlayers.length) {
          // All votes in — resolve early
          const hostTimerEl = document.querySelector('.timer');
          timer.sync(0);
          const result = resolveVotes();
          channel.send({
            type: 'broadcast',
            event: 'phase:day-result',
            payload: {
              eliminatedPlayerId: result.eliminatedPlayer?.id || null,
              eliminatedPlayerName: result.eliminatedPlayer?.name || null,
              eliminatedPlayerRole: result.eliminatedPlayer?.role || null,
              votes: result.votes,
            },
          });
          showResult(result.eliminatedPlayer);
          setTimeout(() => {
            if (onVoteResult) onVoteResult(result);
          }, 3000);
        }
      }

      const statusEl = document.getElementById('vote-status');
      if (statusEl) {
        statusEl.textContent = `You voted for ${votablePlayers.find(p => p.id === targetId)?.name || 'unknown'}`;
      }
    });
  }
}
