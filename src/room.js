import { GAME } from './config.js';
import { startGame } from './game.js';
import { DEV_MODE, createStubPlayer, devStorage } from './dev.js';
import { subscribeToPrivate } from './curator.js';
import { showSpectator } from './phases/spectator.js';

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
// Late joiner who arrived after the host flipped its presence phase
// to 'running'. Spectators stay subscribed to the shared channel but
// never start a game loop. Issue #35.
let isSpectator = false;
let roomCode = null;
let appEl = null;
let onBackFn = null; // stored so renderLobby (and game callbacks) can reach it
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

const CLIENT_ID_STORAGE_KEY = 'houseMafiaClientId';
const CLIENT_ID_LENGTH = 25;
const CLIENT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function createRandomClientId() {
  let id = '';
  for (let i = 0; i < CLIENT_ID_LENGTH; i++) {
    id += CLIENT_ID_CHARS.charAt(Math.floor(Math.random() * CLIENT_ID_CHARS.length));
  }
  return id;
}

/**
 * Return a stable client identity that survives page reloads.
 *
 * Persisted via devStorage, which routes to localStorage in prod and
 * sessionStorage when ?dev=1 is set (so multiple dev tabs get distinct ids).
 * On first visit a 25-char random id is generated and saved; subsequent
 * calls return the same id. Room membership is NOT restored here — that
 * is tracked separately in issue #33.
 */
function generatePlayerId() {
  try {
    const existing = devStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing && typeof existing === 'string' && existing.length === CLIENT_ID_LENGTH) {
      return existing;
    }
    const fresh = createRandomClientId();
    devStorage.setItem(CLIENT_ID_STORAGE_KEY, fresh);
    return fresh;
  } catch (_err) {
    // Storage unavailable (private mode, quota, etc.) — fall back to an
    // ephemeral id so the current session still works.
    return createRandomClientId();
  }
}

// --- Room garbage collection (host-side) ---

/**
 * Count non-host occupants currently in the room. Reads the Supabase
 * presence state, excludes the host's own key, then adds the number of
 * local stub players — stubs are local-only and never appear in presence
 * state, but they count as occupants for GC purposes.
 */
function countNonHostOccupants() {
  let count = 0;
  if (channel && typeof channel.presenceState === 'function') {
    const state = channel.presenceState();
    for (const key of Object.keys(state)) {
      if (currentPlayer && key === currentPlayer.id) continue;
      const presences = state[key];
      if (presences && presences.length > 0) count += 1;
    }
  }
  const stubCount = players.filter((p) => p.isStub).length;
  return count + stubCount;
}

function gcTick() {
  if (!channel || !isHost) return;
  if (countNonHostOccupants() > 0) {
    lastNonHostSeenAt = Date.now();
    return;
  }
  if (Date.now() - lastNonHostSeenAt > GAME.ROOM_GC_ABANDON_THRESHOLD_MS) {
    const back = onBackFn;
    cleanup();
    if (back) back();
  }
}

function startRoomGC() {
  if (gcIntervalId != null) return;
  lastNonHostSeenAt = Date.now();
  gcIntervalId = setInterval(gcTick, GAME.ROOM_GC_CHECK_INTERVAL_MS);
}

function stopRoomGC() {
  if (gcIntervalId != null) {
    clearInterval(gcIntervalId);
    gcIntervalId = null;
  }
  lastNonHostSeenAt = 0;
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
      const latest = presences[presences.length - 1];
      // Spectators (late joiners) are tracked on the same channel but
      // must not appear in the lobby player roster — issue #35.
      if (latest && latest.isSpectator) continue;
      players.push(latest);
    }
  }
  // Re-append stubs (they are local-only, not in Supabase presence)
  for (const stub of stubs) {
    players.push(stub);
  }
  renderLobby();
}

/**
 * Inspect a Supabase presence snapshot and return whether the game host
 * has advertised `phase === 'running'`. Used by joiner validation to
 * decide whether to route as a player or as a spectator.
 */
function hostGameRunning(state) {
  for (const key of Object.keys(state)) {
    const presences = state[key];
    if (!presences || presences.length === 0) continue;
    const latest = presences[presences.length - 1];
    if (latest && latest.isHost && latest.phase === 'running') {
      return true;
    }
  }
  return false;
}

/**
 * Count presence entries flagged as spectators (excluding ourselves).
 */
