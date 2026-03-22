# Lyria 3 Music API — Tarab AI Engine

Standalone REST API microservice for generating music via Google Gemini's Lyria 3 model using Playwright browser automation.

## Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium

# Copy env file
cp .env.example .env

# Start the server
npm start
```

## API Endpoints

### Health Check
```
GET /api/health
```
No authentication required. Returns system status.

### Generate Music
```
POST /api/generate
Headers: x-api-key: YOUR_API_KEY
Body: {
  "prompt": "Upbeat Saudi National Day anthem",
  "genre": "national_day",
  "language": "arabic",
  "instrumental": false,
  "vocalGender": "m",
  "lyrics": "Optional lyrics text...",
  "title": "My Song",
  "duration": 30,
  "callbackUrl": "https://your-app.com/webhook/music"
}
```

### Check Job Status
```
GET /api/status/:jobId
Headers: x-api-key: YOUR_API_KEY
```

Returns:
```json
{
  "jobId": "uuid",
  "status": "completed",
  "audioUrl": "https://s3.../music.mp3",
  "error": null,
  "createdAt": 1711234567890,
  "attempts": 1
}
```

### Upload Google Cookies
```
POST /api/cookies
Headers: x-api-key: YOUR_API_KEY
Body: {
  "cookies": [
    { "name": "SID", "value": "...", "domain": ".google.com", "path": "/" },
    ...
  ]
}
```

### List Recent Jobs
```
GET /api/jobs
Headers: x-api-key: YOUR_API_KEY
```

## Available Genres

| Genre Key | Description |
|-----------|-------------|
| `arabic_pop` | Arabic pop |
| `modern_arabic_pop` | Modern Arabic pop |
| `traditional_arabic` | Traditional Arabic |
| `khaleeji` | Khaleeji Gulf style |
| `national_day` | Saudi National Day anthem |
| `founding_day` | Saudi Founding Day anthem |
| `eid` | Eid celebration |
| `ramadan` | Ramadan spiritual |
| `ardah` | Ardah traditional |
| `samri` | Samri folk |
| `arabic_hiphop` | Arabic hip-hop |
| `arabic_rnb` | Arabic R&B |
| `arabic_emotional` | Arabic emotional ballad |
| `arabic_cinematic` | Arabic cinematic |
| `arabic_luxury` | Arabic luxury elegant |
| `pop` | Pop |
| `hiphop` | Hip-hop |
| `electronic` | Electronic |
| `edm` | EDM |
| `rock` | Rock |
| `rnb` | R&B |
| `jazz` | Jazz |
| `classical_orchestral` | Classical orchestral |
| `corporate_professional` | Corporate background |
| `upbeat_energetic` | Upbeat energetic |
| `emotional_cinematic` | Emotional cinematic |
| `ambient_background` | Ambient background |

## Deploy on Render

1. Push this repo to GitHub
2. On Render: **New > Blueprint > Connect repo**
3. Render will auto-create the service with Docker + persistent disk
4. Set your `API_KEY` in Render environment variables
5. Upload Google cookies via the API (see below)

### Getting Google Cookies

1. Open Chrome, log into your Google account
2. Go to `gemini.google.com`
3. Install the "EditThisCookie" or "Cookie-Editor" Chrome extension
4. Export all cookies for `.google.com` as JSON
5. POST them to your API:

```bash
curl -X POST https://your-lyria-api.onrender.com/api/cookies \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"cookies": [...]}'
```

### Cookie Refresh

Google cookies typically last 2-4 weeks. When they expire:
1. Log into Google in your browser
2. Export fresh cookies
3. POST to `/api/cookies` again

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | Yes | `tarab-dev-key-change-me` | API authentication key |
| `PORT` | No | `4000` | Server port |
| `COOKIE_DIR` | No | `./cookies` | Cookie storage path |
| `S3_BUCKET` | No | - | S3 bucket for music files |
| `S3_REGION` | No | `us-east-1` | S3 region |
| `S3_ACCESS_KEY` | No | - | S3 access key |
| `S3_SECRET_KEY` | No | - | S3 secret key |
| `UPLOAD_URL` | No | - | Custom upload endpoint |

## Integration with V8AQL

In your main app, replace the Playwright code with API calls:

```typescript
const LYRIA3_API_URL = process.env.LYRIA3_API_URL;
const LYRIA3_API_KEY = process.env.LYRIA3_API_KEY;

// Queue generation
const res = await fetch(`${LYRIA3_API_URL}/api/generate`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': LYRIA3_API_KEY,
  },
  body: JSON.stringify({ prompt, genre, language, instrumental, vocalGender, lyrics }),
});
const { jobId } = await res.json();

// Poll for result
let status;
do {
  await new Promise(r => setTimeout(r, 5000));
  const check = await fetch(`${LYRIA3_API_URL}/api/status/${jobId}`, {
    headers: { 'x-api-key': LYRIA3_API_KEY },
  });
  status = await check.json();
} while (status.status !== 'completed' && status.status !== 'failed');
```
