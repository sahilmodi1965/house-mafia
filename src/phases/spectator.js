import { createChatWidget } from '../ui/chat.js';

/**
 * Spectator view — read-only screen.
 *
 * Two flavors share this file:
 *
 *   1. Late-joiner spectator (#35): players who arrived AFTER the game
 *      started. Entry point: showSpectator(). Never had a role, can't
 *      play, just watches.
 *
 *   2. Eliminated-player spectator (#49): players who WERE active,
 *      got eliminated, and stay in the room to watch. Entry point:
 *      showEliminatedSpectator(). Shows a "You were eliminated" banner
 *      with the local player's role reveal, then falls through to the
 *      same read-only phase view as the late-joiner.
 *
 * Both flavors attach to the existing shared room channel and react to
 * the standard phase broadcasts. No inputs, no timers, no game state
 * ownership.
 */

/**
 * Map a raw phase id to a human-readable label.
 */
function phaseLabel(phase) {
  switch (phase) {
    case 'night':
      return 'Night';
    case 'night-end':
      return 'Night ending';
    case 'day-discuss':
      return 'Day — Discussion';
    case 'day-vote':
      return 'Day — Voting';
    case 'game-over':
      return 'Game over';
    default:
      return 'Game in progress';
  }
}

/**
 * Small helper exposed for tests / debugging: inspect the current phase
 * label from a state-like object ({ phase }). Exported because the issue
 * spec mentions it as an optional helper.
 */
export function inspectGamePhase(state) {
  if (!state || typeof state !== 'object') return phaseLabel(null);
  return phaseLabel(state.phase);
}

/**
 * Show the spectator screen for a late joiner.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {Object} opts.channel - Shared Supabase Realtime channel (already subscribed)
 * @param {string} opts.roomCode - Room code for display
 * @param {Array}  [opts.initialPlayers] - Best-effort seed player list (may be empty)
 * @param {Function} opts.onLeave - Called when the spectator taps Leave
 */
export function showSpectator({ app, channel, roomCode, initialPlayers = [], onLeave }) {
  // Local mirror of the public player list. Seeded from whatever room.js
  // saw on presence sync (may be empty) and refreshed on every phase
  // broadcast that carries a players array.
  let players = Array.isArray(initialPlayers) ? initialPlayers.slice() : [];
  let phase = 'running';
  let gameOver = false;
  let winner = null;

  app.innerHTML = `
    <div id="screen-spectator" class="screen active">
      <h1>Spectating</h1>
      <p class="room-code-display">Room Code: <span id="spectator-code">${roomCode || ''}</span></p>
      <p class="spectator-phase" id="spectator-phase">Game in progress</p>
      <div class="spectator-rosters">
        <div class="spectator-roster">
          <h2>Alive</h2>
          <ul class="player-list" id="spectator-alive"></ul>
        </div>
        <div class="spectator-roster">
          <h2>Eliminated</h2>
          <ul class="player-list" id="spectator-eliminated"></ul>
        </div>
      </div>
      <p class="spectator-note">Read-only view. You joined after the game started.</p>
      <button class="btn btn--cyan" id="btn-spectator-leave">Leave</button>
    </div>
  `;

  const phaseEl = document.getElementById('spectator-phase');
  const aliveEl = document.getElementById('spectator-alive');
  const eliminatedEl = document.getElementById('spectator-eliminated');

  function render() {
    if (phaseEl) {
      if (gameOver) {
        phaseEl.textContent = winner === 'mafia'
          ? 'Game over — Mafia wins'
          : winner === 'guests'
            ? 'Game over — Guests win'
            : 'Game over';
      } else {
        phaseEl.textContent = phaseLabel(phase);
      }
    }

    if (aliveEl) {
      const alive = players.filter((p) => p.alive !== false);
      aliveEl.innerHTML = alive.length
        ? alive.map((p) => `<li class="player-item">${escapeHtml(p.name || '')}</li>`).join('')
        : '<li class="player-item player-item--muted">(waiting for roster)</li>';
    }

    if (eliminatedEl) {
      const dead = players.filter((p) => p.alive === false);
      eliminatedEl.innerHTML = dead.length
        ? dead.map((p) => `<li class="player-item">${escapeHtml(p.name || '')}</li>`).join('')
        : '<li class="player-item player-item--muted">(none)</li>';
    }
  }

  function updatePlayersFromPayload(payload) {
    if (payload && Array.isArray(payload.players)) {
      players = payload.players.slice();
    }
  }

  // Subscribe to the existing shared-channel phase broadcasts. The
  // channel is already SUBSCRIBED by room.js so `.on()` adds listeners
  // without a second round-trip.
  if (channel && typeof channel.on === 'function') {
    channel.on('broadcast', { event: 'phase:night-start' }, (msg) => {
      phase = 'night';
      updatePlayersFromPayload(msg && msg.payload);
      render();
    });
    channel.on('broadcast', { event: 'phase:night-end' }, (msg) => {
      phase = 'night-end';
      updatePlayersFromPayload(msg && msg.payload);
      render();
    });
    channel.on('broadcast', { event: 'phase:day-discuss' }, (msg) => {
      phase = 'day-discuss';
      updatePlayersFromPayload(msg && msg.payload);
      render();
    });
    channel.on('broadcast', { event: 'phase:day-vote' }, () => {
      phase = 'day-vote';
      render();
    });
    channel.on('broadcast', { event: 'game:end' }, (msg) => {
      gameOver = true;
      phase = 'game-over';
      const payload = msg && msg.payload;
      if (payload) {
        winner = payload.winner || null;
        if (Array.isArray(payload.players)) {
          players = payload.players.slice();
        }
      }
      render();
    });
  }

  const leaveBtn = document.getElementById('btn-spectator-leave');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', () => {
      if (onLeave) onLeave();
    });
  }

  render();
}

