import { GAME } from '../config.js';
import { playSound } from '../audio.js';
import { haptic, HAPTIC_WARNING } from '../haptic.js';
import { showToast } from './toast.js';

/**
 * Reusable countdown timer component.
 * Renders a large centered display with visual warning at 10s.
 */

/**
 * Create a countdown timer.
 * @param {number} seconds - Starting seconds
 * @param {Function} onTick - Called each second with remaining seconds
 * @param {Function} onEnd - Called when timer reaches 0
 * @returns {{ el: HTMLElement, start: Function, stop: Function, getRemaining: Function }}
 */
export function createTimer(seconds, onTick, onEnd, opts = {}) {
  // Issue #59: some callers (e.g. day.js, vote.js) create TWO timer
  // instances per phase — a visible display timer sync'd from ticks
  // and a host-owned bookkeeping timer that runs `start()`. Both would
  // fire the warning. Callers pass { fireWarnings: false } on the
  // invisible bookkeeping timer to suppress duplicates.
  const fireWarnings = opts.fireWarnings !== false;
  const el = document.createElement('div');
  el.className = 'timer';
  el.textContent = String(seconds);

  let remaining = seconds;
  let intervalId = null;
  // Issue #59: fire audio/haptic/toast warning once per timer instance
  // when the "10-seconds-left" moment hits. For short phases (Night=15)
  // the threshold scales down so the warning still lands before the
  // timer fires — clamped to never exceeding 10.
  const warningThreshold = Math.min(10, Math.floor(seconds * 0.3));
  let warningFired = false;

  function maybeFirePhaseWarning() {
    if (!fireWarnings) return;
    if (warningFired) return;
    if (seconds < 15) return; // skip on very short timers
    if (remaining !== warningThreshold) return;
    warningFired = true;
    try { playSound('timer-warning'); } catch (_) {}
    try { haptic(HAPTIC_WARNING); } catch (_) {}
    try { showToast('10 seconds left', { type: 'warn', duration: 2000 }); } catch (_) {}
  }

  function render() {
    el.textContent = String(remaining);
    if (remaining <= 10) {
      el.classList.add('timer--warning');
    } else {
      el.classList.remove('timer--warning');
    }
  }

  function start() {
    remaining = seconds;
    warningFired = false;
    render();
    intervalId = setInterval(() => {
      remaining--;
      render();
      maybeFirePhaseWarning();
      if (onTick) onTick(remaining);
      if (remaining <= 0) {
        clearInterval(intervalId);
        intervalId = null;
        if (onEnd) onEnd();
      }
    }, 1000);
  }

  function stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function getRemaining() {
    return remaining;
  }

  /**
   * Sync timer to a host-broadcast tick value.
   * @param {number} hostRemaining - Remaining seconds from host
   */
  function sync(hostRemaining) {
    remaining = hostRemaining;
    render();
    maybeFirePhaseWarning();
  }

  return { el, start, stop, getRemaining, sync };
}
