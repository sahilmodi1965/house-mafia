import { GAME } from './config.js';
import { startGame } from './game.js';
import { DEV_MODE, createStubPlayer, devStorage } from './dev.js';
import { subscribeToPrivate } from './curator.js';
import { showSpectator } from './phases/spectator.js';
import {
  openSettingsModal,
  defaultRoomConfig,
  applyRoomConfig,
} from './ui/settings-modal.js';
import { showToast } from './ui/toast.js';
import { isNameAvailable, playAgainResetPlayers } from './engine/resolve.js';

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
// Issue #54: custom game settings chosen by the host before Start.
// On the host this is also the write-through source for GAME.*_DURATION
// mutations (applyRoomConfig). Peers populate it from lobby:config
// broadcasts so their lobby UI reflects the host's picks.
let roomConfig = defaultRoomConfig();

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

      // Issue #52: name collision check. Build a roster snapshot from
      // the current presence state and refuse to join if the
      // requested display name is already taken (case-insensitive).
      const existingNames = [];
      for (const key of Object.keys(state)) {
        const presences = state[key];
        if (!presences || presences.length === 0) continue;
        const latest = presences[presences.length - 1];
        if (latest && !latest.isSpectator && typeof latest.name === 'string') {
          existingNames.push({ name: latest.name });
        }
      }
      if (!isNameAvailable(currentPlayer.name, existingNames)) {
        channel.unsubscribe();
        channel = null;
        const errorEl = document.getElementById('join-error');
        if (errorEl) errorEl.textContent = 'That name is taken — try another.';
        try {
          showToast('That name is taken — try another.', { type: 'error', duration: 2500 });
        } catch (_) {}
        reject(new Error('Name taken'));
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
        .on('broadcast', { event: 'lobby:config' }, (msg) => {
          // Issue #54: host has updated game settings. Peers mirror
          // them locally so their phase timers match and their lobby
          // UI re-renders with the latest values.
          if (isHost) return;
          const cfg = msg.payload && msg.payload.config;
          if (!cfg) return;
          roomConfig = cfg;
          applyRoomConfig(cfg);
          // Re-render lobby if we're on it, so the "Settings updated"
          // state is visible. The lobby render is cheap and idempotent.
          const lobbyEl = document.getElementById('screen-lobby');
          if (lobbyEl) renderLobby();
        })
        .on('broadcast', { event: 'lobby:kick' }, (msg) => {
          // #56: host has removed a player from the lobby.
          const payload = (msg && msg.payload) || {};
          const targetId = payload.targetPlayerId;
          const targetName = payload.targetName || 'player';
          const kickerName = payload.kickerName || 'Host';
          if (!targetId) return;

          // If I'm the one being kicked, tear down and bail.
          if (currentPlayer && targetId === currentPlayer.id) {
            try {
              showToast('You were removed from the room', { type: 'error', duration: 4000 });
            } catch (_) {}
            const back = onBackFn;
            cleanup();
            if (back) back();
            return;
          }

          // Otherwise: remove the kicked player from my local roster
          // and show an informational toast. The host already removed
          // the row locally; peers reach this code path.
          players = players.filter((p) => p.id !== targetId);
          renderLobby();
          if (!isHost) {
            try {
              showToast(`${kickerName} kicked ${targetName}`, { type: 'info', duration: 2500 });
            } catch (_) {}
          }
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
            onRestartRoom: () => restartRoomInPlace(),
            roomConfig,
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

  const settingsBtn = isHost
    ? `<button class="btn btn--cyan" id="btn-settings">Settings</button>`
    : '';

  app.innerHTML = `
    <style>
      .lobby-kick-btn {
        margin-left: 0.5rem;
        background: transparent;
        border: 1px solid var(--neon-pink, #ff00aa);
        color: var(--neon-pink, #ff00aa);
        border-radius: 4px;
        width: 1.6rem;
        height: 1.6rem;
        font-size: 0.9rem;
        cursor: pointer;
        vertical-align: middle;
      }
      .lobby-kick-btn:hover { background: var(--neon-pink, #ff00aa); color: #fff; }
    </style>
    <div id="screen-lobby" class="screen active">
      <h1>Lobby</h1>
      <p class="room-code-display">Room Code: <span id="lobby-code">${roomCode}</span></p>
      <p class="player-count" id="lobby-count">${players.length}/${GAME.MAX_PLAYERS}</p>
      <ul class="player-list" id="lobby-players"></ul>
      <p class="lobby-config" id="lobby-config"></p>
      <button class="btn btn--yellow" id="btn-share-room">Share Room</button>
      <div id="share-panel" class="share-panel" hidden></div>
      <div id="lobby-actions"></div>
      ${settingsBtn}
      ${devStubRow}
      <button class="btn btn--cyan" id="btn-leave-lobby">Leave</button>
    </div>
  `;

  document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    cleanup();
    onBack();
  });

  // #48: Share Room — expose a join URL + QR code inline. Pure UI;
  // no Supabase writes, no new dependency. QR is rendered via the
  // free Google Charts URL so we don't ship a QR encoder.
  const shareBtn = document.getElementById('btn-share-room');
  const sharePanel = document.getElementById('share-panel');
  if (shareBtn && sharePanel) {
    shareBtn.addEventListener('click', () => {
      const url = buildShareUrl(roomCode);
      renderSharePanel(sharePanel, url);
      sharePanel.hidden = false;
      // Attempt clipboard copy on click; fall back silently if blocked.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(url)
          .then(() => {
            try { showToast('Link copied', { type: 'info', duration: 2000 }); } catch (_) {}
          })
          .catch(() => {});
      }
    });
  }

  if (isHost) {
    const settingsEl = document.getElementById('btn-settings');
    if (settingsEl) {
      settingsEl.addEventListener('click', () => {
        openSettingsModal({
          currentConfig: roomConfig,
          playerCount: players.length,
          onSave: (newConfig) => {
            roomConfig = newConfig;
            applyRoomConfig(newConfig);
            // Broadcast to peers so their lobby + phase timers match.
            if (channel) {
              channel.send({
                type: 'broadcast',
                event: 'lobby:config',
                payload: { config: newConfig },
              });
            }
            renderLobby();
          },
        });
      });
    }
  }

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

  // Render current room-settings summary so every player (host and
  // peers) sees what the game will be tuned to. Updates in-place when
  // the host saves the settings modal (or when a peer receives a
  // lobby:config broadcast and calls renderLobby).
  const configEl = document.getElementById('lobby-config');
  if (configEl) {
    const disabledCount = (roomConfig.disabledRoles || []).length;
    const disabledSuffix = disabledCount > 0 ? `, ${disabledCount} role${disabledCount === 1 ? '' : 's'} off` : '';
    configEl.textContent = `Night ${roomConfig.nightDuration}s · Discuss ${roomConfig.discussionDuration}s · Vote ${roomConfig.voteDuration}s · ${roomConfig.preset}${disabledSuffix}`;
  }

  listEl.innerHTML = players
    .map((p) => {
      // #56: host sees a kick ✕ button next to every non-host,
      // non-stub player. Host cannot kick themselves. Stubs already
      // have their own local removal paths and are excluded here.
      const canKick = isHost && !p.isHost && !p.isStub;
      const kickBtn = canKick
        ? `<button class="lobby-kick-btn" data-kick-id="${p.id}" data-kick-name="${p.name}" aria-label="Remove ${p.name}">✕</button>`
        : '';
      return `<li class="player-item">${p.name}${p.isHost ? ' <span class="host-badge">HOST</span>' : ''}${p.isStub ? ' <span class="stub-badge">STUB</span>' : ''}${kickBtn}</li>`;
    })
    .join('');

  // #56: wire kick buttons. Opens a confirm prompt, broadcasts
  // lobby:kick on confirmation. The kicked client receives the
  // broadcast and tears down its own session.
  if (isHost) {
    const kickButtons = listEl.querySelectorAll('.lobby-kick-btn');
    kickButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = btn.getAttribute('data-kick-id');
        const targetName = btn.getAttribute('data-kick-name') || '';
        if (!targetId) return;
        const ok = window.confirm(`Remove ${targetName}?`);
        if (!ok) return;

        // Broadcast kick to every client. The target acts on it;
        // others render a status toast.
        if (channel && typeof channel.send === 'function') {
          channel.send({
            type: 'broadcast',
            event: 'lobby:kick',
            payload: {
              targetPlayerId: targetId,
              targetName,
              kickerName: (currentPlayer && currentPlayer.name) || 'Host',
            },
          });
        }
        // Locally remove from roster + re-render.
        players = players.filter((p) => p.id !== targetId);
        renderLobby();
        try {
          showToast(`Kicked ${targetName}`, { type: 'info', duration: 2000 });
        } catch (_) {}
      });
    });
  }

  if (isHost) {
    const minRequired = DEV_MODE ? GAME.DEV_MIN_PLAYERS : GAME.MIN_PLAYERS;
    const maxAllowed = GAME.MAX_PLAYERS;
    const canStart =
      players.length >= minRequired && players.length <= maxAllowed;
    const disabledLabel =
      players.length < minRequired
        ? ` (need ${minRequired}+)`
        : players.length > maxAllowed
        ? ` (max ${maxAllowed})`
        : '';
    actionsEl.innerHTML = `
      <button class="btn btn--pink" id="btn-start-game" ${canStart ? '' : 'disabled'}>
        Start Game${canStart ? '' : disabledLabel}
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
          onRestartRoom: () => restartRoomInPlace(),
          roomConfig,
        });
      });
    }
  } else {
    actionsEl.innerHTML = `<p class="waiting-text">Waiting for host to start...</p>`;
  }
}

/**
 * Issue #48: build a shareable join URL for the given room code.
 * Re-uses the current origin + pathname so gh-pages preview URLs
 * and the live build both stay in sync. The `?room=` param is
 * consumed at boot in main.js.
 */
function buildShareUrl(code) {
  try {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}?room=${encodeURIComponent(code || '')}`;
  } catch (_) {
    return `?room=${code || ''}`;
  }
}

