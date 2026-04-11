import { ROLES } from '../roles.js';

/**
 * Role reveal screen — shows each player their assigned role
 * with a card flip animation. Handles "Ready" acknowledgement.
 *
 * Game over screen — shows winner, full role reveal, and play-again.
 */

/** Role color map by role id */
const ROLE_COLORS = {
  mafia: 'var(--neon-pink)',
  host: 'var(--neon-cyan)',
  guest: 'var(--neon-yellow)',
};

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
 * Show the game over screen.
 * Full-screen overlay with winner announcement, full role reveal,
 * stats, and a Play Again button.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {string} opts.winner - 'mafia' | 'guests'
 * @param {Array} opts.players - Array of { id, name, role, alive }
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {number} opts.rounds - Number of rounds played
 * @param {number} opts.eliminations - Number of eliminations
 * @param {Function} opts.onPlayAgain - Called when Play Again is tapped
 */
export function showGameOver({ app, winner, players, currentPlayer, rounds, eliminations, onPlayAgain }) {
  const isMafiaWin = winner === 'mafia';
  const winnerText = isMafiaWin ? 'Mafia Wins!' : 'Guests Win!';
  const winnerColorClass = isMafiaWin ? 'gameover__title--mafia' : 'gameover__title--guests';

  // Determine if current player was on the winning team
  const me = players.find(p => p.id === currentPlayer.id);
  const myRole = me ? me.role.id : 'guest';
  const iWon = (winner === 'mafia' && myRole === 'mafia') ||
               (winner === 'guests' && myRole !== 'mafia');
  const outcomeText = iWon ? 'You won!' : 'You lost.';

  // Build role reveal list — all players, color-coded by role, dead = dimmed + strikethrough
  const roleListHTML = players.map(p => {
    const color = ROLE_COLORS[p.role.id] || 'var(--text)';
    const deadClass = !p.alive ? 'gameover-player--dead' : '';
    const youBadge = p.id === currentPlayer.id ? ' <span class="gameover-you">(you)</span>' : '';
    return `<li class="gameover-player ${deadClass}">
      <span class="gameover-player__name" style="color: ${color}">${p.role.emoji} ${p.name}${youBadge}</span>
      <span class="gameover-player__role" style="color: ${color}">${p.role.name}</span>
      ${!p.alive ? '<span class="gameover-player__status">eliminated</span>' : ''}
    </li>`;
  }).join('');

  // Spectator banner for eliminated players
  const spectatorBanner = (me && !me.alive)
    ? '<p class="gameover-spectator">You were eliminated</p>'
    : '';

  app.innerHTML = `
    <div id="screen-game-over" class="screen active gameover-overlay">
      <h1 class="gameover__title ${winnerColorClass}">${winnerText}</h1>
      ${spectatorBanner}
      <p class="gameover__outcome">${outcomeText}</p>
      <div class="gameover__stats">
        <span class="gameover__stat">Rounds: ${rounds}</span>
        <span class="gameover__stat">Eliminations: ${eliminations}</span>
      </div>
      <h2 class="gameover__reveal-heading">All Roles</h2>
      <ul class="gameover__role-list">${roleListHTML}</ul>
      <button class="btn btn--pink" id="btn-play-again">Play Again</button>
    </div>
  `;

  document.getElementById('btn-play-again').addEventListener('click', () => {
    if (onPlayAgain) onPlayAgain();
  });
}
