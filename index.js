/**
 * EarnApp — Secure Server (Hardened)
 *
 * Key additions over the original:
 *  1. AdMob Server-Side Verification (SSV) callback endpoint
 *  2. HMAC-signed reward tokens so /api/reward can't be called without a real SSV
 *  3. auth_date expiry check (reject stale Telegram initData)
 *  4. Per-user in-memory fast-reward detection + DB suspicious_log table
 *  5. Stricter IP + per-user rate limiting on the reward path
 *  6. Strict CORS — no wildcard in production
 */

import express    from 'express';
import cors       from 'cors';
import helmet     from 'helmet';
import rateLimit  from 'express-rate-limit';
import Database   from 'better-sqlite3';
import crypto     from 'crypto';
import path       from 'path';
import { fileURLToPath } from 'url';
import { verifyTelegramInitData, extractUser } from './auth.js';
import { mountAdminRoutes, requireAdmin } from './admin.js';
import {
  initWithdrawalSchema,
  validateWithdrawal,
  notifyAdmin,
  sendStarsToUser,
  createWithdrawalAtomic,
  pointsToStars,
  MIN_WITHDRAWAL_PTS,
  MAX_WITHDRAWAL_PTS,
  MIN_STARS,
  MAX_STARS,
  WITHDRAWAL_COOLDOWN,
} from './withdrawal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ════════════════════════════════════════
// CONFIG  (all values come from .env)
// ════════════════════════════════════════
const PORT              = process.env.PORT              || 3000;
const BOT_TOKEN         = process.env.BOT_TOKEN         || '';
const ADMOB_SSV_KEY_URL = process.env.ADMOB_SSV_KEY_URL || 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const REWARD_HMAC_KEY   = process.env.REWARD_HMAC_KEY   || '';   // 32+ random bytes, hex-encoded
const COOLDOWN_MS       = parseInt(process.env.COOLDOWN_MS  || '30000');  // 30 s between ads
const DAILY_LIMIT       = parseInt(process.env.DAILY_LIMIT  || '50');
const PTS_PER_AD        = parseInt(process.env.PTS_PER_AD   || '1');
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN    || '';   // must be set in prod
const INITDATA_MAX_AGE  = parseInt(process.env.INITDATA_MAX_AGE || '86400'); // 24 h
const ADMIN_CHAT_ID     = process.env.ADMIN_CHAT_ID     || '';   // Chat ID of the admin — REQUIRED for withdrawal notifications

// Fail fast on missing secrets
for (const [k, v] of [
  ['BOT_TOKEN',       BOT_TOKEN],
  ['REWARD_HMAC_KEY', REWARD_HMAC_KEY],
]) {
  if (!v) { console.error(`[FATAL] ${k} environment variable is not set.`); process.exit(1); }
}

if (!ALLOWED_ORIGIN) {
  console.warn('[WARN] ALLOWED_ORIGIN is not set — defaulting to * (insecure for production)');
}

// ════════════════════════════════════════
// DATABASE
// ════════════════════════════════════════
const db = new Database(path.join(__dirname, 'earnapp.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id   TEXT PRIMARY KEY,
    username      TEXT,
    first_name    TEXT,
    balance       INTEGER NOT NULL DEFAULT 0,
    ads_watched   INTEGER NOT NULL DEFAULT 0,
    pts_today     INTEGER NOT NULL DEFAULT 0,
    last_date     TEXT    NOT NULL DEFAULT '',
    last_reward   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reward_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id    TEXT    NOT NULL,
    pts            INTEGER NOT NULL,
    ssv_token_hash TEXT,                          -- SHA-256 of the used SSV token (deduplication)
    rewarded_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS suspicious_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id   TEXT,
    ip            TEXT,
    reason        TEXT    NOT NULL,
    detail        TEXT,
    logged_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Prevent the same SSV token from being replayed
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_log_token
    ON reward_log(ssv_token_hash)
    WHERE ssv_token_hash IS NOT NULL;
`);

const stmts = {
  getUser:    db.prepare('SELECT * FROM users WHERE telegram_id = ?'),
  upsertUser: db.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (@telegram_id, @username, @first_name)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username   = excluded.username,
      first_name = excluded.first_name
  `),
  addReward: db.prepare(`
    UPDATE users
    SET balance     = balance + @pts,
        ads_watched = ads_watched + 1,
        pts_today   = CASE WHEN last_date = @today THEN pts_today + @pts ELSE @pts END,
        last_date   = @today,
        last_reward = @now
    WHERE telegram_id = @telegram_id
  `),
  logReward: db.prepare(`
    INSERT INTO reward_log (telegram_id, pts, ssv_token_hash)
    VALUES (@telegram_id, @pts, @ssv_token_hash)
  `),
  logSuspicious: db.prepare(`
    INSERT INTO suspicious_log (telegram_id, ip, reason, detail)
    VALUES (@telegram_id, @ip, @reason, @detail)
  `),
  tokenUsed: db.prepare(
    'SELECT id FROM reward_log WHERE ssv_token_hash = ?'
  ),
};

