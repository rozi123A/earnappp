/**
 * admin.js — Admin Routes & Middleware
 *
 * Provides:
 *  - requireAdmin middleware: validates ADMIN_SECRET header
 *  - mountAdminRoutes(app, db, wStmts, sendStarsToUser, botToken):
 *      GET  /admin/stats          — dashboard stats
 *      GET  /admin/users          — paginated user list
 *      GET  /admin/withdrawals    — paginated withdrawal list with filters
 *      POST /admin/withdrawal/:id/retry   — retry a failed withdrawal
 *      POST /admin/withdrawal/:id/cancel  — cancel a pending withdrawal
 *      GET  /admin/suspicious     — suspicious activity log
 */

import crypto    from 'crypto';
import rateLimit from 'express-rate-limit';

// ── Admin auth middleware ─────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

/**
 * requireAdmin — middleware that checks the X-Admin-Secret header.
 * Fails if ADMIN_SECRET env var is not set.
 */
export function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    console.error('[Admin] ADMIN_SECRET is not set — admin routes are disabled.');
    return res.status(503).json({ error: 'Admin access is not configured.' });
  }

  const provided = req.headers['x-admin-secret'] || '';

  // Timing-safe comparison
  try {
    const a = Buffer.alloc(64).fill(0);
    const b = Buffer.alloc(64).fill(0);
    Buffer.from(provided.slice(0, 64)).copy(a);
    Buffer.from(ADMIN_SECRET.slice(0, 64)).copy(b);
    if (!crypto.timingSafeEqual(a, b) || provided !== ADMIN_SECRET) {
      console.warn(`[Admin] Unauthorized attempt from ${req.ip}`);
      return res.status(401).json({ error: 'Unauthorized.' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  next();
}

// ── Rate limiter for admin routes ─────────────────────────────────────────────
const adminLimiter = rateLimit({
  windowMs:        60_000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many admin requests.' },
});

// ── Mount all admin routes ────────────────────────────────────────────────────
export function mountAdminRoutes(app, db, wStmts, sendStarsToUser, botToken) {

  // Apply admin limiter + auth to all /admin/* routes
  app.use('/admin', adminLimiter, requireAdmin);

  // ──────────────────────────────────────────────────────────────────────────
  // GET /admin/stats
  // Dashboard overview: users, points, withdrawals, suspicious events.
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/admin/stats', (req, res) => {
    try {
      const stats = {
        users: db.prepare('SELECT COUNT(*) as cnt FROM users').get(),
        total_balance: db.prepare('SELECT SUM(balance) as total FROM users').get(),
        total_ads: db.prepare('SELECT SUM(ads_watched) as total FROM users').get(),
        withdrawals: {
          pending:   db.prepare("SELECT COUNT(*) as cnt FROM withdrawals WHERE status = 'pending'").get(),
          completed: db.prepare("SELECT COUNT(*) as cnt FROM withdrawals WHERE status = 'completed'").get(),
          failed:    db.prepare("SELECT COUNT(*) as cnt FROM withdrawals WHERE status = 'failed'").get(),
          total_stars: db.prepare(
            "SELECT SUM(stars_amount) as total FROM withdrawals WHERE status = 'completed'"
          ).get(),
        },
        suspicious_today: db.prepare(
          "SELECT COUNT(*) as cnt FROM suspicious_log WHERE date(logged_at) = date('now')"
        ).get(),
        new_users_today: db.prepare(
          "SELECT COUNT(*) as cnt FROM users WHERE date(created_at) = date('now')"
        ).get(),
        rewards_today: db.prepare(
          "SELECT COUNT(*) as cnt FROM reward_log WHERE date(rewarded_at) = date('now')"
        ).get(),
      };

      res.json({
        total_users:        stats.users.cnt,
        total_balance_pts:  stats.total_balance.total || 0,
        total_ads_watched:  stats.total_ads.total || 0,
        withdrawals: {
          pending:            stats.withdrawals.pending.cnt,
          completed:          stats.withdrawals.completed.cnt,
          failed:             stats.withdrawals.failed.cnt,
          total_stars_sent:   stats.withdrawals.total_stars.total || 0,
        },
        suspicious_events_today: stats.suspicious_today.cnt,
        new_users_today:         stats.new_users_today.cnt,
        rewards_issued_today:    stats.rewards_today.cnt,
        server_time:             new Date().toISOString(),
      });
    } catch (err) {
      console.error('[Admin] /stats error:', err);
      res.status(500).json({ error: 'Failed to fetch stats.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /admin/users?page=1&limit=50&search=<username>
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/admin/users', (req, res) => {
    try {
      const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
      const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
      const search = (req.query.search || '').trim().slice(0, 50);
      const offset = (page - 1) * limit;

      let query  = 'SELECT * FROM users';
      let cQuery = 'SELECT COUNT(*) as cnt FROM users';
      const params = [];

      if (search) {
        query  += ' WHERE telegram_id LIKE ? OR username LIKE ? OR first_name LIKE ?';
        cQuery += ' WHERE telegram_id LIKE ? OR username LIKE ? OR first_name LIKE ?';
        const s = `%${search}%`;
        params.push(s, s, s);
      }

      query += ' ORDER BY balance DESC LIMIT ? OFFSET ?';

      const users = db.prepare(query).all(...params, limit, offset);
      const total = db.prepare(cQuery).get(...params).cnt;

      res.json({
        users,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error('[Admin] /users error:', err);
      res.status(500).json({ error: 'Failed to fetch users.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /admin/withdrawals?status=pending&page=1&limit=50
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/admin/withdrawals', (req, res) => {
    try {
      const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
      const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
      const status = req.query.status || '';
      const offset = (page - 1) * limit;

      const validStatuses = ['pending', 'completed', 'failed', 'cancelled', 'processing'];

      let query  = `
        SELECT w.*, u.username, u.first_name
        FROM withdrawals w
        LEFT JOIN users u ON w.telegram_id = u.telegram_id
      `;
      let cQuery = 'SELECT COUNT(*) as cnt FROM withdrawals w';
      const params = [];

      if (status && validStatuses.includes(status)) {
        query  += ' WHERE w.status = ?';
        cQuery += ' WHERE w.status = ?';
        params.push(status);
      }

      query  += ' ORDER BY w.requested_at DESC LIMIT ? OFFSET ?';

      const withdrawals = db.prepare(query).all(...params, limit, offset);
      const total       = db.prepare(cQuery).get(...params).cnt;

      res.json({
        withdrawals,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error('[Admin] /withdrawals error:', err);
      res.status(500).json({ error: 'Failed to fetch withdrawals.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /admin/withdrawal/:id/retry
  // Retry a failed withdrawal by re-attempting the Telegram payout.
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/admin/withdrawal/:id/retry', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal ID.' });
    }

    const w = wStmts.getWithdrawalById.get(id);
    if (!w) return res.status(404).json({ error: 'Withdrawal not found.' });
    if (w.status !== 'failed') {
      return res.status(400).json({ error: `Cannot retry withdrawal with status "${w.status}".` });
    }

    try {
      // Reset to pending
      wStmts.updateWithdrawalStatus.run({
        id,
        status:         'pending',
        tg_payment_id:  null,
        failure_reason: null,
      });

      // Attempt payout
      const result = await sendStarsToUser(
        botToken,
        parseInt(w.telegram_id, 10),
        w.stars_amount,
        id
      );

      if (result.ok) {
        wStmts.updateWithdrawalStatus.run({
          id,
          status:         'completed',
          tg_payment_id:  result.payment_id || null,
          failure_reason: null,
        });
        console.log(`[Admin] Retry #${id} succeeded.`);
        return res.json({ ok: true, message: 'Retry succeeded.', method: result.method });
      } else {
        wStmts.updateWithdrawalStatus.run({
          id,
          status:         'failed',
          tg_payment_id:  null,
          failure_reason: result.error || 'Retry failed.',
        });
        return res.status(502).json({ ok: false, error: result.error });
      }
    } catch (err) {
      console.error('[Admin] Retry error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /admin/withdrawal/:id/cancel
  // Cancel a pending withdrawal and refund the points.
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/admin/withdrawal/:id/cancel', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal ID.' });
    }

    const w = wStmts.getWithdrawalById.get(id);
    if (!w) return res.status(404).json({ error: 'Withdrawal not found.' });
    if (!['pending', 'processing'].includes(w.status)) {
      return res.status(400).json({
        error: `Cannot cancel withdrawal with status "${w.status}".`,
      });
    }

    try {
      db.transaction(() => {
        // Refund points
        db.prepare(
          'UPDATE users SET balance = balance + ? WHERE telegram_id = ?'
        ).run(w.points_deducted, w.telegram_id);

        // Update status
        wStmts.updateWithdrawalStatus.run({
          id,
          status:         'cancelled',
          tg_payment_id:  null,
          failure_reason: `Cancelled by admin at ${new Date().toISOString()}`,
        });
      })();

      console.log(`[Admin] Withdrawal #${id} cancelled. ${w.points_deducted} pts refunded.`);
      res.json({ ok: true, message: `Withdrawal #${id} cancelled and ${w.points_deducted} pts refunded.` });
    } catch (err) {
      console.error('[Admin] Cancel error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /admin/suspicious?page=1&limit=50&reason=<reason>
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/admin/suspicious', (req, res) => {
    try {
      const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
      const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
      const reason = (req.query.reason || '').trim().slice(0, 50);
      const offset = (page - 1) * limit;

      let query  = 'SELECT * FROM suspicious_log';
      let cQuery = 'SELECT COUNT(*) as cnt FROM suspicious_log';
      const params = [];

      if (reason) {
        query  += ' WHERE reason LIKE ?';
        cQuery += ' WHERE reason LIKE ?';
        params.push(`%${reason}%`);
      }

      query += ' ORDER BY logged_at DESC LIMIT ? OFFSET ?';

      const rows  = db.prepare(query).all(...params, limit, offset);
      const total = db.prepare(cQuery).get(...params).cnt;

      res.json({
        events: rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      console.error('[Admin] /suspicious error:', err);
      res.status(500).json({ error: 'Failed to fetch suspicious log.' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /admin/user/:telegram_id
  // Full profile for a single user including reward + withdrawal history.
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/admin/user/:telegram_id', (req, res) => {
    try {
      const tid = req.params.telegram_id;
      const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tid);
      if (!user) return res.status(404).json({ error: 'User not found.' });

      const rewardHistory = db.prepare(
        'SELECT * FROM reward_log WHERE telegram_id = ? ORDER BY rewarded_at DESC LIMIT 20'
      ).all(tid);

      const withdrawalHistory = db.prepare(
        'SELECT * FROM withdrawals WHERE telegram_id = ? ORDER BY requested_at DESC LIMIT 20'
      ).all(tid);

      const suspiciousEvents = db.prepare(
        'SELECT * FROM suspicious_log WHERE telegram_id = ? ORDER BY logged_at DESC LIMIT 10'
      ).all(tid);

      res.json({ user, rewardHistory, withdrawalHistory, suspiciousEvents });
    } catch (err) {
      console.error('[Admin] /user error:', err);
      res.status(500).json({ error: 'Failed to fetch user.' });
    }
  });

  console.log('[Admin] Admin routes mounted at /admin/*');
}
