/**
 * Game-over screen — shows winner banner, role reveal for all players,
 * and Play Again / Leave buttons.
 *
 * Usage:
 *   showGameOver(app, { winner, players, onPlayAgain, onLeave, isHost })
 *
 * winner:     'mafia' | 'guests'
 * players:    Array of { id, name, role: { id, name, emoji, color }, alive }
 *             Ordered by seat (original order preserved within role groups).
 * onPlayAgain: Called only on the host's client when the host taps Play Again.
 *              Non-host clients receive the 'game:return-lobby' broadcast and
 *              the swarm calls this callback for them too.
 * onLeave:    Called on any client when Leave is tapped.
 * isHost:     boolean — controls Play Again button behaviour.
 */

import { playSound } from '../audio.js';
import { haptic, HAPTIC_ELIMINATE } from '../haptic.js';

const ROLE_ORDER = { mafia: 0, host: 1, guest: 2 };

/**
 * Sort players: Mafia first (dramatic reveal), then Host, then Guests.
 * Within each group, preserve original seat order.
 * @param {Array} players
 * @returns {Array}
 */
function sortByRole(players) {
  return [...players].sort((a, b) => {
    const ra = ROLE_ORDER[a.role?.id] ?? 99;
    const rb = ROLE_ORDER[b.role?.id] ?? 99;
    return ra - rb;
  });
}

/**
 * Build the role badge HTML for a single player row.
 */
function roleBadge(role) {
  return `<span class="game-over__role-badge" style="--badge-color: ${role.color}">${role.emoji} ${role.name}</span>`;
}

/**
 * Render the game-over screen into the given container.
 *
 * @param {HTMLElement} container - Root app element (will be replaced)
 * @param {Object} opts
 * @param {'mafia'|'guests'} opts.winner
 * @param {Array} opts.players - Full player list with roles
 * @param {Function} opts.onPlayAgain - Callback when Play Again is confirmed
 * @param {Function} opts.onLeave - Callback when Leave is tapped
 * @param {boolean} opts.isHost - Whether this client is the game host
 */
export function showGameOver(container, { winner, players, onPlayAgain, onLeave, isHost }) {
  const isMafiaWin = winner === 'mafia';
  const bannerText = isMafiaWin ? 'Mafia Win' : 'Guests Win';
  const bannerClass = isMafiaWin ? 'game-over__banner--mafia' : 'game-over__banner--guests';

  const sorted = sortByRole(players);

  const playerRowsHTML = sorted
    .map((p) => {
      const deadMark = p.alive ? '' : '<span class="game-over__dead">✗</span>';
      return `
        <li class="game-over__player-row">
          <span class="game-over__player-name">${p.name}${deadMark}</span>
          ${roleBadge(p.role)}
        </li>`;
    })
    .join('');

  const playAgainSection = isHost
    ? `<button class="btn btn--pink" id="btn-play-again">Play Again</button>`
    : `<p class="waiting-text" id="waiting-play-again">Waiting for host to restart…</p>`;

  container.innerHTML = `
    <div id="screen-game-over" class="screen active">
      <div class="game-over__banner ${bannerClass}">${bannerText}</div>
      <h2 class="game-over__roles-heading">Role Reveal</h2>
      <ul class="game-over__player-list" id="game-over-players">
        ${playerRowsHTML}
      </ul>
      <div class="game-over__actions">
        ${playAgainSection}
        <button class="btn btn--cyan" id="btn-leave-game">Leave</button>
      </div>
    </div>
  `;

  // #57 #58: game-over feedback — fires once on mount, on every client.
  try { playSound('game-over'); } catch (_) {}
  try { haptic(HAPTIC_ELIMINATE); } catch (_) {}

  if (isHost) {
    document.getElementById('btn-play-again').addEventListener('click', () => {
      if (onPlayAgain) onPlayAgain();
    });
  }

  document.getElementById('btn-leave-game').addEventListener('click', () => {
    if (onLeave) onLeave();
  });
}