const rewardTx = db.transaction((telegram_id, pts, today, now, tokenHash) => {
  stmts.addReward.run({ telegram_id, pts, today, now });
  stmts.logReward.run({ telegram_id, pts, ssv_token_hash: tokenHash });
});

// ── Withdrawal statements (from withdrawal module) ──
const wStmts = initWithdrawalSchema(db);

// ════════════════════════════════════════
// AdMob SSV KEY CACHE
// Keys rotate rarely; we refresh once per hour.
// ════════════════════════════════════════
let admobKeys    = null;   // Map<keyId, publicKeyPem>
let admobKeysFetched = 0;

async function getAdmobKeys() {
  if (admobKeys && Date.now() - admobKeysFetched < 3_600_000) return admobKeys;
  const res  = await fetch(ADMOB_SSV_KEY_URL);
  const json = await res.json();
  admobKeys = new Map(
    (json.keys || []).map(k => [String(k.keyId), k.pem])
  );
  admobKeysFetched = Date.now();
  return admobKeys;
}

// ════════════════════════════════════════
// HMAC REWARD TOKEN HELPERS
//
// Flow:
//   1. AdMob calls GET /admob/ssv → we verify signature, issue a short-lived
//      HMAC token tied to {telegram_id, reward_amount, nonce}.
//   2. Frontend receives that token and passes it to POST /api/reward.
//   3. Server verifies the HMAC, checks it hasn't been replayed, then credits.
// ════════════════════════════════════════
const HMAC_KEY    = Buffer.from(REWARD_HMAC_KEY, 'hex');
const TOKEN_TTL   = 120_000;  // token expires in 2 minutes

function issueRewardToken(telegramId, amount, nonce) {
  const payload = JSON.stringify({
    tid: telegramId,
    amt: amount,
    nonce,
    exp: Date.now() + TOKEN_TTL,
  });
  const sig = crypto.createHmac('sha256', HMAC_KEY).update(payload).digest('hex');
  // token = base64(payload).sig
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

function verifyRewardToken(token) {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;

    const expectedSig = crypto.createHmac('sha256', HMAC_KEY)
      .update(Buffer.from(b64, 'base64url').toString())
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      return null;  // forged token
    }

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (Date.now() > payload.exp) return null;  // expired
    return payload;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════
// EXPRESS APP
// ════════════════════════════════════════
const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", 'telegram.org', 'sad.adsgram.ai'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '../public')));

app.use(cors({
  origin:  ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));

// Global rate limiter
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));

// Tight limit on reward endpoint
const rewardLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,   // reduced from 20 → 10 requests per minute per IP
  message: { error: 'Too many reward requests.' },
});

// Very tight limit on withdrawal — 3 attempts per 10 min per IP
const withdrawalLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 3,
  message: { error: 'Too many withdrawal requests. Please wait.' },
  keyGenerator: (req) => {
    // Key by IP + telegram_id (set after auth middleware runs)
    const tid = req.tgUser?.id ? String(req.tgUser.id) : 'unknown';
    return getIP(req) + ':' + tid;
  },
});

