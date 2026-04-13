import { GAME } from './config.js';
import { startGame, rebindCuratedState } from './game.js';
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
let gcIntervalId = null;
let lastNonHostSeenAt = 0;

// --- Reconnect grace-window state (issue #33) ---
// Module-level because the presence handlers in subscribeToRoom need to reach
// them across ticks, and there is only one active room per client session.
let gamePhase = 'lobby'; // 'lobby' | 'running' — updated by markGameRunning()
// Host-side map of seats whose owning client just left during an active game.
// Key: clientId. Value: { player, graceTimerId, disconnectedAt }. Cleared
// either by a matching rejoin (seat restored) or by the grace timer firing
// (seat permanently removed).
const disconnectedSeats = new Map();
// Last public player-list seen by the host. Used by the grace-expiry path to
// broadcast an updated roster so surviving clients can drop the dead seat
// from any UI that lists players.
let lastPublicPlayers = [];

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
  // Preserve seats currently inside the reconnect grace window (issue #33):
  // they are missing from Supabase presence (the client left the channel),
  // but the host must keep them on the roster until the grace timer fires
  // so game.js can still reference them by id.
  const gracedSeats = [];
  if (isHost && gamePhase === 'running' && disconnectedSeats.size > 0) {
    const liveKeys = new Set(Object.keys(state));
    for (const [cid, seat] of disconnectedSeats.entries()) {
      if (!liveKeys.has(cid)) gracedSeats.push(seat.player);
    }
  }
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
  for (const graced of gracedSeats) {
    players.push(graced);
  }
  // Host-only: remember the current public list so the grace-expiry path
  // can broadcast an updated roster to surviving clients.
  if (isHost) {
    lastPublicPlayers = players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: !!p.isHost,
      isStub: !!p.isStub,
    }));
  }
  renderLobby();
}

/**
 * Host-side: called from the presence:leave handler when a client drops
 * during an active game. Marks the seat as disconnected on the local
 * roster copy, stashes it in `disconnectedSeats`, and starts the grace
 * timer that will remove the seat permanently after RECONNECT_GRACE_MS
 * if the same clientId has not rejoined by then.
 */
function startReconnectGrace(clientId, leavingPlayer) {
  // Cancel a previous timer for the same clientId if one is somehow still
  // pending (defensive; in normal operation a rejoin clears it).
  const prior = disconnectedSeats.get(clientId);
  if (prior && prior.graceTimerId) clearTimeout(prior.graceTimerId);

  const seatCopy = { ...leavingPlayer, disconnected: true };
  const graceTimerId = setTimeout(() => {
    const entry = disconnectedSeats.get(clientId);
    if (!entry) return;
    disconnectedSeats.delete(clientId);
    // Permanently drop the seat from the local roster and broadcast the
    // updated public roster so surviving clients can clean up any UI that
    // still references the dead player.
    if (channel) {
      players = players.filter((p) => p.id !== clientId);
      lastPublicPlayers = players.map((p) => ({
        id: p.id,
        name: p.name,
        isHost: !!p.isHost,
        isStub: !!p.isStub,
      }));
      try {
        channel.send({
          type: 'broadcast',
          event: 'roster:update',
          payload: { players: lastPublicPlayers, removedId: clientId },
        });
      } catch (err) {
        console.error('reconnect grace: failed to broadcast roster:update', err);
      }
    }
  }, GAME.RECONNECT_GRACE_MS);

  disconnectedSeats.set(clientId, {
    player: seatCopy,
    graceTimerId,
    disconnectedAt: Date.now(),
  });
}

/**
 * Host-side: called from the presence:join handler when a client reappears.
 * If the joining clientId matches a seat inside the grace window, clear the
 * timer, restore the seat to the roster, and re-deliver curated state
 * (role + phase snapshot) on that player's private channel so the rejoined
 * client can jump straight back into the game.
 */
