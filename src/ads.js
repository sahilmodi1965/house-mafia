import { ADS } from './config.js';

/**
 * Ad manager — stub implementations for monetization hooks.
 * Will eventually integrate with AdMob SDK. For now, all ad calls
 * log to console and simulate a 2-second delay.
 */

/** Timestamp (ms) when the session started */
const sessionStartTime = Date.now();

/** Timestamp (ms) of the last rewarded video completion */
let lastRewardedTime = 0;

/** Number of completed games this session */
let gameCount = 0;

/** Timestamp (ms) of the last interstitial shown */
let lastInterstitialTime = 0;

/**
 * Whether enough time has passed since session start to show any ad.
 * @returns {boolean}
 */
export function canShowAd() {
  const elapsed = (Date.now() - sessionStartTime) / 1000 / 60;
  return elapsed >= ADS.FIRST_AD_AFTER_MINUTES;
}

/**
 * Whether the rewarded video cooldown has elapsed.
 * @returns {boolean}
 */
export function canShowRewarded() {
  if (!canShowAd()) return false;
  if (lastRewardedTime === 0) return true;
  const elapsed = (Date.now() - lastRewardedTime) / 1000;
  return elapsed >= ADS.REWARDED_COOLDOWN;
}

/**
 * Show a rewarded video ad (stub — simulates 2s delay).
 * @param {Function} onReward - Called if the user watches the full ad
 * @param {Function} onSkip - Called if the user skips/closes the ad
 */
export function showRewardedVideo(onReward, onSkip) {
  console.log('[ads] showRewardedVideo: displaying rewarded video (stub)');
  const overlay = document.getElementById('ad-overlay');
  if (overlay) {
    overlay.innerHTML = `
      <div class="ad-overlay__content">
        <p class="ad-overlay__label">Rewarded Video Ad (stub)</p>
        <p class="ad-overlay__timer" id="ad-countdown">2</p>
      </div>
    `;
    overlay.classList.add('ad-overlay--visible');
  }

  let remaining = 2;
  const interval = setInterval(() => {
    remaining -= 1;
    const countdownEl = document.getElementById('ad-countdown');
    if (countdownEl) countdownEl.textContent = String(remaining);
  }, 1000);

  setTimeout(() => {
    clearInterval(interval);
    console.log('[ads] showRewardedVideo: completed');
    lastRewardedTime = Date.now();
    if (overlay) {
      overlay.classList.remove('ad-overlay--visible');
      overlay.innerHTML = '';
    }
    if (onReward) onReward();
  }, 2000);
}

/**
 * Show an interstitial ad (stub — simulates 2s delay).
 * @returns {Promise<void>} Resolves when the ad is dismissed.
 */
export function showInterstitial() {
  console.log('[ads] showInterstitial: displaying interstitial (stub)');
  const overlay = document.getElementById('ad-overlay');
  if (overlay) {
    overlay.innerHTML = `
      <div class="ad-overlay__content">
        <p class="ad-overlay__label">Interstitial Ad (stub)</p>
        <p class="ad-overlay__timer" id="ad-countdown">2</p>
      </div>
    `;
    overlay.classList.add('ad-overlay--visible');
  }

  let remaining = 2;
  const interval = setInterval(() => {
    remaining -= 1;
    const countdownEl = document.getElementById('ad-countdown');
    if (countdownEl) countdownEl.textContent = String(remaining);
  }, 1000);

  return new Promise((resolve) => {
    setTimeout(() => {
      clearInterval(interval);
      console.log('[ads] showInterstitial: completed');
      lastInterstitialTime = Date.now();
      if (overlay) {
        overlay.classList.remove('ad-overlay--visible');
        overlay.innerHTML = '';
      }
      resolve();
    }, 2000);
  });
}

/**
 * Show a banner ad in the given container (stub).
 * @param {string} containerId - DOM element id to host the banner
 */
export function showBanner(containerId) {
  console.log(`[ads] showBanner: showing banner in #${containerId} (stub)`);
  const container = document.getElementById(containerId);
  if (container) {
    container.innerHTML = '<p class="ad-banner__text">Ad Banner (stub)</p>';
    container.classList.add('ad-banner--visible');
  }
}

/**
 * Hide the banner ad.
 */
export function hideBanner() {
  console.log('[ads] hideBanner: hiding banner (stub)');
  const container = document.getElementById('ad-banner');
  if (container) {
    container.classList.remove('ad-banner--visible');
    container.innerHTML = '';
  }
}

/**
 * Increment the completed-game counter. Call this when a game ends.
 */
export function incrementGameCount() {
  gameCount += 1;
  console.log(`[ads] game count: ${gameCount}`);
}

/**
 * Whether an interstitial should be shown before returning to lobby.
 * Rules: every N games, never on first game, minimum 2 minutes between,
 * and session must be past FIRST_AD_AFTER_MINUTES.
 * @returns {boolean}
 */
export function shouldShowInterstitial() {
  if (!canShowAd()) return false;
  if (gameCount < ADS.INTERSTITIAL_EVERY_N_GAMES) return false;
  if (gameCount % ADS.INTERSTITIAL_EVERY_N_GAMES !== 0) return false;
  if (lastInterstitialTime > 0) {
    const elapsed = (Date.now() - lastInterstitialTime) / 1000 / 60;
    if (elapsed < ADS.FIRST_AD_AFTER_MINUTES) return false;
  }
  return true;
}
