/**
 * Lightweight toast notification primitive. Issue #60.
 *
 * Usage:
 *   import { showToast } from './ui/toast.js';
 *   showToast('Saved', { type: 'info', duration: 2000 });
 *
 * Pure UI — no Supabase, no dependencies. DOM-only.
 *
 * Types:
 *   - 'info'  (cyan)
 *   - 'warn'  (yellow)
 *   - 'error' (pink)
 *
 * Stack is capped at 5 toasts (oldest evicted). Tap to dismiss early.
 */

const MAX_TOASTS = 5;
const FADE_MS = 250;
const STYLE_ID = 'toast-stack-style';

let mountEl = null;

function ensureMount() {
  if (mountEl && document.body.contains(mountEl)) return mountEl;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #toast-stack {
        position: fixed;
        top: 1rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2000;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        pointer-events: none;
        max-width: 90vw;
      }
      .toast {
        pointer-events: auto;
        padding: 0.6rem 1rem;
        border-radius: 6px;
        font-family: inherit;
        font-size: 0.9rem;
        font-weight: 600;
        color: #0a0a0f;
        background: var(--neon-cyan, #00f0ff);
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
        opacity: 1;
        transition: opacity ${FADE_MS}ms ease;
        cursor: pointer;
        text-align: center;
        min-width: 10rem;
      }
      .toast--info { background: var(--neon-cyan, #00f0ff); }
      .toast--warn { background: var(--neon-yellow, #ffdd00); }
      .toast--error { background: var(--neon-pink, #ff00aa); color: #fff; }
      .toast--fading { opacity: 0; }
    `;
    document.head.appendChild(style);
  }

  const host = document.getElementById('app') || document.body;
  mountEl = document.createElement('div');
  mountEl.id = 'toast-stack';
  host.appendChild(mountEl);
  return mountEl;
}

function evictOldest() {
  if (!mountEl) return;
  while (mountEl.children.length >= MAX_TOASTS) {
    const oldest = mountEl.firstElementChild;
    if (!oldest) break;
    oldest.remove();
  }
}

/**
 * Show a toast notification.
 * @param {string} text
 * @param {{ type?: 'info'|'warn'|'error', duration?: number }} [opts]
 */
export function showToast(text, { type = 'info', duration = 2500 } = {}) {
  try {
    const stack = ensureMount();
    evictOldest();

    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.textContent = text;

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      el.classList.add('toast--fading');
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, FADE_MS);
    };

    el.addEventListener('click', dismiss);
    stack.appendChild(el);

    setTimeout(dismiss, duration);
    return el;
  } catch (_err) {
    // Never throw out of toast code — it's a cosmetic primitive.
    return null;
  }
}
