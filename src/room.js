import { GAME } from './config.js';
import { startGame } from './game.js';

/**
 * Room module — create room, join room, lobby with Supabase Realtime presence.
 * Requires the Supabase client singleton from main.js.
 */

let supabase = null;
let channel = null;
let currentPlayer = null;
let players = [];
let isHost = false;
let roomCode = null;
let appEl = null;

/** Inject the singleton Supabase client */
export function setSupabase(client) {
  supabase = client;
}

// --- Helpers ---

function generateRoomCode(length = GAME.ROOM_CODE_LENGTH) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Probe a candidate room code by subscribing without tracking presence.
 * Returns true if the channel appears empty (code is available), false if taken.
 * The probe never calls channel.track(), so it leaves no presence state behind.
 */
async function isRoomCodeAvailable(client, code) {
  return new Promise((resolve) => {
    const probe = client.channel(`room:${code}`, {
      config: { presence: { key: '__probe__' } },
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        probe.unsubscribe();
        // Timed out waiting for sync — treat as available (no one responded)
        resolve(true);
      }
    }, 1000);

    probe
      .on('presence', { event: 'sync' }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const count = Object.keys(probe.presenceState()).length;
        probe.unsubscribe();
        resolve(count === 0);
      })
      .subscribe();
  });
}

/**
 * Find a collision-free room code by probing Supabase Realtime presence.
 * Tries up to MAX_ROOM_CODE_ATTEMPTS 4-letter codes, then falls back to 5-letter codes.
 */
async function findAvailableRoomCode(client) {
  for (let attempt = 0; attempt < GAME.MAX_ROOM_CODE_ATTEMPTS; attempt++) {
    const candidate = generateRoomCode(GAME.ROOM_CODE_LENGTH);
    if (await isRoomCodeAvailable(client, candidate)) {
      return candidate;
    }
  }
  // Fallback: try 5-letter codes (26^5 = 11.8M vs 26^4 = 456K space)
  for (let attempt = 0; attempt < GAME.MAX_ROOM_CODE_ATTEMPTS; attempt++) {
    const candidate = generateRoomCode(GAME.ROOM_CODE_LENGTH + 1);
    if (await isRoomCodeAvailable(client, candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not find an available room code after maximum attempts');
}

function generatePlayerId() {
  return crypto.randomUUID();
}

// --- Presence handling ---

function syncPlayers(state) {
  players = [];
  for (const key of Object.keys(state)) {
    const presences = state[key];
    if (presences && presences.length > 0) {
      // Use the most recent presence for each key
      players.push(presences[presences.length - 1]);
    }
  }
  renderLobby();
}

// --- Create Room ---

export function showCreateScreen(app, onBack) {
  app.innerHTML = `
    <div id="screen-create" class="screen active">
      <h1>Create Room</h1>
      <label class="input-label" for="create-name">Your Name</label>
      <input type="text" id="create-name" class="input" placeholder="Enter display name" maxlength="16" autocomplete="off" />
      <button class="btn btn--pink" id="btn-do-create">Create</button>
      <p id="create-error" class="error-text"></p>
      <button class="btn btn--cyan" id="btn-back-create">Back</button>
    </div>
  `;

  document.getElementById('btn-back-create').addEventListener('click', () => {
    cleanup();
    onBack();
  });

  document.getElementById('btn-do-create').addEventListener('click', async () => {
    const nameInput = document.getElementById('create-name');
    const name = nameInput.value.trim();
    const errorEl = document.getElementById('create-error');

    if (!name) {
      errorEl.textContent = 'Please enter a display name.';
      return;
    }

    if (!supabase) {
      errorEl.textContent = 'Supabase not configured. Check .env variables.';
      return;
    }

    isHost = true;
    currentPlayer = {
      id: generatePlayerId(),
      name,
      isHost: true,
    };

    try {
      roomCode = await findAvailableRoomCode(supabase);
      await subscribeToRoom(app, onBack);
    } catch (err) {
      errorEl.textContent = 'Failed to create room. Try again.';
    }
  });
}

// --- Join Room ---

export function showJoinScreen(app, onBack) {
  app.innerHTML = `
    <div id="screen-join" class="screen active">
      <h1>Join Room</h1>
      <label class="input-label" for="join-code">Room Code</label>
      <input type="text" id="join-code" class="input" placeholder="e.g. ABCD" maxlength="4" autocomplete="off" style="text-transform: uppercase;" />
      <label class="input-label" for="join-name">Your Name</label>
      <input type="text" id="join-name" class="input" placeholder="Enter display name" maxlength="16" autocomplete="off" />
      <button class="btn btn--cyan" id="btn-do-join">Join</button>
      <p id="join-error" class="error-text"></p>
      <button class="btn btn--pink" id="btn-back-join">Back</button>
    </div>
  `;

  document.getElementById('btn-back-join').addEventListener('click', () => {
    cleanup();
    onBack();
  });

  document.getElementById('btn-do-join').addEventListener('click', async () => {
    const codeInput = document.getElementById('join-code');
    const nameInput = document.getElementById('join-name');
    const code = codeInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();
    const errorEl = document.getElementById('join-error');

    if (!code || code.length !== GAME.ROOM_CODE_LENGTH) {
      errorEl.textContent = `Enter a ${GAME.ROOM_CODE_LENGTH}-letter room code.`;
      return;
    }

    if (!name) {
      errorEl.textContent = 'Please enter a display name.';
      return;
    }

    if (!supabase) {
      errorEl.textContent = 'Supabase not configured. Check .env variables.';
      return;
    }

    roomCode = code;
    isHost = false;
    currentPlayer = {
      id: generatePlayerId(),
      name,
      isHost: false,
    };

    try {
      await subscribeToRoom(app, () => {
        cleanup();
        onBack();
      });
    } catch (err) {
      errorEl.textContent = 'Failed to join room. Try again.';
    }
  });
}

// --- Channel subscription ---

async function subscribeToRoom(app, onBack) {
  appEl = app;
  channel = supabase.channel(`room:${roomCode}`, {
    config: { presence: { key: currentPlayer.id } },
  });

  // Wait for subscribe to complete, then check presence for join validation
  await new Promise((resolve, reject) => {
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        // If joining (not host), validate room exists and capacity
        syncPlayers(state);
        resolve();
      })
      .on('presence', { event: 'join' }, () => {
        // Handled by sync
      })
      .on('presence', { event: 'leave' }, () => {
        // Handled by sync
      })
      .on('broadcast', { event: 'game:start' }, () => {
        startGame({
          channel,
          players: [...players],
          currentPlayer,
          isHost,
          app: appEl,
        });
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          // For joiners: peek at presence to check room existence and capacity
          if (!isHost) {
            const state = channel.presenceState();
            const currentCount = Object.keys(state).length;

            if (currentCount === 0) {
              // No one in the room — room doesn't exist
              channel.unsubscribe();
              channel = null;
              const errorEl = document.getElementById('join-error');
              if (errorEl) errorEl.textContent = 'Room not found. Check the code and try again.';
              reject(new Error('Room not found'));
              return;
            }

            if (currentCount >= GAME.MAX_PLAYERS) {
              channel.unsubscribe();
              channel = null;
              const errorEl = document.getElementById('join-error');
              if (errorEl) errorEl.textContent = `Room is full (${GAME.MAX_PLAYERS}/${GAME.MAX_PLAYERS} players).`;
              reject(new Error('Room full'));
              return;
            }
          }

          await channel.track(currentPlayer);
          showLobby(app, onBack);
          resolve();
        } else if (status === 'CHANNEL_ERROR') {
          reject(new Error('Channel error'));
        }
      });
  });
}

