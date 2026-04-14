/**
 * Synthesized sound effects via Web Audio API. Issue #57.
 *
 * Usage:
 *   import { playSound } from './audio.js';
 *   playSound('vote');
 *
 * Pure programmatic audio — no asset files, no network, no libraries.
 * All sounds are short oscillator+gain envelopes. On browsers without
 * AudioContext or with blocked audio (Safari before first user gesture),
 * calls silently no-op instead of throwing.
 *
 * Mute hook:
 *   localStorage.setItem('hm:muted', '1')  → all sounds suppressed
 *
 * Supported events:
 *   - vote          short high blip  (~150ms, ~800 Hz sine)
 *   - elimination   descending two-tone (~400ms, 600→300 Hz)
 *   - role-reveal   ascending C-E-G arpeggio (~600ms)
 *   - timer-warning 3 quick ticks  (~100ms each, 1200 Hz)
 *   - game-over     C-major chord (~800ms)
 */

const MUTE_KEY = 'hm:muted';

let audioCtx = null;

function isMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function getCtx() {
  if (audioCtx) return audioCtx;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  } catch (_) {
    return null;
  }
}

function tone(ctx, { freq, startTime, duration, type = 'sine', peak = 0.2 }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  // Envelope: quick attack, linear decay. Avoids clicks.
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peak, startTime + 0.01);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

function slideTone(ctx, { fromFreq, toFreq, startTime, duration, peak = 0.2 }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(fromFreq, startTime);
  osc.frequency.linearRampToValueAtTime(toFreq, startTime + duration);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peak, startTime + 0.02);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

function playVote(ctx) {
  const t = ctx.currentTime;
  tone(ctx, { freq: 800, startTime: t, duration: 0.15, peak: 0.18 });
}

function playElimination(ctx) {
  const t = ctx.currentTime;
  slideTone(ctx, { fromFreq: 600, toFreq: 300, startTime: t, duration: 0.4, peak: 0.22 });
}

function playRoleReveal(ctx) {
  const t = ctx.currentTime;
  // C5 261.63, E5 329.63, G5 392.00
  tone(ctx, { freq: 261.63, startTime: t + 0.0, duration: 0.18, peak: 0.2 });
  tone(ctx, { freq: 329.63, startTime: t + 0.18, duration: 0.18, peak: 0.2 });
  tone(ctx, { freq: 392.0, startTime: t + 0.36, duration: 0.24, peak: 0.22 });
}

function playTimerWarning(ctx) {
  const t = ctx.currentTime;
  tone(ctx, { freq: 1200, startTime: t + 0.0, duration: 0.08, peak: 0.18, type: 'square' });
  tone(ctx, { freq: 1200, startTime: t + 0.15, duration: 0.08, peak: 0.18, type: 'square' });
  tone(ctx, { freq: 1200, startTime: t + 0.3, duration: 0.08, peak: 0.18, type: 'square' });
}

function playGameOver(ctx) {
  const t = ctx.currentTime;
  // C major chord: C4, E4, G4
  tone(ctx, { freq: 261.63, startTime: t, duration: 0.8, peak: 0.15 });
  tone(ctx, { freq: 329.63, startTime: t, duration: 0.8, peak: 0.15 });
  tone(ctx, { freq: 392.0, startTime: t, duration: 0.8, peak: 0.15 });
}

/**
 * Play a named sound effect. Silently no-ops on failure (no AudioContext,
 * muted, etc.). Never throws.
 * @param {'vote'|'elimination'|'role-reveal'|'timer-warning'|'game-over'} eventName
 */
export function playSound(eventName) {
  try {
    if (isMuted()) return;
    const ctx = getCtx();
    if (!ctx) return;
    // Some browsers (Safari) start the context suspended. Try to resume
    // — will succeed if this call is inside a user-gesture stack frame.
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(() => {});
    }
    switch (eventName) {
      case 'vote':
        playVote(ctx);
        break;
      case 'elimination':
        playElimination(ctx);
        break;
      case 'role-reveal':
        playRoleReveal(ctx);
        break;
      case 'timer-warning':
        playTimerWarning(ctx);
        break;
      case 'game-over':
        playGameOver(ctx);
        break;
      default:
        // unknown event: no-op
        break;
    }
  } catch (_) {
    // Swallow — audio is cosmetic.
  }
}
