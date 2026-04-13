import { GAME } from '../config.js';
import { createTimer } from '../ui/timer.js';

/**
 * Night phase — scaffold (issue #26).
 *
 * Renders one of three role-specific screens for the local player and
 * runs a 30s countdown. Collects the Mafia's target pick and Host's
 * investigation pick into LOCAL state only — nothing is broadcast or
 * applied to game state in this PR. When the timer expires, the caller's
 * onNightEnd is invoked with placeholder `null` values; the tally/kill/
 * investigation mechanics land in issue #27.
 */

/**
 * Show the night phase screen for the local player.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {Object} opts.channel - Supabase Realtime channel (reserved for #27)
 * @param {Array}  opts.players - Array of { id, name, alive, isStub } — alive flag optional
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {Object} opts.currentRole - { id, name, emoji, color } — local player's role
 * @param {Array}  [opts.mafiaPartners] - Partner list for mafia role (names only used)
 * @param {boolean} opts.isHost - Whether this client is the game host
 * @param {Function} opts.onNightEnd - Called with { eliminatedPlayer, investigationResult }
 */
export function showNightPhase({
  app,
  channel, // eslint-disable-line no-unused-vars
  players,
  currentPlayer,
  currentRole,
  mafiaPartners = [],
  isHost, // eslint-disable-line no-unused-vars
  onNightEnd,
}) {
  const roleId = currentRole && currentRole.id;

  // Only alive players can be targeted. Players lacking an explicit
  // `alive` flag (first night) are assumed alive.
  const alivePlayers = players.filter((p) => p.alive !== false);

  // Local-only state — not broadcast in #26.
  let selectedTarget = null;
  let selectedInvestigation = null;
  let ended = false;

  const headerText =
    roleId === 'mafia'
      ? 'Night -- Mafia, choose your target'
      : roleId === 'host'
      ? 'Night -- Investigate one player'
      : 'Night time...';

  const subtitleHTML =
    roleId === 'mafia' && mafiaPartners.length > 0
      ? `<p class="night-subtitle">Your fellow mafia: ${mafiaPartners
          .map((m) => m.name)
          .join(', ')}</p>`
      : roleId === 'mafia'
      ? '<p class="night-subtitle">You are the only mafia.</p>'
      : roleId === 'host'
      ? '<p class="night-subtitle">Pick a player to learn if they are Mafia.</p>'
      : '<p class="night-subtitle">The mafia are choosing a target. Sit tight.</p>';

  // Targetable players: everyone alive except self. Mafia cannot target
  // their own mafia partners — filter those out too.
  const partnerIds = new Set(mafiaPartners.map((p) => p.id));
  const targetablePlayers = alivePlayers.filter((p) => {
    if (p.id === currentPlayer.id) return false;
    if (roleId === 'mafia' && partnerIds.has(p.id)) return false;
    return true;
  });

  const showsButtons = roleId === 'mafia' || roleId === 'host';

  const buttonsHTML = showsButtons
    ? targetablePlayers
        .map(
          (p) =>
            `<button class="btn btn--pink night-btn" data-player-id="${p.id}">${p.name}</button>`
        )
        .join('')
    : '';

  app.innerHTML = `
    <div id="screen-night" class="screen active screen-night screen-night--${roleId || 'guest'}">
      <h1>🌙 ${headerText}</h1>
      ${subtitleHTML}
      <div id="night-timer-container"></div>
      ${showsButtons ? `<div class="night-buttons" id="night-buttons">${buttonsHTML}</div>` : ''}
      <p class="night-status" id="night-status"></p>
    </div>
  `;

  // Timer — each client runs its own local 30s countdown. Host's
  // subsequent phase:day-discuss broadcast is what re-syncs everyone.
  const timer = createTimer(
    GAME.NIGHT_DURATION,
    null,
    () => {
      endNight();
    }
  );
  document.getElementById('night-timer-container').appendChild(timer.el);
  timer.start();

  function updateStatus(text) {
    const el = document.getElementById('night-status');
    if (el) el.textContent = text;
  }

  function endNight() {
    if (ended) return;
    ended = true;
    timer.stop();
    // Placeholders — real values come from #27.
    if (onNightEnd) {
      onNightEnd({
        eliminatedPlayer: null,
        investigationResult: null,
        localPick: selectedTarget,
        localInvestigation: selectedInvestigation,
      });
    }
  }

  // Click handling for Mafia / Host
  if (showsButtons) {
    const container = document.getElementById('night-buttons');
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.night-btn');
      if (!btn || ended) return;

      // Clear previous highlight
      container
        .querySelectorAll('.night-btn--selected')
        .forEach((b) => b.classList.remove('night-btn--selected'));
      btn.classList.add('night-btn--selected');

      const targetId = btn.dataset.playerId;
      const target = targetablePlayers.find((p) => p.id === targetId) || null;

      if (roleId === 'mafia') {
        selectedTarget = target;
        updateStatus(target ? `Target: ${target.name}` : '');
      } else if (roleId === 'host') {
        selectedInvestigation = target;
        updateStatus(target ? `Investigating: ${target.name}` : '');
      }
    });
  }
}
