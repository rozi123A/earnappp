/**
 * withdrawal-frontend.js
 *
 * كود JavaScript الخاص بزر السحب في Telegram WebApp.
 * يمكن دمجه مباشرة في index.html أو استيراده كملف منفصل.
 *
 * ── ما الذي يفعله هذا الكود ──
 *  1. يجلب معلومات السحب من الخادم (رصيد، cooldown، تاريخ).
 *  2. عند الضغط على زر السحب → يرسل POST /api/withdrawal/request.
 *  3. الخادم يُنشئ الطلب ويرسل إشعاراً فورياً للأدمن عبر Telegram Bot API.
 *  4. يُظهر للمستخدم رسالة تأكيد، ويتابع حالة الطلب.
 *  5. يمنع إرسال أكثر من طلب واحد قبل معالجة الطلب السابق (cooldown 24h).
 */

// ════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════
const STARS_RATE = 100;   // 100 نقطة = 1 Star (يجب أن يتطابق مع الخادم)
const API_BASE   = '';    // نفس الـ origin — عدّله إذا كان الـ backend على نطاق مختلف

// ════════════════════════════════════════
// STATE
// ════════════════════════════════════════
let wInfo              = null;   // بيانات السحب من /api/withdrawal/info
let _withdrawInFlight  = false;  // منع الضغط المتكرر
let wCooldownTimer     = null;   // مؤقت عداد الـ cooldown

// ════════════════════════════════════════
// API HELPER
// ════════════════════════════════════════
async function wApiFetch(path, options = {}) {
  const initData = window.Telegram?.WebApp?.initData ?? '';
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type':          'application/json',
      'x-telegram-init-data':  initData,
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'API error'), { status: res.status, data });
  return data;
}

// ════════════════════════════════════════
// LOAD WITHDRAWAL INFO
// يُستدعى عند تحميل الصفحة وبعد كل عملية.
// ════════════════════════════════════════
async function loadWithdrawalInfo() {
  try {
    wInfo = await wApiFetch('/api/withdrawal/info');
    renderWithdrawalUI();
  } catch (e) {
    console.error('[Withdrawal] Failed to load info:', e);
  }
}

// ════════════════════════════════════════
// RENDER UI
// ════════════════════════════════════════
function renderWithdrawalUI() {
  if (!wInfo) return;

  // تحديث عرض الرصيد
  const balanceEl = document.getElementById('balance-check-val');
  if (balanceEl) balanceEl.textContent = wInfo.balance + ' pts';

  // تحديث اللون بناءً على الرصيد الكافي
  updateBalanceCheck(getSelectedStars());

  // إدارة الـ cooldown
  const btn     = document.getElementById('withdraw-btn');
  const cdInfo  = document.getElementById('w-cooldown-info');

  if (wInfo.cooldown_remaining_ms > 0) {
    if (btn) btn.disabled = true;
    if (cdInfo) cdInfo.style.display = '';
    startWithdrawalCooldownUI(wInfo.cooldown_remaining_ms);
  } else {
    if (btn) btn.disabled = false;
    if (cdInfo) cdInfo.style.display = 'none';
    clearInterval(wCooldownTimer);
  }

  // رندر تاريخ طلبات السحب
  renderWithdrawalHistory(wInfo.history || []);
}

// ════════════════════════════════════════
// SLIDER CHANGE HANDLER
// يُستدعى عند تغيير قيمة الـ slider
// ════════════════════════════════════════
function onSliderChange(val) {
  val = parseInt(val, 10);
  const starsEl = document.getElementById('stars-display-val');
  const ptsEl   = document.getElementById('stars-pts-equiv');
  const btnLbl  = document.getElementById('withdraw-stars-label');

  if (starsEl) starsEl.textContent = val;
  if (ptsEl)   ptsEl.textContent   = `= ${val * STARS_RATE} points`;
  if (btnLbl)  btnLbl.textContent  = val + ' Stars';

  updateBalanceCheck(val);
}

function getSelectedStars() {
  return parseInt(document.getElementById('stars-range')?.value ?? '10', 10);
}

