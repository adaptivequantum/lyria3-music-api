/**
 * Lyria 3 Music Generator — Core Engine (v2)
 * 
 * Uses Playwright to generate music via Gemini's Lyria 3 model.
 * 
 * PROVEN DOWNLOAD APPROACH (March 2026):
 * - Music is served as a <video> element inside <video-player> component
 * - Video src = https://contribution.usercontent.google.com/download?c=[TOKEN]&filename=[NAME].mp4&opi=[ID]
 * - Download via context.request.get(video.src) — includes session cookies automatically
 * - Backup: page.evaluate(fetch(videoUrl, {credentials:'include'}))
 * - The "Download track" button has "active-lock" class and may be disabled — DO NOT rely on clicking it
 */

import { chromium } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getCookies, hasCookies } from './cookies.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const GEMINI_URL = 'https://gemini.google.com/app';
const MAX_CONCURRENT = 1;
const MAX_ATTEMPTS = 3;
const GENERATION_TIMEOUT = 180_000; // 3 minutes

// ─── State ──────────────────────────────────────────────────────────────────

const jobs = new Map();
let activeBrowser = null;
let processingQueue = false;
const queue = [];

// ─── Prompt Builder ─────────────────────────────────────────────────────────

const GENRE_MAP = {
  'modern_arabic_pop': 'modern Arabic pop',
  'traditional_arabic': 'traditional Arabic',
  'khaleeji': 'Khaleeji Gulf style',
  'corporate_professional': 'corporate professional background',
  'upbeat_energetic': 'upbeat energetic',
  'emotional_cinematic': 'emotional cinematic',
  'ambient_background': 'ambient background',
  'hiphop': 'hip-hop',
  'arabic_hiphop': 'Arabic hip-hop',
  'pop': 'pop',
  'arabic_pop': 'Arabic pop',
  'electronic': 'electronic',
  'edm': 'EDM',
  'rock': 'rock',
  'rnb': 'R&B',
  'jazz': 'jazz',
  'classical_orchestral': 'classical orchestral',
  'national_day': 'Saudi National Day patriotic anthem',
  'founding_day': 'Saudi Founding Day heritage anthem',
  'eid': 'Eid celebration festive',
  'ramadan': 'Ramadan spiritual peaceful',
  'ardah': 'Ardah traditional war dance',
  'samri': 'Samri folk',
  'arabic_rnb': 'Arabic R&B',
  'arabic_emotional': 'Arabic emotional ballad',
  'arabic_upbeat': 'Arabic upbeat energetic',
  'arabic_cinematic': 'Arabic cinematic epic',
  'arabic_luxury': 'Arabic luxury elegant',
};

function buildPrompt(params) {
  const parts = ['Create music:'];
  
  if (params.language === 'arabic') {
    parts.push('Arabic music');
  } else if (params.language === 'english') {
    parts.push('English music');
  }
  
  if (params.genre) {
    parts.push(GENRE_MAP[params.genre] || params.genre);
  }
  
  if (params.instrumental) {
    parts.push('instrumental only, no vocals, no singing');
  } else {
    if (params.vocalGender === 'f') {
      parts.push('with female vocals');
    } else if (params.vocalGender === 'm') {
      parts.push('with male vocals');
    } else {
      parts.push('with vocals');
    }
  }
  
  if (params.prompt && params.prompt.length > 5) {
    parts.push(params.prompt);
  }
  
  if (params.lyrics && !params.instrumental) {
    const cleanLyrics = params.lyrics
      .replace(/\[(Hook|Verse|Chorus|Bridge|Outro|Intro)\]/gi, '')
      .trim();
    if (cleanLyrics.length > 10) {
      parts.push(`Lyrics: ${cleanLyrics.substring(0, 300)}`);
    }
  }
  
  if (params.duration && params.duration <= 30) {
    parts.push('30 seconds');
  }
  
  parts.push('professional quality, suitable for advertising');
  
  return parts.join(', ');
}

// ─── Browser Management ─────────────────────────────────────────────────────

