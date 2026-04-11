import { GAME } from '../config.js';
import { createTimer } from '../ui/timer.js';

/**
 * Night phase.
 * - Mafia: pick a target to eliminate from alive non-Mafia players.
 * - Host (role): investigate a player to learn if they are Mafia.
 * - Guest: dark waiting screen with 30-second timer.
 *
 * All night actions are SECRET — sent only to the game host's client.
 * The game host runs the authoritative timer and resolves actions.
 */

/**
 * Show the night screen.
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {Object} opts.channel - Supabase Realtime channel
 * @param {Array} opts.players - Array of { id, name, alive, role }
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {Object} opts.currentRole - { id, name, emoji, color } — this player's role
 * @param {boolean} opts.isHost - Whether this client is the game host (room creator)
 * @param {Array} opts.mafiaPartners - Array of { id, name } — other Mafia (if any)
 * @param {Function} opts.onNightEnd - Called with { eliminatedName: string|null }
 */
export function showNight({ app, channel, players, currentPlayer, currentRole, isHost, mafiaPartners, onNightEnd }) {
  const roleId = currentRole.id;

  if (roleId === 'mafia') {
    showMafiaView({ app, channel, players, currentPlayer, isHost, mafiaPartners, onNightEnd });
  } else if (roleId === 'host') {
    showHostRoleView({ app, channel, players, currentPlayer, isHost, onNightEnd });
  } else {
    showGuestView({ app, channel, players, isHost, onNightEnd });
  }
}

/**
 * Mafia night view — pick a target to eliminate.
 */
function showMafiaView({ app, channel, players, currentPlayer, isHost, mafiaPartners, onNightEnd }) {
  const alivePlayers = players.filter(p => p.alive);
  // Mafia can't target self or other Mafia
  const mafiaIds = new Set([currentPlayer.id, ...(mafiaPartners || []).map(p => p.id)]);
  const targets = alivePlayers.filter(p => !mafiaIds.has(p.id));

  let selectedId = null;
  let hasConfirmed = false;

  const targetButtonsHTML = targets.map(p =>
    `<button class="btn btn--pink night-target-btn" data-player-id="${p.id}">${p.name}</button>`
  ).join('');

  const partnerInfoHTML = mafiaPartners && mafiaPartners.length > 0
    ? `<p class="night-partner-info">Partner: ${mafiaPartners.map(p => p.name).join(', ')}</p>`
    : '';

  app.innerHTML = `
    <div id="screen-night" class="screen active night-screen">
      <h1>Night</h1>
      <p class="night-subtitle">Choose your target</p>
      ${partnerInfoHTML}
      <div id="night-timer-container"></div>
      <div class="night-targets" id="night-targets">
        ${targetButtonsHTML}
      </div>
      <button class="btn btn--cyan night-confirm" id="night-confirm" disabled>Confirm</button>
      <p class="night-status" id="night-status"></p>
    </div>
  `;

  // Timer (display only — host runs authoritative timer)
  const timerContainer = document.getElementById('night-timer-container');
  const timer = createTimer(GAME.NIGHT_DURATION, null, null);
  timerContainer.appendChild(timer.el);

  // Selection logic
  const targetsContainer = document.getElementById('night-targets');
  const confirmBtn = document.getElementById('night-confirm');
  const statusEl = document.getElementById('night-status');

  targetsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.night-target-btn');
    if (!btn || hasConfirmed) return;

    // Deselect previous
    targetsContainer.querySelectorAll('.night-target-btn').forEach(b => {
      b.classList.remove('night-target-btn--selected');
    });
    btn.classList.add('night-target-btn--selected');
    selectedId = btn.dataset.playerId;
    confirmBtn.disabled = false;
  });

  confirmBtn.addEventListener('click', () => {
    if (!selectedId || hasConfirmed) return;
    hasConfirmed = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirmed';

    // Send pick to game host only via broadcast
    channel.send({
      type: 'broadcast',
      event: 'night:mafia-pick',
      payload: { playerId: currentPlayer.id, targetId: selectedId },
    });

    // If this player IS the game host, record locally (broadcast doesn't echo)
    if (isHost) {
      recordMafiaPick(currentPlayer.id, selectedId);
    }

    statusEl.textContent = `You chose ${targets.find(t => t.id === selectedId)?.name || 'unknown'}`;
  });

  // Listen for partner's pick (real-time display for multi-Mafia)
  channel.on('broadcast', { event: 'night:mafia-partner-pick' }, (msg) => {
    if (msg.payload.targetPlayerId) {
      const partnerName = mafiaPartners.find(p => p.id === msg.payload.pickerId)?.name || 'Partner';
      const targetName = targets.find(t => t.id === msg.payload.targetPlayerId)?.name || 'unknown';
      statusEl.textContent = hasConfirmed
        ? `You confirmed. ${partnerName} picked ${targetName}.`
        : `${partnerName} picked ${targetName}.`;
    }
  });

  // Timer sync
  if (isHost) {
    const hostTimer = createTimer(GAME.NIGHT_DURATION, (remaining) => {
      channel.send({
        type: 'broadcast',
        event: 'phase:tick',
        payload: { phase: 'night', remaining },
      });
      timer.sync(remaining);
    }, () => {
      timer.sync(0);
      resolveNight(channel, players, onNightEnd);
    });
    hostTimer.start();
  } else {
    channel.on('broadcast', { event: 'phase:tick' }, (msg) => {
      if (msg.payload.phase === 'night') {
        timer.sync(msg.payload.remaining);
      }
    });

    // Non-host listens for night resolution
    channel.on('broadcast', { event: 'phase:day-discuss' }, (msg) => {
      if (onNightEnd) onNightEnd({
        eliminatedName: msg.payload.eliminatedName,
        players: msg.payload.players,
      });
    });
  }
}

