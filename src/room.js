import { GAME } from './config.js';
import { startGame } from './game.js';
import { DEV_MODE, createStubPlayer, devStorage } from './dev.js';
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

// Reconnect / grace-window state (issue #33).
//
// Once the game has started (state !== 'lobby'), the host no longer removes
// a seat the instant its presence:leave fires. Instead the seat is flagged
// `disconnected: true` and a per-clientId grace timer is started. If the
// same clientId rejoins the room inside RECONNECT_GRACE_MS, the host
// restores the seat and re-delivers curated state (role + current phase
// snapshot) on the player's private channel. After the timer expires the
// seat is removed from `players` for good and the presence snapshot is
// allowed to drop it on the next sync.
let gamePhaseState = 'lobby'; // 'lobby' | 'active'
const disconnectedSeats = new Map(); // clientId -> { seat, timer, disconnectedAt }
let onRebindFn = null; // game.js installs this to re-deliver curated state
let lastPresenceKeys = new Set(); // tracked so we can detect rejoins

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
const CLIENT_ID_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function createRandomClientId() {
  let id = '';
  for (let i = 0; i < CLIENT_ID_LENGTH; i++) {
    id += CLIENT_ID_CHARS.charAt(
      Math.floor(Math.random() * CLIENT_ID_CHARS.length)
    );
  }
  return id;
}

/**
 * Return a stable client identity that survives page reloads and brief
 * network drops. Used as the Supabase presence key so the host can tell
 * "this is the same player rejoining" from "this is a brand-new player".
 *
 * Prod: localStorage-persisted.
 * Dev (?dev=1): sessionStorage-scoped, so multiple tabs can act as
 * distinct clients without colliding.
 */
