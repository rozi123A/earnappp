/**
 * app.js — EarnApp Frontend
 *
 * Responsibilities:
 *  1. Telegram WebApp initialization + theme sync
 *  2. User authentication via initData
 *  3. Display user info, points, progress
 *  4. Ad watch flow with SSV-based HMAC reward tokens
 *  5. Cooldown management (server + client)
 *  6. Withdrawal modal open/close wiring
 *  7. "Open in Telegram" button
 */

'use strict';

// ════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════
const BOT_USERNAME  = window.__BOT_USERNAME__ || 'YOUR_BOT_USERNAME';  // injected by server or set manually
const API_BASE      = '';  // same origin
const DAILY_LIMIT   = 50;
const COOLDOWN_MS   = 30_000;
const SSV_POLL_INTERVAL = 1_500;   // ms between polls for SSV token
const SSV_POLL_MAX      = 40;       // max poll attempts (~60s)

// ════════════════════════════════════════
// TELEGRAM WEBAPP INIT
// ════════════════════════════════════════
const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();

  // Sync Telegram color scheme to CSS if provided
  if (tg.themeParams?.bg_color) {
    // Keep our custom dark theme — just ensure expansion
  }
}

// ════════════════════════════════════════
// STATE
// ════════════════════════════════════════
let _user           = null;        // user data from /api/me
let _adInFlight     = false;       // prevent double-taps
let _cooldownEnd    = 0;           // timestamp when cooldown ends
let _cooldownTimer  = null;        // setInterval handle
let _currentNonce   = null;        // SSV nonce for current ad

// ════════════════════════════════════════
// API HELPER
// ════════════════════════════════════════
async function apiFetch(path, options = {}) {
  const initData = tg?.initData ?? '';
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type':         'application/json',
      'x-telegram-init-data': initData,
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(new Error(data.error || `HTTP ${res.status}`), {
      status: res.status,
      data,
    });
    throw err;
  }
  return data;
}

// ════════════════════════════════════════
// INIT — runs on DOMContentLoaded
// ════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  setupButtons();
  await initApp();
});

async function initApp() {
  try {
    const user = await apiFetch('/api/me');
    _user = user;
    renderAll(user);
    loadWithdrawalInfo();          // from withdrawal-frontend.js
  } catch (err) {
    console.error('[App] Init failed:', err);
    showToast('Failed to load. Please restart the app.', 'error');
  } finally {
    hideLoadingScreen();
  }
}

// ════════════════════════════════════════
// RENDER
// ════════════════════════════════════════
function renderAll(user) {
  _user = user;

  // Name + avatar
  const name = user.first_name || user.username || 'User';
  el('user-name').textContent   = name;
  el('user-avatar').textContent = (name[0] || '?').toUpperCase();

  // Points
  animateNumber(el('points-num'), parseInt(el('points-num').textContent) || 0, user.balance);
  el('ads-watched').textContent = user.ads_watched || 0;
  el('pts-today').textContent   = user.pts_today   || 0;
  el('stars-equiv').textContent = `${Math.floor((user.balance || 0) / 100)} ⭐`;

  // Withdraw badge
  el('balance-badge').textContent = (user.balance || 0) + ' pts';

  // Daily progress
  const today   = user.pts_today || 0;
  const pct     = Math.min(100, (today / DAILY_LIMIT) * 100);
  el('progress-fill').style.width = pct + '%';
  el('progress-text').textContent = `${today} / ${DAILY_LIMIT} pts`;
}

// Smooth number animation
function animateNumber(el, from, to, duration = 600) {
  if (from === to) return;
  const start = performance.now();
  const range = to - from;
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 400);

  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const ease = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + range * ease);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = to;
  }
  requestAnimationFrame(tick);
}

// ════════════════════════════════════════
// BUTTON SETUP
// ════════════════════════════════════════
function setupButtons() {
  // Watch Ad
  el('watch-ad-btn').addEventListener('click', handleWatchAd);

  // Open in Telegram
  el('tg-open-btn').addEventListener('click', openInTelegram);

  // Withdraw modal
  el('open-withdraw-btn').addEventListener('click', openWithdrawModal);
  el('modal-close').addEventListener('click', closeWithdrawModal);
  el('withdraw-modal').addEventListener('click', e => {
    if (e.target === el('withdraw-modal')) closeWithdrawModal();
  });
}