function countSpectators(state, excludeId) {
  let n = 0;
  for (const key of Object.keys(state)) {
    if (key === excludeId) continue;
    const presences = state[key];
    if (!presences || presences.length === 0) continue;
    const latest = presences[presences.length - 1];
    if (latest && latest.isSpectator) n += 1;
  }
  return n;
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
      // Advertise the game phase via presence so late joiners can tell
      // whether to enter the lobby or the read-only spectator view.
      // Flipped to 'running' right before game:start broadcasts.
      phase: 'lobby',
    };

    try {
      roomCode = await findAvailableRoomCode(supabase);
      await subscribeToRoom(app, onBack);
      localStorage.setItem('lastRoomCreatedAt', Date.now().toString());
    } catch (err) {
      errorEl.textContent = err && err.message === 'Connection failed — check your internet'
        ? err.message
        : 'Failed to create room. Try again.';
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
      if (err && err.message === 'Connection failed — check your internet') {
        errorEl.textContent = err.message;
      } else if (!errorEl.textContent) {
        errorEl.textContent = 'Failed to join room. Try again.';
      }
    }
  });
}

// --- Channel subscription ---

async function subscribeToRoom(app, onBack) {
  appEl = app;
  onBackFn = onBack;

  function buildChannel() {
    return supabase.channel(`room:${roomCode}`, {
      config: {
        presence: { key: currentPlayer.id },
        broadcast: { self: true },
      },
    });
  }

  channel = buildChannel();

  // Wait for subscribe to complete, then check presence for join validation.
  // For joiners we must wait for the first presence:sync event before validating
  // room existence, because Supabase Realtime may deliver presence state after
  // the SUBSCRIBED callback fires (especially on slow networks).
  await new Promise((resolve, reject) => {
    // Track whether the joiner validation has already settled (resolved or rejected)
    // so that the sync handler and the timeout don't race each other.
    let joinerSettled = false;
    // CHANNEL_ERROR retry budget — Supabase Realtime can error on the very first
    // connection after page load (cold-start) before the websocket is warm. Retry
    // transparently before surfacing the error to the user.
    let subscribeRetries = 0;

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

      // Issue #35: if the host has flipped its presence phase to
      // 'running', this joiner missed the role:assign broadcast. Route
      // them to a read-only spectator view instead of the lobby.
      if (hostGameRunning(state)) {
        const existingSpectators = countSpectators(state, currentPlayer.id);
        if (existingSpectators >= GAME.MAX_SPECTATORS) {
          channel.unsubscribe();
          channel = null;
          const errorEl = document.getElementById('join-error');
          if (errorEl) {
            errorEl.textContent = `Spectator slots are full (${GAME.MAX_SPECTATORS}/${GAME.MAX_SPECTATORS}).`;
          }
          reject(new Error('Spectators full'));
          return;
        }

        isSpectator = true;
        const spectatorPlayer = { ...currentPlayer, isSpectator: true };
        currentPlayer = spectatorPlayer;
        await channel.track(spectatorPlayer);

        // Seed the spectator view from the current public roster we can
        // see in presence (players who were NOT flagged as spectators).
        const seedPlayers = [];
        for (const key of Object.keys(state)) {
          const presences = state[key];
          if (!presences || presences.length === 0) continue;
          const latest = presences[presences.length - 1];
          if (latest && !latest.isSpectator) {
            seedPlayers.push({ id: latest.id, name: latest.name });
          }
        }

        showSpectator({
          app,
          channel,
          roomCode,
          initialPlayers: seedPlayers,
          onLeave: () => {
            cleanup();
            onBack();
          },
        });
        resolve();
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

    function attachHandlers() {
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
          // Spectators (late joiners) stay on the spectator screen and
          // must not enter the game loop. Issue #35.
          if (isSpectator) return;
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
            if (subscribeRetries < GAME.MAX_SUBSCRIBE_RETRIES) {
              // Supabase Realtime cold-start: tear down and re-subscribe on a
              // fresh channel after a short backoff.
              subscribeRetries += 1;
              try {
                channel.unsubscribe();
              } catch (_) {
                // ignore — channel may already be in an errored state
              }
              setTimeout(() => {
                joinerSettled = false;
                channel = buildChannel();
                attachHandlers();
              }, GAME.SUBSCRIBE_RETRY_BACKOFF_MS);
            } else {
              reject(new Error('Connection failed — check your internet'));
            }
          }
        });
    }

    attachHandlers();
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
      startBtn.addEventListener('click', async () => {
        // Issue #35: advertise the running phase via presence BEFORE
        // broadcasting game:start so anyone joining between now and the
        // role:assign fanout sees the host as in-game and routes to
        // spectator instead of the lobby.
        currentPlayer = { ...currentPlayer, phase: 'running' };
        try {
          await channel.track(currentPlayer);
        } catch (err) {
          console.error('Failed to re-track host presence as running', err);
        }

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
  isSpectator = false;
  roomCode = null;
  appEl = null;
  onBackFn = null;
}
