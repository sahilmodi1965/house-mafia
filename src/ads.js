import { ADS } from './config.js';

/**
 * Ad manager — stub wrapper for future AdMob integration.
 * All methods simulate ad behavior with console.log + delays.
 * Never shows ads during active gameplay.
 */

/** Session start timestamp (ms) */
const sessionStart = Date.now();

/** Timestamp of last rewarded video (ms), 0 = never */
let lastRewardedAt = 0;

/** Timestamp of last interstitial (ms), 0 = never */
let lastInterstitialAt = 0;

/** Number of completed games this session */
let gamesCompleted = 0;

/**
 * Check if enough time has passed since session start
 * to show any ad (respects FIRST_AD_AFTER_MINUTES).
 * @returns {boolean}
 */
export function canShowAd() {
  const elapsed = (Date.now() - sessionStart) / 1000 / 60;
  return elapsed >= ADS.FIRST_AD_AFTER_MINUTES;
}

/**
 * Check if rewarded video cooldown has elapsed.
 * @returns {boolean}
 */
export function canShowRewarded() {
  if (!canShowAd()) return false;
  if (lastRewardedAt === 0) return true;
  const elapsed = (Date.now() - lastRewardedAt) / 1000;
  return elapsed >= ADS.REWARDED_COOLDOWN;
}

/**
 * Show a rewarded video ad (stub: 2-second simulated delay).
 * @param {Function} onReward - Called when user watches the full ad
 * @param {Function} onSkip - Called when user skips/closes early
 */
export function showRewardedVideo(onReward, onSkip) {
  console.log('[ads] Showing rewarded video (stub)');
  const overlay = document.getElementById('ad-overlay');
  if (overlay) {
    overlay.innerHTML = `
      <div class="ad-overlay__content">
        <p class="ad-overlay__label">Ad Playing...</p>
        <p class="ad-overlay__timer" id="ad-overlay-timer">2</p>
      </div>
    `;
    overlay.classList.add('visible');
  }

  let secondsLeft = 2;
  const tick = setInterval(() => {
    secondsLeft--;
    const timerEl = document.getElementById('ad-overlay-timer');
    if (timerEl) timerEl.textContent = String(secondsLeft);
  }, 1000);

  setTimeout(() => {
    clearInterval(tick);
    lastRewardedAt = Date.now();
    console.log('[ads] Rewarded video complete — reward granted');
    if (overlay) {
      overlay.classList.remove('visible');
      overlay.innerHTML = '';
    }
    if (typeof onReward === 'function') onReward();
  }, 2000);
}

/**
 * Check if an interstitial should be shown based on game count
 * and minimum time between interstitials (2 minutes).
 * @returns {boolean}
 */
export function shouldShowInterstitial() {
  if (!canShowAd()) return false;
  if (gamesCompleted === 0) return false;
  if (gamesCompleted % ADS.INTERSTITIAL_EVERY_N_GAMES !== 0) return false;
  if (lastInterstitialAt > 0) {
    const elapsed = (Date.now() - lastInterstitialAt) / 1000 / 60;
    if (elapsed < ADS.FIRST_AD_AFTER_MINUTES) return false;
  }
  return true;
}

/**
 * Show an interstitial ad (stub: 2-second simulated delay).
 * @returns {Promise<void>} Resolves when the ad finishes.
 */
export function showInterstitial() {
  return new Promise((resolve) => {
    console.log('[ads] Showing interstitial (stub)');
    const overlay = document.getElementById('ad-overlay');
    if (overlay) {
      overlay.innerHTML = `
        <div class="ad-overlay__content">
          <p class="ad-overlay__label">Ad</p>
          <p class="ad-overlay__timer" id="ad-overlay-timer">2</p>
        </div>
      `;
      overlay.classList.add('visible');
    }

    let secondsLeft = 2;
    const tick = setInterval(() => {
      secondsLeft--;
      const timerEl = document.getElementById('ad-overlay-timer');
      if (timerEl) timerEl.textContent = String(secondsLeft);
    }, 1000);

    setTimeout(() => {
      clearInterval(tick);
      lastInterstitialAt = Date.now();
      console.log('[ads] Interstitial complete');
      if (overlay) {
        overlay.classList.remove('visible');
        overlay.innerHTML = '';
      }
      resolve();
    }, 2000);
  });
}

/**
 * Show a banner ad in the given container (stub: placeholder text).
 * @param {string} containerId - DOM element ID to place the banner in
 */
export function showBanner(containerId) {
  console.log(`[ads] Showing banner in #${containerId} (stub)`);
  const el = document.getElementById(containerId);
  if (el) {
    el.innerHTML = '<span class="ad-banner__text">Ad Space</span>';
    el.classList.add('visible');
  }
}

/**
 * Hide the banner ad.
 * @param {string} containerId - DOM element ID of the banner
 */
export function hideBanner(containerId) {
  console.log(`[ads] Hiding banner #${containerId}`);
  const el = document.getElementById(containerId);
  if (el) {
    el.classList.remove('visible');
    el.innerHTML = '';
  }
}

/**
 * Increment the completed games counter. Called after each game ends.
 */
export function recordGameCompleted() {
  gamesCompleted++;
  console.log(`[ads] Games completed this session: ${gamesCompleted}`);
}
