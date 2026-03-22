/**
 * Cookie Management for Lyria 3 API
 *
 * Persistence strategy (in priority order):
 *
 *   1. FILE  — Persistent disk at COOKIE_DIR (works on Render paid plans with disk)
 *   2. ENV   — GOOGLE_COOKIES_B64 environment variable (base64-encoded JSON array)
 *              Survives ALL redeploys because env vars are not wiped.
 *              When cookies are saved, we also try to update this env var via the
 *              Render API (requires RENDER_API_KEY + RENDER_SERVICE_ID env vars).
 *
 * On startup:
 *   - If the cookie file exists on disk → use it (fastest path)
 *   - Else if GOOGLE_COOKIES_B64 is set → decode it, write to disk, use it
 *   - Else → no cookies (API returns not_ready until POST /api/cookies is called)
 *
 * On POST /api/cookies:
 *   - Always write to disk
 *   - Always update in-memory cache
 *   - If RENDER_API_KEY + RENDER_SERVICE_ID are set → update GOOGLE_COOKIES_B64
 *     env var on Render so the next redeploy auto-loads them
 */

import fs from 'fs';
import path from 'path';

// ─── Config ─────────────────────────────────────────────────────────────────

const COOKIE_DIR = process.env.COOKIE_DIR || './cookies';
const COOKIE_FILE = path.join(COOKIE_DIR, 'google-cookies.json');

// Render API integration (optional — enables automatic env var update)
const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || '';

// ─── In-memory cache ─────────────────────────────────────────────────────────

let _cookieCache = null;

// ─── Startup: bootstrap from env var if disk is empty ───────────────────────

function bootstrapFromEnv() {
  const b64 = process.env.GOOGLE_COOKIES_B64;
  if (!b64) return;

  try {
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const cookies = JSON.parse(json);
    if (!Array.isArray(cookies) || cookies.length === 0) return;

    // Write to disk so subsequent reads are fast
    if (!fs.existsSync(COOKIE_DIR)) {
      fs.mkdirSync(COOKIE_DIR, { recursive: true });
    }
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    _cookieCache = cookies;
    console.log(`[Cookies] Bootstrapped ${cookies.length} cookies from GOOGLE_COOKIES_B64 env var → wrote to disk`);
  } catch (err) {
    console.error('[Cookies] Failed to decode GOOGLE_COOKIES_B64:', err.message);
  }
}

// Run bootstrap immediately when module loads
bootstrapFromEnv();

// ─── Render API: update GOOGLE_COOKIES_B64 env var ──────────────────────────

async function updateRenderEnvVar(b64Value) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    console.log('[Cookies] RENDER_API_KEY/RENDER_SERVICE_ID not set — skipping env var auto-update');
    return;
  }

  try {
    const url = `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${RENDER_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify([
        { key: 'GOOGLE_COOKIES_B64', value: b64Value },
      ]),
    });

    if (response.ok) {
      console.log('[Cookies] ✅ GOOGLE_COOKIES_B64 updated on Render — cookies will survive next redeploy');
    } else {
      const text = await response.text().catch(() => '');
      console.warn(`[Cookies] Render env var update failed (${response.status}): ${text.substring(0, 200)}`);
    }
  } catch (err) {
    console.warn('[Cookies] Render env var update error:', err.message);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Save cookies to persistent storage.
 * Also updates GOOGLE_COOKIES_B64 env var on Render if credentials are available.
 *
 * @param {Array} cookies - Array of Playwright-compatible cookie objects
 * @returns {number} Count of valid cookies saved
 */
export async function saveCookies(cookies) {
  // Validate
  const validCookies = cookies.filter(c => c.name && c.value && c.domain);
  if (validCookies.length === 0) {
    throw new Error('No valid cookies found. Each cookie needs: name, value, domain');
  }

  // 1. Write to disk
  if (!fs.existsSync(COOKIE_DIR)) {
    fs.mkdirSync(COOKIE_DIR, { recursive: true });
  }
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(validCookies, null, 2));
  console.log(`[Cookies] Saved ${validCookies.length} cookies to ${COOKIE_FILE}`);

  // 2. Update in-memory cache
  _cookieCache = validCookies;

  // 3. Encode as base64 for env var persistence
  const b64 = Buffer.from(JSON.stringify(validCookies)).toString('base64');
  console.log(`[Cookies] Base64 encoded cookies: ${b64.length} chars`);

  // 4. Update Render env var (async, non-blocking — don't let failure block the response)
  updateRenderEnvVar(b64).catch(err => {
    console.warn('[Cookies] Background Render env update failed:', err.message);
  });

  return validCookies.length;
}

/**
 * Load cookies — checks in-memory cache first, then disk, then env var.
 * @returns {Array} Array of cookie objects, or empty array if none available
 */
export function getCookies() {
  // 1. Return from cache if available
  if (_cookieCache && _cookieCache.length > 0) {
    return _cookieCache;
  }

  // 2. Try to load from disk
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      const data = fs.readFileSync(COOKIE_FILE, 'utf-8');
      const cookies = JSON.parse(data);
      _cookieCache = cookies;
      console.log(`[Cookies] Loaded ${cookies.length} cookies from disk`);
      return cookies;
    } catch (err) {
      console.error('[Cookies] Failed to read cookie file:', err.message);
    }
  }

  // 3. Try env var fallback (in case bootstrap didn't run or disk was wiped mid-session)
  const b64 = process.env.GOOGLE_COOKIES_B64;
  if (b64) {
    try {
      const json = Buffer.from(b64, 'base64').toString('utf-8');
      const cookies = JSON.parse(json);
      if (Array.isArray(cookies) && cookies.length > 0) {
        _cookieCache = cookies;
        console.log(`[Cookies] Loaded ${cookies.length} cookies from GOOGLE_COOKIES_B64 env var (runtime fallback)`);
        // Write to disk for next time
        try {
          if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR, { recursive: true });
          fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
        } catch (_) {}
        return cookies;
      }
    } catch (err) {
      console.error('[Cookies] Failed to decode GOOGLE_COOKIES_B64 at runtime:', err.message);
    }
  }

  console.warn('[Cookies] No cookies available. Upload via POST /api/cookies');
  return [];
}

/**
 * Check if cookies are available (from any source).
 */
export function hasCookies() {
  if (_cookieCache && _cookieCache.length > 0) return true;
  if (fs.existsSync(COOKIE_FILE)) return true;
  if (process.env.GOOGLE_COOKIES_B64) return true;
  return false;
}