async function getBrowser() {
  if (activeBrowser && activeBrowser.isConnected()) {
    return activeBrowser;
  }
  
  console.log('[Generator] Launching Playwright Chromium...');
  
  activeBrowser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
    ],
  });
  
  console.log('[Generator] Browser launched successfully');
  return activeBrowser;
}

async function createAuthenticatedContext(browser) {
  const cookies = getCookies();
  
  if (cookies.length === 0) {
    throw new Error('No Google cookies available. Upload cookies via POST /api/cookies first.');
  }
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  
  // Playwright cookies need: name, value, domain, path. Optional: secure, httpOnly, expires, sameSite
  const validCookies = cookies
    .filter(c => c.value && c.name && c.domain)
    .map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      expires: c.expirationDate > 0 ? c.expirationDate : (c.expires > 0 ? c.expires : undefined),
      sameSite: c.sameSite || 'Lax',
    }));
  
  if (validCookies.length > 0) {
    await context.addCookies(validCookies);
    console.log(`[Generator] Added ${validCookies.length} cookies to browser context`);
  }
  
  return context;
}

// ─── Audio Validation ───────────────────────────────────────────────────────

function isAudioContent(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const h = buffer;
  // MP4/M4A ftyp box: bytes 4-7 = "ftyp"
  if (h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) return true;
  // ID3 (MP3)
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return true;
  // MP3 sync
  if (h[0] === 0xFF && (h[1] & 0xE0) === 0xE0) return true;
  // WebM
  if (h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3) return true;
  // OGG
  if (h[0] === 0x4F && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53) return true;
  // WAV
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) return true;
  // FLAC
  if (h[0] === 0x66 && h[1] === 0x4C && h[2] === 0x61 && h[3] === 0x43) return true;
  return false;
}

function isHtmlContent(buffer) {
  if (!buffer || buffer.length < 20) return false;
  const start = buffer.slice(0, 200).toString('utf-8').toLowerCase().trim();
  return start.includes('<!doctype') || start.includes('<html') || start.includes('<?xml');
}

// ─── Core Generation ────────────────────────────────────────────────────────

