import { ROLES } from '../roles.js';
import { playSound } from '../audio.js';
import { haptic, HAPTIC_TAP } from '../haptic.js';

/**
 * Role reveal screen — shows each player their assigned role
 * with a card flip animation. Handles "Ready" acknowledgement.
 */

/**
 * Show the role reveal screen for the current player.
 * @param {HTMLElement} app - Root app element
 * @param {Object} roleData - { role: ROLES.X, mafiaPartners: [] }
 * @param {string} playerName - Current player's display name
 * @param {Function} onReady - Called when the player taps Ready
 */
export function showRoleReveal(app, roleData, playerName, onReady) {
  const { role, mafiaPartners } = roleData;

  let description = '';
  if (role.id === 'mafia') {
    description = 'Eliminate the guests before they find you.';
    if (mafiaPartners.length > 0) {
      const partnerNames = mafiaPartners.map((p) => p.name).join(', ');
      description += ` Your partner: ${partnerNames}`;
    }
  } else if (role.id === 'host') {
    description =
      'You are the party host. Each night, investigate one player to learn if they are Mafia or not.';
  } else {
    description =
      'You are a guest at the party. Survive and vote wisely to eliminate the Mafia.';
  }

  app.innerHTML = `
    <div id="screen-role-reveal" class="screen active">
      <h1>Your Role</h1>
      <div class="role-card" id="role-card" style="--role-color: ${role.color}">
        <div class="role-card__inner" id="role-card-inner">
          <div class="role-card__front">
            <span class="role-card__question">?</span>
          </div>
          <div class="role-card__back">
            <span class="role-card__emoji">${role.emoji}</span>
            <span class="role-card__name">${role.name}</span>
          </div>
        </div>
      </div>
      <p class="role-description" id="role-description" style="opacity: 0;">${description}</p>
      <button class="btn btn--pink" id="btn-ready" style="opacity: 0;" disabled>Ready</button>
      <p class="ready-status" id="ready-status"></p>
    </div>
  `;

  // Trigger card flip after a brief delay so the player sees the card back first
  const cardInner = document.getElementById('role-card-inner');
  const descEl = document.getElementById('role-description');
  const readyBtn = document.getElementById('btn-ready');

  setTimeout(() => {
    cardInner.classList.add('flipped');
    // #57 #58: role-reveal feedback — fires once per game on mount.
    try { playSound('role-reveal'); } catch (_) {}
    try { haptic(HAPTIC_TAP); } catch (_) {}

    // After flip animation, show description and Ready button
    setTimeout(() => {
      descEl.style.opacity = '1';
      readyBtn.style.opacity = '1';
      readyBtn.disabled = false;
    }, 200);
  }, 400);

  readyBtn.addEventListener('click', () => {
    readyBtn.disabled = true;
    readyBtn.textContent = 'Waiting for others...';
    if (onReady) onReady();
  });
}

/**
 * Update the ready status text (e.g. "3/5 ready").
 * @param {number} readyCount
 * @param {number} totalCount
 */
export function updateReadyStatus(readyCount, totalCount) {
  const el = document.getElementById('ready-status');
  if (el) {
    el.textContent = `${readyCount}/${totalCount} ready`;
  }
}
