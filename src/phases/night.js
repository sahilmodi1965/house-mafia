import { GAME } from '../config.js';
import { createTimer } from '../ui/timer.js';

/**
 * Night phase — mafia kill + host investigate (issues #26 + #27).
 *
 * Renders one of three role-specific screens for the local player and
 * runs a 30s countdown. Target picks are reported immediately to the
 * caller via onTargetSelected / onInvestigateSelected so game.js can
 * broadcast them on the appropriate (private) channel. Investigation
 * results arrive asynchronously from the game host on the investigator's
 * private channel — game.js feeds them back to this screen via the
 * returned `showInvestigationResult` handle.
 */

/**
 * Show the night phase screen for the local player.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {Object} opts.channel - Shared Supabase Realtime channel (reserved)
 * @param {Array}  opts.players - Array of { id, name, alive, isStub } — alive flag optional
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {Object} opts.currentRole - { id, name, emoji, color } — local player's role
 * @param {Array}  [opts.mafiaPartners] - Partner list for mafia role (names only used)
 * @param {boolean} opts.isHost - Whether this client is the game host
 * @param {Function} [opts.onTargetSelected] - Called with target player when Mafia picks
 * @param {Function} [opts.onInvestigateSelected] - Called with target player when Host picks
 * @param {Function} opts.onNightEnd - Called with { localPick, localInvestigation, investigationResult }
 * @returns {{ showInvestigationResult: (result: 'mafia'|'not-mafia', targetName: string) => void }}
 */