/**
 * Host role night view — investigate a player.
 */
function showHostRoleView({ app, channel, players, currentPlayer, isHost, onNightEnd }) {
  const alivePlayers = players.filter(p => p.alive && p.id !== currentPlayer.id);

  let selectedId = null;
  let hasConfirmed = false;

  const targetButtonsHTML = alivePlayers.map(p =>
    `<button class="btn btn--cyan night-target-btn" data-player-id="${p.id}">${p.name}</button>`
  ).join('');

  app.innerHTML = `
    <div id="screen-night" class="screen active night-screen">
      <h1>Night</h1>
      <p class="night-subtitle">Investigate a player</p>
      <div id="night-timer-container"></div>
      <div class="night-targets" id="night-targets">
        ${targetButtonsHTML}
      </div>
      <button class="btn btn--pink night-confirm" id="night-confirm" disabled>Confirm</button>
      <p class="night-status" id="night-status"></p>
      <div class="night-result" id="night-result"></div>
    </div>
  `;

  // Timer
  const timerContainer = document.getElementById('night-timer-container');
  const timer = createTimer(GAME.NIGHT_DURATION, null, null);
  timerContainer.appendChild(timer.el);

  const targetsContainer = document.getElementById('night-targets');
  const confirmBtn = document.getElementById('night-confirm');
  const statusEl = document.getElementById('night-status');

  targetsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.night-target-btn');
    if (!btn || hasConfirmed) return;

    targetsContainer.querySelectorAll('.night-target-btn').forEach(b => {
      b.classList.remove('night-target-btn--selected');
    });
    btn.classList.add('night-target-btn--selected');
    selectedId = btn.dataset.playerId;
    confirmBtn.disabled = false;
  });

  confirmBtn.addEventListener('click', () => {
    if (!selectedId || hasConfirmed) return;
    hasConfirmed = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirmed';

    // Send investigation pick to game host
    channel.send({
      type: 'broadcast',
      event: 'night:host-pick',
      payload: { playerId: currentPlayer.id, targetId: selectedId },
    });

    // If this player IS the game host, process investigation locally
    if (isHost) {
      recordHostPick(currentPlayer.id, selectedId);
      // Show result immediately since this player is the investigator
      const targetPlayer = players.find(p => p.id === selectedId);
      const isMafia = targetPlayer?.role?.id === 'mafia';
      showInvestigationResult(isMafia);
    }

    statusEl.textContent = 'Investigating...';
  });

  // Listen for investigation result from game host
  channel.on('broadcast', { event: 'night:investigation-result' }, (msg) => {
    if (msg.payload.targetPlayerId === currentPlayer.id) {
      // This result is for us
      showInvestigationResult(msg.payload.isMafia);
    }
  });

  function showInvestigationResult(isMafia) {
    const resultEl = document.getElementById('night-result');
    const targetName = alivePlayers.find(p => p.id === selectedId)?.name || 'unknown';
    if (resultEl) {
      resultEl.innerHTML = isMafia
        ? `<p class="night-result-text night-result-text--mafia">${targetName} is <strong>Mafia</strong></p>`
        : `<p class="night-result-text night-result-text--safe">${targetName} is <strong>Not Mafia</strong></p>`;
    }
    const statusEl2 = document.getElementById('night-status');
    if (statusEl2) statusEl2.textContent = '';
  }

  // Timer sync
  if (isHost) {
    const hostTimer = createTimer(GAME.NIGHT_DURATION, (remaining) => {
      channel.send({
        type: 'broadcast',
        event: 'phase:tick',
        payload: { phase: 'night', remaining },
      });
      timer.sync(remaining);
    }, () => {
      timer.sync(0);
      resolveNight(channel, players, onNightEnd);
    });
    hostTimer.start();
  } else {
    channel.on('broadcast', { event: 'phase:tick' }, (msg) => {
      if (msg.payload.phase === 'night') {
        timer.sync(msg.payload.remaining);
      }
    });

    channel.on('broadcast', { event: 'phase:day-discuss' }, (msg) => {
      if (onNightEnd) onNightEnd({
        eliminatedName: msg.payload.eliminatedName,
        players: msg.payload.players,
      });
    });
  }
}

/**
 * Guest night view — dark waiting screen.
 */
