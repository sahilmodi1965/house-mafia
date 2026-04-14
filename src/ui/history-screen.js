/**
 * Past Games screen (#51).
 *
 * Renders the local (localStorage-backed) game history as a list of
 * collapsible cards. Tapping a card expands it to show roster, night
 * eliminations, and day eliminations. A "Clear History" button wipes
 * the store after a confirm.
 *
 * Per-device only — a friend who played in the same room will only
 * see the game in their own history if they played to completion on
 * their own client. CLAUDE.md forbids persistent backends so
 * multi-device history is out of scope.
 */

import { loadGameHistory, clearGameHistory } from '../engine/history.js';

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(ms) {
  if (!ms) return '—';
  try {
    const d = new Date(ms);
    return d.toLocaleString();
  } catch (_) {
    return '—';
  }
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt || endedAt < startedAt) return '';
  const totalSec = Math.round((endedAt - startedAt) / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function renderEntry(entry, index) {
  const players = Array.isArray(entry.players) ? entry.players : [];
  const nightElims = Array.isArray(entry.nightEliminations) ? entry.nightEliminations : [];
  const dayElims = Array.isArray(entry.dayEliminations) ? entry.dayEliminations : [];
  const winnerBanner =
    entry.winner === 'mafia'
      ? '<span class="history-winner history-winner--mafia">Mafia win</span>'
      : entry.winner === 'guests'
        ? '<span class="history-winner history-winner--guests">Guests win</span>'
        : '<span class="history-winner">—</span>';
  const dur = formatDuration(entry.startedAt, entry.endedAt);
  const summaryLine = `Room ${escapeHtml(entry.roomCode || '?')} · ${formatDate(entry.endedAt)} · ${players.length} players${dur ? ' · ' + dur : ''}`;

  const rosterRows = players
    .map((p) => {
      const alive = p && p.alive ? '' : ' <span class="history-dead">(eliminated)</span>';
      const stub = p && p.isStub ? ' <span class="history-stub">[stub]</span>' : '';
      const role = p && p.role ? `<em class="history-role">${escapeHtml(p.role)}</em>` : '';
      return `<li>${escapeHtml(p && p.name)} ${role}${stub}${alive}</li>`;
    })
    .join('');

  const nightRows = nightElims.length
    ? nightElims
        .map((n) => `<li>Night ${n.round || '?'}: ${escapeHtml(n.targetName || 'no one')}${n.savedByDoctor ? ' (saved)' : ''}</li>`)
        .join('')
    : '<li class="history-empty">(no night eliminations)</li>';

  const dayRows = dayElims.length
    ? dayElims
        .map((d) => `<li>Day ${d.round || '?'}: ${escapeHtml(d.targetName || 'no one')}${d.voteCount != null ? ` (${d.voteCount} votes)` : ''}</li>`)
        .join('')
    : '<li class="history-empty">(no day eliminations)</li>';

  return `
    <li class="history-entry" data-history-index="${index}">
      <button class="history-entry__toggle" type="button" data-toggle="${index}">
        ${winnerBanner}
        <span class="history-entry__summary">${summaryLine}</span>
      </button>
      <div class="history-entry__body" id="history-body-${index}" hidden>
        <h3>Roster</h3>
        <ul class="history-roster">${rosterRows}</ul>
        <h3>Night eliminations</h3>
        <ul class="history-elims">${nightRows}</ul>
        <h3>Day eliminations</h3>
        <ul class="history-elims">${dayRows}</ul>
      </div>
    </li>
  `;
}

/**
 * Mount the Past Games screen.
 *
 * @param {HTMLElement} app - root app element
 * @param {{ onBack: Function }} opts
 */
export function showHistoryScreen(app, { onBack }) {
  const entries = loadGameHistory();

  app.innerHTML = `
    <style>
      #screen-history {
        padding: 1rem;
        max-width: 36rem;
        margin: 0 auto;
      }
      .history-list {
        list-style: none;
        padding: 0;
        margin: 1rem 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .history-entry {
        border: 1px solid var(--neon-cyan, #00f0ff);
        border-radius: 6px;
        padding: 0.25rem;
        background: rgba(0, 0, 0, 0.3);
      }
      .history-entry__toggle {
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        color: #fff;
        padding: 0.5rem 0.75rem;
        cursor: pointer;
        font: inherit;
        display: flex;
        gap: 0.5rem;
        align-items: center;
        min-height: 44px;
      }
      .history-entry__summary {
        flex: 1;
        font-size: 0.85rem;
        color: var(--neon-cyan, #00f0ff);
      }
      .history-winner {
        font-weight: 700;
        padding: 0.2rem 0.4rem;
        border-radius: 3px;
        font-size: 0.75rem;
        text-transform: uppercase;
      }
      .history-winner--mafia { color: var(--neon-pink, #ff00aa); border: 1px solid var(--neon-pink, #ff00aa); }
      .history-winner--guests { color: var(--neon-yellow, #ffdd00); border: 1px solid var(--neon-yellow, #ffdd00); }
      .history-entry__body {
        padding: 0.5rem 0.75rem 0.75rem;
        font-size: 0.82rem;
        color: #eee;
      }
      .history-entry__body h3 {
        margin: 0.5rem 0 0.25rem;
        font-size: 0.75rem;
        text-transform: uppercase;
        color: var(--neon-yellow, #ffdd00);
      }
      .history-roster, .history-elims {
        list-style: none;
        padding-left: 0.5rem;
        margin: 0;
      }
      .history-roster li, .history-elims li {
        padding: 0.15rem 0;
      }
      .history-role {
        color: var(--neon-cyan, #00f0ff);
        font-style: normal;
        font-size: 0.75rem;
      }
      .history-dead {
        color: #888;
        font-size: 0.75rem;
      }
      .history-stub {
        color: var(--neon-yellow, #ffdd00);
        font-size: 0.7rem;
      }
      .history-empty {
        color: #888;
        font-style: italic;
      }
      .history-empty-state {
        text-align: center;
        color: #888;
        padding: 2rem 1rem;
      }
    </style>
    <div id="screen-history" class="screen active">
      <h1>Past Games</h1>
      ${
        entries.length
          ? `<ul class="history-list" id="history-list">${entries.map((e, i) => renderEntry(e, i)).join('')}</ul>`
          : '<p class="history-empty-state">No past games yet. Play a game to start building history.</p>'
      }
      ${entries.length ? '<button class="btn btn--pink" id="btn-clear-history">Clear History</button>' : ''}
      <button class="btn btn--cyan" id="btn-history-back">Back</button>
    </div>
  `;

  // Expand / collapse toggle
  const listEl = document.getElementById('history-list');
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle]');
      if (!btn) return;
      const idx = btn.getAttribute('data-toggle');
      const body = document.getElementById(`history-body-${idx}`);
      if (!body) return;
      body.hidden = !body.hidden;
    });
  }

  // Clear history button
  const clearBtn = document.getElementById('btn-clear-history');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const ok = window.confirm('Wipe all past game history? This cannot be undone.');
      if (!ok) return;
      clearGameHistory();
      showHistoryScreen(app, { onBack });
    });
  }

  const backBtn = document.getElementById('btn-history-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (onBack) onBack();
    });
  }
}
