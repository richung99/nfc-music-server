require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const cron    = require('node-cron');

// Auto-build retrochung.html from src/ on every server start
require('./build');

const app       = express();
const HTTP_PORT  = 3000;
const HTTPS_PORT = 8443;

// ─── Tailscale HTTPS cert ─────────────────────────────────────────────────────
// Run: tailscale cert YOUR-MACHINE.tail1234.ts.net
// Place the generated .crt and .key files in your project root
// Set TAILSCALE_HOSTNAME in your environment or edit the line below
const TAILSCALE_HOSTNAME = process.env.TAILSCALE_HOSTNAME || '';
let sslOptions = null;
if (TAILSCALE_HOSTNAME) {
  const certPath = path.join(__dirname, `${TAILSCALE_HOSTNAME}.crt`);
  const keyPath  = path.join(__dirname, `${TAILSCALE_HOSTNAME}.key`);
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    sslOptions = {
      cert: fs.readFileSync(certPath),
      key:  fs.readFileSync(keyPath),
    };
    console.log(`SSL certs loaded for ${TAILSCALE_HOSTNAME}`);
  } else {
    console.warn(`SSL cert files not found for ${TAILSCALE_HOSTNAME} - run: tailscale cert ${TAILSCALE_HOSTNAME}`);
  }
}

// Ensure tmp dir exists for uploads
fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────
// Root folder where your music lives. Each album is a subfolder containing:
//   - album.json   (metadata)
//   - cover.jpg    (album art)
//   - 01.mp3, 02.mp3 ... (audio files, any order matches the JSON tracklist)
const MUSIC_DIR = path.join(__dirname, 'music');
const RADIO_DIR = path.join(__dirname, 'public', 'radio');

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve the frontend (index.html + assets) from /public
app.use(express.static(path.join(__dirname, 'public')));

// Album uploader utility
const uploader = require('./uploader');
app.use('/upload', uploader);

// ─── Helper: load an album's metadata ─────────────────────────────────────────
function loadAlbum(albumId) {
  const albumDir = path.join(MUSIC_DIR, albumId);
  if (!fs.existsSync(albumDir)) return null;

  const metaPath = path.join(albumDir, 'album.json');
  if (!fs.existsSync(metaPath)) return null;

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.tracks = meta.tracks.map((track, i) => ({
      ...track,
      url: `/audio/${albumId}/${track.file}`,
    }));
    meta.cover = `/audio/${albumId}/cover.jpg`;
    meta.id = albumId;
    return meta;
  } catch(e) {
    console.error('loadAlbum error:', e.message);
    return null;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/albums
// Returns a list of all albums (for a browse/library view later)
app.get('/api/albums', (req, res) => {
  if (!fs.existsSync(MUSIC_DIR)) {
    return res.json([]);
  }

  const albums = fs.readdirSync(MUSIC_DIR)
    .filter(name => {
      const full = path.join(MUSIC_DIR, name);
      return fs.statSync(full).isDirectory();
    })
    .map(id => loadAlbum(id))
    .filter(Boolean); // drop any folders missing album.json

  res.json(albums);
});

// GET /api/album/:id
// Returns metadata + track list for a single album.
// This is the endpoint your NFC tag URL will trigger.
app.get('/api/album/:id', (req, res) => {
  const album = loadAlbum(req.params.id);

  if (!album) {
    return res.status(404).json({
      error: `Album "${req.params.id}" not found.`
    });
  }

  res.json(album);
});

// GET /audio/:albumId/:filename
// Streams audio files and images with range request support (needed for
// seeking in the browser audio player).
app.get('/audio/:albumId/:filename', (req, res) => {
  const filePath = path.join(MUSIC_DIR, req.params.albumId, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  // Images — serve normally
  if (!range) {
    res.sendFile(filePath);
    return;
  }

  // Audio — handle range requests so the browser can seek
  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  const chunkSize = end - start + 1;

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg; codecs=opus',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': contentType,
  });

  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// ─── Browser debug log ────────────────────────────────────────────────────────
app.post('/debug-log', (req, res) => {
  const { ts, type, msg } = req.body || {};
  console.log(`[browser ${ts||'?'}] [${(type||'info').toUpperCase()}] ${msg||JSON.stringify(req.body)}`);
  res.sendStatus(200);
});

// ─── Radio files ──────────────────────────────────────────────────────────────
// Serve MP3s from public/radio/ — express.static handles range requests,
// special characters, and spaces in filenames correctly
app.use('/radio', express.static(path.join(__dirname, 'public', 'radio'), {
  setHeaders: (res) => {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'audio/mpeg');
  }
}));

// ─── Library home screen ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'library.html'));
});

