import { ROLES } from '../roles.js';

/**
 * Screen components: role reveal, game over overlay, spectator banner.
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

/**
 * Show the game over screen with full role reveal and stats.
 * @param {HTMLElement} app - Root app element
 * @param {Object} opts
 * @param {string} opts.winner - 'mafia' | 'guests'
 * @param {Array} opts.players - Array of { id, name, role, alive }
 * @param {number} opts.roundNumber - How many rounds the game lasted
 * @param {number} opts.eliminatedCount - Total players eliminated
 * @param {boolean} opts.isHost - Whether this client is the game host
 * @param {Function} opts.onPlayAgain - Called when Play Again is pressed
 */
export function showGameOver(app, { winner, players, roundNumber, eliminatedCount, isHost, onPlayAgain }) {
  const isMafiaWin = winner === 'mafia';
  const headerText = isMafiaWin ? 'Mafia Wins!' : 'Guests Win!';
  const headerColor = isMafiaWin ? 'var(--neon-pink)' : 'var(--neon-cyan)';

  const roleColor = (role) => {
    if (role.id === 'mafia') return 'var(--neon-pink)';
    if (role.id === 'host') return 'var(--neon-cyan)';
    return 'var(--neon-yellow)';
  };

  const playerListHTML = players.map(p => {
    const color = roleColor(p.role);
    const deadClass = p.alive ? '' : ' gameover-player--dead';
    const statusText = p.alive ? 'Alive' : 'Eliminated';
    return `<li class="gameover-player${deadClass}">
      <span class="gameover-player__name" style="color: ${color}">${p.role.emoji} ${p.name}</span>
      <span class="gameover-player__role" style="color: ${color}">${p.role.name}</span>
      <span class="gameover-player__status">${statusText}</span>
    </li>`;
  }).join('');

  app.innerHTML = `
    <div id="screen-gameover" class="screen active gameover-screen">
      <h1 class="gameover-header" style="color: ${headerColor}; -webkit-text-fill-color: ${headerColor};">${headerText}</h1>
      <ul class="gameover-players">${playerListHTML}</ul>
      <div class="gameover-stats">
        <p>Game lasted <strong>${roundNumber}</strong> round${roundNumber !== 1 ? 's' : ''}</p>
        <p><strong>${eliminatedCount}</strong> player${eliminatedCount !== 1 ? 's' : ''} eliminated</p>
      </div>
      <button class="btn btn--pink" id="btn-play-again">Play Again</button>
    </div>
  `;

  document.getElementById('btn-play-again').addEventListener('click', () => {
    if (onPlayAgain) onPlayAgain();
  });
}

/**
 * Show a spectator banner for eliminated players.
 * Inserts a fixed banner at the top of the current screen.
 */
export function showSpectatorBanner() {
  // Remove existing banner if any
  const existing = document.getElementById('spectator-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'spectator-banner';
  banner.className = 'spectator-banner';
  banner.textContent = 'You were eliminated — spectating';
  document.body.prepend(banner);
}

/**
 * Remove the spectator banner (e.g. on game over or play again).
 */
export function hideSpectatorBanner() {
  const existing = document.getElementById('spectator-banner');
  if (existing) existing.remove();
}
