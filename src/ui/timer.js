import { GAME } from '../config.js';

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
export function createTimer(seconds, onTick, onEnd) {
  const el = document.createElement('div');
  el.className = 'timer';
  el.textContent = String(seconds);

  let remaining = seconds;
  let intervalId = null;

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
    render();
    intervalId = setInterval(() => {
      remaining--;
      render();
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
  }

  return { el, start, stop, getRemaining, sync };
}