/**
 * Issue #48: render the share panel (link text + lazy QR image).
 * Uses the Google Charts QR endpoint — zero dependency, stable URL.
 */
function renderSharePanel(panelEl, url) {
  const qrSrc = `https://chart.googleapis.com/chart?cht=qr&chs=180x180&chl=${encodeURIComponent(url)}`;
  panelEl.innerHTML = `
    <style>
      .share-panel {
        margin: 0.75rem auto;
        padding: 0.75rem;
        border: 1px solid var(--neon-cyan, #00f0ff);
        border-radius: 6px;
        max-width: 18rem;
        text-align: center;
      }
      .share-panel__url {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8rem;
        word-break: break-all;
        color: var(--neon-cyan, #00f0ff);
        margin-bottom: 0.5rem;
      }
      .share-panel__qr {
        width: 180px;
        height: 180px;
        background: #fff;
        padding: 4px;
        border-radius: 4px;
      }
    </style>
    <div class="share-panel__url" id="share-panel-url">${url}</div>
    <img class="share-panel__qr" loading="lazy" alt="Room QR code" src="${qrSrc}" />
  `;
}

/**
 * Issue #47: Play Again in-place. Resets every player row in the local
 * roster so the next game starts from clean state, flips the host's
 * presence phase back to 'lobby' (so new joiners get the lobby screen
 * instead of spectator), and re-renders the lobby. The Supabase channel
 * and currentPlayer identity are preserved — this is NOT a teardown.
 */
function restartRoomInPlace() {
  if (!appEl) return;
  // Strip transient game state from every player via the pure helper.
  // Preserves id/name/isHost/isStub; drops alive/role/votedFor.
  players = playAgainResetPlayers(players);

  if (isHost && currentPlayer) {
    currentPlayer = { ...currentPlayer, phase: 'lobby' };
    if (channel && typeof channel.track === 'function') {
      try {
        channel.track(currentPlayer);
      } catch (err) {
        console.error('restartRoomInPlace: failed to re-track host as lobby', err);
      }
    }
  }

  // showLobby re-renders from scratch and rewires the host Start /
  // Settings listeners. onBackFn is already cached on the module.
  showLobby(appEl, onBackFn || (() => {}));
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
  roomConfig = defaultRoomConfig();
}
