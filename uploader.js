const express = require('express');
const multer = require('multer');
const mm = require('music-metadata');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const DISCOVERIES_PATH = path.join(__dirname, 'discoveries.json');

function notifyUpload(albumId, title, artist) {
  try {
    let state = { discoveries: [], generatedAt: null, uploads: [] };
    if (fs.existsSync(DISCOVERIES_PATH)) {
      state = JSON.parse(fs.readFileSync(DISCOVERIES_PATH, 'utf-8'));
    }
    if (!state.uploads) state.uploads = [];
    state.uploads.push({ albumId, title, artist, addedAt: new Date().toISOString() });
    if (state.uploads.length > 20) state.uploads = state.uploads.slice(-20);
    fs.writeFileSync(DISCOVERIES_PATH, JSON.stringify(state, null, 2));
    console.log(`[uploader] Upload notification added: ${artist} — ${title}`);
  } catch(e) {
    console.warn('[uploader] Could not write upload notification:', e.message);
  }
}

const router = express.Router();
const MUSIC_DIR = path.join(__dirname, 'music');

const PYTHON_EXE = process.env.PYTHON_EXE
  || 'C:\\Users\\richu\\AppData\\Local\\Programs\\Python\\Python314\\python.exe';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';

// ─── Temp storage for uploads ─────────────────────────────────────────────────
// Files land in /tmp first, we move them after processing
const upload = multer({
  dest: path.join(__dirname, 'tmp'),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB per file
  fileFilter: (req, file, cb) => {
    const audioTypes = /mp3|flac|ogg|opus|aac|m4a|wav/i;
    const imageTypes = /jpg|jpeg|png|gif|webp/i;
    const ext = path.extname(file.originalname).slice(1);
    if (audioTypes.test(ext) || imageTypes.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}`));
    }
  }
});

// ─── Helper: slugify album title to folder name ───────────────────────────────
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ─── Helper: format seconds to mm:ss ─────────────────────────────────────────
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Helper: extract track number from filename ───────────────────────────────
// Handles: "01 - title.mp3", "01. title.mp3", "01_title.mp3", "title.mp3"
function extractTrackNumber(filename) {
  const match = filename.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ─── Helper: clean up track title from filename ───────────────────────────────
function cleanTitle(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/^\d+[\s.\-_]+/, '') // strip leading track number
    .replace(/[\-_]+/g, ' ')       // dashes/underscores to spaces
    .replace(/\s+/g, ' ')
    .trim()
    // Title case
    .replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// ─── Enrichment: audio analysis ──────────────────────────────────────────────
// Runs analyze-albums.py for a single album. Returns a promise that resolves
// when the Python process exits. Output is streamed to server console.
function analyzeAlbum(albumId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'tools', 'analyze-albums.py');
    if (!fs.existsSync(scriptPath)) {
      console.warn('[uploader] tools/analyze-albums.py not found — skipping audio analysis');
      return resolve();
    }
    console.log(`[uploader] Analyzing audio features for "${albumId}"...`);
    const proc = spawn(PYTHON_EXE, [scriptPath, '--album', albumId], {
      cwd: __dirname,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('close', code => {
      if (code !== 0) {
        console.warn(`[uploader] tools/analyze-albums.py exited with code ${code} — continuing anyway`);
      } else {
        console.log(`[uploader] Audio analysis complete for "${albumId}"`);
      }
      resolve(); // always resolve — don't block upload on analysis failure
    });
    proc.on('error', err => {
      console.warn(`[uploader] Failed to spawn Python: ${err.message} — skipping analysis`);
      resolve();
    });
  });
}

// ─── Enrichment: AI tag-tracks ────────────────────────────────────────────────
// Calls tag-tracks.js logic for a single album via child process.
function tagAlbum(albumId) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'tag-tracks.js');
    if (!fs.existsSync(scriptPath)) {
      console.warn('[uploader] tag-tracks.js not found — skipping AI tagging');
      return resolve();
    }
    console.log(`[uploader] AI tagging tracks for "${albumId}"...`);
    const proc = spawn(process.execPath, [scriptPath, '--album', albumId], {
      cwd: __dirname,
      env: { ...process.env, OLLAMA_MODEL, OLLAMA_URL },
    });
    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('close', code => {
      if (code !== 0) {
        console.warn(`[uploader] tag-tracks.js exited with code ${code} — continuing anyway`);
      } else {
        console.log(`[uploader] AI tagging complete for "${albumId}"`);
      }
      resolve();
    });
    proc.on('error', err => {
      console.warn(`[uploader] Failed to spawn tag-tracks.js: ${err.message} — skipping tagging`);
      resolve();
    });
  });
}

// ─── GET /upload — serve the uploader UI ──────────────────────────────────────
router.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Add Album — NFC Music Server</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0e0e12;
      color: #e0ddd8;
      min-height: 100vh;
      padding: 2rem 1rem;
    }

    .page {
      max-width: 640px;
      margin: 0 auto;
    }

    header {
      margin-bottom: 2.5rem;
    }

    header h1 {
      font-size: 1.5rem;
      font-weight: 600;
      color: #fff;
      letter-spacing: -0.02em;
    }

    header p {
      margin-top: 0.4rem;
      font-size: 0.875rem;
      color: #6b6a66;
    }

    .card {
      background: #18181f;
      border: 1px solid #2a2a35;
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.25rem;
    }

    .card h2 {
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #6b6a66;
      margin-bottom: 1rem;
    }

    .field {
      margin-bottom: 1rem;
    }

    .field:last-child { margin-bottom: 0; }

    label {
      display: block;
      font-size: 0.825rem;
      color: #a0a09a;
      margin-bottom: 0.375rem;
    }

    input[type="text"],
    input[type="number"] {
      width: 100%;
      background: #0e0e12;
      border: 1px solid #2a2a35;
      border-radius: 7px;
      color: #e0ddd8;
      font-size: 0.9rem;
      padding: 0.6rem 0.75rem;
      outline: none;
      transition: border-color 0.15s;
    }

    input[type="text"]:focus,
    input[type="number"]:focus {
      border-color: #5b5bf0;
    }

    .drop-zone {
      border: 1.5px dashed #2a2a35;
      border-radius: 10px;
      padding: 2rem 1rem;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      position: relative;
    }

    .drop-zone:hover,
    .drop-zone.drag-over {
      border-color: #5b5bf0;
      background: #1c1c28;
    }

    .drop-zone input[type="file"] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      width: 100%;
      height: 100%;
    }

    .drop-icon {
      font-size: 2rem;
      margin-bottom: 0.5rem;
      opacity: 0.4;
    }

    .drop-zone p {
      font-size: 0.875rem;
      color: #6b6a66;
    }

    .drop-zone strong {
      color: #a0a09a;
    }

    .file-list {
      margin-top: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    .file-chip {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: #0e0e12;
      border: 1px solid #2a2a35;
      border-radius: 6px;
      padding: 0.4rem 0.75rem;
      font-size: 0.8rem;
      color: #a0a09a;
    }

    .file-chip .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #5b5bf0;
      flex-shrink: 0;
    }

    .file-chip .dot.img { background: #f0905b; }

    .file-chip .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-chip .size {
      color: #4a4a50;
      flex-shrink: 0;
    }

    .btn {
      display: block;
      width: 100%;
      padding: 0.8rem;
      background: #5b5bf0;
      border: none;
      border-radius: 9px;
      color: #fff;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      margin-top: 1.25rem;
    }

    .btn:hover { background: #4a4ad8; }
    .btn:active { transform: scale(0.99); }
    .btn:disabled {
      background: #2a2a35;
      color: #4a4a50;
      cursor: not-allowed;
    }

    .progress {
      display: none;
      margin-top: 1.25rem;
    }

    .progress-bar-bg {
      background: #2a2a35;
      border-radius: 4px;
      height: 4px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      background: #5b5bf0;
      width: 0%;
      transition: width 0.3s;
      border-radius: 4px;
    }

    .progress-label {
      font-size: 0.8rem;
      color: #6b6a66;
      margin-top: 0.5rem;
    }

    .result {
      display: none;
      margin-top: 1.25rem;
      padding: 1rem;
      border-radius: 9px;
      font-size: 0.875rem;
    }

    .result.success {
      background: #0d1f12;
      border: 1px solid #1e4a26;
      color: #6fcf8a;
    }

    .result.error {
      background: #1f0d0d;
      border: 1px solid #4a1e1e;
      color: #cf6f6f;
    }

    .result h3 {
      font-size: 0.9rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }

    .result pre {
      font-size: 0.75rem;
      white-space: pre-wrap;
      word-break: break-word;
      opacity: 0.8;
      margin-top: 0.5rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }

    .result a {
      color: #6fcf8a;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .hint {
      font-size: 0.775rem;
      color: #4a4a50;
      margin-top: 0.4rem;
    }

    .row { display: flex; gap: 0.75rem; }
    .row .field { flex: 1; }
  </style>
</head>
<body>
<div class="page">

  <header>
    <h1>Add album</h1>
    <p>Drop your audio files and cover art — the server handles the rest.</p>
  </header>

  <form id="uploadForm">

    <div class="card">
      <h2>Album info</h2>

      <div class="field">
        <label for="title">Album title <span style="color:#4a4a50">(required)</span></label>
        <input type="text" id="title" name="title" placeholder="Eine Kleine Nachtmusik" required>
      </div>

      <div class="field">
        <label for="artist">Artist</label>
        <input type="text" id="artist" name="artist" placeholder="Wolfgang Amadeus Mozart">
      </div>

      <div class="row">
        <div class="field">
          <label for="year">Year</label>
          <input type="number" id="year" name="year" placeholder="1787" min="1000" max="2099">
        </div>
        <div class="field">
          <label for="genre">Genre</label>
          <input type="text" id="genre" name="genre" placeholder="Classical">
        </div>
      </div>

      <div class="field">
        <label for="albumId">Folder name <span style="color:#4a4a50">(auto-filled, editable)</span></label>
        <input type="text" id="albumId" name="albumId" placeholder="eine-kleine-nachtmusik">
        <p class="hint">Used in the URL: /play/<span id="idPreview">...</span></p>
      </div>
    </div>

    <div class="card">
      <h2>Audio files</h2>
      <div class="drop-zone" id="audioZone">
        <input type="file" id="audioFiles" name="audio" multiple
               accept=".mp3,.flac,.ogg,.opus,.aac,.m4a,.wav">
        <div class="drop-icon">🎵</div>
        <p><strong>Click or drag</strong> your audio files here</p>
        <p>MP3, FLAC, OGG, OPUS, AAC, WAV · tracks are sorted by filename</p>
      </div>
      <div class="file-list" id="audioList"></div>
    </div>

    <div class="card">
      <h2>Cover art <span style="color:#4a4a50; font-size:0.75rem; text-transform:none; letter-spacing:0">(optional)</span></h2>
      <div class="drop-zone" id="coverZone">
        <input type="file" id="coverFile" name="cover"
               accept=".jpg,.jpeg,.png,.gif,.webp">
        <div class="drop-icon">🖼️</div>
        <p><strong>Click or drag</strong> your cover image here</p>
        <p>JPG, PNG, WEBP · will be resized to 500×500</p>
      </div>
      <div class="file-list" id="coverList"></div>
    </div>

    <button class="btn" id="submitBtn" type="submit" disabled>
      Upload and create album
    </button>

    <div class="progress" id="progress">
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="progressFill"></div>
      </div>
      <p class="progress-label" id="progressLabel">Uploading...</p>
    </div>

    <div class="result" id="result"></div>

  </form>
</div>

<script>
  const titleEl   = document.getElementById('title');
  const albumIdEl = document.getElementById('albumId');
  const idPreview = document.getElementById('idPreview');
  const audioFilesEl = document.getElementById('audioFiles');
  const coverFileEl  = document.getElementById('coverFile');
  const submitBtn = document.getElementById('submitBtn');
  const form      = document.getElementById('uploadForm');
  const progressEl = document.getElementById('progress');
  const progressFill = document.getElementById('progressFill');
  const progressLabel = document.getElementById('progressLabel');
  const resultEl  = document.getElementById('result');

  function slugify(s) {
    return s.toLowerCase()
      .replace(/[^a-z0-9\\s-]/g, '')
      .trim().replace(/\\s+/g, '-').replace(/-+/g, '-');
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  // Auto-fill album ID from title
  titleEl.addEventListener('input', () => {
    const slug = slugify(titleEl.value);
    albumIdEl.value = slug;
    idPreview.textContent = slug || '...';
    checkReady();
  });

  albumIdEl.addEventListener('input', () => {
    idPreview.textContent = albumIdEl.value || '...';
  });

  // Render file chips
  function renderFiles(files, listEl, type) {
    listEl.innerHTML = '';
    Array.from(files).forEach(f => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.innerHTML = \`
        <span class="dot \${type === 'img' ? 'img' : ''}"></span>
        <span class="name">\${f.name}</span>
        <span class="size">\${formatSize(f.size)}</span>
      \`;
      listEl.appendChild(chip);
    });
  }

  audioFilesEl.addEventListener('change', () => {
    renderFiles(audioFilesEl.files, document.getElementById('audioList'), 'audio');
    checkReady();
  });

  coverFileEl.addEventListener('change', () => {
    renderFiles(coverFileEl.files, document.getElementById('coverList'), 'img');
  });

  // Drag and drop
  ['audioZone', 'coverZone'].forEach(id => {
    const zone = document.getElementById(id);
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const input = zone.querySelector('input[type="file"]');
      // Can't set files directly on input, but we can trigger change via DataTransfer
      const dt = new DataTransfer();
      Array.from(e.dataTransfer.files).forEach(f => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    });
  });

  function checkReady() {
    const hasTitle = titleEl.value.trim().length > 0;
    const hasTracks = audioFilesEl.files.length > 0;
    submitBtn.disabled = !(hasTitle && hasTracks);
  }

  // Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const albumId = albumIdEl.value.trim() || slugify(titleEl.value);
    if (!albumId) return;

    const fd = new FormData();
    fd.append('title',    titleEl.value.trim());
    fd.append('artist',   document.getElementById('artist').value.trim());
    fd.append('year',     document.getElementById('year').value.trim());
    fd.append('genre',    document.getElementById('genre').value.trim());
    fd.append('albumId',  albumId);

    Array.from(audioFilesEl.files).forEach(f => fd.append('audio', f));
    if (coverFileEl.files[0]) fd.append('cover', coverFileEl.files[0]);

    submitBtn.disabled = true;
    progressEl.style.display = 'block';
    resultEl.style.display   = 'none';
    progressFill.style.width = '0%';
    progressLabel.textContent = 'Uploading files...';

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', window.location.origin + '/upload/process');

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 80);
          progressFill.style.width = pct + '%';
          if (pct < 80) {
            progressLabel.textContent = \`Uploading... \${pct}%\`;
          } else {
            progressLabel.textContent = 'Analyzing audio (this may take a few minutes)...';
          }
        }
      });

      xhr.addEventListener('load', () => {
        progressFill.style.width = '100%';
        progressLabel.textContent = 'Done!';

        let data;
        try { data = JSON.parse(xhr.responseText); } catch { data = { error: xhr.responseText }; }

        resultEl.style.display = 'block';

        if (xhr.status === 200 && data.success) {
          resultEl.className = 'result success';
          resultEl.innerHTML = \`
            <h3>✓ Album created</h3>
            <p>Folder: <code>\${data.albumId}</code> · \${data.trackCount} tracks</p>
            <pre>\${JSON.stringify(data.albumJson, null, 2)}</pre>
            <p style="margin-top:0.75rem">
              <a href="/api/album/\${data.albumId}" target="_blank">View API →</a>
              &nbsp;·&nbsp;
              <a href="/play/\${data.albumId}" target="_blank">Open player →</a>
            </p>
          \`;
        } else {
          resultEl.className = 'result error';
          resultEl.innerHTML = \`<h3>Something went wrong</h3><pre>\${data.error || 'Unknown error'}</pre>\`;
          submitBtn.disabled = false;
        }
        progressEl.style.display = 'none';
      });

      xhr.addEventListener('error', () => {
        resultEl.style.display = 'block';
        resultEl.className = 'result error';
        resultEl.innerHTML = '<h3>Upload failed</h3><p>Check that your server is running.</p>';
        progressEl.style.display = 'none';
        submitBtn.disabled = false;
      });

      xhr.send(fd);
    } catch (err) {
      resultEl.style.display = 'block';
      resultEl.className = 'result error';
      resultEl.innerHTML = \`<h3>Error</h3><pre>\${err.message}</pre>\`;
      progressEl.style.display = 'none';
      submitBtn.disabled = false;
    }
  });
</script>
</body>
</html>`);
});

