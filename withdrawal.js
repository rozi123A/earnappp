/**
 * withdrawal.js — Secure Telegram Stars Withdrawal System
 * [التعديل المضاف]: دالة notifyAdmin لإرسال إشعار فوري للأدمن عند كل طلب سحب.
 */

import crypto from 'crypto';

// ── Constants ────────────────────────────────────────────────────────────────
export const STARS_RATE          = 100;
export const MIN_WITHDRAWAL_PTS  = 1000;
export const MAX_WITHDRAWAL_PTS  = 4500;
export const MIN_STARS           = MIN_WITHDRAWAL_PTS / STARS_RATE;
export const MAX_STARS           = MAX_WITHDRAWAL_PTS / STARS_RATE;
export const WITHDRAWAL_COOLDOWN = 24 * 60 * 60 * 1000;

const TELEGRAM_API = 'https://api.telegram.org';

// ── Database schema ───────────────────────────────────────────────────────────
export function initWithdrawalSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id      TEXT    NOT NULL,
      points_deducted  INTEGER NOT NULL,
      stars_amount     INTEGER NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'pending',
      idempotency_key  TEXT    UNIQUE NOT NULL,
      tg_payment_id    TEXT,
      failure_reason   TEXT,
      requested_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      processed_at     TEXT,
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
    );

    CREATE INDEX IF NOT EXISTS idx_withdrawals_user
      ON withdrawals(telegram_id);

    CREATE INDEX IF NOT EXISTS idx_withdrawals_status
      ON withdrawals(status);
  `);

  return {
    getLastWithdrawal: db.prepare(`
      SELECT * FROM withdrawals
      WHERE telegram_id = ? AND status NOT IN ('failed','cancelled')
      ORDER BY requested_at DESC LIMIT 1
    `),
    getDailyCount: db.prepare(`
      SELECT COUNT(*) as cnt FROM withdrawals
      WHERE telegram_id = ?
        AND status NOT IN ('failed','cancelled')
        AND date(requested_at) = date('now')
    `),
    insertWithdrawal: db.prepare(`
      INSERT INTO withdrawals
        (telegram_id, points_deducted, stars_amount, idempotency_key)
      VALUES (@telegram_id, @points_deducted, @stars_amount, @idempotency_key)
    `),
    updateWithdrawalStatus: db.prepare(`
      UPDATE withdrawals
      SET status = @status, tg_payment_id = @tg_payment_id,
          failure_reason = @failure_reason, processed_at = datetime('now')
      WHERE id = @id
    `),
    getWithdrawalById: db.prepare('SELECT * FROM withdrawals WHERE id = ?'),
    getWithdrawalByKey: db.prepare(
      'SELECT * FROM withdrawals WHERE idempotency_key = ?'
    ),
    getUserWithdrawals: db.prepare(`
      SELECT id, stars_amount, points_deducted, status, requested_at, processed_at
      FROM withdrawals WHERE telegram_id = ?
      ORDER BY requested_at DESC LIMIT 10
    `),
  };
}

// ── Withdrawal validation ─────────────────────────────────────────────────────
export function validateWithdrawal(user, pointsRequested, stmts) {
  if (
    !Number.isInteger(pointsRequested) ||
    pointsRequested < MIN_WITHDRAWAL_PTS ||
    pointsRequested > MAX_WITHDRAWAL_PTS
  ) {
    return {
      ok: false,
      code: 400,
      error: `Withdrawal must be between ${MIN_WITHDRAWAL_PTS} and ${MAX_WITHDRAWAL_PTS} points ` +
             `(${MIN_STARS}–${MAX_STARS} Stars).`,
    };
  }

  if (user.balance < pointsRequested) {
    return {
      ok: false,
      code: 400,
      error: `Insufficient balance. You have ${user.balance} points, need ${pointsRequested}.`,
    };
  }

  const lastW = stmts.getLastWithdrawal.get(user.telegram_id);
  if (lastW) {
    const elapsed = Date.now() - new Date(lastW.requested_at + 'Z').getTime();
    if (elapsed < WITHDRAWAL_COOLDOWN) {
      const waitH = Math.ceil((WITHDRAWAL_COOLDOWN - elapsed) / 3_600_000);
      return {
        ok: false,
        code: 429,
        error: `Withdrawal cooldown active. Try again in ${waitH} hour(s).`,
        wait_ms: WITHDRAWAL_COOLDOWN - elapsed,
      };
    }
  }

  const { cnt } = stmts.getDailyCount.get(user.telegram_id);
  if (cnt >= 1) {
    return {
      ok: false,
      code: 429,
      error: 'You have already withdrawn today. Come back tomorrow.',
    };
  }

  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// [جديد] notifyAdmin — إرسال إشعار فوري للأدمن عبر Telegram Bot API
//
// يُستدعى مباشرة بعد إنشاء طلب السحب في index.js.
// يرسل رسالة منسّقة تحتوي على جميع بيانات الطلب.
//
// @param {string} botToken        توكن البوت
// @param {string} adminChatId     Chat ID الخاص بالأدمن (من متغير البيئة ADMIN_CHAT_ID)
// @param {object} withdrawalData  بيانات الطلب
// @param {object} user            بيانات المستخدم من قاعدة البيانات
// ══════════════════════════════════════════════════════════════════════════════
export async function notifyAdmin(botToken, adminChatId, withdrawalData, user) {
  if (!adminChatId) {
    console.warn('[Admin Notify] ADMIN_CHAT_ID is not set — skipping admin notification.');
    return;
  }

  const { withdrawalId, starsAmount, pointsRequested } = withdrawalData;

  // تنسيق وقت الطلب بتوقيت UTC
  const now = new Date();
  const timeStr = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // بناء نص الرسالة
  const username    = user.username  ? `@${user.username}` : '_(no username)_';
  const displayName = user.first_name || 'Unknown';

  const text =
    `🚨 *Withdrawal Request*\n\n` +
    `👤 *User:* ${escapeMd(displayName)} ${escapeMd(username)}\n` +
    `🆔 *User ID:* \`${user.telegram_id}\`\n` +
    `💰 *Points:* ${pointsRequested.toLocaleString()}\n` +
    `⭐ *Stars Requested:* ${starsAmount}\n` +
    `🕐 *Time:* ${timeStr}\n` +
    `🔖 *Withdrawal ID:* #${withdrawalId}\n\n` +
    `_Review in the admin dashboard or process manually._`;

  // إنشاء أزرار inline للأدمن (اختياري — يمكن حذفها إذا لم تكن تستخدم webhook)
  const replyMarkup = {
    inline_keyboard: [[
      {
        text: '✅ View in Dashboard',
        url: `${process.env.ADMIN_URL || 'https://your-server.com'}/admin`,
      },
    ]],
  };

  try {
    const res = await telegramPost(botToken, 'sendMessage', {
      chat_id:    adminChatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup,
    });

    if (res.ok) {
      console.log(`[Admin Notify] ✓ Notified admin for withdrawal #${withdrawalId}`);
    } else {
      console.error(`[Admin Notify] ✗ Telegram API error:`, res.description);
    }
  } catch (err) {
    // لا نوقف العملية إذا فشل الإشعار — الطلب تم إنشاؤه بالفعل
    console.error('[Admin Notify] ✗ Failed to send admin notification:', err.message);
  }
}

