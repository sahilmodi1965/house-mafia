/**
 * Sound effects and haptic feedback module.
 * Uses Web Audio API stubs (console.log) since real audio files aren't available.
 * Provides haptic feedback via navigator.vibrate() with silent fallback.
 */

// --- Mute state ---
let muted = false;

/**
 * Get current mute state.
 * @returns {boolean}
 */
export function isMuted() {
  return muted;
}

/**
 * Toggle mute on/off.
 * @returns {boolean} New mute state
 */
export function toggleMute() {
  muted = !muted;
  return muted;
}

/**
 * Set mute state explicitly.
 * @param {boolean} value
 */
export function setMuted(value) {
  muted = !!value;
}

// --- Sound definitions ---
// TODO: Replace console.log stubs with actual Web Audio API playback
// when .mp3/.ogg files are added to assets/sounds/

const SOUNDS = {
  vote: { name: 'vote', file: 'assets/sounds/vote.mp3' },
  eliminate: { name: 'eliminate', file: 'assets/sounds/eliminate.mp3' },
  reveal: { name: 'reveal', file: 'assets/sounds/reveal.mp3' },
  tick: { name: 'tick', file: 'assets/sounds/tick.mp3' },
  win: { name: 'win', file: 'assets/sounds/win.mp3' },
  night: { name: 'night', file: 'assets/sounds/night.mp3' },
};

/**
 * Play a named sound effect.
 * Currently stubs with console.log — replace with Web Audio API when audio files exist.
 * Respects mute toggle.
 *
 * @param {string} name - One of: vote, eliminate, reveal, tick, win, night
 */
export function playSound(name) {
  if (muted) return;

  const sound = SOUNDS[name];
  if (!sound) {
    console.warn(`[audio] Unknown sound: ${name}`);
    return;
  }

  // TODO: Implement Web Audio API playback when audio files are available.
  // Example implementation:
  //   const audioCtx = getAudioContext();
  //   const buffer = await loadBuffer(audioCtx, sound.file);
  //   const source = audioCtx.createBufferSource();
  //   source.buffer = buffer;
  //   source.connect(audioCtx.destination);
  //   source.start();
  console.log(`[audio] playSound: ${sound.name} (stub — file: ${sound.file})`);
}

// --- Haptic feedback ---
// Uses navigator.vibrate() with silent fallback on unsupported devices.

const HAPTIC_PATTERNS = {
  vote: [50],
  eliminate: [100, 50, 100],
  reveal: [150],
  gameOver: [300],
};

/**
 * Trigger haptic feedback for a named event.
 * Falls back silently if vibration API is unavailable.
 *
 * @param {string} name - One of: vote, eliminate, reveal, gameOver
 */
export function haptic(name) {
  if (muted) return;

  const pattern = HAPTIC_PATTERNS[name];
  if (!pattern) return;

  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch {
      // Silent fallback — vibration not supported or blocked
    }
  }
}

// --- Mute toggle button ---

/**
 * Create a mute toggle button element.
 * @returns {HTMLButtonElement}
 */
export function createMuteButton() {
  const btn = document.createElement('button');
  btn.className = 'btn-mute';
  btn.setAttribute('aria-label', 'Toggle sound');
  btn.textContent = muted ? '🔇' : '🔊';

  btn.addEventListener('click', () => {
    toggleMute();
    btn.textContent = muted ? '🔇' : '🔊';
  });

  return btn;
}