// ─── Gacha slot machine ─────────────────────────────────────────────────────────
// Standalone page — not yet linked from library.html. UI/interaction pass with
// mock playlist data; real cache-backed generation lands in a follow-up.
app.get('/gacha', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gacha.html'));
});

// ─── Gacha playlist batch (background-curated, real tracks) ────────────────
// See gacha-engine.js for the full design. In short: there's always a
// current batch of 5 real, curated playlists shared by every device. A
// device fetches the batch, picks one it hasn't pulled yet client-side, and
// calls /complete once it's personally pulled all 5 — whichever device does
// that FIRST starts the 30-minute countdown to the next curation run.
const gacha = require('./gacha-engine');

app.get('/api/gacha/batch', async (req, res) => {
  try {
    const state = await gacha.getState();
    res.json(state);
  } catch (err) {
    console.error('gacha batch error:', err.message);
    res.status(500).json({ error: 'Failed to load gacha batch' });
  }
});

app.post('/api/gacha/complete', async (req, res) => {
  const { batchId } = req.body || {};
  if (!batchId) return res.status(400).json({ error: 'batchId is required' });
  try {
    const state = await gacha.markComplete(batchId);
    res.json(state);
  } catch (err) {
    console.error('gacha complete error:', err.message);
    res.status(500).json({ error: 'Failed to register completion' });
  }
});

// ─── Saved playlists (server-side, shared across all devices) ────────────────
// Stored in saved-playlists.json at the project root. Persists across
// sessions, browser clears, and device switches — anywhere on the home
// network that can reach this server sees the same saved list.
const SAVED_FILE = path.join(__dirname, 'saved-playlists.json');

function loadSaved() {
  try { return JSON.parse(fs.readFileSync(SAVED_FILE, 'utf-8')); }
  catch (e) { return []; }
}
function persistSaved(list) {
  fs.writeFileSync(SAVED_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/saved', (req, res) => {
  res.json(loadSaved());
});

app.post('/api/saved', (req, res) => {
  const playlist = req.body;
  if (!playlist?.id || !playlist?.name) {
    return res.status(400).json({ error: 'playlist must have id and name' });
  }
  const list = loadSaved();
  if (list.some(p => p.id === playlist.id)) {
    return res.status(409).json({ error: 'already saved' });
  }
  list.unshift(playlist);
  persistSaved(list);
  res.json({ ok: true, count: list.length });
});

app.delete('/api/saved/:id', (req, res) => {
  const list = loadSaved().filter(p => p.id !== req.params.id);
  persistSaved(list);
  res.json({ ok: true, count: list.length });
});

// ─── Shared affinity aggregation helper ───────────────────────────────────────
function applyRating(track, mood, mood_rating, setting, setting_rating) {
  const MOODS    = ['sunny','cloudy','rainy','snowy','windy','stormy'];
  const SETTINGS = ['bedroom','cafe','gym','work','drive','travel'];

  if(!track.affinities) track.affinities = { moods: {}, settings: {} };
  if(!track.affinities.moods) track.affinities.moods = {};
  if(!track.affinities.settings) track.affinities.settings = {};
  if(!track.affinities.moodRatings) track.affinities.moodRatings = {};
  if(!track.affinities.settingRatings) track.affinities.settingRatings = {};

  if(mood && MOODS.includes(mood) && mood_rating >= 1 && mood_rating <= 5) {
    const nudge   = (mood_rating - 3) * AFFINITY_NUDGE;
    const current = track.affinities.moods[mood] ?? 0.5;
    const count   = track.affinities.moodRatings[mood] ?? 0;
    track.affinities.moodRatings[mood] = count + 1;
    track.affinities.moods[mood] = Math.max(0, Math.min(1,
      Math.round(((current * count) + (current + nudge)) / (count + 1) * 1000) / 1000
    ));
  }

  if(setting && SETTINGS.includes(setting) && setting_rating >= 1 && setting_rating <= 5) {
    const nudge   = (setting_rating - 3) * AFFINITY_NUDGE;
    const current = track.affinities.settings[setting] ?? 0.5;
    const count   = track.affinities.settingRatings[setting] ?? 0;
    track.affinities.settingRatings[setting] = count + 1;
    track.affinities.settings[setting] = Math.max(0, Math.min(1,
      Math.round(((current * count) + (current + nudge)) / (count + 1) * 1000) / 1000
    ));
  }
}