async function restoreDisconnectedSeat(clientId) {
  const entry = disconnectedSeats.get(clientId);
  if (!entry) return false;
  if (entry.graceTimerId) clearTimeout(entry.graceTimerId);
  disconnectedSeats.delete(clientId);
  // rebindCuratedState is imported from game.js — it is a no-op when no
  // game is active (e.g. something weird happened and gamePhase lied).
  try {
    await rebindCuratedState({ supabase, roomCode, clientId });
  } catch (err) {
    console.error('restoreDisconnectedSeat: rebind failed', err);
  }
  return true;
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

      // --- Reconnect recovery (issue #33) ---
      // This check MUST come before capacity / spectator gates so a player
      // who dropped mid-game can reclaim their seat even if the room is at
      // MAX_PLAYERS. Detection: any presence entry in the room is marked
      // `phase: 'running'` by the host (see markGameRunning). Spectator
      // path for fresh joiners to a running game is tracked separately
      // in issue #35 and is NOT wired up here.
      let hostRunning = false;
      for (const key of Object.keys(state)) {
        const presences = state[key];
        if (!presences || presences.length === 0) continue;
        const last = presences[presences.length - 1];
        if (last && last.phase === 'running') {
          hostRunning = true;
          break;
        }
      }

      if (hostRunning) {
        // Enter recovery mode: subscribe to private channel FIRST (so
        // the host's rebind frames land on a live listener), wire the
        // game loop, THEN track presence — tracking is what triggers
        // the host's presence:join handler and the rebind send. Doing
        // these steps in this order avoids a race where the host sends
        // before our private channel is subscribed. No lobby screen —
        // we are mid-game.
        try {
          privateChannel = await subscribeToPrivate(supabase, roomCode, currentPlayer.id);
        } catch (err) {
          console.error('Recovery: failed to subscribe to private channel', err);
        }
        // Kick the game loop so its private-channel listeners are wired
        // up before the host's rebind frame arrives. The player list is
        // populated later from the rebind payload.
        startGame({
          channel,
          privateChannel,
          supabase,
          roomCode,
          players: [],
          currentPlayer,
          isHost: false,
          app: appEl,
          onReturnToTitle: () => {
            cleanup();
            onBack();
          },
        });
        try {
          await channel.track(currentPlayer);
        } catch (err) {
          console.error('Recovery: failed to re-track presence', err);
        }
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
        .on('presence', { event: 'join' }, ({ key }) => {
          // Host-only reconnect path (issue #33): if this clientId matches
          // a seat currently inside the grace window, clear the timer and
          // re-deliver curated state on that player's private channel.
          // The sync handler above already re-adds them to `players`
          // because they are now in presenceState.
          if (isHost && gamePhase === 'running' && key && disconnectedSeats.has(key)) {
            restoreDisconnectedSeat(key);
          }
        })
        .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
          // Reconnect grace (issue #33) — only the host arbitrates this,
          // and only while the game is active. Lobby leaves fall through
          // to the sync handler above and are removed immediately, which
          // matches the issue spec ("Lobby leaves remove immediately").
          if (!isHost || gamePhase !== 'running' || !key) return;
          // Find the seat being vacated. The most recent presence for
          // the key is the one the host was tracking. Fall back to the
          // previous roster snapshot if leftPresences is missing.
          let leavingPlayer = null;
          if (leftPresences && leftPresences.length > 0) {
            leavingPlayer = leftPresences[leftPresences.length - 1];
          }
          if (!leavingPlayer) {
            leavingPlayer = players.find((p) => p.id === key) || null;
          }
          if (!leavingPlayer) return;
          // Never grace-hold the host themself — if the host disconnects
          // the whole room is effectively gone (authoritative state lives
          // on their client), so we skip the stash.
          if (leavingPlayer.id === currentPlayer?.id) return;
          startReconnectGrace(key, leavingPlayer);
        })
        .on('broadcast', { event: 'roster:update' }, (msg) => {
          // Non-host listener for host-driven grace-expiry roster updates.
          // The host broadcasts this when a disconnected seat's grace
          // timer expires so surviving clients can drop the dead player
          // from any roster-based UI.
          if (isHost) return;
          const payload = msg.payload || {};
          if (Array.isArray(payload.players)) {
            players = payload.players;
            renderLobby();
          }
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
      startBtn.addEventListener('click', () => {
        // Mark the game running on the host's own presence so joiners
        // (and the host's own leave handler) can tell we are past the
        // lobby. See markGameRunning + issue #33.
        markGameRunning();
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
  // Cancel any in-flight reconnect grace timers so timers started on this
  // client session don't fire after teardown.
  for (const seat of disconnectedSeats.values()) {
    if (seat.graceTimerId) clearTimeout(seat.graceTimerId);
  }
  disconnectedSeats.clear();
  gamePhase = 'lobby';
  lastPublicPlayers = [];
  currentPlayer = null;
  players = [];
  isHost = false;
  roomCode = null;
  appEl = null;
  onBackFn = null;
}

/**
 * Called by the game loop when the host transitions from lobby → active
 * game (issue #33). Re-tracks the host's own presence with `phase: 'running'`
 * so joiners (and the host's own presence:leave handler) can tell that a
 * leave event during this window is a potential reconnect candidate, not a
 * clean lobby exit.
 */
export async function markGameRunning() {
  gamePhase = 'running';
  if (channel && currentPlayer) {
    try {
      await channel.track({ ...currentPlayer, phase: 'running' });
    } catch (err) {
      console.error('markGameRunning: failed to re-track presence', err);
    }
  }
}