// ─── POST /upload/process — handle the actual upload ─────────────────────────
const cpUpload = upload.fields([
  { name: 'audio', maxCount: 200 },
  { name: 'cover', maxCount: 1 },
]);

router.post('/process', (req, res) => {
  cpUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const { title, artist, year, genre, albumId } = req.body;

      if (!title || !albumId) {
        return res.status(400).json({ error: 'Title and album ID are required.' });
      }

      const audioFiles = req.files['audio'] || [];
      const coverFiles = req.files['cover'] || [];

      if (audioFiles.length === 0) {
        return res.status(400).json({ error: 'No audio files uploaded.' });
      }

      // Create album directory — reject if already exists
      const albumDir = path.join(MUSIC_DIR, albumId);
      if (fs.existsSync(albumDir)) {
        // Clean up temp files
        req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(_){} });
        return res.status(409).json({
          error: `Album "${albumId}" already exists. Choose a different folder name or delete the existing album first.`
        });
      }
      fs.mkdirSync(albumDir, { recursive: true });

      // Sort audio files by original filename (handles track numbering)
      audioFiles.sort((a, b) => a.originalname.localeCompare(b.originalname, undefined, { numeric: true }));

      // Process audio files
      const tracks = [];
      for (let i = 0; i < audioFiles.length; i++) {
        const file = audioFiles[i];
        const ext  = path.extname(file.originalname).toLowerCase();
        const num  = String(i + 1).padStart(2, '0');
        const destFilename = `${num}${ext}`;
        const destPath = path.join(albumDir, destFilename);

        // Move from temp to album dir
        fs.renameSync(file.path, destPath);

        // Read audio metadata for duration
        let duration = 0;
        try {
          const meta = await mm.parseFile(destPath, { duration: true });
          duration = Math.round(meta.format.duration || 0);
        } catch (metaErr) {
          // Duration stays 0 if we can't read it — not fatal
        }

        // Build track title: prefer ID3 tag title, fall back to filename
        let trackTitle = cleanTitle(file.originalname);
        try {
          const meta = await mm.parseFile(destPath);
          if (meta.common.title) trackTitle = meta.common.title;
        } catch (_) {}

        tracks.push({
          title: trackTitle,
          file: destFilename,
          duration,
        });
      }

      // Process cover art
      if (coverFiles.length > 0) {
        const coverFile = coverFiles[0];
        const coverDest = path.join(albumDir, 'cover.jpg');
        try {
          await sharp(coverFile.path)
            .resize(500, 500, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 90 })
            .toFile(coverDest);
        } catch (_) {
          // If sharp fails, just copy the file as-is
          fs.copyFileSync(coverFile.path, coverDest);
        }
        fs.unlinkSync(coverFile.path);
      }

      // Build and write album.json
      const albumJson = {
        title,
        artist: artist || '',
        year: year ? parseInt(year, 10) : undefined,
        genre: genre || '',
        tracks,
      };

      // Remove undefined keys
      Object.keys(albumJson).forEach(k => albumJson[k] === undefined && delete albumJson[k]);

      fs.writeFileSync(
        path.join(albumDir, 'album.json'),
        JSON.stringify(albumJson, null, 2)
      );

      // ── Auto-enrichment ───────────────────────────────────────────────────
      await analyzeAlbum(albumId);

      // Notify other devices of new upload
      notifyUpload(albumId, title, artist || 'Unknown Artist');

      res.json({
        success: true,
        albumId,
        trackCount: tracks.length,
        albumJson,
      });

    } catch (err) {
      // Clean up any remaining temp files
      ['audio', 'cover'].forEach(field => {
        (req.files?.[field] || []).forEach(f => {
          try { fs.unlinkSync(f.path); } catch (_) {}
        });
      });
      res.status(500).json({ error: err.message });
    }
  });
});

module.exports = router;