function showGuestView({ app, channel, players, isHost, onNightEnd }) {
  app.innerHTML = `
    <div id="screen-night" class="screen active night-screen night-screen--guest">
      <h1>Night</h1>
      <p class="night-subtitle">Sleep tight...</p>
      <div id="night-timer-container"></div>
      <p class="night-guest-msg">The night is dark. Wait for dawn.</p>
    </div>
  `;

  // Timer
  const timerContainer = document.getElementById('night-timer-container');
  const timer = createTimer(GAME.NIGHT_DURATION, null, null);
  timerContainer.appendChild(timer.el);

  if (isHost) {
    // Edge case: game host player is a Guest. They still run the authoritative timer.
    const hostTimer = createTimer(GAME.NIGHT_DURATION, (remaining) => {
      channel.send({
        type: 'broadcast',
        event: 'phase:tick',
        payload: { phase: 'night', remaining },
      });
      timer.sync(remaining);
    }, () => {
      timer.sync(0);
      resolveNight(channel, players, onNightEnd);
    });
    hostTimer.start();
  } else {
    channel.on('broadcast', { event: 'phase:tick' }, (msg) => {
      if (msg.payload.phase === 'night') {
        timer.sync(msg.payload.remaining);
      }
    });

    channel.on('broadcast', { event: 'phase:day-discuss' }, (msg) => {
      if (onNightEnd) onNightEnd({
        eliminatedName: msg.payload.eliminatedName,
        players: msg.payload.players,
      });
    });
  }
}

// --- Night action tracking (game host only) ---

let nightActions = {
  mafiaPicks: {},  // mafiaPlayerId -> targetId
  hostPick: null,  // { playerId, targetId }
  resolved: false,
};

/** Reset night actions for a new night. */
export function resetNightActions() {
  nightActions = {
    mafiaPicks: {},
    hostPick: null,
    resolved: false,
  };
}

/** Record a Mafia player's pick (game host only). */
function recordMafiaPick(mafiaPlayerId, targetId) {
  nightActions.mafiaPicks[mafiaPlayerId] = targetId;
}

/** Record the Host role's investigation pick (game host only). */
function recordHostPick(hostPlayerId, targetId) {
  nightActions.hostPick = { playerId: hostPlayerId, targetId };
}

/**
 * Set up game-host-only listeners for night actions from other players.
 * Must be called before showNight on the game host's client.
 * @param {Object} channel - Supabase Realtime channel
 * @param {Array} players - Array of { id, name, alive, role }
 */
export function setupNightListeners(channel, players) {
  // Listen for Mafia picks
  channel.on('broadcast', { event: 'night:mafia-pick' }, (msg) => {
    const { playerId, targetId } = msg.payload;
    recordMafiaPick(playerId, targetId);

    // Notify other Mafia of this pick (for real-time display)
    const mafiaPlayers = players.filter(p => p.role.id === 'mafia' && p.alive);
    if (mafiaPlayers.length > 1) {
      channel.send({
        type: 'broadcast',
        event: 'night:mafia-partner-pick',
        payload: { pickerId: playerId, targetPlayerId: targetId },
      });
    }
  });

  // Listen for Host role investigation picks
  channel.on('broadcast', { event: 'night:host-pick' }, (msg) => {
    const { playerId, targetId } = msg.payload;
    recordHostPick(playerId, targetId);

    // Send result back to the Host role player only
    const targetPlayer = players.find(p => p.id === targetId);
    const isMafia = targetPlayer?.role?.id === 'mafia';
    channel.send({
      type: 'broadcast',
      event: 'night:investigation-result',
      payload: {
        targetPlayerId: playerId, // send to the investigator
        investigatedId: targetId,
        isMafia,
      },
    });
  });
}

/**
 * Resolve the night — determine who gets eliminated.
 * Called by the game host when the night timer expires.
 * @param {Object} channel - Supabase Realtime channel
 * @param {Array} players - Array of { id, name, alive, role }
 * @param {Function} onNightEnd - Called with { eliminatedName }
 */
function resolveNight(channel, players, onNightEnd) {
  if (nightActions.resolved) return;
  nightActions.resolved = true;

  const alivePlayers = players.filter(p => p.alive);
  const aliveNonMafia = alivePlayers.filter(p => p.role.id !== 'mafia');

  let eliminatedId = null;

  // Determine Mafia's target
  const picks = Object.values(nightActions.mafiaPicks);
  if (picks.length > 0) {
    // First Mafia's pick wins (as per game rules for 2-Mafia tie)
    eliminatedId = picks[0];
  } else {
    // Mafia didn't pick — random alive non-Mafia eliminated
    if (aliveNonMafia.length > 0) {
      const randomIndex = Math.floor(Math.random() * aliveNonMafia.length);
      eliminatedId = aliveNonMafia[randomIndex].id;
    }
  }

  let eliminatedName = null;
  if (eliminatedId) {
    const eliminated = players.find(p => p.id === eliminatedId);
    if (eliminated) {
      eliminated.alive = false;
      eliminatedName = eliminated.name;
    }
  }

  // Night eliminations do NOT reveal victim's role
  if (onNightEnd) onNightEnd({ eliminatedName });
}
