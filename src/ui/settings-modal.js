import { GAME } from '../config.js';
import { ALL_ROLES } from '../roles/index.js';

/**
 * Host-only custom game settings modal (issue #54).
 *
 * Shown when the game host taps the "Settings" button in the lobby.
 * Lets the host tune phase timers, pick a preset, and toggle optional
 * roles on/off (Mafia/Host/Guest are always on and disabled).
 *
 * When the host closes the modal, `onSave(config)` is invoked with the
 * mutated settings object:
 *
 *   {
 *     nightDuration: number,       // seconds
 *     discussionDuration: number,  // seconds
 *     voteDuration: number,        // seconds
 *     preset: 'classic',
 *     disabledRoles: string[],     // role ids the host switched off
 *   }
 *
 * The caller (room.js) writes these into GAME + broadcasts the new
 * config on the shared channel so peers mirror them locally. Actual
 * role-substitution at game-start happens in room.js / game.js via the
 * disabledRoles set applied on top of distributeRoles() output.
 *
 * Styling: inline <style> block in the modal element scoped by class,
 * using the existing --neon-* / --surface / --bg / --text CSS variables.
 * No CSS preprocessor, no new globals leaked into style.css.
 */

const NIGHT_CHOICES = [15, 30, 45, 60];
const DISCUSSION_CHOICES = [30, 60, 90];
const VOTE_CHOICES = [15, 20, 30];

const CORE_ROLE_IDS = new Set(['mafia', 'host', 'guest']);

/**
 * Open the settings modal. Returns a `close()` handle.
 *
 * @param {Object} opts
 * @param {Object} opts.currentConfig - Current settings to render (same shape as onSave arg)
 * @param {number} opts.playerCount - Current lobby size (used to gate special-role checkboxes)
 * @param {Function} opts.onSave - Called with the new config when the host taps Save
 * @param {Function} [opts.onCancel] - Called if the host dismisses without saving
 */