// ════════════════════════════════════════
// OPEN IN TELEGRAM
// ════════════════════════════════════════
function openInTelegram() {
  const url = `https://t.me/${BOT_USERNAME}?startapp=1`;
  if (tg) {
    tg.openTelegramLink(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// ════════════════════════════════════════
// WATCH AD FLOW
//
// Full secure flow:
//  1. Generate a nonce (random UUID)
//  2. Show the rewarded ad (AdMob / Adsgram)
//     - custom_data = `${telegram_id}:${nonce}` passed to the ad SDK
//  3. On ad completion callback (onUserEarnedReward), poll /api/pending-reward
//     - Server receives the SSV callback from AdMob and stores a token keyed by nonce
//  4. Once we have the HMAC reward_token, POST /api/reward
// ════════════════════════════════════════
async function handleWatchAd() {
  if (_adInFlight || !_user) return;

  // Check client-side cooldown
  if (_cooldownEnd > Date.now()) {
    showToast('Please wait for the cooldown to finish.', 'warning');
    return;
  }

  _adInFlight = true;
  setAdBtnState('loading');

  try {
    if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');

    const nonce = generateUUID();
    _currentNonce = nonce;

    // ── If Adsgram SDK is available, use it ──────────────────────────────────
    if (window.Adsgram) {
      await watchAdsgramAd(nonce);
    } else {
      // ── Fallback: simulate an ad for dev/testing ──────────────────────────
      await simulateAdForTesting(nonce);
    }

  } catch (err) {
    console.error('[Ad] Error:', err);
    const msg = err.data?.error || err.message || 'Ad failed. Please try again.';
    showToast(msg, err.status === 429 ? 'warning' : 'error');
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
  } finally {
    _adInFlight = false;
    setAdBtnState('idle');
  }
}

// ── Adsgram integration ───────────────────────────────────────────────────────
async function watchAdsgramAd(nonce) {
  const telegramId = tg?.initDataUnsafe?.user?.id;
  const customData = `${telegramId}:${nonce}`;

  const ad = window.Adsgram.init({
    blockId:    window.__ADSGRAM_BLOCK_ID__ || 'your-block-id',
    customData,
  });

  await new Promise((resolve, reject) => {
    ad.show()
      .then(async () => {
        // Ad completed — poll for SSV token
        const rewardToken = await pollForRewardToken(nonce);
        if (!rewardToken) throw new Error('Ad reward verification timed out.');
        await claimReward(rewardToken);
        resolve();
      })
      .catch(err => {
        if (err?.type === 'AdSkipped' || err?.type === 'AdClosed') {
          showToast('Watch the full ad to earn points.', 'warning');
          resolve();
        } else {
          reject(err);
        }
      });
  });
}

// ── Dev/test fallback: ask server to issue a test reward token ───────────────
async function simulateAdForTesting(nonce) {
  // In production this would never be called — only for localhost/dev
  // The server issues a real HMAC token through the normal SSV flow.
  // For development we bypass SSV and get a dev token directly.
  showToast('Simulating ad (dev mode)…', 'warning');

  // Fake a 2s ad watch
  await sleep(2000);

  // Ask server for a dev reward token (server must have DEV_MODE=true)
  try {
    const res = await apiFetch(`/api/dev/reward-token?nonce=${nonce}`);
    if (res.reward_token) {
      await claimReward(res.reward_token);
    } else {
      showToast('Ad simulation not available.', 'warning');
    }
  } catch {
    // Dev endpoint not available — show info
    showToast('Watch a real ad to earn points.', 'warning');
  }
}

// ── Poll /api/pending-reward until the SSV token arrives ─────────────────────
async function pollForRewardToken(nonce, attempts = SSV_POLL_MAX) {
  for (let i = 0; i < attempts; i++) {
    await sleep(SSV_POLL_INTERVAL);
    try {
      const res = await apiFetch(`/api/pending-reward?nonce=${encodeURIComponent(nonce)}`);
      if (res.reward_token) return res.reward_token;
      // res.pending === true → keep polling
    } catch {
      // transient error — keep polling
    }
  }
  return null;
}

// ── POST /api/reward with the HMAC token ─────────────────────────────────────
async function claimReward(rewardToken) {
  const result = await apiFetch('/api/reward', {
    method: 'POST',
    body: JSON.stringify({ reward_token: rewardToken }),
  });

  if (result.ok && result.user) {
    renderAll(result.user);
    startCooldown(COOLDOWN_MS);

    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    showToast('+1 point earned! 🎉', 'success');
  }
}

// ════════════════════════════════════════
// COOLDOWN UI
// ════════════════════════════════════════
function startCooldown(ms) {
  _cooldownEnd = Date.now() + ms;
  el('cooldown-container').style.display = '';
  el('watch-ad-btn').disabled = true;
  clearInterval(_cooldownTimer);

  function tick() {
    const left = _cooldownEnd - Date.now();
    if (left <= 0) {
      clearInterval(_cooldownTimer);
      el('cooldown-container').style.display = 'none';
      el('watch-ad-btn').disabled = false;
      el('cooldown-label').textContent = '';
      return;
    }
    const secs = Math.ceil(left / 1000);
    el('cooldown-label').textContent = `Next ad in ${secs}s`;
    el('cooldown-fill').style.width = Math.max(0, (left / ms) * 100) + '%';
  }
  tick();
  _cooldownTimer = setInterval(tick, 500);
}

// ════════════════════════════════════════
// AD BUTTON STATE
// ════════════════════════════════════════
function setAdBtnState(state) {
  const btn = el('watch-ad-btn');
  if (state === 'loading') {
    btn.disabled = true;
    btn.querySelector('.btn-text').textContent = 'Loading Ad…';
    btn.querySelector('.btn-icon').innerHTML =
      '<span class="spinner"></span>';
  } else {
    btn.disabled = _cooldownEnd > Date.now();
    btn.querySelector('.btn-text').textContent = 'Watch Ad';
    btn.querySelector('.btn-icon').innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>`;
  }
}

// ════════════════════════════════════════
// WITHDRAWAL MODAL
// ════════════════════════════════════════
function openWithdrawModal() {
  el('withdraw-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
  // Refresh withdrawal info
  loadWithdrawalInfo();
}

function closeWithdrawModal() {
  el('withdraw-modal').style.display = 'none';
  document.body.style.overflow = '';
}

// ════════════════════════════════════════
// TOAST
// ════════════════════════════════════════
let _toastTimer = null;

function showToast(msg, type = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    t.className = 'toast';
  }, 3500);
}

// ════════════════════════════════════════
// LOADING SCREEN
// ════════════════════════════════════════
function hideLoadingScreen() {
  const ls  = el('loading-screen');
  const app = el('app');
  ls.classList.add('hidden');
  app.style.display = '';
  setTimeout(() => ls.remove(), 500);
}

// ════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════
function el(id) { return document.getElementById(id); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

// Expose renderAll globally so withdrawal-frontend.js can call it
window.renderAll = renderAll;
window.showToast = showToast;
window.openWithdrawModal  = openWithdrawModal;
window.closeWithdrawModal = closeWithdrawModal;