// ════════════════════════════════════════
// PER-USER IN-MEMORY RAPID-REQUEST TRACKER
// ════════════════════════════════════════
const recentRewardTimes = new Map();   // telegram_id → [timestamps]
const RAPID_WINDOW_MS   = 60_000;
const RAPID_MAX_CALLS   = 5;          // >5 reward attempts in 1 min → suspicious

function trackAndCheckRapid(telegramId) {
  const now   = Date.now();
  const times = (recentRewardTimes.get(telegramId) || [])
    .filter(t => now - t < RAPID_WINDOW_MS);
  times.push(now);
  recentRewardTimes.set(telegramId, times);
  return times.length > RAPID_MAX_CALLS;
}

// ════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════
function requireTelegramAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || '';
  if (!initData) return res.status(401).json({ error: 'Missing Telegram auth.' });

  const valid = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!valid) {
    flagSuspicious(null, getIP(req), 'INVALID_TELEGRAM_SIG', initData.slice(0, 80));
    return res.status(403).json({ error: 'Invalid Telegram signature.' });
  }

  // ── auth_date expiry check ──
  const params   = new URLSearchParams(initData);
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || (Math.floor(Date.now() / 1000) - authDate) > INITDATA_MAX_AGE) {
    return res.status(403).json({ error: 'Telegram session expired. Please restart the app.' });
  }

  const user = extractUser(initData);
  if (!user?.id) return res.status(403).json({ error: 'Could not extract Telegram user.' });

  req.tgUser = user;
  next();
}

// ── Pending SSV tokens (in-memory, short-lived) ──────────────────
// When /admob/ssv is called, we store the token here keyed by nonce.
// The frontend polls /api/pending-reward to retrieve it.
const pendingTokens = new Map();   // nonce → { token, expires }
const PENDING_TTL   = 180_000;     // 3 minutes

function storePendingToken(nonce, token) {
  pendingTokens.set(nonce, { token, expires: Date.now() + PENDING_TTL });
  // Prune expired entries periodically
  if (pendingTokens.size > 1000) {
    for (const [k, v] of pendingTokens) {
      if (Date.now() > v.expires) pendingTokens.delete(k);
    }
  }
}

function consumePendingToken(nonce) {
  const entry = pendingTokens.get(nonce);
  if (!entry || Date.now() > entry.expires) { pendingTokens.delete(nonce); return null; }
  pendingTokens.delete(nonce);  // consume once
  return entry.token;
}

// ════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════

/**
 * GET /api/me
 */
app.get('/api/me', requireTelegramAuth, (req, res) => {
  const { id, username, first_name } = req.tgUser;
  const tid = String(id);
  stmts.upsertUser.run({ telegram_id: tid, username: username || null, first_name: first_name || null });
  res.json(sanitiseUser(stmts.getUser.get(tid)));
});

/**
 * GET /api/pending-reward?nonce=<nonce>
 *
 * Frontend polls this after onUserEarnedReward fires.
 * Returns the HMAC reward token once the SSV callback has been received.
 * The token is consumed (deleted) on first successful retrieval.
 */
app.get('/api/pending-reward', requireTelegramAuth, (req, res) => {
  const nonce = req.query.nonce;
  if (!nonce || typeof nonce !== 'string' || nonce.length > 100) {
    return res.status(400).json({ error: 'Missing or invalid nonce.' });
  }
  const token = consumePendingToken(nonce);
  if (!token) {
    // Not ready yet — frontend should retry
    return res.status(202).json({ pending: true });
  }
  res.json({ reward_token: token });
});

/**
 * GET /admob/ssv
 *
 * AdMob calls this URL after the user finishes watching a rewarded ad.
 * https://developers.google.com/admob/android/rewarded-video-ssv
 *
 * Query params (from AdMob):
 *   ad_network, ad_unit, custom_data (we put telegram_id here),
 *   key_id, reward_amount, reward_item, timestamp, transaction_id, user_id, signature
 *
 * We verify the ECDSA signature, then issue an HMAC reward token that the
 * frontend can use to call POST /api/reward.
 */