async function generateWithPlaywright(job) {
  const browser = await getBrowser();
  const context = await createAuthenticatedContext(browser);
  let page = null;
  
  try {
    page = await context.newPage();
    
    // Navigate to Gemini
    console.log(`[Generator] Navigating to Gemini...`);
    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    // Log page state for debugging
    const pageState = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyPreview: document.body.innerText.substring(0, 300),
        hasInput: !!document.querySelector('div[contenteditable="true"], [aria-label*="prompt" i], rich-textarea'),
        hasSignIn: !!document.querySelector('a[href*="accounts.google.com/ServiceLogin"]'),
      };
    });
    console.log(`[Generator] Page state: url=${pageState.url}, title=${pageState.title}, hasInput=${pageState.hasInput}, hasSignIn=${pageState.hasSignIn}`);
    console.log(`[Generator] Page body preview: ${pageState.bodyPreview.substring(0, 200)}`);
    
    // Handle consent/cookie dialogs that might block the page
    try {
      const consentBtn = await page.$('[aria-label*="Accept" i], [aria-label*="agree" i]') 
        || await page.locator('button:has-text("I agree")').first().elementHandle().catch(() => null)
        || await page.locator('button:has-text("Accept all")').first().elementHandle().catch(() => null);
      if (consentBtn) {
        console.log('[Generator] Found consent dialog — clicking Accept...');
        await consentBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log('[Generator] No consent dialog found (ok)');
    }
    
    // Check if we're logged in — look for the user avatar or greeting, not sign-in link
    // (hasSignIn can be a false positive from Google Terms links on the page)
    const isLoggedIn = await page.evaluate(() => {
      // If we see a greeting like "Hi Aql" or the input field, we're logged in
      const bodyText = document.body.innerText;
      const hasGreeting = /Hi \w+/i.test(bodyText) || /Where should we start/i.test(bodyText);
      const hasInput = !!document.querySelector('rich-textarea, div[contenteditable="true"], [role="textbox"], .ql-editor');
      const hasUserAvatar = !!document.querySelector('[aria-label*="Google Account"]');
      return hasGreeting || hasInput || hasUserAvatar;
    });
    
    if (!isLoggedIn) {
      const screenshotPath = path.join(os.tmpdir(), `lyria3-not-logged-in-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
      console.error(`[Generator] NOT LOGGED IN! url=${pageState.url}, title=${pageState.title}`);
      console.error(`[Generator] Body preview: ${pageState.bodyPreview}`);
      throw new Error(`Not logged into Gemini — page shows: ${pageState.title}. Cookies may be expired.`);
    }
    
    console.log(`[Generator] Logged in to Gemini successfully`);
    
    // Dismiss the welcome/terms dialog if present
    try {
      const dismissBtn = await page.$('[aria-label="Close"], button[aria-label="Dismiss"]');
      if (dismissBtn) {
        console.log('[Generator] Dismissing welcome dialog...');
        await dismissBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      console.log('[Generator] No welcome dialog to dismiss');
    }
    
    // Type the prompt into the input field
    console.log(`[Generator] Typing prompt: ${job.prompt.substring(0, 80)}...`);
    
    // Try clicking on the input area first — Gemini 3 uses rich-textarea or contenteditable
    const inputSelectors = [
      'rich-textarea',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"]',
      '.ql-editor',
      '[role="textbox"]',
      'textarea',
      '[aria-label*="prompt" i]',
      '[aria-label*="Ask Gemini" i]',
      '[aria-label*="message" i]',
      'p[data-placeholder]',
    ];
    
    let inputFound = false;
    for (const selector of inputSelectors) {
      const input = await page.$(selector);
      if (input) {
        await input.click();
        await page.waitForTimeout(500);
        // Use keyboard.insertText for faster input, then verify
        await page.keyboard.insertText(job.prompt);
        inputFound = true;
        console.log(`[Generator] Input found with selector: ${selector}`);
        break;
      }
    }
    
    if (!inputFound) {
      // Last resort: try clicking in the center of the page where the input should be
      console.log('[Generator] No input selector matched, trying click at input area...');
      const viewport = page.viewportSize();
      await page.mouse.click(viewport.width / 2, viewport.height / 2 + 50);
      await page.waitForTimeout(500);
      await page.keyboard.insertText(job.prompt);
      inputFound = true;
      console.log('[Generator] Used fallback click method for input');
    }
    
    await page.waitForTimeout(1000);
    
    // Verify text was entered
    const enteredText = await page.evaluate(() => {
      const rt = document.querySelector('rich-textarea');
      if (rt) return rt.innerText?.trim();
      const ce = document.querySelector('div[contenteditable="true"]');
      if (ce) return ce.innerText?.trim();
      return '';
    });
    console.log(`[Generator] Text in input field: "${enteredText.substring(0, 80)}..."`);
    
    if (!enteredText) {
      console.warn('[Generator] Input appears empty — retrying with keyboard.type...');
      await page.keyboard.type(job.prompt, { delay: 15 });
      await page.waitForTimeout(500);
    }
    
    // Submit the prompt — try Enter key first, then look for submit button
    console.log(`[Generator] Submitting prompt...`);
    
    // Try clicking the submit/send button directly
    const submitBtn = await page.$('[aria-label="Send message"], [aria-label*="Submit" i], [aria-label*="Send" i], button[data-testid="send-button"]');
    if (submitBtn) {
      console.log('[Generator] Found submit button — clicking it');
      await submitBtn.click();
    } else {
      console.log('[Generator] No submit button found — pressing Enter');
      await page.keyboard.press('Enter');
    }
    
    // Wait a moment and check if the page changed (prompt was accepted)
    await page.waitForTimeout(3000);
    const afterSubmit = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      return {
        hasGenerating: /generating|creating|working/i.test(bodyText),
        hasMusic: /music|track|song/i.test(bodyText),
        bodyPreview: bodyText.substring(0, 500),
      };
    });
    console.log(`[Generator] After submit — generating: ${afterSubmit.hasGenerating}, hasMusic: ${afterSubmit.hasMusic}`);
    console.log(`[Generator] After submit body: ${afterSubmit.bodyPreview.substring(0, 300)}`);
    
    // ─── WAIT FOR MUSIC GENERATION ──────────────────────────────────
    // The track is ready when a <video> element appears with a src from
    // contribution.usercontent.google.com, or when buttons like
    // "Download track", "Play video", or "Listen" appear.
    
    console.log(`[Generator] Waiting for music generation (up to 3 minutes)...`);
    
    const startTime = Date.now();
    let videoSrc = null;
    
    while (Date.now() - startTime < GENERATION_TIMEOUT) {
      await page.waitForTimeout(5000);
      
      // Check for video element with src (the primary signal)
      const mediaInfo = await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video && video.src && video.src.startsWith('http')) {
          return { src: video.src, duration: video.duration || 0 };
        }
        
        // Fallback: check for download/play buttons as secondary signal
        const dlBtn = document.querySelector('[aria-label="Download track"]');
        const playBtn = document.querySelector('[aria-label="Play video"]');
        const listenBtn = document.querySelector('[aria-label="Listen"]');
        
        return {
          src: null,
          hasDownload: !!dlBtn,
          hasPlay: !!playBtn,
          hasListen: !!listenBtn,
        };
      });
      
      if (mediaInfo.src) {
        videoSrc = mediaInfo.src;
        console.log(`[Generator] Video element found! src: ${videoSrc.substring(0, 100)}...`);
        break;
      }
      
      if (mediaInfo.hasDownload || mediaInfo.hasPlay) {
        // Buttons appeared but video src not yet available — wait a bit more
        console.log(`[Generator] Track buttons detected, waiting for video src...`);
        await page.waitForTimeout(3000);
        
        // Try again to get video src
        const recheck = await page.evaluate(() => {
          const video = document.querySelector('video');
          return video && video.src && video.src.startsWith('http') ? video.src : null;
        });
        
        if (recheck) {
          videoSrc = recheck;
          console.log(`[Generator] Video src found on recheck: ${videoSrc.substring(0, 100)}...`);
          break;
        }
      }
      
      // Check for error messages
      const hasError = await page.evaluate(() => {
        const errorTexts = ['something went wrong', 'try again', 'unable to generate', "can't create music", 'error'];
        const bodyText = document.body.innerText.toLowerCase();
        return errorTexts.some(t => bodyText.includes(t) && !bodyText.includes('gemini can make mistakes'));
      });
      
      if (hasError) {
        console.warn('[Generator] Detected possible error on page');
      }
      
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      
      // Every 30 seconds, log what the page shows
      if (elapsed % 30 === 0 && elapsed > 0) {
        const pageCheck = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          return {
            hasVideo: !!document.querySelector('video'),
            hasAudio: !!document.querySelector('audio'),
            hasGenerating: /generating|creating your track/i.test(bodyText),
            hasError: /something went wrong|try again later/i.test(bodyText),
            responsePreview: bodyText.substring(bodyText.length - 500),
          };
        });
        console.log(`[Generator] Page check at ${elapsed}s: video=${pageCheck.hasVideo}, audio=${pageCheck.hasAudio}, generating=${pageCheck.hasGenerating}, error=${pageCheck.hasError}`);
        console.log(`[Generator] Page tail: ${pageCheck.responsePreview.substring(0, 200)}`);
      }
      
      console.log(`[Generator] Still waiting... (${elapsed}s elapsed)`);
    }
    
    if (!videoSrc) {
      // Last attempt: screenshot and log page state for remote debugging
      const screenshotPath = path.join(os.tmpdir(), `lyria3-timeout-${job.id}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`[Generator] Timeout screenshot: ${screenshotPath}`);
      
      // Log the full page state on timeout for debugging
      const timeoutState = await page.evaluate(() => {
        return {
          url: window.location.href,
          title: document.title,
          bodyText: document.body.innerText.substring(0, 2000),
          allVideos: document.querySelectorAll('video').length,
          allAudios: document.querySelectorAll('audio').length,
          allIframes: document.querySelectorAll('iframe').length,
        };
      });
      console.error(`[Generator] TIMEOUT STATE: url=${timeoutState.url}, videos=${timeoutState.allVideos}, audios=${timeoutState.allAudios}, iframes=${timeoutState.allIframes}`);
      console.error(`[Generator] TIMEOUT BODY: ${timeoutState.bodyText.substring(0, 1000)}`);
      
      // One final check
      videoSrc = await page.evaluate(() => {
        const video = document.querySelector('video');
        return video && video.src && video.src.startsWith('http') ? video.src : null;
      });
      
      if (!videoSrc) {
        throw new Error('Music generation timed out — no video element found after 3 minutes');
      }
    }
    
    // ─── DOWNLOAD THE AUDIO ─────────────────────────────────────────
    // PROVEN APPROACH: Use context.request.get() which carries all session cookies.
    // The video src URL requires Google authentication cookies to download.
    // Direct curl/wget without cookies returns HTML login page.
    
    job.status = 'downloading';
    console.log(`[Generator] Downloading audio from: ${videoSrc.substring(0, 100)}...`);
    
    let downloadedBuffer = null;
    
    // Strategy 1 (PRIMARY): context.request.get() — Playwright's built-in HTTP client with cookies
    console.log(`[Generator] Strategy 1: context.request.get()...`);
    try {
      const response = await context.request.get(videoSrc, {
        maxRedirects: 5,
        timeout: 60000,
      });
      
      if (response.ok()) {
        const body = await response.body();
        const contentType = response.headers()['content-type'] || '';
        console.log(`[Generator] Strategy 1: ${body.length} bytes, Content-Type: ${contentType}`);
        
        if (body.length > 5000 && !isHtmlContent(body)) {
          downloadedBuffer = body;
          console.log(`[Generator] Strategy 1 SUCCESS: ${downloadedBuffer.length} bytes`);
        } else if (isHtmlContent(body)) {
          console.warn(`[Generator] Strategy 1: Got HTML response (${body.length} bytes) — cookies may be invalid`);
        } else {
          console.warn(`[Generator] Strategy 1: Response too small (${body.length} bytes)`);
        }
      } else {
        console.warn(`[Generator] Strategy 1: HTTP ${response.status()}`);
      }
    } catch (e) {
      console.warn(`[Generator] Strategy 1 failed: ${e.message}`);
    }
    
    // Strategy 2 (BACKUP): page.evaluate(fetch) with credentials
    if (!downloadedBuffer) {
      console.log(`[Generator] Strategy 2: page.evaluate(fetch with credentials)...`);
      try {
        const fetchResult = await page.evaluate(async (url) => {
          try {
            const resp = await fetch(url, {
              credentials: 'include',
              headers: { 'Accept': '*/*' },
            });
            if (!resp.ok) return { error: `HTTP ${resp.status}`, size: 0 };
            const blob = await resp.blob();
            const ab = await blob.arrayBuffer();
            return {
              bytes: Array.from(new Uint8Array(ab)),
              type: blob.type,
              size: ab.byteLength,
            };
          } catch (e) {
            return { error: e.message, size: 0 };
          }
        }, videoSrc);
        
        if (fetchResult.error) {
          console.warn(`[Generator] Strategy 2 error: ${fetchResult.error}`);
        } else if (fetchResult.size > 5000) {
          downloadedBuffer = Buffer.from(fetchResult.bytes);
          console.log(`[Generator] Strategy 2 SUCCESS: ${downloadedBuffer.length} bytes, type: ${fetchResult.type}`);
          
          if (isHtmlContent(downloadedBuffer)) {
            console.warn(`[Generator] Strategy 2: Content is HTML, discarding`);
            downloadedBuffer = null;
          }
        } else {
          console.warn(`[Generator] Strategy 2: Too small (${fetchResult.size} bytes)`);
        }
      } catch (e) {
        console.warn(`[Generator] Strategy 2 failed: ${e.message}`);
      }
    }
    
    // Strategy 3 (LAST RESORT): Click download button + capture Playwright download event
    if (!downloadedBuffer) {
      console.log(`[Generator] Strategy 3: Click download button...`);
      try {
        const dlBtn = await page.$('[aria-label="Download track"]');
        if (dlBtn) {
          // Check if button is enabled
          const isDisabled = await dlBtn.evaluate(el => {
            return el.disabled || el.classList.contains('active-lock') || el.getAttribute('aria-disabled') === 'true';
          });
          
          if (!isDisabled) {
            await dlBtn.click();
            await page.waitForTimeout(2000);
            
            // Look for "Audio only" or "MP3" option in the dropdown menu
            const mp3Option = await page.$('text=Audio only')
              || await page.$('text=MP3')
              || await page.$('[role="menuitem"]:has-text("Audio")');
            
            if (mp3Option) {
              const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 15000 }),
                mp3Option.click(),
              ]);
              
              if (download) {
                const downloadPath = path.join(os.tmpdir(), `lyria3-dl-${job.id}-${Date.now()}`);
                await download.saveAs(downloadPath);
                downloadedBuffer = fs.readFileSync(downloadPath);
                console.log(`[Generator] Strategy 3 SUCCESS: ${downloadedBuffer.length} bytes`);
                fs.unlinkSync(downloadPath);
                
                if (isHtmlContent(downloadedBuffer)) {
                  console.warn(`[Generator] Strategy 3: Got HTML, discarding`);
                  downloadedBuffer = null;
                }
              }
            } else {
              // No menu appeared, try direct download
              const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 15000 }),
                dlBtn.click(),
              ]);
              
              if (download) {
                const downloadPath = path.join(os.tmpdir(), `lyria3-dl-${job.id}-${Date.now()}`);
                await download.saveAs(downloadPath);
                downloadedBuffer = fs.readFileSync(downloadPath);
                console.log(`[Generator] Strategy 3 (direct): ${downloadedBuffer.length} bytes`);
                fs.unlinkSync(downloadPath);
                
                if (isHtmlContent(downloadedBuffer)) {
                  downloadedBuffer = null;
                }
              }
            }
          } else {
            console.log(`[Generator] Strategy 3: Download button is disabled (active-lock)`);
          }
        } else {
          console.log(`[Generator] Strategy 3: No download button found`);
        }
      } catch (e) {
        console.warn(`[Generator] Strategy 3 failed: ${e.message}`);
      }
    }
    
    // ─── VALIDATE DOWNLOAD ──────────────────────────────────────────
    
    if (!downloadedBuffer || downloadedBuffer.length < 5000) {
      const screenshotPath = path.join(os.tmpdir(), `lyria3-dl-fail-${job.id}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`[Generator] All download strategies failed. Screenshot: ${screenshotPath}`);
      throw new Error(`All audio download strategies failed. Video src was: ${videoSrc.substring(0, 80)}`);
    }
    
    if (isHtmlContent(downloadedBuffer)) {
      throw new Error(`Downloaded content is HTML (${downloadedBuffer.length} bytes), not audio — session cookies may be expired`);
    }
    
    // Save to temp file
    const tempFile = path.join(os.tmpdir(), `lyria3-${job.id}-${Date.now()}.mp4`);
    fs.writeFileSync(tempFile, downloadedBuffer);
    console.log(`[Generator] Saved ${downloadedBuffer.length} bytes to ${tempFile}`);
    
    if (isAudioContent(downloadedBuffer)) {
      console.log(`[Generator] Audio magic bytes confirmed`);
    } else {
      console.log(`[Generator] Unknown format — first 8 bytes: ${downloadedBuffer.slice(0, 8).toString('hex')}`);
    }
    
    // Verify with ffprobe if available
    try {
      const probe = execSync(`ffprobe -v quiet -print_format json -show_format "${tempFile}" 2>/dev/null`, { timeout: 10000 });
      const info = JSON.parse(probe.toString());
      console.log(`[Generator] ffprobe: format=${info.format?.format_name}, duration=${info.format?.duration}s, size=${info.format?.size}`);
    } catch (e) {
      console.log(`[Generator] ffprobe check skipped (not installed or failed)`);
    }
    
    return tempFile;
    
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ─── MP4 → MP3 Conversion ──────────────────────────────────────────────────

function convertToMp3(inputPath) {
  const outputPath = inputPath.replace(/\.mp4$/, '.mp3');
  
  console.log(`[Generator] Converting MP4 to MP3: ${inputPath}`);
  
  // Try full re-encode to MP3
  try {
    execSync(
      `ffmpeg -y -i "${inputPath}" -vn -acodec libmp3lame -ab 192k -ar 44100 "${outputPath}" 2>/dev/null`,
      { timeout: 30000 }
    );
    
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      console.log(`[Generator] Converted to MP3: ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
      fs.unlinkSync(inputPath);
      return outputPath;
    }
  } catch (err) {
    console.warn(`[Generator] ffmpeg re-encode failed, trying stream copy...`);
  }
  
  // Try extracting audio stream without re-encoding
  try {
    execSync(
      `ffmpeg -y -i "${inputPath}" -vn -c:a copy "${outputPath}" 2>/dev/null`,
      { timeout: 30000 }
    );
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      console.log(`[Generator] Audio extracted (copy): ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
      fs.unlinkSync(inputPath);
      return outputPath;
    }
  } catch {
    console.warn('[Generator] All conversion attempts failed, returning original MP4');
  }
  
  return inputPath;
}

// ─── S3 Upload ──────────────────────────────────────────────────────────────

async function uploadToStorage(filePath, jobId) {
  const S3_BUCKET = process.env.S3_BUCKET;
  const S3_REGION = process.env.S3_REGION;
  const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
  const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
  
  if (S3_BUCKET && S3_ACCESS_KEY) {
    const ext = filePath.endsWith('.mp3') ? 'mp3' : 'mp4';
    const contentType = ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
    const key = `lyria3-music/${jobId}-${Date.now()}.${ext}`;
    try {
      execSync(
        `AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}" AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}" aws s3 cp "${filePath}" "s3://${S3_BUCKET}/${key}" --region "${S3_REGION || 'us-east-1'}" --content-type "${contentType}" --acl public-read 2>/dev/null`,
        { timeout: 30000 }
      );
      const url = `https://${S3_BUCKET}.s3.${S3_REGION || 'us-east-1'}.amazonaws.com/${key}`;
      fs.unlinkSync(filePath);
      return url;
    } catch (err) {
      console.warn('[Generator] S3 upload failed:', err.message);
    }
  }
  
  const UPLOAD_URL = process.env.UPLOAD_URL;
  if (UPLOAD_URL) {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      const ext = filePath.endsWith('.mp3') ? 'mp3' : 'mp4';
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer], { type: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4' }), `${jobId}.${ext}`);
      
      const response = await fetch(UPLOAD_URL, {
        method: 'POST',
        body: formData,
        headers: { 'x-api-key': process.env.UPLOAD_API_KEY || '' },
      });
      
      const result = await response.json();
      fs.unlinkSync(filePath);
      return result.url;
    } catch (err) {
      console.warn('[Generator] Upload failed:', err.message);
    }
  }
  
  console.warn('[Generator] No S3/upload configured. File saved locally:', filePath);
  return `local://${filePath}`;
}