// ─── POST /api/ratings/flush — batch aggregate pending ratings on new batch ───
// Called by gacha.js when a new batchId is detected.
// Accepts: { ratings: [{ albumId, file, mood, mood_rating, setting, setting_rating }] }
app.post('/api/ratings/flush', (req, res) => {
  const { ratings } = req.body;
  if(!Array.isArray(ratings) || !ratings.length)
    return res.json({ ok: true, processed: 0 });

  // Group by albumId to minimize file reads/writes
  const byAlbum = {};
  for(const r of ratings){
    if(!r.albumId || !r.file) continue;
    if(!byAlbum[r.albumId]) byAlbum[r.albumId] = [];
    byAlbum[r.albumId].push(r);
  }

  let processed = 0;
  let errors = 0;

  for(const [albumId, albumRatings] of Object.entries(byAlbum)){
    const jsonPath = path.join(__dirname, 'music', albumId, 'album.json');
    if(!fs.existsSync(jsonPath)){ errors++; continue; }

    let album;
    try { album = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); }
    catch(e){ errors++; continue; }

    let changed = false;
    for(const r of albumRatings){
      const track = album.tracks.find(t => t.file === r.file);
      if(!track){ errors++; continue; }
      applyRating(track, r.mood, r.mood_rating, r.setting, r.setting_rating);
      processed++;
      changed = true;
    }

    if(changed){
      try { fs.writeFileSync(jsonPath, JSON.stringify(album, null, 2)); }
      catch(e){ errors++; }
    }
  }

  console.log(`[server] Flushed ${processed} ratings (${errors} errors)`);
  res.json({ ok: true, processed, errors });
});

// ─── PATCH /api/track/:albumId/:file — update track affinity from player ratings ─
// Accepts: { mood, mood_rating (1-5), setting, setting_rating (1-5) }
// Ratings translate to affinity nudges: 3=neutral, 1-2=negative, 4-5=positive
const AFFINITY_NUDGE = 0.08; // how much one star away from midpoint shifts affinity
app.patch('/api/track/:albumId/:file', (req, res) => {
  const { albumId, file } = req.params;
  const albumDir  = path.join(__dirname, 'music', albumId);
  const jsonPath  = path.join(albumDir, 'album.json');

  if(!fs.existsSync(jsonPath))
    return res.status(404).json({ error: `Album "${albumId}" not found` });

  let album;
  try { album = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); }
  catch(e) { return res.status(500).json({ error: 'Could not read album.json' }); }

  const track = album.tracks.find(t => t.file === file);
  if(!track) return res.status(404).json({ error: `Track "${file}" not found` });

  const { mood, mood_rating, setting, setting_rating } = req.body;

  // Ensure affinities structure exists
  if(!track.affinities) track.affinities = { moods: {}, settings: {} };
  if(!track.affinities.moods) track.affinities.moods = {};
  if(!track.affinities.settings) track.affinities.settings = {};

  applyRating(track, mood, mood_rating, setting, setting_rating);

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(album, null, 2));
    console.log(`[server] Affinity updated: ${albumId}/${file} mood=${mood}:${track.affinities.moods[mood]} setting=${setting}:${track.affinities.settings[setting]}`);
    res.json({ ok: true, affinities: track.affinities });
  } catch(e) {
    res.status(500).json({ error: 'Could not write album.json' });
  }
});


// matches this literal route first. player.js reads the playlist from
// sessionStorage (written by gacha.html's PLAY button) instead of an album API.
app.get('/play/gacha', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'retrochung.html'));
});

// NFC tag URL: http://yourserver/play/ALBUM_ID
// Serves the combined arcade + player experience
app.get('/play/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'retrochung.html'));
});

// ─── Discovery system ─────────────────────────────────────────────────────────
const { fetchDiscoveries }  = require('./fetch-discoveries');
const DISCOVERIES_PATH      = path.join(__dirname, 'discoveries.json');

