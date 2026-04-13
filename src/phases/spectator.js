import { GAME } from '../config.js';

/**
 * Spectator view — read-only display of a game already in progress.
 *
 * Late joiners (anyone who subscribes to a room after the host has
 * broadcast game:start) are routed here instead of the normal lobby →
 * role-reveal → night/day flow. They do not receive a role, cannot
 * vote, and cannot send any game actions. They simply listen to the
 * public phase broadcasts on the shared channel and display the
 * current phase + alive/eliminated rosters.
 *
 * The host tracks its own presence with a `phase` field so joiners
 * can detect mid-game state on first presence:sync. See room.js
 * validateJoinerPresence().
 */

/**
 * Mount the spectator screen and wire up the listeners.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {Object} opts.channel - Shared Supabase Realtime channel
 * @param {string} opts.roomCode
 * @param {Array} opts.initialPlayers - Best-effort snapshot from presence
 * @param {string} opts.initialPhase - Phase label from host presence (e.g. 'running')
 * @param {Function} opts.onLeave - Called when the spectator taps Leave
 * @returns {Object} handle with a cleanup() method
 */
export function showSpectator({ app, channel, roomCode, initialPlayers, initialPhase, onLeave }) {
  // Local state — updated as broadcasts arrive on the shared channel.
  let phaseLabel = labelForPhase(initialPhase || 'running');
  let players = Array.isArray(initialPlayers) ? [...initialPlayers] : [];
  let eliminationNote = '';

  app.innerHTML = `
    <div id="screen-spectator" class="screen active">
      <h1>Spectating</h1>
      <p class="room-code-display">Room Code: <span>${roomCode}</span></p>
      <p class="spectator-phase" id="spectator-phase">${phaseLabel}</p>
      <p class="spectator-note" id="spectator-note"></p>
      <div class="spectator-rosters">
        <div class="spectator-roster">
          <h2>Alive</h2>
          <ul class="player-list" id="spectator-alive"></ul>
        </div>
        <div class="spectator-roster">
          <h2>Eliminated</h2>
          <ul class="player-list" id="spectator-dead"></ul>
        </div>
      </div>
      <p class="waiting-text">Read-only view. You joined after the game started.</p>
      <button class="btn btn--cyan" id="btn-leave-spectator">Leave</button>
    </div>
  `;

  document.getElementById('btn-leave-spectator').addEventListener('click', () => {
    if (onLeave) onLeave();
  });

  render();

  // --- Broadcast listeners ---

  const onNightStart = (msg) => {
    const payload = msg && msg.payload;
    if (payload && Array.isArray(payload.players)) {
      players = payload.players;
    }
    phaseLabel = labelForPhase('night');
    eliminationNote = '';
    render();
  };

  const onNightEnd = (msg) => {
    const payload = msg && msg.payload;
    if (payload && Array.isArray(payload.players)) {
      players = payload.players;
    }
    if (payload && payload.eliminatedPlayerName) {
      eliminationNote = `${payload.eliminatedPlayerName} was eliminated in the night.`;
    }
    render();
  };

  const onDayDiscuss = (msg) => {
    const payload = msg && msg.payload;
    if (payload && Array.isArray(payload.players)) {
      players = payload.players;
    }
    if (payload && payload.eliminatedName) {
      eliminationNote = `${payload.eliminatedName} was eliminated in the night.`;
    }
    phaseLabel = labelForPhase('day-discuss');
    render();
  };

  const onDayVote = () => {
    phaseLabel = labelForPhase('day-vote');
    render();
  };

  const onGameEnd = (msg) => {
    const payload = msg && msg.payload;
    if (payload && Array.isArray(payload.players)) {
      players = payload.players;
    }
    phaseLabel = payload && payload.winner === 'mafia' ? 'Mafia wins' : 'Guests win';
    eliminationNote = 'Game over.';
    render();
  };

  channel.on('broadcast', { event: 'phase:night-start' }, onNightStart);
  channel.on('broadcast', { event: 'phase:night-end' }, onNightEnd);
  channel.on('broadcast', { event: 'phase:day-discuss' }, onDayDiscuss);
  channel.on('broadcast', { event: 'phase:day-vote' }, onDayVote);
  channel.on('broadcast', { event: 'game:end' }, onGameEnd);

  function render() {
    const phaseEl = document.getElementById('spectator-phase');
    const noteEl = document.getElementById('spectator-note');
    const aliveEl = document.getElementById('spectator-alive');
    const deadEl = document.getElementById('spectator-dead');
    if (!phaseEl || !aliveEl || !deadEl || !noteEl) return;

    phaseEl.textContent = phaseLabel;
    noteEl.textContent = eliminationNote;

    // Spectators and stubs should never appear in rosters — the host's
    // broadcasts already exclude spectators, and stubs are harmless
    // dev-only placeholders.
    const realPlayers = players.filter((p) => !p.isSpectator);
    const alive = realPlayers.filter((p) => p.alive !== false);
    const dead = realPlayers.filter((p) => p.alive === false);

    aliveEl.innerHTML = alive.length
      ? alive.map((p) => `<li class="player-item">${escapeHtml(p.name)}</li>`).join('')
      : '<li class="player-item player-item--muted">(none)</li>';

    deadEl.innerHTML = dead.length
      ? dead.map((p) => `<li class="player-item player-item--muted">${escapeHtml(p.name)}</li>`).join('')
      : '<li class="player-item player-item--muted">(none)</li>';
  }

  function labelForPhase(phase) {
    switch (phase) {
      case 'lobby': return 'Lobby';
      case 'night': return 'Night';
      case 'night-end': return 'Night';
      case 'day-discuss': return 'Day — Discussion';
      case 'day-vote': return 'Day — Voting';
      case 'game-over': return 'Game over';
      case 'running':
      default:
        return 'Game in progress';
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  return {
    cleanup() {
      // Channel teardown is handled by room.js cleanup(); nothing to do here.
    },
  };
}

/**
 * Determine whether a tracked host presence indicates the game is
 * already past the lobby. Used by room.js on first presence:sync to
 * decide between the normal lobby path and the spectator path.
 *
 * @param {Object} presenceState - Output of channel.presenceState()
 * @returns {{inProgress: boolean, phase: string|null, spectatorCount: number}}
 */
export function inspectGamePhase(presenceState) {
  let phase = null;
  let inProgress = false;
  let spectatorCount = 0;

  for (const key of Object.keys(presenceState)) {
    const presences = presenceState[key];
    if (!presences || presences.length === 0) continue;
    const latest = presences[presences.length - 1];
    if (latest.isSpectator) {
      spectatorCount += 1;
      continue;
    }
    if (latest.isHost && latest.phase) {
      phase = latest.phase;
      if (phase !== 'lobby') inProgress = true;
    }
  }

  return { inProgress, phase, spectatorCount };
}

export { GAME as _GAME };
