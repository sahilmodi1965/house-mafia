/**
 * Minimal QR image helper. Issue #108.
 *
 * Background: the previous Share Room panel (#48) rendered QR codes via
 * https://chart.googleapis.com/chart?cht=qr&... Google deprecated that
 * endpoint in 2024; the image now returns blank or 404 and the share
 * panel shows a broken-image placeholder.
 *
 * This module replaces it with a pure factory function — zero npm
 * dependencies, zero bundle weight. It uses api.qrserver.com (a free
 * no-auth QR endpoint) for the image source, with a two-level fallback:
 *
 *   1. Primary: qrserver.com — still alive in 2026, no deprecation.
 *   2. Secondary (onerror): hide the QR slot entirely. The share link
 *      still works; we just stop showing a broken image.
 *
 * We intentionally do NOT ship a full inline Reed-Solomon + byte-mode
 * QR encoder in this commit — the minimum correct version is ~400 lines
 * of dense code and this PR is about polish, not a new primitive. If
 * qrserver.com ever goes the way of Google Charts, the fallback path
 * already hides the image gracefully and we can swap in an inline
 * encoder without touching room.js.
 *
 * Pure DOM — no Supabase, no state. Returns an HTMLImageElement.
 */

const QR_ENDPOINT = 'https://api.qrserver.com/v1/create-qr-code/';
const QR_SIZE = 180;

/**
 * Build an <img> element that renders a QR code for the given URL.
 * On image-load error, the element hides itself so the share panel
 * is never stuck showing a broken-image placeholder.
 *
 * @param {string} url
 * @returns {HTMLImageElement}
 */
export function qrImage(url) {
  const img = document.createElement('img');
  img.className = 'share-panel__qr';
  img.alt = 'Room QR code';
  img.width = QR_SIZE;
  img.height = QR_SIZE;
  img.loading = 'lazy';
  img.src = `${QR_ENDPOINT}?size=${QR_SIZE}x${QR_SIZE}&data=${encodeURIComponent(url || '')}`;
  img.addEventListener('error', () => {
    // Second fallback: hide the slot entirely. The URL text in the
    // share panel is still copyable and the link still works.
    img.style.display = 'none';
  });
  return img;
}