app.get('/admob/ssv', async (req, res) => {
  try {
    const q = req.query;

    // 1. Extract required fields
    const { signature, key_id, reward_amount, custom_data, transaction_id } = q;
    if (!signature || !key_id || !reward_amount || !custom_data || !transaction_id) {
      return res.status(400).send('Missing required SSV parameters');
    }

    const telegramId = custom_data;  // we pass telegram_id as custom_data from the app

    // 2. Reconstruct the query string that AdMob signed
    //    (everything except &signature=... at the end, in original order)
    const rawUrl  = req.originalUrl;
    const sigIdx  = rawUrl.lastIndexOf('&signature=');
    if (sigIdx === -1) return res.status(400).send('Malformed SSV callback');
    const signedPart = rawUrl.slice(rawUrl.indexOf('?') + 1, sigIdx);

    // 3. Fetch current AdMob public keys and verify ECDSA-SHA256 signature
    const keys    = await getAdmobKeys();
    const pemKey  = keys.get(key_id);
    if (!pemKey) return res.status(400).send('Unknown key_id');

    const verify = crypto.createVerify('SHA256');
    verify.update(signedPart);
    const sigBuf = Buffer.from(
      signature.replace(/-/g, '+').replace(/_/g, '/'),  // URL-safe base64 → standard
      'base64'
    );
    const sigOk = verify.verify(pemKey, sigBuf);
    if (!sigOk) {
      flagSuspicious(telegramId, getIP(req), 'ADMOB_SIG_INVALID', signedPart.slice(0, 100));
      return res.status(403).send('Invalid AdMob signature');
    }

    // 4. Check for replayed transaction_id
    const txHash = sha256(transaction_id);
    if (stmts.tokenUsed.get(txHash)) {
      flagSuspicious(telegramId, getIP(req), 'REPLAYED_TRANSACTION', transaction_id);
      return res.status(200).send('OK');  // silently ignore replay (don't 4xx AdMob)
    }

    // 5. Issue short-lived HMAC token and store it for the frontend to poll
    const [telegramId, nonce] = custom_data.split(':');
    if (!telegramId || !nonce) return res.status(400).send('Invalid custom_data format');

    const rewardToken = issueRewardToken(telegramId, parseInt(reward_amount, 10), transaction_id);
    storePendingToken(nonce, rewardToken);

    // AdMob expects HTTP 200 from the SSV endpoint.
    res.status(200).send('OK');

  } catch (err) {
    console.error('[SSV] Error:', err);
    res.status(500).send('SSV processing error');
  }
});

/**
 * POST /api/reward
 *
 * Body: { reward_token: "<hmac-token-from-SSV>" }
 *
 * Server:
 *  1. Verifies Telegram identity (middleware)
 *  2. Verifies + consumes HMAC reward token
 *  3. Enforces cooldown + daily cap
 *  4. Credits points atomically
 */