// ─── Job Processing ─────────────────────────────────────────────────────────

async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  job.status = 'processing';
  job.attempts++;
  
  try {
    const tempFile = await generateWithPlaywright(job);
    
    job.status = 'converting';
    const mp3File = convertToMp3(tempFile);
    
    job.status = 'uploading';
    const audioUrl = await uploadToStorage(mp3File, job.id);
    
    job.status = 'completed';
    job.audioUrl = audioUrl;
    console.log(`[Generator] Job ${job.id} completed: ${audioUrl}`);
    
    if (job.callbackUrl) {
      try {
        await fetch(job.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id, status: 'completed', audioUrl }),
        });
      } catch (err) {
        console.warn('[Generator] Callback failed:', err.message);
      }
    }
    
  } catch (error) {
    console.error(`[Generator] Job ${job.id} attempt ${job.attempts}/${MAX_ATTEMPTS} failed:`, error.message);
    
    if (job.attempts < MAX_ATTEMPTS) {
      job.status = 'queued';
      queue.push(jobId);
      console.log(`[Generator] Re-queuing job ${job.id} for retry...`);
    } else {
      job.status = 'failed';
      job.error = error.message;
      
      if (job.callbackUrl) {
        try {
          await fetch(job.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: job.id, status: 'failed', error: error.message }),
          });
        } catch (err) {
          console.warn('[Generator] Callback failed:', err.message);
        }
      }
    }
  }
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  
  try {
    while (queue.length > 0) {
      const jobId = queue.shift();
      if (jobId) {
        await processJob(jobId);
      }
    }
  } finally {
    processingQueue = false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function generateMusic(params) {
  const id = uuidv4();
  const prompt = buildPrompt(params);
  
  const job = {
    id,
    status: 'queued',
    prompt,
    audioUrl: null,
    error: null,
    attempts: 0,
    createdAt: Date.now(),
    callbackUrl: params.callbackUrl || null,
    params,
  };
  
  jobs.set(id, job);
  queue.push(id);
  
  console.log(`[Generator] Job ${id} queued: ${prompt.substring(0, 80)}...`);
  
  processQueue().catch(err => console.error('[Generator] Queue error:', err.message));
  
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function getRecentJobs() {
  const oneHourAgo = Date.now() - 3600000;
  return Array.from(jobs.values())
    .filter(j => j.createdAt > oneHourAgo)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(j => ({
      id: j.id,
      status: j.status,
      audioUrl: j.audioUrl,
      error: j.error,
      createdAt: j.createdAt,
      attempts: j.attempts,
    }));
}

/**
 * Debug screenshot — opens Gemini with cookies and captures what the page looks like.
 * Useful for remote debugging when generation fails.
 */
export async function debugScreenshot() {
  const browser = await getBrowser();
  const context = await createAuthenticatedContext(browser);
  let page = null;
  
  try {
    page = await context.newPage();
    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    
    const pageInfo = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyTextPreview: document.body.innerText.substring(0, 1000),
        hasInput: !!document.querySelector('div[contenteditable="true"], [aria-label*="prompt" i], rich-textarea'),
        hasSignIn: !!document.querySelector('a[href*="accounts.google.com"]'),
        hasConsentDialog: !!document.querySelector('[aria-label*="consent" i], [aria-label*="agree" i], [aria-label*="accept" i]'),
        allButtons: Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 20).map(b => ({
          text: b.innerText?.substring(0, 50),
          ariaLabel: b.getAttribute('aria-label'),
          classes: b.className?.substring(0, 100),
        })),
      };
    });
    
    const screenshot = await page.screenshot({ fullPage: true });
    return { screenshot, pageInfo };
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function checkHealth() {
  const cookiesAvailable = hasCookies();
  let browserOk = false;
  let ffmpegOk = false;
  
  try {
    execSync('which chromium || which chromium-browser || which google-chrome', { timeout: 5000 });
    browserOk = true;
  } catch {
    try {
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      await browser.close();
      browserOk = true;
    } catch {
      browserOk = false;
    }
  }
  
  try {
    execSync('which ffmpeg', { timeout: 5000 });
    ffmpegOk = true;
  } catch {
    ffmpegOk = false;
  }
  
  const activeJobs = Array.from(jobs.values()).filter(j => 
    j.status !== 'completed' && j.status !== 'failed'
  ).length;
  
  return {
    status: cookiesAvailable && browserOk ? 'ready' : 'not_ready',
    cookies: cookiesAvailable ? 'available' : 'missing — upload via POST /api/cookies',
    browser: browserOk ? 'available' : 'missing — run: npx playwright install chromium',
    ffmpeg: ffmpegOk ? 'available' : 'missing — install ffmpeg',
    activeJobs,
    queueLength: queue.length,
  };
}