// ── Stars payout via Telegram Bot API ────────────────────────────────────────
export async function sendStarsToUser(botToken, telegramUserId, starsAmount, withdrawalId) {
  try {
    const pushRes = await telegramPost(botToken, 'giveStars', {
      user_id:    telegramUserId,
      star_count: starsAmount,
    });

    if (pushRes.ok) {
      return {
        ok:         true,
        payment_id: pushRes.result?.payment_charge_id ?? `give_${withdrawalId}`,
        method:     'giveStars',
      };
    }
    console.warn('[Withdrawal] giveStars not available:', pushRes.description);
  } catch (err) {
    console.warn('[Withdrawal] giveStars call failed:', err.message);
  }

  try {
    const invoiceRes = await telegramPost(botToken, 'sendMessage', {
      chat_id:    telegramUserId,
      text:
        `🌟 *Stars Withdrawal Ready!*\n\n` +
        `You requested a withdrawal of *${starsAmount} Telegram Stars*.\n\n` +
        `Your Stars have been queued for transfer. Payouts are processed within 24 hours.\n\n` +
        `_Withdrawal ID: #${withdrawalId}_`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{
          text: `⭐ Claim ${starsAmount} Stars`,
          url:  `https://t.me/${process.env.BOT_USERNAME || 'your_bot'}?start=claim_${withdrawalId}`,
        }]],
      },
    });

    if (invoiceRes.ok) {
      return {
        ok:         true,
        payment_id: `msg_${invoiceRes.result?.message_id}`,
        method:     'notification_queued',
        note:       'Stars queued for manual/Fragment payout. User notified.',
      };
    }

    return {
      ok:     false,
      method: 'notification_failed',
      error:  invoiceRes.description || 'Could not send Telegram message.',
    };
  } catch (err) {
    return { ok: false, method: 'error', error: err.message };
  }
}

// ── Atomic withdrawal transaction ─────────────────────────────────────────────
export function createWithdrawalAtomic(db, stmts, telegramId, pointsRequested, starsAmount, idempotencyKey) {
  const deductPoints = db.prepare(
    'UPDATE users SET balance = balance - ? WHERE telegram_id = ? AND balance >= ?'
  );

  const tx = db.transaction(() => {
    const result = deductPoints.run(pointsRequested, telegramId, pointsRequested);
    if (result.changes === 0) {
      throw new Error('Insufficient balance (race condition prevented).');
    }

    stmts.insertWithdrawal.run({
      telegram_id:     telegramId,
      points_deducted: pointsRequested,
      stars_amount:    starsAmount,
      idempotency_key: idempotencyKey,
    });

    return db.prepare('SELECT last_insert_rowid() as id').get().id;
  });

  return tx();
}

// ── Telegram API helper ───────────────────────────────────────────────────────
async function telegramPost(botToken, method, body) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.json();
}

// ── MarkdownV2 escape helper ──────────────────────────────────────────────────
function escapeMd(str) {
  return String(str || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ── Points ↔ Stars converter ──────────────────────────────────────────────────
export function pointsToStars(points) {
  return Math.floor(points / STARS_RATE);
}

export function starsToPoints(stars) {
  return stars * STARS_RATE;
}
