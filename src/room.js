import { GAME } from './config.js';
import { startGame } from './game.js';
import { DEV_MODE, createStubPlayer } from './dev.js';
import { subscribeToPrivate } from './curator.js';

/**
 * Room module — create room, join room, lobby with Supabase Realtime presence.
 * Requires the Supabase client singleton from main.js.
 */

let supabase = null;
let channel = null;
let privateChannel = null; // this player's own per-player private channel
let currentPlayer = null;
let players = [];
let isHost = false;
let roomCode = null;
let appEl = null;
let onBackFn = null; // stored so renderLobby (and game callbacks) can reach it

// --- Host-side garbage collection state ---
// Tracks the last moment at which the room had >=1 non-host occupant (real
// presence OR local dev stub). When that moment is older than the abandon
// threshold AND only the host is left, the host tears down the channel.
let gcIntervalId = null;
let lastNonHostSeenAt = 0;

/** Inject the singleton Supabase client */
export function setSupabase(client) {
  supabase = client;
}

// --- Helpers ---

function generateRoomCode(length = GAME.ROOM_CODE_LENGTH) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += GAME.ROOM_CODE_CHARS.charAt(Math.floor(Math.random() * GAME.ROOM_CODE_CHARS.length));
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

// --- Host-side room garbage collection ---

/**
 * Count non-host occupants of the room: real Supabase presences (excluding the
 * host's own presence key) plus any local dev stubs. Stubs live only in the
 * `players` array and are not in presenceState, so they are counted separately.
 */
function countNonHostOccupants() {
  if (!channel) return 0;
  let realNonHost = 0;
  try {
    const state = channel.presenceState();
    for (const key of Object.keys(state)) {
      if (currentPlayer && key === currentPlayer.id) continue;
      realNonHost += 1;
    }
  } catch (_err) {
    // presenceState can throw if channel is torn down mid-tick
    return 0;
  }
  const stubs = players.filter((p) => p.isStub).length;
  return realNonHost + stubs;
}

function gcTick() {
  if (!isHost || !channel) return;

  const nonHostCount = countNonHostOccupants();
  if (nonHostCount > 0) {
    lastNonHostSeenAt = Date.now();
    return;
  }

  // Only the host remains. If the gap exceeds the abandon threshold, tear down.
  if (Date.now() - lastNonHostSeenAt >= GAME.ROOM_GC_ABANDON_THRESHOLD_MS) {
    const back = onBackFn;
    cleanup();
    if (back) back();
  }
}

function startRoomGC() {
  if (!isHost) return;
  stopRoomGC();
  lastNonHostSeenAt = Date.now();
  gcIntervalId = setInterval(gcTick, GAME.ROOM_GC_CHECK_INTERVAL_MS);
}

function stopRoomGC() {
  if (gcIntervalId !== null) {
    clearInterval(gcIntervalId);
    gcIntervalId = null;
  }
}

// --- Presence handling ---

function syncPlayers(state) {
  // Preserve local stub players across Supabase presence syncs
  const stubs = players.filter(p => p.isStub);
  players = [];
  for (const key of Object.keys(state)) {
    const presences = state[key];
    if (presences && presences.length > 0) {
      // Use the most recent presence for each key
      players.push(presences[presences.length - 1]);
    }
  }
  // Re-append stubs (they are local-only, not in Supabase presence)
  for (const stub of stubs) {
    players.push(stub);
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

    const lastCreatedAt = localStorage.getItem('lastRoomCreatedAt');
    if (lastCreatedAt && Date.now() - parseInt(lastCreatedAt, 10) < GAME.ROOM_CREATE_COOLDOWN_MS) {
      errorEl.textContent = 'Slow down — wait a moment';
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
      localStorage.setItem('lastRoomCreatedAt', Date.now().toString());
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
      if (!errorEl.textContent) {
        errorEl.textContent = 'Failed to join room. Try again.';
      }
    }
  });
}

// --- Channel subscription ---