app.post('/api/reward', rewardLimiter, requireTelegramAuth, (req, res) => {
  const tid   = String(req.tgUser.id);
  const ip    = getIP(req);
  const now   = Date.now();
  const today = new Date().toDateString();

  // ── 1. Validate reward token ──
  const { reward_token } = req.body || {};
  if (!reward_token || typeof reward_token !== 'string') {
    flagSuspicious(tid, ip, 'MISSING_REWARD_TOKEN', 'POST /api/reward without token');
    return res.status(400).json({ error: 'Missing reward token.' });
  }

  const tokenPayload = verifyRewardToken(reward_token);
  if (!tokenPayload) {
    flagSuspicious(tid, ip, 'INVALID_REWARD_TOKEN', reward_token.slice(0, 40));
    return res.status(403).json({ error: 'Invalid or expired reward token.' });
  }

  // ── 2. Token must belong to THIS Telegram user ──
  if (String(tokenPayload.tid) !== tid) {
    flagSuspicious(tid, ip, 'TOKEN_USER_MISMATCH',
      `token.tid=${tokenPayload.tid} req.tid=${tid}`);
    return res.status(403).json({ error: 'Token user mismatch.' });
  }

  // ── 3. Check token hasn't been replayed (nonce stored as ssv_token_hash) ──
  const tokenHash = sha256(reward_token);
  if (stmts.tokenUsed.get(tokenHash)) {
    flagSuspicious(tid, ip, 'REPLAYED_REWARD_TOKEN', reward_token.slice(0, 40));
    return res.status(403).json({ error: 'Reward token already used.' });
  }

  // ── 4. Rapid-request detection ──
  if (trackAndCheckRapid(tid)) {
    flagSuspicious(tid, ip, 'RAPID_REWARD_REQUESTS',
      `>${RAPID_MAX_CALLS} calls in ${RAPID_WINDOW_MS / 1000}s`);
    // Still enforce rather than just log — return 429
    return res.status(429).json({ error: 'Unusual activity detected. Please slow down.' });
  }

  // ── 5. Ensure user exists ──
  stmts.upsertUser.run({
    telegram_id: tid,
    username:    req.tgUser.username   || null,
    first_name:  req.tgUser.first_name || null,
  });
  const user = stmts.getUser.get(tid);

  // ── 6. Server-side cooldown (per user, not per IP) ──
  const elapsed = now - (user.last_reward || 0);
  if (elapsed < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({
      error:   `Cooldown active. Wait ${waitSec}s.`,
      wait_ms: COOLDOWN_MS - elapsed,
    });
  }

  // ── 7. Daily limit ──
  const ptsToday = user.last_date === today ? user.pts_today : 0;
  if (ptsToday >= DAILY_LIMIT) {
    return res.status(429).json({
      error: `Daily limit of ${DAILY_LIMIT} points reached. Come back tomorrow!`,
    });
  }

  // ── 8. Credit atomically, storing tokenHash for replay prevention ──
  const pts = Math.min(tokenPayload.amt, PTS_PER_AD);  // never grant more than server allows
  rewardTx(tid, pts, today, now, tokenHash);

  res.json({ ok: true, user: sanitiseUser(stmts.getUser.get(tid)) });
});

// ════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════