function generatePlayerId() {
  try {
    const existing = devStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (
      existing &&
      typeof existing === 'string' &&
      existing.length === CLIENT_ID_LENGTH
    ) {
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

/**
 * Called by game.js when the host starts (or ends) a game. While in
 * 'active' state, mid-game presence:leave events don't immediately drop
 * the seat — they start a grace timer. Lobby state is unchanged: leaves
 * remove the player instantly.
 */
export function setGamePhaseState(state) {
  gamePhaseState = state === 'active' ? 'active' : 'lobby';
  if (gamePhaseState === 'lobby') {
    // Cancel any pending grace timers — fresh lobby, fresh slate.
    for (const entry of disconnectedSeats.values()) {
      clearTimeout(entry.timer);
    }
    disconnectedSeats.clear();
  }
}

/**
 * Register a callback that game.js uses to re-deliver curated state to
 * a reconnecting player. Called with (clientId, seat) on rebind so the
 * host can re-send role:assign and a current-phase snapshot on that
 * player's private channel.
 */
export function setRebindHandler(fn) {
  onRebindFn = typeof fn === 'function' ? fn : null;
}

/**
 * Expose the currently-tracked player list to game.js (host side).
 * Returned array is a copy — mutation is fine.
 */
export function getCurrentRoomPlayers() {
  return [...players];
}

// --- Presence handling ---

function syncPlayers(state) {
  // Preserve local stub players across Supabase presence syncs
  const stubs = players.filter(p => p.isStub);
  const nextKeys = new Set(Object.keys(state));

  // Seats that are currently in their grace window — we must keep them
  // in the player list even though Supabase presence has dropped them.
  const gracedSeats = [];
  for (const [cid, entry] of disconnectedSeats.entries()) {
    if (!nextKeys.has(cid)) {
      gracedSeats.push({ ...entry.seat, disconnected: true, disconnectedAt: entry.disconnectedAt });
    }
  }

  const nextPlayers = [];
  for (const key of nextKeys) {
    const presences = state[key];
    if (presences && presences.length > 0) {
      // Use the most recent presence for each key
      nextPlayers.push(presences[presences.length - 1]);
    }
  }

  // During an active game: detect rejoins and drops by comparing
  // presence keys against the previous sync.
  if (gamePhaseState === 'active') {
    // Rejoins: any key now present that has a grace entry → restore seat.
    for (const key of nextKeys) {
      if (disconnectedSeats.has(key)) {
        rebindSeat(key);
      }
    }
    // Drops: any key previously present but now absent → start grace.
    for (const key of lastPresenceKeys) {
      if (!nextKeys.has(key) && !disconnectedSeats.has(key)) {
        // Find the seat we knew about so we can preserve it.
        const oldSeat = players.find((p) => p.id === key && !p.isStub);
        if (oldSeat) {
          startGraceFor(oldSeat);
        }
      }
    }
  }

  players = nextPlayers;
  // Re-append graced seats (flagged disconnected) so the UI still shows them.
  for (const graced of gracedSeats) {
    if (!players.find((p) => p.id === graced.id)) {
      players.push(graced);
    }
  }
  // Re-append stubs (they are local-only, not in Supabase presence)
  for (const stub of stubs) {
    players.push(stub);
  }

  lastPresenceKeys = nextKeys;
  renderLobby();
}

/**
 * Mark a seat as disconnected and start its per-clientId grace timer.
 * Only invoked on the game host's client once the game is active.
 * Stubs are skipped (they live locally and can't disconnect).
 */
function startGraceFor(seat) {
  if (!seat || !seat.id || seat.isStub) return;
  if (disconnectedSeats.has(seat.id)) return;
  const disconnectedAt = Date.now();
  const timer = setTimeout(() => {
    // Grace expired — drop the seat permanently.
    const entry = disconnectedSeats.get(seat.id);
    if (!entry) return;
    disconnectedSeats.delete(seat.id);
    players = players.filter((p) => p.id !== seat.id);
    renderLobby();
    if (onRebindFn) {
      // Signal expiry via the same callback (seat=null) so game.js can
      // react (e.g. auto-eliminate through its existing game loop).
      try {
        onRebindFn(seat.id, null, { expired: true });
      } catch (err) {
        console.error('Rebind handler expiry error', err);
      }
    }
  }, GAME.RECONNECT_GRACE_MS);
  disconnectedSeats.set(seat.id, {
    seat: { ...seat },
    timer,
    disconnectedAt,
  });
}

/**
 * Restore a disconnected seat on the host and ask game.js to re-deliver
 * curated state (role + phase snapshot) on the player's private channel.
 */
function rebindSeat(clientId) {
  const entry = disconnectedSeats.get(clientId);
  if (!entry) return;
  clearTimeout(entry.timer);
  disconnectedSeats.delete(clientId);
  if (onRebindFn) {
    try {
      onRebindFn(clientId, entry.seat, { reconnected: true });
    } catch (err) {
      console.error('Rebind handler reconnect error', err);
    }
  }
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

      const keys = Object.keys(state);
      const currentCount = keys.length;

      // Recovery mode: this stable clientId is already present in the
      // room's presence state (e.g. the host still sees us within the
      // grace window, or presence hasn't timed us out yet). We skip the
      // empty/full checks, track ourselves again, and wait for the host
      // to re-deliver curated state on our private channel (issue #33).
      const isRecovery = keys.includes(currentPlayer.id);

      if (!isRecovery && currentCount === 0) {
        // No one in the room — room doesn't exist
        channel.unsubscribe();
        channel = null;
        const errorEl = document.getElementById('join-error');
        if (errorEl) errorEl.textContent = 'Room not found. Check the code and try again.';
        reject(new Error('Room not found'));
        return;
      }

      if (!isRecovery && currentCount >= GAME.MAX_PLAYERS) {
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
  // Reconnect state — fully reset so a fresh Create/Join starts clean.
  gamePhaseState = 'lobby';
  for (const entry of disconnectedSeats.values()) {
    clearTimeout(entry.timer);
  }
  disconnectedSeats.clear();
  onRebindFn = null;
  lastPresenceKeys = new Set();
}