function getDiscoveryState() {
  if (!fs.existsSync(DISCOVERIES_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(DISCOVERIES_PATH, 'utf-8')); }
  catch(e) { return null; }
}

function saveDiscoveryState(state) {
  fs.writeFileSync(DISCOVERIES_PATH, JSON.stringify(state, null, 2));
}

function notifyUpload(albumId, title, artist) {
  let state = getDiscoveryState() || { discoveries: [], generatedAt: null, uploads: [] };
  if (!state.uploads) state.uploads = [];
  state.uploads.push({ albumId, title, artist, addedAt: new Date().toISOString() });
  if (state.uploads.length > 20) state.uploads = state.uploads.slice(-20);
  saveDiscoveryState(state);
  console.log(`[server] Upload notification added: ${artist} — ${title}`);
}

(async () => {
  const state = getDiscoveryState();
  if (!state) {
    console.log('[discoveries] No discoveries.json found, running initial fetch...');
    await fetchDiscoveries();
    return;
  }
  const lastRun    = new Date(state.generatedAt).getTime();
  const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
  if (hoursSince >= 12) {
    console.log(`[discoveries] Last run was ${Math.round(hoursSince)}h ago, running catch-up fetch...`);
    await fetchDiscoveries();
  } else {
    console.log(`[discoveries] Last run was ${Math.round(hoursSince)}h ago, next run scheduled.`);
  }
})();

cron.schedule('0 9 * * *',  () => fetchDiscoveries(), { timezone: 'America/New_York' });
cron.schedule('0 21 * * *', () => fetchDiscoveries(), { timezone: 'America/New_York' });

app.get('/api/discoveries', (req, res) => {
  const state = getDiscoveryState();
  if (!state) return res.json({ discoveries: [], uploads: [], generatedAt: null });
  res.json({
    discoveries: state.discoveries || [],
    uploads:     state.uploads     || [],
    generatedAt: state.generatedAt || null,
  });
});

// ─── Debug catch-all ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log('Unmatched route:', req.method, req.path);
  next();
});

app.get('/api/discoveries/preview', async (req, res) => {
  const { artist, track } = req.query;
  if (!artist || !track) return res.status(400).json({ error: 'missing artist or track' });
  try {
    const q    = encodeURIComponent(`artist:"${artist}" track:"${track}"`);
    const data = await fetch(`https://api.deezer.com/search?q=${q}&limit=3`).then(r => r.json());
    for (const r of (data.data || [])) {
      if (r.preview?.length > 0) {
        return res.json({ previewUrl: r.preview.replace(/^http:\/\//, 'https://') });
      }
    }
    res.status(404).json({ error: 'no preview found' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/discoveries — returns raw data, no dismissed field (client handles per-device)
app.get('/api/discoveries', (req, res) => {
  const state = getDiscoveryState();
  if (!state) return res.json({ discoveries: [], uploads: [], generatedAt: null });
  res.json({
    discoveries: state.discoveries || [],
    uploads:     state.uploads     || [],
    generatedAt: state.generatedAt || null,
  });
});

// Always start HTTP (for local access)
http.createServer(app).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\n🎵 NFC Music Server`);
  console.log(`   HTTP:  http://localhost:${HTTP_PORT}`);
  console.log(`   Music: ${MUSIC_DIR}`);
});

// Start HTTPS if certs are available — try 443 first, fall back to 8443
if (sslOptions) {
  const tryHTTPS = (port) => {
    const server = https.createServer(sslOptions, app);
    server.on('error', (err) => {
      if (err.code === 'EACCES' && port === 443) {
        console.log('   Port 443 requires admin, trying 8443...');
        tryHTTPS(8443);
      } else {
        console.error('HTTPS error:', err.message);
      }
    });
    server.listen(port, '0.0.0.0', () => {
      const portStr = port === 443 ? '' : `:${port}`;
      console.log(`   HTTPS: https://${TAILSCALE_HOSTNAME}${portStr}`);
      console.log(`\n   NFC tag URL: https://${TAILSCALE_HOSTNAME}${portStr}/play/ALBUM_ID\n`);
    });
  };
  tryHTTPS(443);
} else {
  console.log(`\n   HTTPS not configured. Set TAILSCALE_HOSTNAME and run tailscale cert.`);
  console.log(`   NFC tag URL (HTTP only): http://YOUR_IP:${HTTP_PORT}/play/ALBUM_ID\n`);
}
