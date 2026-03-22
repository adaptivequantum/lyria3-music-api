/**
 * Lyria 3 Music Generation API — "Tarab AI Engine"
 * 
 * Standalone microservice that generates music via Google Gemini's Lyria 3 model
 * using Playwright browser automation. Deploy separately, call via REST API.
 * 
 * Endpoints:
 *   POST /api/generate     — Queue a music generation job
 *   GET  /api/status/:id   — Check job status
 *   GET  /api/health       — Health check
 *   POST /api/cookies      — Upload Google cookies (JSON array)
 *   GET  /api/jobs         — List recent jobs
 */

import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { generateMusic, getJob, getRecentJobs, checkHealth } from './generator.js';
import { saveCookies, getCookies } from './cookies.js';

config();

const app = express();
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY || 'tarab-dev-key-change-me';

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API Key authentication
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check (no auth required)
app.get('/api/health', async (req, res) => {
  const health = await checkHealth();
  res.json(health);
});

// Generate music
app.post('/api/generate', authenticate, async (req, res) => {
  try {
    const {
      prompt,
      genre,
      language,
      instrumental,
      vocalGender,
      lyrics,
      title,
      duration,
      callbackUrl,  // Optional: webhook URL to POST result when done
    } = req.body;

    if (!prompt && !lyrics) {
      return res.status(400).json({ error: 'Either prompt or lyrics is required' });
    }

    const job = await generateMusic({
      prompt: prompt || '',
      genre: genre || 'arabic_pop',
      language: language || 'arabic',
      instrumental: instrumental ?? false,
      vocalGender: vocalGender || 'm',
      lyrics: lyrics || '',
      title: title || '',
      duration: duration || 30,
      callbackUrl,
    });

    res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      message: 'Music generation queued. Poll /api/status/:jobId for updates.',
    });
  } catch (err) {
    console.error('[API] Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Check job status
app.get('/api/status/:id', authenticate, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({
    jobId: job.id,
    status: job.status,
    audioUrl: job.audioUrl || null,
    error: job.error || null,
    createdAt: job.createdAt,
    attempts: job.attempts,
  });
});

// List recent jobs
app.get('/api/jobs', authenticate, (req, res) => {
  const jobs = getRecentJobs();
  res.json({ jobs });
});

// Upload cookies
app.post('/api/cookies', authenticate, async (req, res) => {
  try {
    const { cookies } = req.body;
    if (!cookies || !Array.isArray(cookies)) {
      return res.status(400).json({ error: 'cookies must be an array of cookie objects' });
    }
    await saveCookies(cookies);
    res.json({ success: true, count: cookies.length, message: 'Cookies saved successfully' });
  } catch (err) {
    console.error('[API] Cookie save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Lyria 3 Music API (Tarab AI Engine) running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   API Key: ${API_KEY.substring(0, 8)}...`);
});
