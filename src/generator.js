/**
 * Lyria 3 Music Generator — Core Engine
 * 
 * Uses Playwright browser automation to generate music via Google Gemini.
 * Manages a job queue, browser lifecycle, and result handling.
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
  
  // Add cookies to context
  const validCookies = cookies
    .filter(c => c.value && c.name && c.domain)
    .map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      expires: c.expires > 0 ? c.expires : undefined,
    }));
  
  if (validCookies.length > 0) {
    await context.addCookies(validCookies);
    console.log(`[Generator] Added ${validCookies.length} cookies to browser context`);
  }
  
  return context;
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
        const media = document.querySelectorAll('audio source, video source, audio[src], video[src]');
        for (const el of media) {
          const src = el.getAttribute('src') || '';
          if (src && (src.includes('usercontent.google') || src.includes('blob:') || src.includes('googleusercontent'))) {
            return src;
          }
        }
        
        const links = document.querySelectorAll('a[href*="download"], a[href*="usercontent"]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (href && href.includes('google')) {
            return href;
          }
        }
        
        const playButtons = document.querySelectorAll('[data-track-url], [data-audio-url], [data-src]');
        for (const btn of playButtons) {
          const url = btn.getAttribute('data-track-url') || btn.getAttribute('data-audio-url') || btn.getAttribute('data-src') || '';
          if (url) return url;
        }
        
        return null;
      });
      
      if (audioUrl) {
        console.log(`[Generator] Found audio URL: ${audioUrl.substring(0, 80)}...`);
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
    
    // Download the audio/video file
    job.status = 'downloading';
    const tempFile = path.join(os.tmpdir(), `lyria3-${job.id}-${Date.now()}.mp4`);
    
    const buffer = await page.evaluate(async (url) => {
      const response = await fetch(url);
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      return Array.from(new Uint8Array(arrayBuffer));
    }, audioUrl);
    
    fs.writeFileSync(tempFile, Buffer.from(buffer));
    
    const fileSize = fs.statSync(tempFile).size;
    console.log(`[Generator] Downloaded ${fileSize} bytes to ${tempFile}`);
    
    if (fileSize < 1000) {
      throw new Error(`Downloaded file too small (${fileSize} bytes) — likely not valid audio`);
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
  
  // Fallback: try extracting audio stream
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

// ─── S3 Upload (optional — can use external URL or local file) ──────────────

async function uploadToStorage(filePath, jobId) {
  // If S3 credentials are configured, upload there
  const S3_BUCKET = process.env.S3_BUCKET;
  const S3_REGION = process.env.S3_REGION;
  const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
  const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
  
  if (S3_BUCKET && S3_ACCESS_KEY) {
    // Use AWS CLI or SDK to upload
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
  
  // If UPLOAD_URL is configured, POST the file there
  const UPLOAD_URL = process.env.UPLOAD_URL;
  if (UPLOAD_URL) {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer], { type: 'audio/mpeg' }), `${jobId}.mp3`);
      
      const response = await fetch(UPLOAD_URL, {
        method: 'POST',
        body: formData,
        headers: {
          'x-api-key': process.env.UPLOAD_API_KEY || '',
        },
      });
      
      const result = await response.json();
      fs.unlinkSync(filePath);
      return result.url;
    } catch (err) {
      console.warn('[Generator] Upload failed:', err.message);
    }
  }
  
  // Fallback: serve the file locally (not ideal for production)
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
    // Generate with Playwright
    const tempFile = await generateWithPlaywright(job);
    
    // Convert to MP3
    job.status = 'converting';
    const mp3File = convertToMp3(tempFile);
    
    // Upload
    job.status = 'uploading';
    const audioUrl = await uploadToStorage(mp3File, job.id);
    
    job.status = 'completed';
    job.audioUrl = audioUrl;
    console.log(`[Generator] Job ${job.id} completed: ${audioUrl}`);
    
    // Webhook callback if configured
    if (job.callbackUrl) {
      try {
        await fetch(job.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: job.id,
            status: 'completed',
            audioUrl,
          }),
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
      
      // Webhook callback for failure
      if (job.callbackUrl) {
        try {
          await fetch(job.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: job.id,
              status: 'failed',
              error: error.message,
            }),
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
    params, // Store original params for reference
  };
  
  jobs.set(id, job);
  queue.push(id);
  
  console.log(`[Generator] Job ${id} queued: ${prompt.substring(0, 80)}...`);
  
  // Start processing (non-blocking)
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
    // Check if Playwright has its own browser
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
