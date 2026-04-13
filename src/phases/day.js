import { GAME } from '../config.js';
import { createTimer } from '../ui/timer.js';

/**
 * Day discussion phase.
 * Shows alive players, night elimination announcement, 40-second countdown,
 * and tap-to-suspect mechanic via Supabase broadcast.
 * Auto-transitions to voting when timer hits 0.
 */

/**
 * Show the day discussion screen.
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {Object} opts.channel - Supabase Realtime channel
 * @param {Array} opts.players - Array of { id, name, alive, role }
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {boolean} opts.isHost - Whether this client is the game host
 * @param {string|null} opts.eliminatedName - Name of player eliminated during night (null if none)
 * @param {Function} opts.onDiscussionEnd - Called when discussion timer ends
 */
export function showDayDiscussion({ app, channel, players, currentPlayer, isHost, eliminatedName, onDiscussionEnd }) {
  const isAlive = players.find(p => p.id === currentPlayer.id)?.alive !== false;

  // Suspect tally — reset fresh each round
  // suspectTally: Map<targetId, Set<voterId>>
  // voterNames: Map<voterId, voterName>
  const suspectTally = new Map();
  const voterNames = new Map();

  // Track current player's active suspect (at most one at a time)
  let myCurrentSuspect = null; // targetId or null

  // Night elimination announcement
  const announcementHTML = eliminatedName
    ? `<p class="day-announcement">During the night, <strong>${eliminatedName}</strong> was eliminated.</p>`
    : `<p class="day-announcement">No one was eliminated during the night.</p>`;

  app.innerHTML = `
    <div id="screen-day-discuss" class="screen active">
      <h1>Day -- Discuss!</h1>
      ${announcementHTML}
      <div id="day-timer-container"></div>
      <ul class="day-player-list" id="day-player-list"></ul>
      ${!isAlive ? '<p class="day-chat__spectator">You are eliminated. Spectating.</p>' : ''}
    </div>
  `;

  // Timer
  const timerContainer = document.getElementById('day-timer-container');
  const timer = createTimer(GAME.DISCUSSION_DURATION, null, () => {
    if (onDiscussionEnd) onDiscussionEnd();
  });
  timerContainer.appendChild(timer.el);

  // Host runs the timer and broadcasts ticks
  if (isHost) {
    const hostTimer = createTimer(GAME.DISCUSSION_DURATION, (remaining) => {
      channel.send({
        type: 'broadcast',
        event: 'phase:tick',
        payload: { phase: 'day-discuss', remaining },
      });
      timer.sync(remaining);
    }, () => {
      timer.sync(0);
      // Host broadcasts transition to voting
      channel.send({
        type: 'broadcast',
        event: 'phase:day-vote',
        payload: {},
      });
      if (onDiscussionEnd) onDiscussionEnd();
    });
    hostTimer.start();
  } else {
    // Non-host: listen for ticks
    channel.on('broadcast', { event: 'phase:tick' }, (msg) => {
      if (msg.payload.phase === 'day-discuss') {
        timer.sync(msg.payload.remaining);
      }
    });
  }

  // --- Suspect tally helpers ---

  function renderPlayerList() {
    const listEl = document.getElementById('day-player-list');
    if (!listEl) return;

    listEl.innerHTML = players.map(p => {
      const isAlivePlayer = p.alive !== false;
      const isDead = !isAlivePlayer;

      // Determine if this row is tappable:
      // - local player must be alive
      // - target must be a different alive player (not self, not dead)
      const tappable = isAlive && isAlivePlayer && p.id !== currentPlayer.id;

      // Build suspect list for this player
      const suspectors = suspectTally.get(p.id) || new Set();
      const suspectorNames = [...suspectors].map(vid => voterNames.get(vid) || '?');
      const iSuspectThis = myCurrentSuspect === p.id;

      const classes = ['day-player-item'];
      if (isDead) classes.push('day-player-item--dead');
      if (tappable) classes.push('day-player-item--clickable');
      if (suspectors.size > 0) classes.push('day-player-item--has-suspects');
      if (iSuspectThis) classes.push('day-player-item--my-suspect');

      const deadLabel = isDead ? ' <span class="day-player-status">eliminated</span>' : '';

      let suspectHTML = '';
      if (suspectors.size > 0) {
        suspectHTML = `<span class="suspect-list">← ${suspectorNames.join(', ')}</span>`;
      }

      return `<li class="${classes.join(' ')}" data-player-id="${p.id}">
        <span class="day-player-name">${p.name}${deadLabel}</span>
        ${suspectHTML}
      </li>`;
    }).join('');
  }

  // Initial render
  renderPlayerList();

  // --- Suspect broadcast logic ---

  function broadcastSuspect(targetId) {
    channel.send({
      type: 'broadcast',
      event: 'day:suspect',
      payload: {
        voterId: currentPlayer.id,
        voterName: currentPlayer.name,
        targetId,
      },
    });
  }

  function broadcastUnsuspect(targetId) {
    channel.send({
      type: 'broadcast',
      event: 'day:unsuspect',
      payload: {
        voterId: currentPlayer.id,
        targetId,
      },
    });
  }

  function applyLocalSuspect(voterId, voterName, targetId) {
    voterNames.set(voterId, voterName);
    if (!suspectTally.has(targetId)) {
      suspectTally.set(targetId, new Set());
    }
    suspectTally.get(targetId).add(voterId);
    renderPlayerList();
  }

  function applyLocalUnsuspect(voterId, targetId) {
    const s = suspectTally.get(targetId);
    if (s) {
      s.delete(voterId);
      if (s.size === 0) suspectTally.delete(targetId);
    }
    renderPlayerList();
  }

  // Listen for suspect/unsuspect from all players
  channel.on('broadcast', { event: 'day:suspect' }, (msg) => {
    const { voterId, voterName, targetId } = msg.payload;
    applyLocalSuspect(voterId, voterName, targetId);
  });

  channel.on('broadcast', { event: 'day:unsuspect' }, (msg) => {
    const { voterId, targetId } = msg.payload;
    applyLocalUnsuspect(voterId, targetId);
  });

  // --- Click handler for tap-to-suspect (alive players only) ---

  if (isAlive) {
    const listEl = document.getElementById('day-player-list');
    listEl.addEventListener('click', (e) => {
      const li = e.target.closest('.day-player-item--clickable');
      if (!li) return;

      const targetId = li.dataset.playerId;
      const targetPlayer = players.find(p => p.id === targetId);
      if (!targetPlayer || !targetPlayer.alive) return;

      if (myCurrentSuspect === targetId) {
        // Tapping existing suspect → retract
        myCurrentSuspect = null;
        broadcastUnsuspect(targetId);
        applyLocalUnsuspect(currentPlayer.id, targetId);
      } else {
        // Auto-retract previous suspect before moving to new one
        if (myCurrentSuspect !== null) {
          const prev = myCurrentSuspect;
          broadcastUnsuspect(prev);
          applyLocalUnsuspect(currentPlayer.id, prev);
        }
        myCurrentSuspect = targetId;
        broadcastSuspect(targetId);
        applyLocalSuspect(currentPlayer.id, currentPlayer.name, targetId);
      }
    });
  }
}