export function openSettingsModal({ currentConfig, playerCount, onSave, onCancel }) {
  // Snapshot: never mutate currentConfig until Save.
  const draft = {
    nightDuration: currentConfig.nightDuration,
    discussionDuration: currentConfig.discussionDuration,
    voteDuration: currentConfig.voteDuration,
    preset: currentConfig.preset || 'classic',
    disabledRoles: new Set(currentConfig.disabledRoles || []),
  };

  const overlay = document.createElement('div');
  overlay.className = 'settings-modal__overlay';

  const radioGroup = (label, name, choices, selected) =>
    `<fieldset class="settings-modal__group">
      <legend>${label}</legend>
      <div class="settings-modal__radios">
        ${choices
          .map(
            (c) => `
          <label class="settings-modal__radio">
            <input type="radio" name="${name}" value="${c}" ${c === selected ? 'checked' : ''} />
            <span>${c}s</span>
          </label>`
          )
          .join('')}
      </div>
    </fieldset>`;

  const roleRows = ALL_ROLES.map((role) => {
    const isCore = CORE_ROLE_IDS.has(role.id);
    const gated = !isCore && role.minPlayers && playerCount < role.minPlayers;
    const checked = !draft.disabledRoles.has(role.id);
    const disabled = isCore || gated;
    const title = gated ? ` (unlocks at ${role.minPlayers} players)` : '';
    return `
      <label class="settings-modal__role ${disabled ? 'is-disabled' : ''}">
        <input type="checkbox" data-role-id="${role.id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span>${role.emoji || ''} ${role.name}${title}</span>
      </label>`;
  }).join('');

  overlay.innerHTML = `
    <style>
      .settings-modal__overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.72);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 2rem 1rem;
        z-index: 1000;
        overflow-y: auto;
      }
      .settings-modal {
        width: 100%;
        max-width: 440px;
        background: var(--surface);
        border: 2px solid var(--neon-cyan);
        border-radius: 12px;
        padding: 1.25rem 1.25rem 1rem;
        color: var(--text);
        text-align: left;
      }
      .settings-modal h2 {
        font-size: 1.375rem;
        font-weight: 900;
        margin-bottom: 0.75rem;
        color: var(--neon-cyan);
      }
      .settings-modal__group {
        border: none;
        margin-bottom: 1rem;
      }
      .settings-modal__group legend {
        font-size: 0.875rem;
        font-weight: 700;
        color: var(--neon-yellow);
        margin-bottom: 0.375rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .settings-modal__radios {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
      }
      .settings-modal__radio {
        flex: 1 1 auto;
        min-width: 64px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0.5rem 0.25rem;
        background: var(--bg);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.875rem;
      }
      .settings-modal__radio input {
        margin-right: 0.375rem;
      }
      .settings-modal__select {
        width: 100%;
        padding: 0.5rem;
        background: var(--bg);
        color: var(--text);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        font-size: 0.9375rem;
      }
      .settings-modal__role {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0;
        font-size: 0.9375rem;
      }
      .settings-modal__role.is-disabled {
        opacity: 0.55;
      }
      .settings-modal__actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
      .settings-modal__actions .btn {
        margin-bottom: 0;
      }
    </style>
    <div class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
      <h2 id="settings-modal-title">Game Settings</h2>

      ${radioGroup('Night duration', 'nightDuration', NIGHT_CHOICES, draft.nightDuration)}
      ${radioGroup('Discussion duration', 'discussionDuration', DISCUSSION_CHOICES, draft.discussionDuration)}
      ${radioGroup('Vote duration', 'voteDuration', VOTE_CHOICES, draft.voteDuration)}

      <fieldset class="settings-modal__group">
        <legend>Preset</legend>
        <select class="settings-modal__select" id="settings-preset">
          <option value="classic" ${draft.preset === 'classic' ? 'selected' : ''}>Classic</option>
        </select>
      </fieldset>

      <fieldset class="settings-modal__group">
        <legend>Enabled roles</legend>
        ${roleRows}
      </fieldset>

      <div class="settings-modal__actions">
        <button class="btn btn--cyan" id="settings-cancel" type="button">Cancel</button>
        <button class="btn btn--pink" id="settings-save" type="button">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // #101: Delegated change listener. Every radio / checkbox / select
  // change inside the overlay immediately propagates into `draft`, so
  // the Save handler just reads what's already there. This is the
  // single source of truth for "what did the host pick?" — no more
  // reading from DOM on save (which was fragile when selectors changed).
  const TIMER_FIELDS = new Set([
    'nightDuration',
    'discussionDuration',
    'voteDuration',
  ]);
  overlay.addEventListener('change', (e) => {
    const el = /** @type {HTMLInputElement | HTMLSelectElement} */ (e.target);
    if (!el) return;
    if (el.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (el).type === 'radio') {
      const name = /** @type {HTMLInputElement} */ (el).name;
      if (TIMER_FIELDS.has(name)) {
        draft[name] = Number(/** @type {HTMLInputElement} */ (el).value);
      }
      return;
    }
    if (
      el.tagName === 'INPUT' &&
      /** @type {HTMLInputElement} */ (el).type === 'checkbox' &&
      /** @type {HTMLInputElement} */ (el).dataset.roleId
    ) {
      const cb = /** @type {HTMLInputElement} */ (el);
      // Core roles render as disabled — their change events should never
      // fire, but if they do we ignore them so they can't be toggled off.
      if (cb.disabled) return;
      const id = cb.dataset.roleId;
      if (cb.checked) {
        draft.disabledRoles.delete(id);
      } else {
        draft.disabledRoles.add(id);
      }
      return;
    }
    if (el.tagName === 'SELECT' && el.id === 'settings-preset') {
      draft.preset = /** @type {HTMLSelectElement} */ (el).value;
    }
  });

  function close() {
    overlay.remove();
  }

  overlay.querySelector('#settings-cancel').addEventListener('click', () => {
    close();
    if (onCancel) onCancel();
  });

  overlay.querySelector('#settings-save').addEventListener('click', () => {
    close();
    if (onSave) {
      onSave({
        nightDuration: draft.nightDuration,
        discussionDuration: draft.discussionDuration,
        voteDuration: draft.voteDuration,
        preset: draft.preset,
        disabledRoles: Array.from(draft.disabledRoles),
      });
    }
  });

  // Dismiss on overlay click (outside the card).
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close();
      if (onCancel) onCancel();
    }
  });

  return { close };
}

/**
 * Default settings derived from GAME constants. Used by room.js as the
 * seed config when the host opens the modal for the first time.
 */
export function defaultRoomConfig() {
  return {
    nightDuration: GAME.NIGHT_DURATION,
    discussionDuration: GAME.DISCUSSION_DURATION,
    voteDuration: GAME.VOTE_DURATION,
    preset: 'classic',
    disabledRoles: [],
  };
}

/**
 * Apply a room config to the local GAME constants so that existing
 * phase code (night.js / day.js / vote.js) picks up the new durations
 * on their next createTimer() call. Called on every client (host and
 * peers) whenever a `lobby:config` broadcast arrives.
 */
export function applyRoomConfig(config) {
  if (!config) return;
  if (Number.isFinite(config.nightDuration)) GAME.NIGHT_DURATION = config.nightDuration;
  if (Number.isFinite(config.discussionDuration)) GAME.DISCUSSION_DURATION = config.discussionDuration;
  if (Number.isFinite(config.voteDuration)) GAME.VOTE_DURATION = config.voteDuration;
}