// --- Lobby screen ---

function showLobby(app, onBack) {
  app.innerHTML = `
    <div id="screen-lobby" class="screen active">
      <h1>Lobby</h1>
      <p class="room-code-display">Room Code: <span id="lobby-code">${roomCode}</span></p>
      <p class="player-count" id="lobby-count">${players.length}/${GAME.MAX_PLAYERS}</p>
      <ul class="player-list" id="lobby-players"></ul>
      <div id="lobby-actions"></div>
      <button class="btn btn--cyan" id="btn-leave-lobby">Leave</button>
    </div>
  `;

  document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    cleanup();
    onBack();
  });

  renderLobby();
}

function renderLobby() {
  const listEl = document.getElementById('lobby-players');
  const countEl = document.getElementById('lobby-count');
  const actionsEl = document.getElementById('lobby-actions');

  if (!listEl || !countEl || !actionsEl) return;

  countEl.textContent = `${players.length}/${GAME.MAX_PLAYERS}`;

  listEl.innerHTML = players
    .map(
      (p) =>
        `<li class="player-item">${p.name}${p.isHost ? ' <span class="host-badge">HOST</span>' : ''}</li>`
    )
    .join('');

  if (isHost) {
    const canStart = players.length >= GAME.MIN_PLAYERS;
    actionsEl.innerHTML = `
      <button class="btn btn--pink" id="btn-start-game" ${canStart ? '' : 'disabled'}>
        Start Game${canStart ? '' : ` (need ${GAME.MIN_PLAYERS}+)`}
      </button>
    `;
    const startBtn = document.getElementById('btn-start-game');
    if (startBtn && canStart) {
      startBtn.addEventListener('click', () => {
        channel.send({
          type: 'broadcast',
          event: 'game:start',
          payload: {},
        });
        // Broadcast doesn't echo back to sender, so trigger locally
        startGame({
          channel,
          players: [...players],
          currentPlayer,
          isHost,
          app: appEl,
        });
      });
    }
  } else {
    actionsEl.innerHTML = `<p class="waiting-text">Waiting for host to start...</p>`;
  }
}

// --- Cleanup ---

function cleanup() {
  if (channel) {
    channel.unsubscribe();
    channel = null;
  }
  currentPlayer = null;
  players = [];
  isHost = false;
  roomCode = null;
  appEl = null;
}
