/**
 * auth.js — Telegram WebApp initData Verification
 *
 * Implements HMAC-SHA256 verification of Telegram's initData string
 * as described in the official Telegram docs:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import crypto from 'crypto';

/**
 * Verify Telegram WebApp initData HMAC signature.
 *
 * Algorithm:
 *  1. Parse initData as URLSearchParams
 *  2. Extract `hash` param (the signature to verify)
 *  3. Sort remaining params alphabetically and build data-check-string
 *  4. Derive secret key = HMAC-SHA256("WebAppData", BOT_TOKEN)
 *  5. Compute HMAC-SHA256(secret_key, data-check-string)
 *  6. Compare computed hash with received hash (timing-safe)
 *
 * @param {string} initData   Raw initData string from Telegram.WebApp.initData
 * @param {string} botToken   The bot's secret token from BotFather
 * @returns {boolean}         true if signature is valid, false otherwise
 */
export function verifyTelegramInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return false;

    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return false;

    // Build the data-check-string: all params except hash, sorted, joined with \n
    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // secret_key = HMAC-SHA256("WebAppData", bot_token)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // computed_hash = HMAC-SHA256(secret_key, data_check_string)
    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // Timing-safe comparison to prevent timing attacks
    if (computedHash.length !== receivedHash.length) return false;

    return crypto.timingSafeEqual(
      Buffer.from(computedHash, 'hex'),
      Buffer.from(receivedHash, 'hex')
    );
  } catch (err) {
    console.error('[Auth] verifyTelegramInitData error:', err.message);
    return false;
  }
}

/**
 * Extract user object from Telegram initData string.
 *
 * @param {string} initData  Raw initData string
 * @returns {{ id, username, first_name, last_name, language_code, ... } | null}
 */
export function extractUser(initData) {
  try {
    const params = new URLSearchParams(initData);
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

/**
 * Extract raw query params from initData for additional use.
 *
 * @param {string} initData
 * @returns {Object}
 */
export function parseInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const result = {};
    for (const [k, v] of params.entries()) {
      result[k] = v;
    }
    if (result.user) {
      try { result.user = JSON.parse(result.user); } catch { /* keep raw */ }
    }
    return result;
  } catch {
    return {};
  }
}
