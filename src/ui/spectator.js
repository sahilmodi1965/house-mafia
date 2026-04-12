/**
 * Spectator screen — shown to players who join after the game has started.
 * Read-only: no role, no actions. Sees public phase state only.
 */

/**
 * Show the spectator waiting screen.
 * The spectator stays subscribed to the channel so they receive public
 * broadcasts (e.g. game:over). When the game ends they see the outcome.
 *
 * @param {HTMLElement} app - Root app element
 * @param {Object} opts
 * @param {string} opts.roomCode - 4-letter room code
 * @param {Object} opts.channel - Supabase Realtime channel (already subscribed)
 * @param {Function} opts.onLeave - Called when the player leaves
 */
export function showSpectator(app, { roomCode, channel, onLeave }) {
  app.innerHTML = `
    <div id="screen-spectator" class="screen active">
      <h1>Watching</h1>
      <p class="room-code-display">Room <span id="spectator-code">${roomCode}</span></p>
      <p class="waiting-text" id="spectator-status">Game in progress. No role reveal.</p>
      <p class="role-description" id="spectator-info">
        You joined after the game started. Sit back and watch — you'll see the outcome when the game ends.
      </p>
      <button class="btn btn--cyan" id="btn-spectator-leave">Leave</button>
    </div>
  `;

  document.getElementById('btn-spectator-leave').addEventListener('click', () => {
    if (onLeave) onLeave();
  });

  // Listen for game-over broadcast so spectators see the final result
  if (channel) {
    channel.on('broadcast', { event: 'game:over' }, (msg) => {
      const statusEl = document.getElementById('spectator-status');
      const infoEl = document.getElementById('spectator-info');
      if (!statusEl || !infoEl) return;

      const winner = msg.payload && msg.payload.winner;
      if (winner === 'mafia') {
        statusEl.textContent = 'Game over — Mafia wins!';
      } else if (winner === 'guests') {
        statusEl.textContent = 'Game over — Guests win!';
      } else {
        statusEl.textContent = 'Game over!';
      }
      infoEl.textContent = 'The game has ended. Thanks for watching!';
    });
  }
}