function updateBalanceCheck(stars) {
  const needed    = stars * STARS_RATE;
  const balance   = wInfo?.balance ?? 0;
  const el        = document.getElementById('balance-check-val');
  if (!el) return;
  el.textContent  = balance + ' pts';
  el.className    = 'balance-check-val ' + (balance >= needed ? 'ok' : 'bad');
}

// ════════════════════════════════════════
// COOLDOWN COUNTDOWN UI
// ════════════════════════════════════════
function startWithdrawalCooldownUI(remainingMs) {
  clearInterval(wCooldownTimer);
  const totalMs = 24 * 60 * 60 * 1000;
  const end     = Date.now() + remainingMs;

  function tick() {
    const left = end - Date.now();
    if (left <= 0) {
      clearInterval(wCooldownTimer);
      const cdInfo = document.getElementById('w-cooldown-info');
      const btn    = document.getElementById('withdraw-btn');
      if (cdInfo) cdInfo.style.display = 'none';
      if (btn)    btn.disabled = false;
      return;
    }
    const h   = Math.floor(left / 3_600_000);
    const m   = Math.floor((left % 3_600_000) / 60_000);
    const s   = Math.floor((left % 60_000) / 1000);
    const pad = n => String(n).padStart(2, '0');

    const label = document.getElementById('w-cooldown-label');
    const bar   = document.getElementById('w-cooldown-bar');
    if (label) label.textContent = `Next withdrawal in ${h}h ${pad(m)}m ${pad(s)}s`;
    if (bar)   bar.style.width   = Math.max(0, Math.min(100, (left / totalMs) * 100)) + '%';
  }

  tick();
  wCooldownTimer = setInterval(tick, 1000);
}

