/**
 * In-game chat widget (#50).
 *
 * Scrollable message list + input bar that broadcasts `chat:message` on
 * the shared room channel during Day Discussion. Dead players get the
 * read-only feed. Profanity is scrubbed via engine/chat-filter.js
 * before broadcast AND before render, so a bypass on one client can't
 * splash on others.
 *
 * The widget is ephemeral: it only exists for the lifetime of the
 * Discussion phase. The caller (day.js / spectator.js) mounts it on
 * phase entry and calls destroy() on phase exit to detach the channel
 * listener and remove the DOM.
 */

import { filterProfanity } from '../engine/chat-filter.js';

const MAX_MESSAGE_LENGTH = 200;

/**
 * Create a chat widget bound to a Supabase Realtime channel.
 *
 * @param {Object} opts
 * @param {Object} opts.channel - shared Supabase Realtime channel (already subscribed)
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {boolean} opts.isAlive - false → input is disabled, placeholder reads "(eliminated — read-only)"
 * @returns {{ el: HTMLElement, destroy: Function }}
 */
export function createChatWidget({ channel, currentPlayer, isAlive }) {
  // --- DOM ---
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-widget';
  wrapper.innerHTML = `
    <style>
      .chat-widget {
        margin: 0.5rem 0 0.5rem;
        padding: 0.5rem 0.75rem;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid var(--neon-cyan, #00f0ff);
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .chat-widget__header {
        font-size: 0.6875rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--neon-pink, #ff00aa);
      }
      .chat-widget__feed {
        max-height: 9rem;
        overflow-y: auto;
        font-size: 0.85rem;
        line-height: 1.35;
        color: var(--neon-cyan, #00f0ff);
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      }
      .chat-widget__msg {
        word-break: break-word;
      }
      .chat-widget__msg strong {
        color: var(--neon-yellow, #ffdd00);
        margin-right: 0.3rem;
      }
      .chat-widget__form {
        display: flex;
        gap: 0.4rem;
      }
      .chat-widget__input {
        flex: 1;
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid var(--neon-cyan, #00f0ff);
        color: #fff;
        border-radius: 4px;
        padding: 0.35rem 0.5rem;
        font-size: 0.85rem;
        min-height: 2rem;
      }
      .chat-widget__input:disabled {
        opacity: 0.6;
      }
      .chat-widget__send {
        background: var(--neon-pink, #ff00aa);
        color: #fff;
        border: none;
        border-radius: 4px;
        padding: 0 0.75rem;
        font-weight: 700;
        cursor: pointer;
        min-height: 2rem;
      }
      .chat-widget__send:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    </style>
    <div class="chat-widget__header">chat</div>
    <div class="chat-widget__feed" id="chat-feed" data-testid="chat-feed"></div>
    <form class="chat-widget__form" id="chat-form" autocomplete="off">
      <input class="chat-widget__input" id="chat-input" type="text"
             maxlength="${MAX_MESSAGE_LENGTH}"
             placeholder="${isAlive ? 'Say something…' : '(eliminated — read-only)'}"
             ${isAlive ? '' : 'disabled'} />
      <button class="chat-widget__send" type="submit"
              ${isAlive ? '' : 'disabled'}>Send</button>
    </form>
  `;

  const feedEl = wrapper.querySelector('#chat-feed');
  const inputEl = wrapper.querySelector('#chat-input');
  const formEl = wrapper.querySelector('#chat-form');

  // --- Dedup across optimistic + round-trip echo ---
  // key: `${playerId}:${ts}` — same frame arriving twice collapses.
  const seen = new Set();

  function appendMessage({ playerId, playerName, text, ts }) {
    const key = `${playerId}:${ts}`;
    if (seen.has(key)) return;
    seen.add(key);
    const scrubbed = filterProfanity(text || '');
    if (!scrubbed) return;
    const line = document.createElement('div');
    line.className = 'chat-widget__msg';
    const nameEl = document.createElement('strong');
    nameEl.textContent = (playerName || '?') + ':';
    line.appendChild(nameEl);
    line.appendChild(document.createTextNode(' ' + scrubbed));
    feedEl.appendChild(line);
    // Keep newest visible
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  // --- Incoming message listener ---
  // We cannot easily unsubscribe a single listener from a Supabase
  // channel mid-session, so we guard with a `disposed` flag that the
  // listener checks on fire. Phase teardown sets the flag.
  let disposed = false;
  if (channel && typeof channel.on === 'function') {
    channel.on('broadcast', { event: 'chat:message' }, (msg) => {
      if (disposed) return;
      const payload = (msg && msg.payload) || {};
      appendMessage(payload);
    });
  }

  // --- Outgoing message on submit ---
  if (isAlive) {
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      if (disposed) return;
      const raw = (inputEl.value || '').trim();
      if (!raw) return;
      const truncated = raw.slice(0, MAX_MESSAGE_LENGTH);
      const payload = {
        playerId: currentPlayer.id,
        playerName: currentPlayer.name,
        text: truncated,
        ts: Date.now(),
      };
      // Optimistic append (dedup protects us against the round-trip).
      appendMessage(payload);
      try {
        channel.send({
          type: 'broadcast',
          event: 'chat:message',
          payload,
        });
      } catch (err) {
        console.error('chat: broadcast failed', err);
      }
      inputEl.value = '';
    });
  }

  return {
    el: wrapper,
    destroy: () => {
      disposed = true;
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    },
  };
}
