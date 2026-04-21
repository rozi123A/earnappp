# EarnApp — Telegram Mini App

Watch rewarded ads → earn points → withdraw as Telegram ⭐ Stars.

## Project Structure

```
earnapp/
├── server/
│   ├── index.js          # Express server, all API routes
│   ├── auth.js           # Telegram initData HMAC verification
│   ├── admin.js          # Admin routes & requireAdmin middleware
│   └── withdrawal.js     # Withdrawal logic, Stars payout, DB schema
├── public/
│   ├── index.html        # Main Mini App UI
│   ├── style.css         # Dark Telegram-style theme
│   ├── app.js            # Frontend logic, ad flow, Telegram init
│   └── withdrawal-frontend.js  # Withdrawal modal logic
├── .env.example          # Environment variable template
├── package.json
└── README.md
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create .env from template
cp .env.example .env

# 3. Generate secure keys
node -e "const c=require('crypto');console.log('REWARD_HMAC_KEY='+c.randomBytes(32).toString('hex'));console.log('ADMIN_SECRET='+c.randomBytes(32).toString('hex'));"

# 4. Fill in your BOT_TOKEN, ADMIN_CHAT_ID, etc. in .env

# 5. Start the server
npm start
```

## Security Features

- **Telegram initData HMAC** — Every API request verifies the Telegram signature
- **auth_date expiry** — Rejects stale sessions (configurable, default 24h)
- **AdMob SSV** — Server-side ECDSA verification of ad rewards
- **HMAC reward tokens** — Short-lived (2 min) tokens prevent fake reward claims
- **Replay prevention** — Token hashes stored in DB, replays silently rejected
- **Per-user rapid-request detection** — Flags >5 reward attempts/minute
- **Idempotency keys** — Safe withdrawal retries without double-processing
- **Atomic transactions** — Points deducted and withdrawal recorded in one DB tx
- **Helmet + CORS** — Security headers and strict origin enforcement
- **Rate limiting** — Global + per-endpoint + per-user limits

## Admin API

All admin routes require the `X-Admin-Secret` header.

| Route | Description |
|---|---|
| `GET /admin/stats` | Dashboard overview |
| `GET /admin/users?search=&page=` | User list |
| `GET /admin/withdrawals?status=pending` | Withdrawal list |
| `POST /admin/withdrawal/:id/retry` | Retry failed payout |
| `POST /admin/withdrawal/:id/cancel` | Cancel + refund |
| `GET /admin/suspicious` | Fraud log |
| `GET /admin/user/:telegram_id` | Full user profile |

## Withdrawal Flow

1. User selects Stars amount (10–45 ⭐ = 1,000–4,500 pts)
2. Client generates UUID idempotency key
3. `POST /api/withdrawal/request` — server validates, deducts points atomically
4. Server notifies admin via Telegram bot immediately
5. Server attempts `giveStars` Bot API call → falls back to notification
6. Client polls `GET /api/withdrawal/status/:id` for completion

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token |
| `REWARD_HMAC_KEY` | ✅ | 32-byte hex key for reward tokens |
| `ADMIN_SECRET` | ✅ | Secret for admin route access |
| `ADMIN_CHAT_ID` | ⭐ | Telegram chat ID for withdrawal alerts |
| `ALLOWED_ORIGIN` | ⭐ | CORS origin (required in production) |
| `BOT_USERNAME` | — | Bot username without @ |
| `PORT` | — | Server port (default: 3000) |
| `COOLDOWN_MS` | — | Ad cooldown in ms (default: 30000) |
| `DAILY_LIMIT` | — | Max points per day (default: 50) |
| `PTS_PER_AD` | — | Points per ad watch (default: 1) |
