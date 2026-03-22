/**
 * Cookie Management for Lyria 3 API
 * 
 * Handles saving/loading Google cookies for Playwright browser sessions.
 * Cookies are stored as JSON on persistent disk so they survive deploys.
 */

import fs from 'fs';
import path from 'path';

// Use persistent disk path if available, otherwise local
const COOKIE_DIR = process.env.COOKIE_DIR || './cookies';
const COOKIE_FILE = path.join(COOKIE_DIR, 'google-cookies.json');

/**
 * Save cookies to persistent storage
 * @param {Array} cookies - Array of Playwright-compatible cookie objects
 */
export async function saveCookies(cookies) {
  if (!fs.existsSync(COOKIE_DIR)) {
    fs.mkdirSync(COOKIE_DIR, { recursive: true });
  }
  
  // Validate cookie format
  const validCookies = cookies.filter(c => c.name && c.value && c.domain);
  if (validCookies.length === 0) {
    throw new Error('No valid cookies found. Each cookie needs: name, value, domain');
  }
  
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(validCookies, null, 2));
  console.log(`[Cookies] Saved ${validCookies.length} cookies to ${COOKIE_FILE}`);
  return validCookies.length;
}

/**
 * Load cookies from persistent storage
 * @returns {Array} Array of cookie objects, or empty array if none saved
 */
export function getCookies() {
  if (!fs.existsSync(COOKIE_FILE)) {
    console.warn('[Cookies] No cookie file found. Upload cookies via POST /api/cookies');
    return [];
  }
  
  try {
    const data = fs.readFileSync(COOKIE_FILE, 'utf-8');
    const cookies = JSON.parse(data);
    console.log(`[Cookies] Loaded ${cookies.length} cookies from storage`);
    return cookies;
  } catch (err) {
    console.error('[Cookies] Failed to read cookie file:', err.message);
    return [];
  }
}

/**
 * Check if cookies are available
 */
export function hasCookies() {
  return fs.existsSync(COOKIE_FILE);
}