async function subscribeToRoom(app, onBack) {
  appEl = app;
  onBackFn = onBack;
  channel = supabase.channel(`room:${roomCode}`, {
    config: {
      presence: { key: currentPlayer.id },
      broadcast: { self: true },
    },
  });

  // Wait for subscribe to complete, then check presence for join validation.
  // For joiners we must wait for the first presence:sync event before validating
  // room existence, because Supabase Realtime may deliver presence state after
  // the SUBSCRIBED callback fires (especially on slow networks).
  await new Promise((resolve, reject) => {
    // Track whether the joiner validation has already settled (resolved or rejected)
    // so that the sync handler and the timeout don't race each other.
    let joinerSettled = false;

    async function validateJoinerPresence(state) {
      if (joinerSettled) return;
      joinerSettled = true;

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

      // Room exists and has capacity — proceed
      await channel.track(currentPlayer);
      try {
        privateChannel = await subscribeToPrivate(supabase, roomCode, currentPlayer.id);
      } catch (err) {
        console.error('Failed to subscribe to private channel', err);
      }
      showLobby(app, onBack);
      resolve();
    }

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        if (!isHost && !joinerSettled) {
          // Joiner: presence:sync is the authoritative moment to validate the room.
          validateJoinerPresence(state);
        } else {
          // Host path, or joiner after initial validation — keep lobby in sync.
          syncPlayers(state);
        }
      })
      .on('presence', { event: 'join' }, () => {
        // Handled by sync
      })
      .on('presence', { event: 'leave' }, () => {
        // Handled by sync
      })
      .on('broadcast', { event: 'game:start' }, () => {
        if (isHost) return; // host already triggered startGame locally
        startGame({
          channel,
          privateChannel,
          supabase,
          roomCode,
          players: [...players],
          currentPlayer,
          isHost,
          app: appEl,
          onReturnToTitle: () => {
            cleanup();
            onBack();
          },
        });
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          if (isHost) {
            // Creator: track immediately; no presence validation needed.
            await channel.track(currentPlayer);
            try {
              privateChannel = await subscribeToPrivate(supabase, roomCode, currentPlayer.id);
            } catch (err) {
              console.error('Failed to subscribe to private channel', err);
            }
            startRoomGC();
            showLobby(app, onBack);
            resolve();
          } else {
            // Joiner: wait up to 3 s for presence:sync before falling back.
            setTimeout(() => {
              // If sync already fired and settled, this is a no-op.
              validateJoinerPresence(channel.presenceState());
            }, 3000);
          }
        } else if (status === 'CHANNEL_ERROR') {
          reject(new Error('Channel error'));
        }
      });
  });
}

// --- Lobby screen ---

function showLobby(app, onBack) {
  const devStubRow = DEV_MODE && isHost
    ? `<button class="btn btn--yellow" id="btn-add-stub">Add Stub Player</button>`
    : '';

  app.innerHTML = `
    <div id="screen-lobby" class="screen active">
      <h1>Lobby</h1>
      <p class="room-code-display">Room Code: <span id="lobby-code">${roomCode}</span></p>
      <p class="player-count" id="lobby-count">${players.length}/${GAME.MAX_PLAYERS}</p>
      <ul class="player-list" id="lobby-players"></ul>
      <div id="lobby-actions"></div>
      ${devStubRow}
      <button class="btn btn--cyan" id="btn-leave-lobby">Leave</button>
    </div>
  `;

  document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    cleanup();
    onBack();
  });

  if (DEV_MODE && isHost) {
    document.getElementById('btn-add-stub').addEventListener('click', () => {
      if (players.length >= GAME.MAX_PLAYERS) return;
      const stub = createStubPlayer();
      players.push(stub);
      renderLobby();
    });
  }

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
        `<li class="player-item">${p.name}${p.isHost ? ' <span class="host-badge">HOST</span>' : ''}${p.isStub ? ' <span class="stub-badge">STUB</span>' : ''}</li>`
    )
    .join('');

  if (isHost) {
    const minRequired = DEV_MODE ? GAME.DEV_MIN_PLAYERS : GAME.MIN_PLAYERS;
    const canStart = players.length >= minRequired;
    actionsEl.innerHTML = `
      <button class="btn btn--pink" id="btn-start-game" ${canStart ? '' : 'disabled'}>
        Start Game${canStart ? '' : ` (need ${minRequired}+)`}
      </button>
    `;
    const startBtn = document.getElementById('btn-start-game');
    if (startBtn && canStart) {
      startBtn.addEventListener('click', () => {
        // Real (non-stub) players receive the broadcast
        const realPlayers = players.filter(p => !p.isStub);
        if (realPlayers.length > 1) {
          channel.send({
            type: 'broadcast',
            event: 'game:start',
            payload: {},
          });
        }
        // Broadcast doesn't echo back to sender, so trigger locally
        startGame({
          channel,
          privateChannel,
          supabase,
          roomCode,
          players: [...players],
          currentPlayer,
          isHost,
          app: appEl,
          onReturnToTitle: () => {
            const back = onBackFn;
            cleanup();
            if (back) back();
          },
        });
      });
    }
  } else {
    actionsEl.innerHTML = `<p class="waiting-text">Waiting for host to start...</p>`;
  }
}

// --- Cleanup ---

function cleanup() {
  stopRoomGC();
  if (channel) {
    channel.unsubscribe();
    channel = null;
  }
  if (privateChannel) {
    privateChannel.unsubscribe();
    privateChannel = null;
  }
  currentPlayer = null;
  players = [];
  isHost = false;
  roomCode = null;
  appEl = null;
  onBackFn = null;
}