// ════════════════════════════════════════
// WITHDRAWAL HISTORY RENDER
// ════════════════════════════════════════
function renderWithdrawalHistory(history) {
  const container = document.getElementById('w-history-list');
  if (!container) return;

  if (!history.length) {
    container.innerHTML = '';
    return;
  }

  const statusLabels = {
    completed:  '✓ Completed',
    pending:    '⏳ Pending',
    processing: '⚙ Processing',
    failed:     '✗ Failed',
    cancelled:  '✗ Cancelled',
  };

  container.innerHTML = history.slice(0, 5).map(w => {
    const date = new Date(w.requested_at + 'Z').toLocaleDateString([], {
      month: 'short', day: 'numeric',
    });
    const label = statusLabels[w.status] || w.status;
    return `<div class="w-item">
      <div>
        <div style="font-size:14px;font-weight:700;color:var(--gold)">⭐ ${w.stars_amount} Stars</div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px">${esc(date)} · ${esc(w.points_deducted)} pts</div>
      </div>
      <span class="w-status ${esc(w.status)}">${esc(label)}</span>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════
// MAIN WITHDRAW HANDLER
// يُستدعى عند الضغط على زر "Withdraw"
//
// الخطوات:
//  1. التحقق من الرصيد والـ cooldown على جهة العميل (الخادم يعيد التحقق أيضاً)
//  2. عرض نافذة تأكيد Telegram
//  3. إرسال POST /api/withdrawal/request
//  4. الخادم يُنشئ الطلب ويُرسل إشعاراً للأدمن تلقائياً
//  5. عرض رسالة تأكيد للمستخدم
//  6. متابعة حالة الطلب بشكل دوري
// ════════════════════════════════════════
async function handleWithdraw() {
  if (_withdrawInFlight) return;

  const tg        = window.Telegram?.WebApp;
  const starsVal  = getSelectedStars();
  const pointsVal = starsVal * STARS_RATE;
  const balance   = wInfo?.balance ?? 0;

  // ── التحقق على جهة العميل ──
  if (balance < pointsVal) {
    showWithdrawToast(`Need ${pointsVal} pts. You have ${balance}.`, 'warning');
    return;
  }
  if (wInfo?.cooldown_remaining_ms > 0) {
    showWithdrawToast('Withdrawal cooldown active. Please wait.', 'warning');
    return;
  }

  // ── تأكيد عبر Telegram native popup ──
  if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
  let confirmed = false;
  try {
    await new Promise((resolve, reject) => {
      if (tg?.showConfirm) {
        tg.showConfirm(
          `Withdraw ${starsVal} ⭐ Stars for ${pointsVal} points?\n\nCooldown: 24 hours after withdrawal.`,
          ok => { if (ok) { confirmed = true; resolve(); } else reject(new Error('cancelled')); }
        );
      } else {
        // Fallback for non-Telegram environments
        if (window.confirm(`Withdraw ${starsVal} Stars for ${pointsVal} points?`)) {
          confirmed = true;
          resolve();
        } else {
          reject(new Error('cancelled'));
        }
      }
    });
  } catch {
    return; // المستخدم ألغى العملية
  }

  // ── تفعيل حالة التحميل ──
  _withdrawInFlight = true;
  const btn = document.getElementById('withdraw-btn');
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = '<span class="spinner" style="border-top-color:#000;width:16px;height:16px;display:inline-block;border:2px solid rgba(0,0,0,0.2);border-radius:50%;animation:spin 0.6s linear infinite"></span> Processing…';
  }

  // ── إنشاء مفتاح idempotency (UUID) — آمن للإعادة ──
  const idempotencyKey = generateUUID();

  try {
    const result = await wApiFetch('/api/withdrawal/request', {
      method: 'POST',
      body: JSON.stringify({
        points:          pointsVal,
        idempotency_key: idempotencyKey,
      }),
    });

    // ── النجاح ──
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    showWithdrawToast(
      'تم إرسال طلب السحب بنجاح، سيتم مراجعته قريباً. ⭐',
      'success'
    );

    // تحديث بيانات السحب والرصيد
    await loadWithdrawalInfo();
    const me = await wApiFetch('/api/me').catch(() => null);
    if (me && typeof renderAll === 'function') renderAll(me);

    // متابعة حالة الطلب في الخلفية
    if (result.withdrawal_id) {
      pollWithdrawalStatus(result.withdrawal_id);
    }

  } catch (err) {
    if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
    const msg = err.data?.error || err.message || 'Withdrawal failed.';

    if (err.status === 429) {
      showWithdrawToast(msg, 'warning');
      await loadWithdrawalInfo();
    } else {
      showWithdrawToast(msg, 'error');
      if (btn) btn.disabled = false;
    }
  } finally {
    _withdrawInFlight = false;
    if (btn) {
      btn.innerHTML = `⭐ Withdraw <span id="withdraw-stars-label">${starsVal} Stars</span>`;
    }
  }
}

// ════════════════════════════════════════
// POLL WITHDRAWAL STATUS
// يتابع حالة الطلب حتى يكتمل أو يفشل
// ════════════════════════════════════════
async function pollWithdrawalStatus(withdrawalId, maxAttempts = 8, intervalMs = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(intervalMs);
    try {
      const w = await wApiFetch(`/api/withdrawal/status/${withdrawalId}`);
      if (w.status === 'completed') {
        showWithdrawToast('⭐ Stars sent! Check your Telegram wallet.', 'success');
        await loadWithdrawalInfo();
        return;
      }
      if (w.status === 'failed') {
        showWithdrawToast('Withdrawal failed — points refunded to your balance.', 'error');
        const me = await wApiFetch('/api/me').catch(() => null);
        if (me && typeof renderAll === 'function') renderAll(me);
        await loadWithdrawalInfo();
        return;
      }
    } catch (_) { /* تجاهل أخطاء الـ polling */ }
  }
}

// ════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════
function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Toast محلي للسحب (يستخدم دالة showToast الموجودة أو يعرض alert)
function showWithdrawToast(msg, type) {
  if (typeof showToast === 'function') {
    showToast(msg, type);
  } else {
    alert(msg);
  }
}

// ════════════════════════════════════════
// AUTO-INIT
// يُشغَّل تلقائياً عند تحميل الصفحة
// ════════════════════════════════════════
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadWithdrawalInfo);
} else {
  loadWithdrawalInfo();
}
