/**
 * Lyria 3 Music Generator — Core Engine
 * 
 * Uses Playwright to generate music via Gemini.
 * Audio download: uses Playwright's APIRequestContext (page.request) to download
 * with proper cookies and session, avoiding the broken page.evaluate(fetch) approach.
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
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return true; // ID3 (MP3)
  if (h[0] === 0xFF && (h[1] & 0xE0) === 0xE0) return true; // MP3 sync
  if (h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) return true; // MP4/M4A ftyp
  if (h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3) return true; // WebM
  if (h[0] === 0x4F && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53) return true; // OGG
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) return true; // WAV
  if (h[0] === 0x66 && h[1] === 0x4C && h[2] === 0x61 && h[3] === 0x43) return true; // FLAC
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
    
    // Click "Create music" mode button
    console.log(`[Generator] Activating music creation mode...`);
    const musicButton = await page.$('button:has-text("Create music"), [aria-label*="music"], [data-test-id*="music"]');
    if (musicButton) {
      await musicButton.click();
      await page.waitForTimeout(2000);
    } else {
      const chips = await page.$$('button, [role="button"]');
      for (const chip of chips) {
        const text = await chip.textContent().catch(() => '');
        if (text && text.toLowerCase().includes('music')) {
          await chip.click();
          await page.waitForTimeout(2000);
          break;
        }
      }
    }
    
    // Type the prompt
    console.log(`[Generator] Typing prompt: ${job.prompt.substring(0, 80)}...`);
    
    const inputSelectors = [
      'div[contenteditable="true"]',
      'textarea',
      '.ql-editor',
      '[aria-label*="prompt"]',
      '[aria-label*="message"]',
      'rich-textarea',
    ];
    
    let inputFound = false;
    for (const selector of inputSelectors) {
      const input = await page.$(selector);
      if (input) {
        await input.click();
        await page.waitForTimeout(500);
        await page.keyboard.type(job.prompt, { delay: 20 });
        inputFound = true;
        break;
      }
    }
    
    if (!inputFound) {
      throw new Error('Could not find Gemini input field');
    }
    
    await page.waitForTimeout(1000);
    
    // Submit the prompt
    console.log(`[Generator] Submitting prompt...`);
    await page.keyboard.press('Enter');
    
    // Wait for music generation (30-120 seconds)
    console.log(`[Generator] Waiting for music generation (up to 3 minutes)...`);
    
    const startTime = Date.now();
    let audioUrl = null;
    
    while (Date.now() - startTime < GENERATION_TIMEOUT) {
      await page.waitForTimeout(5000);
      
      // Check for audio/video elements with src
      audioUrl = await page.evaluate(() => {
        // Strategy 1: audio/video elements
        const media = document.querySelectorAll('audio source, video source, audio[src], video[src]');
        for (const el of media) {
          const src = el.getAttribute('src') || '';
          if (src && (src.includes('usercontent.google') || src.includes('blob:') || src.includes('googleusercontent'))) {
            return src;
          }
        }
        
        // Strategy 2: download links
        const links = document.querySelectorAll('a[href*="download"], a[href*="usercontent"]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (href && href.includes('google')) {
            return href;
          }
        }
        
        // Strategy 3: data attributes on play buttons
        const playButtons = document.querySelectorAll('[data-track-url], [data-audio-url], [data-src]');
        for (const btn of playButtons) {
          const url = btn.getAttribute('data-track-url') || btn.getAttribute('data-audio-url') || btn.getAttribute('data-src') || '';
          if (url) return url;
        }
        
        return null;
      });
      
      if (audioUrl) {
        console.log(`[Generator] Found audio URL: ${audioUrl.substring(0, 120)}...`);
        break;
      }
      
      // Check for error messages
      const hasError = await page.evaluate(() => {
        const errorTexts = ['something went wrong', 'try again', 'unable to generate'];
        const bodyText = document.body.innerText.toLowerCase();
        return errorTexts.some(t => bodyText.includes(t) && bodyText.indexOf(t) > bodyText.length - 500);
      });
      
      if (hasError) {
        console.warn('[Generator] Detected possible error on page');
      }
      
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[Generator] Still waiting... (${elapsed}s elapsed)`);
    }
    
    if (!audioUrl) {
      const screenshotPath = path.join(os.tmpdir(), `lyria3-debug-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.warn(`[Generator] Debug screenshot saved: ${screenshotPath}`);
      throw new Error('Music generation timed out — no audio URL found after 3 minutes');
    }
    
    // ─── DOWNLOAD THE AUDIO ─────────────────────────────────────────────
    // The old code used page.evaluate(fetch(url)) which returned HTML.
    // Now we use multiple strategies to get the actual audio bytes.
    
    job.status = 'downloading';
    const tempFile = path.join(os.tmpdir(), `lyria3-${job.id}-${Date.now()}.mp4`);
    let downloadedBuffer = null;
    
    // Strategy 1: Use Playwright's download event — click the download button
    console.log(`[Generator] Attempting download via Playwright download event...`);
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.evaluate(() => {
          // Click any download button/link
          const dlBtns = document.querySelectorAll(
            'a[href*="download"], [aria-label*="Download"], [aria-label*="download"], button:has-text("Download")'
          );
          for (const btn of dlBtns) { btn.click(); return true; }
          
          // If no download button, try right-click save on audio element
          const audio = document.querySelector('audio, video');
          if (audio && audio.src) {
            const a = document.createElement('a');
            a.href = audio.src;
            a.download = 'music.mp4';
            document.body.appendChild(a);
            a.click();
            a.remove();
            return true;
          }
          return false;
        }),
      ]);
      
      if (download) {
        const downloadPath = path.join(os.tmpdir(), `lyria3-dl-${job.id}-${Date.now()}`);
        await download.saveAs(downloadPath);
        downloadedBuffer = fs.readFileSync(downloadPath);
        console.log(`[Generator] Downloaded via Playwright event: ${downloadedBuffer.length} bytes`);
        fs.unlinkSync(downloadPath);
        
        if (isHtmlContent(downloadedBuffer)) {
          console.warn(`[Generator] Download event returned HTML (${downloadedBuffer.length} bytes) — trying next strategy`);
          downloadedBuffer = null;
        }
      }
    } catch (e) {
      console.log(`[Generator] Download event strategy failed: ${e.message} — trying next strategy`);
    }
    
    // Strategy 2: Use context.request (Playwright APIRequestContext) to fetch with cookies
    if (!downloadedBuffer && audioUrl.startsWith('http')) {
      console.log(`[Generator] Attempting download via Playwright APIRequestContext...`);
      try {
        const response = await context.request.get(audioUrl, {
          maxRedirects: 5,
          timeout: 30000,
        });
        
        downloadedBuffer = Buffer.from(await response.body());
        const contentType = response.headers()['content-type'] || '';
        console.log(`[Generator] APIRequestContext response: ${response.status()} ${contentType} (${downloadedBuffer.length} bytes)`);
        
        if (isHtmlContent(downloadedBuffer)) {
          console.warn(`[Generator] APIRequestContext returned HTML (${downloadedBuffer.length} bytes) — trying next strategy`);
          downloadedBuffer = null;
        }
      } catch (e) {
        console.log(`[Generator] APIRequestContext strategy failed: ${e.message} — trying next strategy`);
      }
    }
    
    // Strategy 3: Use page.evaluate with blob: URL handling
    if (!downloadedBuffer && audioUrl.startsWith('blob:')) {
      console.log(`[Generator] Attempting blob: URL extraction...`);
      try {
        const blobData = await page.evaluate(async (url) => {
          const resp = await fetch(url);
          const blob = await resp.blob();
          const ab = await blob.arrayBuffer();
          const bytes = Array.from(new Uint8Array(ab));
          return { bytes, type: blob.type, size: ab.byteLength };
        }, audioUrl);
        
        if (blobData && blobData.bytes.length > 5000) {
          downloadedBuffer = Buffer.from(blobData.bytes);
          console.log(`[Generator] Blob extraction: ${downloadedBuffer.length} bytes, type: ${blobData.type}`);
          
          if (isHtmlContent(downloadedBuffer)) {
            console.warn(`[Generator] Blob returned HTML — trying next strategy`);
            downloadedBuffer = null;
          }
        }
      } catch (e) {
        console.log(`[Generator] Blob extraction failed: ${e.message} — trying next strategy`);
      }
    }
    
    // Strategy 4: Use Node.js fetch with cookies from context
    if (!downloadedBuffer && audioUrl.startsWith('http')) {
      console.log(`[Generator] Attempting download via Node.js fetch with cookies...`);
      try {
        const contextCookies = await context.cookies();
        const cookieHeader = contextCookies
          .filter(c => audioUrl.includes(c.domain.replace(/^\./, '')))
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        
        const response = await fetch(audioUrl, {
          headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'audio/*, video/*, application/octet-stream, */*',
            'Referer': 'https://gemini.google.com/',
          },
          redirect: 'follow',
        });
        
        const ab = await response.arrayBuffer();
        downloadedBuffer = Buffer.from(ab);
        const contentType = response.headers.get('content-type') || '';
        console.log(`[Generator] Node fetch: ${response.status} ${contentType} (${downloadedBuffer.length} bytes)`);
        
        if (isHtmlContent(downloadedBuffer)) {
          console.warn(`[Generator] Node fetch returned HTML (${downloadedBuffer.length} bytes) — trying next strategy`);
          downloadedBuffer = null;
        }
      } catch (e) {
        console.log(`[Generator] Node fetch failed: ${e.message} — trying next strategy`);
      }
    }
    
    // Strategy 5: Use CDP to navigate to the URL and capture the response
    if (!downloadedBuffer && audioUrl.startsWith('http')) {
      console.log(`[Generator] Attempting download via CDP navigation...`);
      try {
        const dlPage = await context.newPage();
        const cdpSession = await dlPage.context().newCDPSession(dlPage);
        await cdpSession.send('Network.enable', { maxResourceBufferSize: 10 * 1024 * 1024 });
        
        let capturedRequestId = null;
        cdpSession.on('Network.responseReceived', (params) => {
          if (params.response.url.includes('download') || params.response.url === audioUrl) {
            capturedRequestId = params.requestId;
          }
        });
        
        await dlPage.goto(audioUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await dlPage.waitForTimeout(3000);
        
        if (capturedRequestId) {
          try {
            const { body, base64Encoded } = await cdpSession.send('Network.getResponseBody', { requestId: capturedRequestId });
            downloadedBuffer = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body);
            console.log(`[Generator] CDP navigation: ${downloadedBuffer.length} bytes`);
            
            if (isHtmlContent(downloadedBuffer)) {
              console.warn(`[Generator] CDP navigation returned HTML — giving up`);
              downloadedBuffer = null;
            }
          } catch (e) {
            console.log(`[Generator] CDP getResponseBody failed: ${e.message}`);
          }
        }
        
        await dlPage.close().catch(() => {});
      } catch (e) {
        console.log(`[Generator] CDP navigation failed: ${e.message}`);
      }
    }
    
    // Final validation
    if (!downloadedBuffer || downloadedBuffer.length < 5000) {
      // Save debug screenshot
      const screenshotPath = path.join(os.tmpdir(), `lyria3-dl-debug-${job.id}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`[Generator] All download strategies failed. Debug screenshot: ${screenshotPath}`);
      console.error(`[Generator] Audio URL was: ${audioUrl}`);
      throw new Error(`All audio download strategies failed for URL: ${audioUrl.substring(0, 80)}`);
    }
    
    if (isHtmlContent(downloadedBuffer)) {
      throw new Error(`Downloaded content is HTML (${downloadedBuffer.length} bytes), not audio — Gemini page was captured instead of audio stream`);
    }
    
    // Save to file
    fs.writeFileSync(tempFile, downloadedBuffer);
    console.log(`[Generator] Saved ${downloadedBuffer.length} bytes to ${tempFile}`);
    
    if (isAudioContent(downloadedBuffer)) {
      console.log(`[Generator] ✅ Audio magic bytes confirmed`);
    } else {
      console.log(`[Generator] ⚠️ Unknown format — first 8 bytes: ${downloadedBuffer.slice(0, 8).toString('hex')}`);
    }
    
    // Verify with ffprobe if available
    try {
      const probe = execSync(`ffprobe -v quiet -print_format json -show_format "${tempFile}" 2>/dev/null`, { timeout: 10000 });
      const info = JSON.parse(probe.toString());
      console.log(`[Generator] ffprobe: format=${info.format?.format_name}, duration=${info.format?.duration}s, size=${info.format?.size}`);
    } catch (e) {
      console.log(`[Generator] ffprobe check skipped`);
    }
    
    return tempFile;
    
  } finally {
    if (page) await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

function convertToMp3(inputPath) {
  const outputPath = inputPath.replace(/\.mp4$/, '.mp3');
  
  console.log(`[Generator] Converting to MP3: ${inputPath}`);
  
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
    console.warn(`[Generator] ffmpeg conversion failed, trying direct copy...`);
  }
  
  try {
    execSync(
      `ffmpeg -y -i "${inputPath}" -vn -c:a copy "${outputPath}" 2>/dev/null`,
      { timeout: 30000 }
    );
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      fs.unlinkSync(inputPath);
      return outputPath;
    }
  } catch {
    console.warn('[Generator] All conversion attempts failed, returning original file');
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
    const key = `lyria3-music/${jobId}-${Date.now()}.mp3`;
    try {
      execSync(
        `AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}" AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}" aws s3 cp "${filePath}" "s3://${S3_BUCKET}/${key}" --region "${S3_REGION || 'us-east-1'}" --content-type "audio/mpeg" --acl public-read 2>/dev/null`,
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
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer], { type: 'audio/mpeg' }), `${jobId}.mp3`);
      
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
