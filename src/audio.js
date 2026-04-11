/**
 * Audio manager and haptic feedback for House Mafia.
 * Uses Web Audio API with <audio> fallback. Respects device mute.
 * No npm dependencies — vanilla Web APIs only.
 */

// --- Audio state ---
let muted = false;
let audioCtx = null;

/**
 * Get or create the AudioContext lazily (must be triggered by user gesture).
 * @returns {AudioContext|null}
 */
function getAudioContext() {
  if (audioCtx) return audioCtx;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  } catch {
    return null;
  }
}

/**
 * Sound registry — maps sound names to their asset paths.
 * TODO: Replace placeholder paths with real .mp3 files (<50KB each)
 * in assets/sounds/ once audio assets are sourced.
 *
 * Expected files:
 *   assets/sounds/vote.mp3       — short click/tap for vote cast
 *   assets/sounds/eliminate.mp3  — dramatic sting for elimination
 *   assets/sounds/reveal.mp3     — card flip / whoosh for role reveal
 *   assets/sounds/tick.mp3       — subtle tick for timer warning (<10s)
 *   assets/sounds/win.mp3        — victory fanfare for game over
 *   assets/sounds/night.mp3      — ambient transition for night phase
 */
const SOUND_PATHS = {
  vote: 'assets/sounds/vote.mp3',
  eliminate: 'assets/sounds/eliminate.mp3',
  reveal: 'assets/sounds/reveal.mp3',
  tick: 'assets/sounds/tick.mp3',
  win: 'assets/sounds/win.mp3',
  night: 'assets/sounds/night.mp3',
};

/** Cache of decoded AudioBuffers keyed by sound name */
const bufferCache = {};

/**
 * Preload a sound file into the buffer cache.
 * Fails silently if the file doesn't exist yet (stub mode).
 * @param {string} name - Sound name from SOUND_PATHS
 */
async function preload(name) {
  const path = SOUND_PATHS[name];
  if (!path || bufferCache[name]) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const response = await fetch(path);
    if (!response.ok) {
      // Sound file not available yet — stub mode
      console.log(`[audio] stub: ${name} not found at ${path}`);
      return;
    }
    const arrayBuffer = await response.arrayBuffer();
    bufferCache[name] = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    // Silently fail — sound files are optional stubs for now
    console.log(`[audio] stub: could not load ${name}`);
  }
}

/**
 * Preload all registered sounds. Call once after first user gesture.
 */
export function preloadAll() {
  Object.keys(SOUND_PATHS).forEach((name) => preload(name));
}

/**
 * Play a sound by name.
 * Uses Web Audio API if the buffer is cached, otherwise logs a stub message.
 * Respects mute state and device mute (AudioContext suspended = device muted).
 * @param {string} name - Sound name (vote, eliminate, reveal, tick, win, night)
 */
export function playSound(name) {
  if (muted) return;

  const ctx = getAudioContext();
  if (!ctx) {
    // No Web Audio API — log stub
    console.log(`[audio] playSound stub: ${name}`);
    return;
  }

  // Resume context if suspended (respects device mute — if the OS suspends
  // audio, the context stays suspended and no sound plays)
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const buffer = bufferCache[name];
  if (!buffer) {
    // Sound file not loaded — stub fallback
    console.log(`[audio] playSound stub: ${name} (no buffer)`);
    return;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
}

// --- Mute toggle ---

/**
 * Toggle mute state.
 * @returns {boolean} New muted state
 */
export function toggleMute() {
  muted = !muted;
  return muted;
}

/**
 * Get current mute state.
 * @returns {boolean}
 */
export function isMuted() {
  return muted;
}

// --- Haptic feedback ---

/**
 * Trigger haptic feedback using navigator.vibrate().
 * Silent fallback on devices that don't support it.
 * @param {string} type - Haptic type: 'vote' | 'eliminate' | 'reveal' | 'gameover'
 */
export function haptic(type) {
  if (!navigator.vibrate) return;

  switch (type) {
    case 'vote':
      // Short tap — 50ms
      navigator.vibrate(50);
      break;
    case 'eliminate':
      // Double buzz — 100ms vibrate, 50ms pause, 100ms vibrate
      navigator.vibrate([100, 50, 100]);
      break;
    case 'reveal':
      // Medium pulse — 150ms
      navigator.vibrate(150);
      break;
    case 'gameover':
      // Long buzz — 300ms
      navigator.vibrate(300);
      break;
    default:
      break;
  }
}

/**
 * Create a mute toggle button element.
 * @returns {HTMLElement} Button element
 */
export function createMuteButton() {
  const btn = document.createElement('button');
  btn.className = 'mute-btn';
  btn.setAttribute('aria-label', 'Toggle sound');
  btn.textContent = muted ? '🔇' : '🔊';
  btn.addEventListener('click', () => {
    // First click also initialises AudioContext (user gesture required)
    getAudioContext();
    preloadAll();
    const nowMuted = toggleMute();
    btn.textContent = nowMuted ? '🔇' : '🔊';
  });
  return btn;
}