export function showNightPhase({
  app,
  channel, // eslint-disable-line no-unused-vars
  players,
  currentPlayer,
  currentRole,
  mafiaPartners = [],
  isHost, // eslint-disable-line no-unused-vars
  onTargetSelected,
  onInvestigateSelected,
  onNightActionSelected,
  onNightEnd,
}) {
  const roleId = currentRole && currentRole.id;
  const nightActionKind = currentRole && currentRole.nightActionKind;

  // Only alive players can be targeted. Players lacking an explicit
  // `alive` flag (first night) are assumed alive.
  const alivePlayers = players.filter((p) => p.alive !== false);

  // Local pick state. Picks are reported upward via onTargetSelected /
  // onInvestigateSelected as soon as they happen so game.js can route
  // them on the appropriate private channel. Investigation results come
  // back asynchronously and are displayed via showInvestigationResult.
  let selectedTarget = null;
  let selectedInvestigation = null;
  let investigationResult = null; // 'mafia' | 'not-mafia'
  let investigationResultShownAt = 0; // ms timestamp, 0 = not yet shown
  let ended = false;
  // Issue #95: the Host role's investigate result can arrive within the
  // final second of the Night timer. Without a grace window, endNight()
  // fires immediately and the Host never sees the "X is Mafia" text
  // before the day-discuss screen replaces it. We hold the local
  // transition for up to HOST_INVESTIGATE_GRACE_MS after the result
  // is first painted. The Mafia kill broadcast from the game host is
  // unaffected — it runs on the game host's authoritative timer, and
  // this grace is local-only to the investigator's client.
  const HOST_INVESTIGATE_GRACE_MS = 3000;
  let graceTimeout = null;

  // Per-role copy table. Keeps the header/subtitle/button prompts
  // centralized and readable rather than stacking ternaries.
  const ROLE_COPY = {
    mafia: {
      header: 'Night -- Mafia, choose your target',
      subtitle: mafiaPartners.length > 0
        ? `Your fellow mafia: ${mafiaPartners.map((m) => m.name).join(', ')}`
        : 'You are the only mafia.',
    },
    host: {
      header: 'Night -- Investigate one player',
      subtitle: 'Pick a player to learn if they are Mafia.',
    },
    detective: {
      header: 'Night -- Detective, pick a suspect',
      subtitle: 'Your result is INVERTED: "Mafia" means safe, "Not Mafia" means danger.',
    },
    doctor: {
      header: 'Night -- Doctor, pick who to save',
      subtitle: 'If Mafia target them, the kill is blocked. No back-to-back same save.',
    },
    bodyguard: {
      header: 'Night -- Bodyguard, pick who to protect',
      subtitle: 'If Mafia target them, you die instead. One-shot.',
    },
  };
  const copy = ROLE_COPY[roleId] || {
    header: 'Night time...',
    subtitle: 'The mafia are choosing a target. Sit tight.',
  };
  const headerText = copy.header;
  const subtitleHTML = `<p class="night-subtitle">${copy.subtitle}</p>`;

  // Targetable players: everyone alive except self. Mafia cannot target
  // their own mafia partners — filter those out too.
  const partnerIds = new Set(mafiaPartners.map((p) => p.id));
  const targetablePlayers = alivePlayers.filter((p) => {
    if (p.id === currentPlayer.id) return false;
    if (roleId === 'mafia' && partnerIds.has(p.id)) return false;
    return true;
  });

  // Any role with a nightActionKind gets a button list.
  const showsButtons = !!nightActionKind;

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
  //
  // Issue #95: for the Host role specifically, when the timer fires
  // and we have an investigation result that was shown <3s ago, we
  // delay endNight() by the remaining grace so the investigator can
  // actually read the result. Other roles call endNight() immediately.
  const timer = createTimer(
    GAME.NIGHT_DURATION,
    null,
    () => {
      if (
        (nightActionKind === 'investigate' || nightActionKind === 'investigate-inverted') &&
        investigationResultShownAt > 0
      ) {
        const elapsed = Date.now() - investigationResultShownAt;
        const remaining = HOST_INVESTIGATE_GRACE_MS - elapsed;
        if (remaining > 0) {
          graceTimeout = setTimeout(() => endNight(), remaining);
          return;
        }
      }
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
    if (graceTimeout) {
      clearTimeout(graceTimeout);
      graceTimeout = null;
    }
    if (onNightEnd) {
      onNightEnd({
        localPick: selectedTarget,
        localInvestigation: selectedInvestigation,
        investigationResult,
      });
    }
  }

  // Click handling dispatched by nightActionKind. Mafia / Host keep
  // their dedicated callbacks for backwards compatibility with the
  // existing game.js routing; detective/doctor/bodyguard use the
  // generic onNightActionSelected hook.
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
      if (!target) return;

      switch (nightActionKind) {
        case 'mafia-kill':
          selectedTarget = target;
          updateStatus(`Target: ${target.name}`);
          if (onTargetSelected) onTargetSelected(target);
          break;
        case 'investigate':
          selectedInvestigation = target;
          updateStatus(`Investigating: ${target.name}...`);
          if (onInvestigateSelected) onInvestigateSelected(target);
          break;
        case 'investigate-inverted':
          selectedInvestigation = target;
          updateStatus(`Investigating: ${target.name}...`);
          if (onNightActionSelected) {
            onNightActionSelected({ kind: nightActionKind, target });
          }
          break;
        case 'save':
          selectedTarget = target;
          updateStatus(`Saving: ${target.name}`);
          if (onNightActionSelected) {
            onNightActionSelected({ kind: nightActionKind, target });
          }
          break;
        case 'protect':
          selectedTarget = target;
          updateStatus(`Protecting: ${target.name}`);
          if (onNightActionSelected) {
            onNightActionSelected({ kind: nightActionKind, target });
          }
          break;
        default:
          break;
      }
    });
  }

  /**
   * Called by game.js when the Host's investigation result arrives on
   * the investigator's private channel. Displays it in the status line
   * so the Host sees it before Night ends, and stashes it so it can be
   * threaded through onNightEnd too.
   */
  function showInvestigationResult(result, targetName) {
    if (ended) return;
    if (nightActionKind !== 'investigate' && nightActionKind !== 'investigate-inverted') {
      return;
    }
    investigationResult = result;
    investigationResultShownAt = Date.now();
    const label = result === 'mafia' ? 'Mafia' : 'Not Mafia';
    updateStatus(`${targetName} is ${label}.`);
  }

  /**
   * Issue #95: game.js reads this when it receives phase:day-discuss
   * on a non-host Host-role client so the day transition can be held
   * for the same 3s grace window night.js uses for its own timer.
   */
  function getInvestigationShownAt() {
    return investigationResultShownAt;
  }

  return {
    showInvestigationResult,
    getInvestigationShownAt,
    HOST_INVESTIGATE_GRACE_MS,
  };
}