function sanitiseUser(row) {
  return {
    balance:     row.balance,
    ads_watched: row.ads_watched,
    pts_today:   row.pts_today,
    last_date:   row.last_date,
    username:    row.username,
    first_name:  row.first_name,
  };
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function flagSuspicious(telegramId, ip, reason, detail = '') {
  console.warn(`[SUSPICIOUS] reason=${reason} tid=${telegramId} ip=${ip} detail=${detail}`);
  try {
    stmts.logSuspicious.run({
      telegram_id: telegramId || null,
      ip,
      reason,
      detail: String(detail).slice(0, 500),
    });
  } catch (e) {
    console.error('[DB] Failed to log suspicious activity:', e.message);
  }
}

// ════════════════════════════════════════
// WITHDRAWAL ROUTES
// ════════════════════════════════════════

/**
 * GET /api/withdrawal/info
 * Returns the user's current balance, Stars conversion rate,
 * withdrawal limits, and the cooldown status.
 */
app.get('/api/withdrawal/info', requireTelegramAuth, (req, res) => {
  const tid  = String(req.tgUser.id);
  stmts.upsertUser.run({
    telegram_id: tid,
    username:    req.tgUser.username   || null,
    first_name:  req.tgUser.first_name || null,
  });
  const user  = stmts.getUser.get(tid);
  const lastW = wStmts.getLastWithdrawal.get(tid);

  let cooldown_remaining_ms = 0;
  if (lastW) {
    const elapsed = Date.now() - new Date(lastW.requested_at + 'Z').getTime();
    if (elapsed < WITHDRAWAL_COOLDOWN) {
      cooldown_remaining_ms = WITHDRAWAL_COOLDOWN - elapsed;
    }
  }

  res.json({
    balance:              user.balance,
    stars_rate:           100,           // 100 pts = 1 Star
    min_points:           MIN_WITHDRAWAL_PTS,
    max_points:           MAX_WITHDRAWAL_PTS,
    min_stars:            MIN_STARS,
    max_stars:            MAX_STARS,
    cooldown_remaining_ms,
    last_withdrawal:      lastW ? {
      id:          lastW.id,
      stars:       lastW.stars_amount,
      status:      lastW.status,
      requested_at: lastW.requested_at,
    } : null,
    history: wStmts.getUserWithdrawals.all(tid),
  });
});

/**
 * POST /api/withdrawal/request
 *
 * Body: { points: number, idempotency_key: string }
 *
 * idempotency_key must be a UUID generated by the client.
 * Sending the same key twice returns the existing withdrawal (safe retry).
 *
 * Flow:
 *  1. Auth + input validation
 *  2. Duplicate-request check (idempotency_key)
 *  3. Business rule validation (balance, cooldown, limits)
 *  4. Atomic: deduct points + insert withdrawal record
 *  5. Async: call Telegram Bot API to send Stars
 *  6. Update withdrawal status
 */
app.post(
  '/api/withdrawal/request',
  requireTelegramAuth,
  withdrawalLimiter,
  async (req, res) => {
    const tid  = String(req.tgUser.id);
    const ip   = getIP(req);

    // ── 1. Input validation ──────────────────────────────────────────────────
    const { points, idempotency_key } = req.body || {};

    if (
      typeof points !== 'number' ||
      !Number.isInteger(points) ||
      points <= 0
    ) {
      return res.status(400).json({ error: 'Invalid points value.' });
    }

    if (
      !idempotency_key ||
      typeof idempotency_key !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(idempotency_key)   // must be a UUID
    ) {
      return res.status(400).json({
        error: 'Missing or malformed idempotency_key. Must be a UUID v4.',
      });
    }

    // ── 2. Idempotency check ─────────────────────────────────────────────────
    const keyHash = sha256(tid + ':' + idempotency_key);
    const existing = wStmts.getWithdrawalByKey.get(keyHash);
    if (existing) {
      // Safe retry — return the existing record without re-processing
      return res.json({
        ok:         true,
        idempotent: true,
        withdrawal: {
          id:        existing.id,
          stars:     existing.stars_amount,
          points:    existing.points_deducted,
          status:    existing.status,
        },
      });
    }

    // ── 3. Ensure user exists & get current data ─────────────────────────────
    stmts.upsertUser.run({
      telegram_id: tid,
      username:    req.tgUser.username   || null,
      first_name:  req.tgUser.first_name || null,
    });
    const user = stmts.getUser.get(tid);

    // ── 4. Business rule validation ──────────────────────────────────────────
    const validation = validateWithdrawal(user, points, wStmts);
    if (!validation.ok) {
      flagSuspicious(tid, ip, 'WITHDRAWAL_VALIDATION_FAIL',
        `pts=${points} bal=${user.balance} err=${validation.error}`);
      return res.status(validation.code).json({
        error:   validation.error,
        wait_ms: validation.wait_ms,
      });
    }

    const starsAmount = pointsToStars(points);

    // ── 5. Atomic deduction + withdrawal record creation ─────────────────────
    let withdrawalId;
    try {
      withdrawalId = createWithdrawalAtomic(
        db, wStmts, tid, points, starsAmount, keyHash
      );
    } catch (err) {
      console.error('[Withdrawal] Atomic transaction failed:', err.message);
      flagSuspicious(tid, ip, 'WITHDRAWAL_ATOMIC_FAIL', err.message);
      return res.status(400).json({ error: err.message });
    }

    // ── 6. Send Stars via Telegram Bot API (async — don't block response) ────
    // We return HTTP 202 immediately so the user isn't kept waiting, then
    // process the Telegram API call and update status asynchronously.
    res.status(202).json({
      ok:            true,
      withdrawal_id: withdrawalId,
      stars:         starsAmount,
      points:        points,
      status:        'pending',
      message:       'Withdrawal queued. Stars will arrive shortly.',
    });

    // ── 7. Notify admin immediately (async — does not block response) ────────
    // يرسل إشعاراً فورياً للأدمن عبر بوت التليغرام يحتوي على جميع بيانات الطلب.
    notifyAdmin(BOT_TOKEN, ADMIN_CHAT_ID, {
      withdrawalId,
      starsAmount,
      pointsRequested: points,
    }, user);

    // Async processing (after response is sent)
    processTelegramPayout(withdrawalId, tid, starsAmount, ip);
  }
);

/**
 * GET /api/withdrawal/status/:id
 * Returns the current status of a specific withdrawal.
 */
app.get('/api/withdrawal/status/:id', requireTelegramAuth, (req, res) => {
  const tid = String(req.tgUser.id);
  const id  = parseInt(req.params.id, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid withdrawal ID.' });
  }

  const withdrawal = wStmts.getWithdrawalById.get(id);
  if (!withdrawal) {
    return res.status(404).json({ error: 'Withdrawal not found.' });
  }

  // Users can only see their own withdrawals
  if (withdrawal.telegram_id !== tid) {
    flagSuspicious(tid, getIP(req), 'WITHDRAWAL_ID_SNOOPING',
      `user ${tid} tried to access withdrawal ${id} owned by ${withdrawal.telegram_id}`);
    return res.status(403).json({ error: 'Access denied.' });
  }

  res.json({
    id:           withdrawal.id,
    stars:        withdrawal.stars_amount,
    points:       withdrawal.points_deducted,
    status:       withdrawal.status,
    requested_at: withdrawal.requested_at,
    processed_at: withdrawal.processed_at,
    failure_reason: withdrawal.status === 'failed'
      ? withdrawal.failure_reason : undefined,
  });
});

// ── Async Telegram payout processor ──────────────────────────────────────────
async function processTelegramPayout(withdrawalId, telegramId, starsAmount, ip) {
  try {
    console.log(
      `[Withdrawal] Processing payout #${withdrawalId}: ` +
      `${starsAmount} Stars → user ${telegramId}`
    );

    const result = await sendStarsToUser(
      BOT_TOKEN,
      parseInt(telegramId, 10),
      starsAmount,
      withdrawalId
    );

    if (result.ok) {
      wStmts.updateWithdrawalStatus.run({
        id:            withdrawalId,
        status:        'completed',
        tg_payment_id: result.payment_id || null,
        failure_reason: null,
      });
      console.log(
        `[Withdrawal] Payout #${withdrawalId} completed via ${result.method}. ` +
        `payment_id=${result.payment_id}`
      );
    } else {
      // Payout failed — refund points to user
      db.prepare(
        'UPDATE users SET balance = balance + ? WHERE telegram_id = ?'
      ).run(
        wStmts.getWithdrawalById.get(withdrawalId)?.points_deducted || 0,
        telegramId
      );
      wStmts.updateWithdrawalStatus.run({
        id:             withdrawalId,
        status:         'failed',
        tg_payment_id:  null,
        failure_reason: result.error || 'Unknown Telegram API error',
      });
      console.error(
        `[Withdrawal] Payout #${withdrawalId} FAILED: ${result.error}. ` +
        `Points refunded to user ${telegramId}.`
      );
      flagSuspicious(
        telegramId, ip, 'WITHDRAWAL_PAYOUT_FAILED',
        `id=${withdrawalId} err=${result.error}`
      );
    }

  } catch (err) {
    console.error(`[Withdrawal] Unexpected error for payout #${withdrawalId}:`, err);
    // Refund points on unexpected error
    try {
      const w = wStmts.getWithdrawalById.get(withdrawalId);
      if (w && w.status === 'pending') {
        db.prepare(
          'UPDATE users SET balance = balance + ? WHERE telegram_id = ?'
        ).run(w.points_deducted, telegramId);
        wStmts.updateWithdrawalStatus.run({
          id:             withdrawalId,
          status:         'failed',
          tg_payment_id:  null,
          failure_reason: err.message,
        });
      }
    } catch (refundErr) {
      console.error('[Withdrawal] CRITICAL: Could not refund points after failure:', refundErr);
    }
  }
}

// ════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════
mountAdminRoutes(app, db, wStmts, sendStarsToUser, BOT_TOKEN);

// ════════════════════════════════════════
// START
// ════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`[EarnApp] Server on http://localhost:${PORT}`);
  console.log(`[EarnApp] Daily limit: ${DAILY_LIMIT} pts | Cooldown: ${COOLDOWN_MS}ms`);
});