/**
 * Issue #49: eliminated-player spectator view.
 *
 * Unlike #35 (late joiner) this player had an active role. We show
 * their role reveal banner prominently, then render the live phase
 * roster below. Transitions to game-over when the host fires game:end.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.app
 * @param {Object} opts.channel - shared Supabase channel (already subscribed)
 * @param {string} opts.roomCode
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {{id:string,name:string,emoji:string,color:string}} opts.role - player's role
 * @param {Array}  opts.players - full roster snapshot (with alive flags)
 * @param {Function} opts.onGameOver - called when game:end fires (forwards winner/players)
 */
export function showEliminatedSpectator({ app, channel, roomCode, currentPlayer, role, players: initialPlayers, onGameOver }) {
  let players = Array.isArray(initialPlayers) ? initialPlayers.slice() : [];
  let phase = 'running';

  const roleBadge = role
    ? `<span class="role-reveal-animate role-reveal-badge" style="--reveal-color: ${role.color}; color: ${role.color}">${role.emoji} ${role.name}</span>`
    : '';

  app.innerHTML = `
    <div id="screen-spectator" class="screen active screen-spectator--eliminated">
      <div class="spectator-eliminated-banner">
        <h1>You were eliminated</h1>
        <p>Your role: ${roleBadge}</p>
      </div>
      <p class="room-code-display">Room Code: <span id="spectator-code">${roomCode || ''}</span></p>
      <p class="spectator-phase" id="spectator-phase">Game in progress</p>
      <div class="spectator-rosters">
        <div class="spectator-roster">
          <h2>Alive</h2>
          <ul class="player-list" id="spectator-alive"></ul>
        </div>
        <div class="spectator-roster">
          <h2>Eliminated</h2>
          <ul class="player-list" id="spectator-eliminated"></ul>
        </div>
      </div>
      <div id="spectator-chat-slot"></div>
      <p class="spectator-note">Read-only view — waiting for the round to end.</p>
    </div>
  `;

  // #50: mount the chat widget in read-only mode (isAlive=false) so
  // eliminated players see the live discussion feed but can't type.
  // This runs for the entire eliminated-spectator lifetime — the
  // listener is a no-op outside Day-Discussion anyway since no
  // chat:message frames fire then.
  const chatSlot = document.getElementById('spectator-chat-slot');
  if (chatSlot) {
    const widget = createChatWidget({
      channel,
      currentPlayer,
      isAlive: false,
    });
    chatSlot.appendChild(widget.el);
  }

  const phaseEl = document.getElementById('spectator-phase');
  const aliveEl = document.getElementById('spectator-alive');
  const eliminatedEl = document.getElementById('spectator-eliminated');

  function render() {
    if (phaseEl) phaseEl.textContent = phaseLabel(phase);
    if (aliveEl) {
      const alive = players.filter((p) => p.alive !== false);
      aliveEl.innerHTML = alive.length
        ? alive.map((p) => `<li class="player-item">${escapeHtml(p.name || '')}</li>`).join('')
        : '<li class="player-item player-item--muted">(waiting)</li>';
    }
    if (eliminatedEl) {
      const dead = players.filter((p) => p.alive === false);
      eliminatedEl.innerHTML = dead.length
        ? dead.map((p) => `<li class="player-item">${escapeHtml(p.name || '')}</li>`).join('')
        : '<li class="player-item player-item--muted">(none)</li>';
    }
  }

  function updatePlayersFromPayload(payload) {
    if (payload && Array.isArray(payload.players)) {
      players = payload.players.slice();
    }
  }

  if (channel && typeof channel.on === 'function') {
    channel.on('broadcast', { event: 'phase:night-start' }, (msg) => {
      phase = 'night';
      updatePlayersFromPayload(msg && msg.payload);
      render();
    });
    channel.on('broadcast', { event: 'phase:night-end' }, (msg) => {
      phase = 'night-end';
      updatePlayersFromPayload(msg && msg.payload);
      render();
    });
    channel.on('broadcast', { event: 'phase:day-discuss' }, (msg) => {
      phase = 'day-discuss';
      updatePlayersFromPayload(msg && msg.payload);
      render();
    });
    channel.on('broadcast', { event: 'phase:day-vote' }, () => {
      phase = 'day-vote';
      render();
    });
    channel.on('broadcast', { event: 'game:end' }, (msg) => {
      const payload = (msg && msg.payload) || {};
      if (onGameOver) {
        onGameOver({
          winner: payload.winner || null,
          players: Array.isArray(payload.players) ? payload.players.slice() : players,
        });
      }
    });
  }

  render();
}

/**
 * Minimal HTML-escaper for player names rendered into innerHTML. Keeps
 * the spectator roster safe from oddball display names without pulling
 * in a sanitizer dep.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
