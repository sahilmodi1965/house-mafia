import { GAME } from '../config.js';
import { createTimer } from '../ui/timer.js';

/**
 * Night phase.
 * Three role-specific views:
 * - Mafia: pick a target to eliminate
 * - Host (party host role): investigate a player
 * - Guest: waiting screen with timer
 *
 * All night actions are SECRET — sent only to the game host client
 * via targeted broadcast. Duration: GAME.NIGHT_DURATION (30s).
 */

/**
 * Show the night phase screen.
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {Object} opts.channel - Supabase Realtime channel
 * @param {Array} opts.players - Array of { id, name, alive, role }
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {Object} opts.roleData - { role, mafiaPartners }
 * @param {boolean} opts.isHost - Whether this client is the game host (room creator)
 * @param {string} opts.gameHostPlayerId - The game host's player id (for targeted messages)
 * @param {Function} opts.onNightEnd - Called with { eliminatedPlayer, investigationResult }
 */
export function showNight({ app, channel, players, currentPlayer, roleData, isHost, gameHostPlayerId, onNightEnd }) {
  const myRole = roleData.role.id;
  const alivePlayers = players.filter(p => p.alive);

  // Night action state (host tracks all actions)
  const nightActions = {
    mafiaPick: null,       // playerId picked by mafia
    mafiaConfirmed: false,
    hostPick: null,        // playerId investigated by party-host role
    hostConfirmed: false,
  };

  let hasConfirmed = false;
  let selectedTargetId = null;

  if (myRole === 'mafia') {
    renderMafiaView();
  } else if (myRole === 'host') {
    renderHostRoleView();
  } else {
    renderGuestView();
  }

  // --- Timer setup (shared across all views) ---
  const timerContainer = document.getElementById('night-timer-container');
  const timer = createTimer(GAME.NIGHT_DURATION, null, null);
  if (timerContainer) timerContainer.appendChild(timer.el);

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
      resolveNight();
    });
    hostTimer.start();

    // Listen for night actions from other players (sent to game host)
    channel.on('broadcast', { event: 'night:mafia-pick' }, (msg) => {
      if (!nightActions.mafiaConfirmed) {
        nightActions.mafiaPick = msg.payload.targetId;
        nightActions.mafiaConfirmed = true;
        // Broadcast to other mafia so they see the pick
        channel.send({
          type: 'broadcast',
          event: 'night:mafia-pick-update',
          payload: { targetId: msg.payload.targetId, pickerName: msg.payload.pickerName },
        });
        checkAllActionsIn(hostTimer);
      }
    });

    channel.on('broadcast', { event: 'night:host-pick' }, (msg) => {
      if (!nightActions.hostConfirmed) {
        nightActions.hostPick = msg.payload.targetId;
        nightActions.hostConfirmed = true;
        // Send investigation result back privately
        const investigatedPlayer = players.find(p => p.id === msg.payload.targetId);
        const isMafia = investigatedPlayer?.role?.id === 'mafia';
        channel.send({
          type: 'broadcast',
          event: 'night:investigation-result',
          payload: {
            targetPlayerId: msg.payload.pickerId,
            investigatedName: investigatedPlayer?.name || 'Unknown',
            isMafia,
          },
        });
        checkAllActionsIn(hostTimer);
      }
    });

    // If the game host is also mafia or party-host role, handle locally
    // (broadcast doesn't echo back to sender)
  } else {
    // Non-host: listen for timer ticks
    channel.on('broadcast', { event: 'phase:tick' }, (msg) => {
      if (msg.payload.phase === 'night') {
        timer.sync(msg.payload.remaining);
      }
    });
  }

  // Listen for night resolution (all clients)
  channel.on('broadcast', { event: 'phase:night-result' }, (msg) => {
    const { eliminatedPlayerId, eliminatedPlayerName } = msg.payload;
    let eliminatedPlayer = null;
    if (eliminatedPlayerId) {
      eliminatedPlayer = players.find(p => p.id === eliminatedPlayerId) || {
        id: eliminatedPlayerId,
        name: eliminatedPlayerName,
      };
    }
    if (onNightEnd) onNightEnd({ eliminatedPlayer });
  });

  /**
   * Check if all active night roles have confirmed their actions.
   * If so, resolve early (stop the timer).
   */
  function checkAllActionsIn(hostTimer) {
    const mafiaPlayers = alivePlayers.filter(p => p.role.id === 'mafia');
    const hostRolePlayers = alivePlayers.filter(p => p.role.id === 'host');

    const mafiaReady = mafiaPlayers.length === 0 || nightActions.mafiaConfirmed;
    const hostRoleReady = hostRolePlayers.length === 0 || nightActions.hostConfirmed;

    if (mafiaReady && hostRoleReady) {
      hostTimer.stop();
      timer.sync(0);
      resolveNight();
    }
  }

  /**
   * Resolve the night phase (host only).
   * - If mafia didn't pick, random alive non-mafia is eliminated.
   * - If party-host didn't pick, no investigation.
   * - Mark eliminated player dead.
   * - Broadcast result.
   */
  function resolveNight() {
    if (!isHost) return;

    // Determine elimination target
    let eliminatedPlayerId = nightActions.mafiaPick;

    if (!eliminatedPlayerId) {
      // Mafia didn't pick — random alive non-mafia eliminated
      const nonMafia = alivePlayers.filter(p => p.role.id !== 'mafia');
      if (nonMafia.length > 0) {
        const randomIndex = Math.floor(Math.random() * nonMafia.length);
        eliminatedPlayerId = nonMafia[randomIndex].id;
      }
    }

    // Mark eliminated player as dead
    let eliminatedPlayerName = null;
    if (eliminatedPlayerId) {
      const target = players.find(p => p.id === eliminatedPlayerId);
      if (target) {
        target.alive = false;
        eliminatedPlayerName = target.name;
      }
    }

    // Broadcast night result to all players
    channel.send({
      type: 'broadcast',
      event: 'phase:night-result',
      payload: {
        eliminatedPlayerId,
        eliminatedPlayerName,
      },
    });

    // Also handle locally on host (broadcast doesn't echo)
    let eliminatedPlayer = null;
    if (eliminatedPlayerId) {
      eliminatedPlayer = players.find(p => p.id === eliminatedPlayerId) || {
        id: eliminatedPlayerId,
        name: eliminatedPlayerName,
      };
    }
    if (onNightEnd) onNightEnd({ eliminatedPlayer });
  }

  // --- Mafia view ---
  function renderMafiaView() {
    const targets = alivePlayers.filter(p => p.role.id !== 'mafia');
    const targetButtonsHTML = targets.map(p =>
      `<button class="btn btn--pink night-target-btn" data-player-id="${p.id}">${p.name}</button>`
    ).join('');

    app.innerHTML = `
      <div id="screen-night" class="screen active night-screen">
        <h1 class="night-header">Night — Choose your target</h1>
        <div id="night-timer-container"></div>
        <div class="night-targets" id="night-targets">${targetButtonsHTML}</div>
        <button class="btn btn--pink night-confirm" id="night-confirm" disabled>Confirm</button>
        <p class="night-status" id="night-status"></p>
        <p class="night-partner-pick" id="night-partner-pick"></p>
      </div>
    `;

    const confirmBtn = document.getElementById('night-confirm');
    const statusEl = document.getElementById('night-status');
    const targetsContainer = document.getElementById('night-targets');

    // Select target on tap
    targetsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.night-target-btn');
      if (!btn || hasConfirmed) return;

      // Deselect all, select this one
      document.querySelectorAll('.night-target-btn').forEach(b => b.classList.remove('night-target-btn--selected'));
      btn.classList.add('night-target-btn--selected');
      selectedTargetId = btn.dataset.playerId;
      confirmBtn.disabled = false;
    });

    // Confirm pick
    confirmBtn.addEventListener('click', () => {
      if (!selectedTargetId || hasConfirmed) return;
      hasConfirmed = true;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Locked in';
      document.querySelectorAll('.night-target-btn').forEach(b => {
        b.disabled = true;
        b.classList.add('night-target-btn--disabled');
      });
      if (statusEl) statusEl.textContent = 'Your pick has been sent.';

      // If this player IS the game host, handle locally
      if (isHost) {
        if (!nightActions.mafiaConfirmed) {
          nightActions.mafiaPick = selectedTargetId;
          nightActions.mafiaConfirmed = true;
          // Broadcast update to other mafia
          channel.send({
            type: 'broadcast',
            event: 'night:mafia-pick-update',
            payload: { targetId: selectedTargetId, pickerName: currentPlayer.name },
          });
          // Check if all roles done (need reference to hostTimer — use timer container as signal)
          const mafiaPlayers = alivePlayers.filter(p => p.role.id === 'mafia');
          const hostRolePlayers = alivePlayers.filter(p => p.role.id === 'host');
          const mafiaReady = nightActions.mafiaConfirmed;
          const hostRoleReady = hostRolePlayers.length === 0 || nightActions.hostConfirmed;
          if (mafiaReady && hostRoleReady) {
            resolveNight();
          }
        }
      } else {
        // Send pick to game host only
        channel.send({
          type: 'broadcast',
          event: 'night:mafia-pick',
          payload: { targetId: selectedTargetId, pickerName: currentPlayer.name },
        });
      }
    });

    // Listen for other mafia's pick (2-mafia scenario)
    channel.on('broadcast', { event: 'night:mafia-pick-update' }, (msg) => {
      const partnerPickEl = document.getElementById('night-partner-pick');
      if (partnerPickEl && msg.payload.pickerName !== currentPlayer.name) {
        const targetName = targets.find(p => p.id === msg.payload.targetId)?.name || 'someone';
        partnerPickEl.textContent = `${msg.payload.pickerName} picked ${targetName}`;
      }
      // If we haven't confirmed yet and another mafia locked in first, our pick is moot
      if (!hasConfirmed) {
        hasConfirmed = true;
        if (confirmBtn) {
          confirmBtn.disabled = true;
          confirmBtn.textContent = 'Partner locked in';
        }
        document.querySelectorAll('.night-target-btn').forEach(b => {
          b.disabled = true;
          b.classList.add('night-target-btn--disabled');
        });
        if (statusEl) statusEl.textContent = 'Your partner confirmed first.';
      }
    });
  }

  // --- Host role (party host / investigator) view ---
  function renderHostRoleView() {
    const targets = alivePlayers.filter(p => p.id !== currentPlayer.id);
    const targetButtonsHTML = targets.map(p =>
      `<button class="btn btn--cyan night-target-btn" data-player-id="${p.id}">${p.name}</button>`
    ).join('');

    app.innerHTML = `
      <div id="screen-night" class="screen active night-screen">
        <h1 class="night-header">Night — Investigate a player</h1>
        <div id="night-timer-container"></div>
        <div class="night-targets" id="night-targets">${targetButtonsHTML}</div>
        <button class="btn btn--cyan night-confirm" id="night-confirm" disabled>Confirm</button>
        <p class="night-status" id="night-status"></p>
        <div class="night-investigation-result" id="night-investigation-result"></div>
      </div>
    `;

    const confirmBtn = document.getElementById('night-confirm');
    const statusEl = document.getElementById('night-status');
    const targetsContainer = document.getElementById('night-targets');
    const resultEl = document.getElementById('night-investigation-result');

    // Select target
    targetsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.night-target-btn');
      if (!btn || hasConfirmed) return;

      document.querySelectorAll('.night-target-btn').forEach(b => b.classList.remove('night-target-btn--selected'));
      btn.classList.add('night-target-btn--selected');
      selectedTargetId = btn.dataset.playerId;
      confirmBtn.disabled = false;
    });

    // Confirm investigation
    confirmBtn.addEventListener('click', () => {
      if (!selectedTargetId || hasConfirmed) return;
      hasConfirmed = true;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Investigating...';
      document.querySelectorAll('.night-target-btn').forEach(b => {
        b.disabled = true;
        b.classList.add('night-target-btn--disabled');
      });

      if (isHost) {
        // Game host is also the party-host role — resolve locally
        if (!nightActions.hostConfirmed) {
          nightActions.hostPick = selectedTargetId;
          nightActions.hostConfirmed = true;
          const investigatedPlayer = players.find(p => p.id === selectedTargetId);
          const isMafia = investigatedPlayer?.role?.id === 'mafia';
          showInvestigationResult(resultEl, investigatedPlayer?.name || 'Unknown', isMafia);
          // Check all done
          const mafiaPlayers = alivePlayers.filter(p => p.role.id === 'mafia');
          const hostRolePlayers = alivePlayers.filter(p => p.role.id === 'host');
          const mafiaReady = mafiaPlayers.length === 0 || nightActions.mafiaConfirmed;
          if (mafiaReady && nightActions.hostConfirmed) {
            resolveNight();
          }
        }
      } else {
        // Send pick to game host
        channel.send({
          type: 'broadcast',
          event: 'night:host-pick',
          payload: { targetId: selectedTargetId, pickerId: currentPlayer.id },
        });
      }
    });

    // Listen for investigation result (non-host party-host role)
    if (!isHost) {
      channel.on('broadcast', { event: 'night:investigation-result' }, (msg) => {
        if (msg.payload.targetPlayerId !== currentPlayer.id) return;
        showInvestigationResult(resultEl, msg.payload.investigatedName, msg.payload.isMafia);
      });
    }
  }

  /**
   * Display investigation result privately to the party-host role.
   */
  function showInvestigationResult(container, playerName, isMafia) {
    if (!container) return;
    if (isMafia) {
      container.innerHTML = `<p class="night-result night-result--mafia">🔪 <strong>${playerName}</strong> is <strong>Mafia</strong></p>`;
    } else {
      container.innerHTML = `<p class="night-result night-result--safe">✅ <strong>${playerName}</strong> is <strong>Not Mafia</strong></p>`;
    }
    const confirmBtn = document.getElementById('night-confirm');
    if (confirmBtn) confirmBtn.textContent = 'Done';
  }

  // --- Guest view ---
  function renderGuestView() {
    app.innerHTML = `
      <div id="screen-night" class="screen active night-screen night-screen--guest">
        <h1 class="night-header">Night — Sleep tight...</h1>
        <div id="night-timer-container"></div>
        <div class="night-ambience">
          <span class="night-moon">🌙</span>
          <div class="night-stars">
            <span class="night-star" style="top:15%;left:20%">✦</span>
            <span class="night-star" style="top:25%;left:70%">✦</span>
            <span class="night-star" style="top:10%;left:45%">✧</span>
            <span class="night-star" style="top:35%;left:85%">✦</span>
            <span class="night-star" style="top:5%;left:60%">✧</span>
          </div>
        </div>
        <p class="night-guest-text">The party has gone quiet...</p>
      </div>
    `;
  }
}
