/**
 * Lyria 3 Music Generator — Core Engine
 * 
 * Uses Playwright + CDP (Chrome DevTools Protocol) to generate music via Gemini.
 * Audio capture: CDP Network.responseReceived + Network.getResponseBody to grab
 * the actual binary audio data at the protocol level.
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
  // ID3 tag (MP3)
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return true;
  // MP3 sync
  if (h[0] === 0xFF && (h[1] & 0xE0) === 0xE0) return true;
  // MP4/M4A ftyp
  if (h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) return true;
  // WebM EBML
  if (h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3) return true;
  // OGG
  if (h[0] === 0x4F && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53) return true;
  // WAV RIFF
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

// ─── Core Generation with CDP ───────────────────────────────────────────────

async function generateWithPlaywright(job) {
  const browser = await getBrowser();
  const context = await createAuthenticatedContext(browser);
  let page = null;
  
  // Audio data captured via CDP
  let capturedAudioBuffer = null;
  
  // Track all network responses via CDP for audio content
  const cdpResponseBodies = new Map(); // requestId -> {url, contentType, contentLength}
  
  try {
    page = await context.newPage();
    
    // Get CDP session for low-level network interception
    const cdpSession = await page.context().newCDPSession(page);
    
    // Enable Network domain to intercept all responses
    await cdpSession.send('Network.enable', {
      maxResourceBufferSize: 10 * 1024 * 1024,  // 10MB buffer
      maxTotalBufferSize: 50 * 1024 * 1024,      // 50MB total
    });
    
    // Track responses that might contain audio
    cdpSession.on('Network.responseReceived', (params) => {
      const { requestId, response } = params;
      const url = response.url;
      const contentType = (response.headers['content-type'] || response.headers['Content-Type'] || '').toLowerCase();
      const contentLength = parseInt(response.headers['content-length'] || response.headers['Content-Length'] || '0');
      
      // Track ANY response that could be audio/video
      const isMedia = contentType.includes('audio/') || 
                      contentType.includes('video/') ||
                      contentType.includes('octet-stream') ||
                      contentType.includes('application/mp4') ||
                      url.includes('.mp3') || url.includes('.mp4') || 
                      url.includes('.wav') || url.includes('.webm') ||
                      url.includes('.ogg') || url.includes('.m4a') ||
                      url.includes('.opus');
      
      if (isMedia) {
        console.log(`[CDP] Media response: ${url.substring(0, 120)} (type: ${contentType}, size: ${contentLength})`);
        cdpResponseBodies.set(requestId, { url, contentType, contentLength });
      }
    });
    
    // When loading finishes, try to get the body
    cdpSession.on('Network.loadingFinished', async (params) => {
      const { requestId, encodedDataLength } = params;
      const info = cdpResponseBodies.get(requestId);
      
      if (info && encodedDataLength > 5000) {
        try {
          const { body, base64Encoded } = await cdpSession.send('Network.getResponseBody', { requestId });
          const buffer = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body);
          
          if (buffer.length > 10000 && !isHtmlContent(buffer)) {
            if (isAudioContent(buffer)) {
              console.log(`[CDP] ✅ CAPTURED AUDIO via Network.getResponseBody: ${info.url.substring(0, 100)} (${buffer.length} bytes, type: ${info.contentType})`);
              capturedAudioBuffer = buffer;
            } else if (info.contentType.includes('audio/') || info.contentType.includes('video/')) {
              // Trust content-type even if magic bytes don't match known formats
              console.log(`[CDP] ✅ CAPTURED AUDIO (by content-type): ${info.url.substring(0, 100)} (${buffer.length} bytes, type: ${info.contentType})`);
              capturedAudioBuffer = buffer;
            }
          }
        } catch (e) {
          // Some responses can't be retrieved (e.g., streaming) — that's OK
          if (!e.message.includes('No resource with given identifier') && !e.message.includes('No data found')) {
            console.log(`[CDP] Could not get body for ${info.url.substring(0, 80)}: ${e.message}`);
          }
        }
      }
    });
    
    // Navigate to Gemini
    console.log(`[Generator] Navigating to Gemini...`);
    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    // Screenshot for debugging
    const navScreenshot = path.join(os.tmpdir(), `lyria3-nav-${job.id}.png`);
    await page.screenshot({ path: navScreenshot });
    console.log(`[Generator] Navigation screenshot: ${navScreenshot}`);
    
    // Check if we're on Gemini (not a login page)
    const pageTitle = await page.title();
    console.log(`[Generator] Page title: ${pageTitle}`);
    
    // Click "Create music" if available
    console.log(`[Generator] Looking for music creation mode...`);
    const musicButton = await page.$('button:has-text("Create music"), [aria-label*="music"], [data-test-id*="music"]');
    if (musicButton) {
      await musicButton.click();
      await page.waitForTimeout(2000);
      console.log(`[Generator] Clicked music creation button`);
    } else {
      const chips = await page.$$('button, [role="button"]');
      for (const chip of chips) {
        const text = await chip.textContent().catch(() => '');
        if (text && text.toLowerCase().includes('music')) {
          await chip.click();
          await page.waitForTimeout(2000);
          console.log(`[Generator] Clicked chip: ${text}`);
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
        console.log(`[Generator] Input found with selector: ${selector}`);
        break;
      }
    }
    
    if (!inputFound) {
      throw new Error('Could not find Gemini input field');
    }
    
    await page.waitForTimeout(1000);
    
    // Submit
    console.log(`[Generator] Submitting prompt...`);
    await page.keyboard.press('Enter');
    
    // Wait for generation — poll for CDP-captured audio or DOM audio elements
    console.log(`[Generator] Waiting for music generation (up to 3 minutes)...`);
    const startTime = Date.now();
    let clickedPlay = false;
    
    while (Date.now() - startTime < GENERATION_TIMEOUT) {
      await page.waitForTimeout(5000);
      
      // Check if CDP already captured audio
      if (capturedAudioBuffer && capturedAudioBuffer.length > 10000) {
        console.log(`[Generator] Audio captured via CDP! (${capturedAudioBuffer.length} bytes)`);
        break;
      }
      
      // Check DOM for audio/video elements or play buttons
      const domState = await page.evaluate(() => {
        const result = { audioSrcs: [], playButtons: 0, hasMedia: false };
        
        // Check audio/video elements
        const media = document.querySelectorAll('audio, video, audio source, video source');
        for (const el of media) {
          const src = el.getAttribute('src') || el.src || '';
          if (src) {
            result.audioSrcs.push(src.substring(0, 150));
            result.hasMedia = true;
          }
        }
        
        // Check play buttons
        const playBtns = document.querySelectorAll(
          '[aria-label*="Play"], [aria-label*="play"], [data-track-url], [data-audio-url]'
        );
        result.playButtons = playBtns.length;
        if (playBtns.length > 0) result.hasMedia = true;
        
        return result;
      });
      
      if (domState.hasMedia && !clickedPlay) {
        console.log(`[Generator] Media detected in DOM! Sources: ${JSON.stringify(domState.audioSrcs)}, Play buttons: ${domState.playButtons}`);
        
        // Click play to trigger the audio network request (which CDP will intercept)
        console.log(`[Generator] Clicking play to trigger audio download...`);
        await page.evaluate(() => {
          // Click play buttons
          const playBtns = document.querySelectorAll(
            '[aria-label*="Play"], [aria-label*="play"], [data-track-url], [data-audio-url]'
          );
          for (const btn of playBtns) { btn.click(); break; }
          
          // Try playing media elements directly
          const media = document.querySelectorAll('audio, video');
          for (const el of media) {
            try { el.play(); } catch(e) {}
          }
        });
        clickedPlay = true;
        
        // Wait for CDP to capture the audio stream
        await page.waitForTimeout(8000);
        
        if (capturedAudioBuffer && capturedAudioBuffer.length > 10000) {
          console.log(`[Generator] Audio captured after clicking play! (${capturedAudioBuffer.length} bytes)`);
          break;
        }
        
        // If CDP didn't catch it, the audio might be in a blob: URL
        // Use page.evaluate to read the blob and send it back
        console.log(`[Generator] CDP didn't capture audio. Trying blob extraction from media elements...`);
        
        const blobResult = await page.evaluate(async () => {
          const results = [];
          
          // Try all audio/video elements
          const media = document.querySelectorAll('audio, video');
          for (const el of media) {
            const src = el.src || el.querySelector('source')?.src || '';
            if (!src) continue;
            
            try {
              // For blob: URLs, fetch the blob directly
              if (src.startsWith('blob:')) {
                const resp = await fetch(src);
                const blob = await resp.blob();
                // Check if it's actually audio (not HTML)
                if (blob.type && (blob.type.includes('audio') || blob.type.includes('video') || blob.type.includes('octet'))) {
                  const ab = await blob.arrayBuffer();
                  const bytes = Array.from(new Uint8Array(ab));
                  return { bytes, type: blob.type, size: blob.size, source: 'blob:' + src.substring(5, 30) };
                }
                // Even if type is empty, check the bytes
                const ab = await blob.arrayBuffer();
                const first4 = new Uint8Array(ab.slice(0, 4));
                // Check for non-HTML content (not starting with '<')
                if (first4[0] !== 0x3C && ab.byteLength > 10000) {
                  const bytes = Array.from(new Uint8Array(ab));
                  return { bytes, type: blob.type || 'unknown', size: ab.byteLength, source: 'blob-raw' };
                }
              }
              
              // For http(s) URLs
              if (src.startsWith('http')) {
                const resp = await fetch(src, { credentials: 'include' });
                const ct = resp.headers.get('content-type') || '';
                if (ct.includes('audio') || ct.includes('video') || ct.includes('octet')) {
                  const ab = await resp.arrayBuffer();
                  const bytes = Array.from(new Uint8Array(ab));
                  return { bytes, type: ct, size: ab.byteLength, source: 'http' };
                }
              }
            } catch (e) {
              results.push({ error: e.message, src: src.substring(0, 50) });
            }
          }
          
          return null;
        }).catch(() => null);
        
        if (blobResult && blobResult.bytes && blobResult.bytes.length > 10000) {
          const buf = Buffer.from(blobResult.bytes);
          if (!isHtmlContent(buf)) {
            console.log(`[Generator] Got audio via blob extraction (${blobResult.source}): ${buf.length} bytes, type: ${blobResult.type}`);
            capturedAudioBuffer = buf;
            break;
          } else {
            console.warn(`[Generator] Blob extraction returned HTML content (${buf.length} bytes)`);
          }
        }
        
        // Last resort: try to download via the page's download mechanism
        console.log(`[Generator] Trying download button...`);
        const downloadClicked = await page.evaluate(() => {
          const dlBtns = document.querySelectorAll(
            '[aria-label*="Download"], [aria-label*="download"], a[download], button:has-text("Download")'
          );
          for (const btn of dlBtns) { btn.click(); return true; }
          return false;
        });
        
        if (downloadClicked) {
          console.log(`[Generator] Clicked download button, waiting for file...`);
          await page.waitForTimeout(5000);
          
          if (capturedAudioBuffer && capturedAudioBuffer.length > 10000) {
            console.log(`[Generator] Audio captured via download! (${capturedAudioBuffer.length} bytes)`);
            break;
          }
        }
      }
      
      // Check for errors
      const hasError = await page.evaluate(() => {
        const errorTexts = ['something went wrong', 'try again', 'unable to generate', "can't generate"];
        const bodyText = document.body.innerText.toLowerCase();
        return errorTexts.some(t => bodyText.includes(t));
      });
      
      if (hasError) {
        console.warn('[Generator] Detected possible error on page');
      }
      
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[Generator] Still waiting... (${elapsed}s, captured: ${capturedAudioBuffer ? capturedAudioBuffer.length + 'B' : 'none'}, cdpTracked: ${cdpResponseBodies.size})`);
    }
    
    // Final check
    if (!capturedAudioBuffer || capturedAudioBuffer.length < 10000) {
      // Take debug screenshot
      const screenshotPath = path.join(os.tmpdir(), `lyria3-debug-${job.id}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      
      // Log detailed page state
      const pageState = await page.evaluate(() => {
        const audioEls = document.querySelectorAll('audio, video');
        const sources = [];
        audioEls.forEach(el => {
          sources.push({
            tag: el.tagName,
            src: (el.src || '').substring(0, 150),
            childSources: Array.from(el.querySelectorAll('source')).map(s => (s.src || '').substring(0, 150)),
            paused: el.paused,
            duration: el.duration,
            readyState: el.readyState,
          });
        });
        
        // Also check for any large data URLs or blob URLs in the page
        const allElements = document.querySelectorAll('[src], [data-src], [href]');
        const mediaUrls = [];
        allElements.forEach(el => {
          const src = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('href') || '';
          if (src.includes('blob:') || src.includes('.mp3') || src.includes('.mp4') || 
              src.includes('.wav') || src.includes('.webm') || src.includes('audio') ||
              src.includes('usercontent.google')) {
            mediaUrls.push(src.substring(0, 150));
          }
        });
        
        return {
          title: document.title,
          url: window.location.href,
          audioElements: sources,
          mediaUrls,
          bodyTextLength: document.body.innerText.length,
        };
      });
      
      console.error(`[Generator] FAILED — Debug screenshot: ${screenshotPath}`);
      console.error(`[Generator] Page state:`, JSON.stringify(pageState, null, 2));
      console.error(`[Generator] CDP tracked ${cdpResponseBodies.size} media responses`);
      
      // List all tracked CDP responses
      for (const [reqId, info] of cdpResponseBodies) {
        console.error(`[CDP] Tracked: ${info.url.substring(0, 120)} (type: ${info.contentType}, size: ${info.contentLength})`);
      }
      
      throw new Error(`Music generation failed — no audio captured. Page: ${pageState.title}, Audio elements: ${pageState.audioElements.length}, Media URLs: ${pageState.mediaUrls.length}, CDP tracked: ${cdpResponseBodies.size}`);
    }
    
    // Validate
    if (isHtmlContent(capturedAudioBuffer)) {
      throw new Error('Captured content is HTML, not audio — Gemini session may have expired');
    }
    
    // Save to temp file
    job.status = 'downloading';
    const tempFile = path.join(os.tmpdir(), `lyria3-${job.id}-${Date.now()}.mp4`);
    fs.writeFileSync(tempFile, capturedAudioBuffer);
    
    console.log(`[Generator] Saved ${capturedAudioBuffer.length} bytes to ${tempFile}`);
    
    // Verify with ffprobe if available
    try {
      const probe = execSync(`ffprobe -v quiet -print_format json -show_format "${tempFile}" 2>/dev/null`, { timeout: 10000 });
      const info = JSON.parse(probe.toString());
      console.log(`[Generator] ffprobe: format=${info.format?.format_name}, duration=${info.format?.duration}s, size=${info.format?.size}`);
    } catch (e) {
      console.log(`[Generator] ffprobe not available or failed — skipping validation`);
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
  
  // Fallback: local file served via /api/download/:id
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
