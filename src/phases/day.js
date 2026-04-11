import { GAME } from '../config.js';
import { createTimer } from '../ui/timer.js';
import { playSound, haptic } from '../audio.js';
import { transitionTo } from '../ui/screens.js';

/**
 * Day discussion phase.
 * Shows alive players, night elimination announcement, 40-second countdown,
 * and text chat via Supabase broadcast.
 * Auto-transitions to voting when timer hits 0.
 */

/**
 * Show the day discussion screen.
 * @param {Object} opts
 * @param {HTMLElement} opts.app - Root app element
 * @param {Object} opts.channel - Supabase Realtime channel
 * @param {Array} opts.players - Array of { id, name, alive, role }
 * @param {Object} opts.currentPlayer - { id, name }
 * @param {boolean} opts.isHost - Whether this client is the game host
 * @param {string|null} opts.eliminatedName - Name of player eliminated during night (null if none)
 * @param {Function} opts.onDiscussionEnd - Called when discussion timer ends
 */
export function showDayDiscussion({ app, channel, players, currentPlayer, isHost, eliminatedName, onDiscussionEnd }) {
  const isAlive = players.find(p => p.id === currentPlayer.id)?.alive !== false;

  // Build player list HTML
  const playerListHTML = players.map(p => {
    const classes = ['day-player-item'];
    if (!p.alive) classes.push('day-player-item--dead');
    return `<li class="${classes.join(' ')}">${p.name}${!p.alive ? ' <span class="day-player-status">eliminated</span>' : ''}</li>`;
  }).join('');

  // Night elimination announcement
  const announcementHTML = eliminatedName
    ? `<p class="day-announcement">During the night, <strong>${eliminatedName}</strong> was eliminated.</p>`
    : `<p class="day-announcement">No one was eliminated during the night.</p>`;

  transitionTo(app, () => {
    app.innerHTML = `
      <div id="screen-day-discuss" class="screen active screen--day-wash">
        <h1>Day -- Discuss!</h1>
        ${announcementHTML}
        <div id="day-timer-container"></div>
        <ul class="day-player-list">${playerListHTML}</ul>
        <div class="day-chat" id="day-chat">
          <div class="day-chat__messages" id="day-chat-messages"></div>
          ${isAlive ? `
          <div class="day-chat__input-row">
            <input type="text" class="input day-chat__input" id="day-chat-input" placeholder="Type a message..." maxlength="120" autocomplete="off" />
            <button class="btn btn--cyan day-chat__send" id="day-chat-send">Send</button>
          </div>
          ` : '<p class="day-chat__spectator">You are eliminated. Spectating.</p>'}
        </div>
      </div>
    `;
    afterRender();
  }, 'screen--day-wash');

  function afterRender() {
  // Timer
  const timerContainer = document.getElementById('day-timer-container');
  const timer = createTimer(GAME.DISCUSSION_DURATION, null, () => {
    if (onDiscussionEnd) onDiscussionEnd();
  });
  timerContainer.appendChild(timer.el);

  // Host runs the timer and broadcasts ticks
  if (isHost) {
    const hostTimer = createTimer(GAME.DISCUSSION_DURATION, (remaining) => {
      channel.send({
        type: 'broadcast',
        event: 'phase:tick',
        payload: { phase: 'day-discuss', remaining },
      });
      timer.sync(remaining);
    }, () => {
      timer.sync(0);
      // Host broadcasts transition to voting
      channel.send({
        type: 'broadcast',
        event: 'phase:day-vote',
        payload: {},
      });
      if (onDiscussionEnd) onDiscussionEnd();
    });
    hostTimer.start();
  } else {
    // Non-host: listen for ticks
    channel.on('broadcast', { event: 'phase:tick' }, (msg) => {
      if (msg.payload.phase === 'day-discuss') {
        timer.sync(msg.payload.remaining);
      }
    });
  }

  // Chat
  const messagesEl = document.getElementById('day-chat-messages');
  const chatInput = document.getElementById('day-chat-input');
  const chatSend = document.getElementById('day-chat-send');

  function addChatMessage(name, text) {
    const msgEl = document.createElement('div');
    msgEl.className = 'day-chat__msg';
    msgEl.innerHTML = `<strong>${name}:</strong> ${text}`;
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Listen for chat messages
  channel.on('broadcast', { event: 'chat:message' }, (msg) => {
    addChatMessage(msg.payload.name, msg.payload.text);
  });

  if (chatSend && chatInput) {
    function sendMessage() {
      const text = chatInput.value.trim();
      if (!text) return;
      channel.send({
        type: 'broadcast',
        event: 'chat:message',
        payload: { name: currentPlayer.name, text },
      });
      // Broadcast doesn't echo to sender
      addChatMessage(currentPlayer.name, text);
      chatInput.value = '';
    }

    chatSend.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
  }
  } // end afterRender
}
