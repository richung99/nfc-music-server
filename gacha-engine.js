// gacha-engine.js — background playlist curation for the gacha slot machine
//
// Uses a chained prompt strategy with two models:
//   OLLAMA_MODEL (default: qwen2.5:14b) — structured tasks: track selection
//   NAMING_MODEL (default: gemma3:12b)  — creative tasks: playlist naming
//
// Step 1: Server-side random combo assignment (no LLM needed)
// Step 2: Five calls to OLLAMA_MODEL — pick track indices per combo
// Step 3: One call to NAMING_MODEL — name all playlists from track titles
//
// Falls back to algorithmic shuffle if any step fails.

const fs   = require('fs');
const path = require('path');

const MUSIC_DIR      = path.join(__dirname, 'music');
const STATE_FILE     = path.join(__dirname, 'gacha-state.json');
const REASONING_FILE = path.join(__dirname, 'gacha-reasoning.log');
const OLLAMA_URL     = process.env.OLLAMA_URL     || 'http://localhost:11434';
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   || 'qwen2.5:14b';
const NAMING_MODEL   = process.env.NAMING_MODEL   || 'gemma3:12b';

const { comboDescription } = require('./combo_descriptions');

const COOLDOWN_MS  = 30 * 60 * 1000;
const NAME_HISTORY_SIZE = 15; // rolling window of recent playlist names to avoid repetition


const BATCH_SIZE   = 5;
const MIN_TRACKS   = 8;
const MAX_TRACKS   = 20;
const TRACKS_PER_PLAYLIST = 12; // what we ask the LLM to aim for
// How many tracks to show per playlist in the prompt — keeps each call small

const MOODS    = ['sunny','rainy','stormy','windy','snowy','cloudy'];
const SPEEDS   = ['snail','stroll','quick','fast','ultra'];
const SETTINGS = ['bedroom','cafe','drive','travel','gym','work'];

// ─── State ───────────────────────────────────────────────────────────────────
let state = null;
let isGenerating = false;
let generationPromise = null;

function loadStateFromDisk() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch (e) { return null; }
}
function saveStateToDisk() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('gacha-engine: failed to persist state:', e.message); }
}

// ─── Library ─────────────────────────────────────────────────────────────────
const MIN_TRACK_DURATION_SEC = 45;  // filter out stingers, jingles, fanfares
const MAX_TRACKS_PER_ALBUM   = 20;  // cap per album — diversity enforced by prompt
const TRACKS_IN_PLAYLIST_PROMPT = 80; // total tracks sent to model per playlist call

function loadFlatLibrary() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  const albumIds = fs.readdirSync(MUSIC_DIR).filter(name => {
    try { return fs.statSync(path.join(MUSIC_DIR, name)).isDirectory(); }
    catch (e) { return false; }
  });
  const flat = [];
  for (const albumId of albumIds) {
    const metaPath = path.join(MUSIC_DIR, albumId, 'album.json');
    if (!fs.existsSync(metaPath)) continue;
    let album;
    try { album = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); }
    catch (e) { continue; }

    // Skip hidden albums (dev/sample albums excluded from gacha but still in library)
    if (album.hidden) continue;

    const allTracks = (album.tracks || [])
      .filter(t => (t.duration || 0) >= MIN_TRACK_DURATION_SEC); // drop stingers

    // If the album has more tracks than the cap, pick randomly so different
    // tracks appear each batch. Diversity across albums is enforced by the prompt.
    let tracks;
    if (allTracks.length > MAX_TRACKS_PER_ALBUM) {
      const shuffled = [...allTracks].sort(() => Math.random() - 0.5);
      tracks = shuffled.slice(0, MAX_TRACKS_PER_ALBUM);
    } else {
      tracks = allTracks;
    }

    for (const track of tracks) {
      flat.push({
        albumId, albumTitle: album.title || albumId,
        artist: album.artist || '', genre: album.genre || '', year: album.year || null,
        title: track.title || track.file, file: track.file,
        duration: track.duration || 0,
        bpm: track.bpm, energy: track.energy,
        key: track.key || null, mode: track.mode || null,
        brightness: track.brightness || null,
        danceability: track.danceability || null,
        valence: track.valence || null,
        genres: track.genres || [],
        affinities: track.affinities || null,
      });
    }
  }
  return flat;
}

// ─── Ollama call ─────────────────────────────────────────────────────────────
const OLLAMA_TIMEOUT_MS = 2 * 60 * 1000;

async function callOllama(messages, label, options={}, model=OLLAMA_MODEL, jsonFormat=true) {
  process.stdout.write(`[gacha-engine] ${label}...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  let res;
  try {
    const body = { model, messages, stream: true, options: { num_predict: 1200, ...options } };
    if (jsonFormat) body.format = 'json';
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch (e) { clearTimeout(timer); throw e; }

  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }

  let full = '';
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n').filter(Boolean)) {
        try {
          const chunk = JSON.parse(line);
          if (chunk.message?.content) full += chunk.message.content;
        } catch (_) {}
      }
    }
  } finally { clearTimeout(timer); }

  process.stdout.write(` done (${full.length} chars)\n`);
  const cleaned = full.replace(/^```json\s*|^```\s*|```\s*$/gm, '').trim();
  // Extract JSON — handle both clean JSON and JSON embedded in prose
  const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  return JSON.parse(jsonMatch ? jsonMatch[1] : cleaned);
}

// ─── Step 1: assign 5 combos ─────────────────────────────────────────────────
// Generate combos server-side — pure random, guaranteed variety, no LLM call needed.
// All 5 must have different moods. Speed and setting are fully random.
function assignCombos() {
  const shuffledMoods = [...MOODS].sort(() => Math.random() - 0.5).slice(0, BATCH_SIZE);
  return shuffledMoods.map(mood => ({
    mood,
    speed:   SPEEDS[Math.floor(Math.random() * SPEEDS.length)],
    setting: SETTINGS[Math.floor(Math.random() * SETTINGS.length)],
  }));
}

// ─── Step 2: pick tracks for one playlist ────────────────────────────────────
// One small call per playlist — library is sampled to TRACKS_IN_PLAYLIST_PROMPT
// tracks so the prompt stays tiny. The model only needs to output a list of
// numbers and a name/description.
function formatTrackLine(t) {
  const bits = [`${t.artist||'Unknown'} - ${t.title}`];
  if (typeof t.bpm === 'number') bits.push(`${Math.round(t.bpm)}bpm`);
  if (t.mode) bits.push(t.mode);
  if (typeof t.valence === 'number') bits.push(`val:${t.valence.toFixed(2)}`);
  if (typeof t.energy === 'number') bits.push(`nrg:${t.energy.toFixed(2)}`);
  // Skip first 2 Genius genres (too generic) — use from 3rd onwards
  // For algorithmic subgenres (single value) always include it
  if (Array.isArray(t.genres) && t.genres.length) {
    const meaningful = t.genres.length <= 2 ? t.genres : t.genres.slice(2);
    if (meaningful.length) bits.push(`[${meaningful.slice(0, 3).join(', ')}]`);
  }
  return `${t._idx}: ${bits.join(' | ')}`;
}

async function pickTracksForPlaylist(combo, library, playlistNum) {
  // Show the full filtered library — small enough to fit in context after per-album capping
  const sample = library.slice(0, TRACKS_IN_PLAYLIST_PROMPT);
  const maxIdx = sample.length - 1;

  const trackList = sample.map(t => formatTrackLine(t)).join('\n');

  const messages = [
    {
      role: 'system',
      content: `You are curating a music playlist for a home jukebox.
Here is the feeling you are going for:

${comboDescription(combo.mood, combo.speed, combo.setting)}

Target BPM range: ${BPM_RANGES[combo.speed]?.[0]}–${BPM_RANGES[combo.speed]?.[1] === 999 ? '150+' : BPM_RANGES[combo.speed]?.[1]}
Target valence: ${VALENCE_TARGETS[combo.mood] !== undefined ? (VALENCE_TARGETS[combo.mood] >= 0.6 ? 'high (0.6+)' : VALENCE_TARGETS[combo.mood] <= 0.4 ? 'low (0.0–0.4)' : 'mid (0.4–0.6)') : 'mid'}

Pick ${TRACKS_PER_PLAYLIST} tracks from the numbered library below that best match this feeling.
IMPORTANT: trackIndices must only contain numbers between 0 and ${maxIdx}. Any number outside this range is invalid.

When scoring each track, weight these factors in order of importance:
1. BPM (40%) — primary guide for pace. Favor tracks in the target range but don't exclude a great fit slightly outside it.
2. Valence (35%) — emotional positivity. High valence = bright/happy, low valence = dark/sad.
3. Energy (25%) — intensity level. Lean higher for active settings, lower for passive or reflective ones.
4. Genre tags — soft signal for character. Use them to match the playlist's specific mood and texture, not just its energy level.

Key and mode are additional mood signals: minor keys tend darker and more interior, major keys brighter and more outward.
Spread picks across at least 3 different artists.

Respond with ONLY this JSON — trackIndices MUST contain exactly ${TRACKS_PER_PLAYLIST} numbers:
{"trackIndices":[0,1,2],"reasoning":"brief note on curation"}`
    },
    { role: 'user', content: `Library:\n${trackList}` }
  ];

  const result = await callOllama(messages, `Step 2/${BATCH_SIZE} playlist ${playlistNum}`);
  if (result.reasoning) {
    console.log(`[gacha-engine] Playlist ${playlistNum} reasoning: ${result.reasoning}`);
  }
  return { ...combo, ...result };
}

// Clean track titles for naming model — strip symbols that confuse it
function cleanTitle(title) {
  return title
    .replace(/[♡♥❤️]/g, 'Love')
    .replace(/[$€£¥]/g, 'S')
    .replace(/^[A-Z0-9]+=/, '')
    .replace(/[^\w\s\-',.()&!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Step 3: name all playlists in one call ───────────────────────────────────
async function nameAllPlaylists(playlists, combos) {
  // Load recent name history from state
  const recentNames = (state?.nameHistory || []).slice(-NAME_HISTORY_SIZE);

  const sections = playlists.map((playlist, i) => {
    const trackList = playlist.tracks
      .map(t => {
        const genres = Array.isArray(t.genres) && t.genres.length
          ? (t.genres.length <= 2 ? t.genres : t.genres.slice(2)).slice(0, 3)
          : [];
        const genreStr = genres.length ? ` (${genres.join(', ')})` : '';
        return `  - ${t.artist} — "${cleanTitle(t.title)}"${genreStr}`;
      })
      .join('\n');
    return `Playlist ${i + 1} (${combos[i]?.mood}/${combos[i]?.speed}/${combos[i]?.setting}):\n${trackList}`;
  }).join('\n\n');

  const recentSection = recentNames.length
    ? `\nRecently used names — avoid similar structures, phrasing, or scenarios:\n${recentNames.map(n => `- "${n}"`).join('\n')}\n`
    : '';

  const messages = [
    {
      role: 'system',
      content: `Name these ${playlists.length} playlists based on their track listings.

${sections}
${recentSection}
Write each name like a note you typed in your phone at 1am, or a thought you had in the shower.
Do not use artist names, genre names, underscores, hyphens, or describe what the music sounds like.
All ${playlists.length} must be structurally different. One must be unexpected.
Mostly lowercase, 2-8 words. ALL CAPS for one or two words MAX.
Respond in English only.

For the description: look only at the NAME you just wrote. One dry offhand sentence extending the joke. Not poetic. Not about the music.

Respond with ONLY this JSON object:
{"playlists":[{"name":"string","description":"string"}]}`
    },
    { role: 'user', content: 'Name all playlists.' }
  ];

  const raw = await callOllama(messages, `Step 3 naming all ${playlists.length} playlists`, { temperature: 0.9, num_predict: 600 }, NAMING_MODEL, false);
  const results = Array.isArray(raw) ? raw
    : Array.isArray(raw?.playlists) ? raw.playlists
    : Array.isArray(raw?.names) ? raw.names
    : [];

  // Log to reasoning file
  const line = results.map((r, i) => {
    const reasoning = playlists[i]?.reasoning || '(no reasoning)';
    return `[${new Date().toISOString()}] #${i+1} "${r.name}" (${combos[i]?.mood}/${combos[i]?.speed}/${combos[i]?.setting})\n  ${reasoning}`;
  }).join('\n') + '\n\n';
  fs.appendFileSync(REASONING_FILE, line);

  const named = results.map(r => ({
    name: (r.name || 'Untitled Playlist')
      .replace(/_/g, ' ')
      .replace(/\b(?![A-Z]{2,})[A-Z][a-z]/g, m => m.toLowerCase()),
    description: r.description || '',
  }));

  // Update rolling name history in state
  const newNames = named.map(r => r.name).filter(n => n !== 'Untitled Playlist');
  if (state) {
    state.nameHistory = [...(state.nameHistory || []), ...newNames].slice(-NAME_HISTORY_SIZE);
  }

  return named;
}

// ─── Hydrate raw LLM result into a real playlist object ──────────────────────
function hydratePlaylist(raw, libraryByIdx, libMin) {
  const mood    = MOODS.includes(String(raw.mood||'').toLowerCase())    ? String(raw.mood).toLowerCase()    : MOODS[Math.floor(Math.random()*MOODS.length)];
  const speed   = SPEEDS.includes(String(raw.speed||'').toLowerCase())  ? String(raw.speed).toLowerCase()   : SPEEDS[Math.floor(Math.random()*SPEEDS.length)];
  const setting = SETTINGS.includes(String(raw.setting||'').toLowerCase()) ? String(raw.setting).toLowerCase() : SETTINGS[Math.floor(Math.random()*SETTINGS.length)];

  const seenAlbums = new Set();
  const tracks = [];
  const returnedIndices = Array.isArray(raw.trackIndices) ? raw.trackIndices : [];
  const validKeys = [...libraryByIdx.keys()];
  const maxIdx = validKeys.length ? Math.max(...validKeys) : 0;
  for (const idx of returnedIndices) {
    const t = libraryByIdx.get(Number(idx));
    if (!t) continue;
    tracks.push(t);
    seenAlbums.add(t.albumId);
  }
  if (tracks.length < libMin) return null;

  const trimmed = tracks.slice(0, MAX_TRACKS);
  return {
    id: 'pl-' + Math.random().toString(36).slice(2, 10),
    name: 'Untitled Playlist',
    description: '',
    mood, speed, setting,
    trackCount: trimmed.length,
    totalDuration: trimmed.reduce((s, t) => s + (t.duration || 0), 0),
    covers: [...seenAlbums].map(a => `/audio/${a}/cover.jpg`),
    tracks: trimmed.map(t => ({
      title: t.title, artist: t.artist, albumTitle: t.albumTitle,
      duration: t.duration, url: `/audio/${t.albumId}/${t.file}`,
    })),
  };
}

// ─── Fallback ─────────────────────────────────────────────────────────────────
function fallbackBatch(library) {
  const libMin = Math.min(MIN_TRACKS, library.length);
  const libMax = Math.min(MAX_TRACKS, library.length);
  const playlists = [];
  const usedMoods = new Set();
  for (let i = 0; i < BATCH_SIZE; i++) {
    const mood    = MOODS.find(m => !usedMoods.has(m)) || MOODS[i % MOODS.length];
    const speed   = SPEEDS[Math.floor(Math.random()*SPEEDS.length)];
    const setting = SETTINGS[Math.floor(Math.random()*SETTINGS.length)];
    usedMoods.add(mood);
    const count  = libMax > libMin ? Math.floor(Math.random()*(libMax-libMin))+libMin : libMin;
    const tracks = [...library].sort(() => Math.random()-0.5).slice(0, Math.max(1, count));
    const albums = new Set(tracks.map(t => t.albumId));
    playlists.push({
      id: 'pl-' + Math.random().toString(36).slice(2, 10),
      name: `${mood[0].toUpperCase()+mood.slice(1)} ${speed[0].toUpperCase()+speed.slice(1)} ${setting[0].toUpperCase()+setting.slice(1)}`,
      description: 'Algorithmically curated — AI curator offline.',
      mood, speed, setting,
      trackCount: tracks.length,
      totalDuration: tracks.reduce((s,t)=>s+(t.duration||0),0),
      covers: [...albums].map(a=>`/audio/${a}/cover.jpg`),
      tracks: tracks.map(t=>({ title:t.title, artist:t.artist, albumTitle:t.albumTitle, duration:t.duration, url:`/audio/${t.albumId}/${t.file}` })),
    });
  }
  return playlists;
}

// ─── Pre-filter: score and trim library for a given combo ────────────────────
const TARGET_LIBRARY_SIZE = 80;

const BPM_RANGES = {
  snail:  [0,   60],
  stroll: [61,  90],
  quick:  [91,  120],
  fast:   [121, 150],
  ultra:  [150, 999],
};

const VALENCE_TARGETS = {
  sunny: 0.75, rainy: 0.35, stormy: 0.25,
  windy: 0.55, snowy: 0.45, cloudy: 0.5,
};

const ENERGY_TARGETS = {
  bedroom: 0.3, cafe: 0.35, drive: 0.6,
  travel:  0.5, gym:  0.8,  work:  0.55,
};

function scoreTrack(track, combo) {
  // ── Affinity-based scoring (preferred) ────────────────────────────────────
  // If the track has precomputed affinity scores, use them directly.
  // combo_affinity = mood_affinity × 0.60 + setting_affinity × 0.40
  if (track.affinities?.moods && track.affinities?.settings) {
    const moodAffinity    = track.affinities.moods[combo.mood]    ?? 0.5;
    const settingAffinity = track.affinities.settings[combo.setting] ?? 0.5;
    const jitter = (Math.random() - 0.5) * 0.1;
    return (moodAffinity * 0.60) + (settingAffinity * 0.40) + jitter;
  }

  // ── Fallback: audio feature scoring ───────────────────────────────────────
  // Used when affinities haven't been computed yet (new uploads).
  let bpmScore = 0.5;
  if (typeof track.bpm === 'number') {
    const [lo, hi] = BPM_RANGES[combo.speed] || [91, 120];
    if (track.bpm >= lo && track.bpm <= hi) {
      bpmScore = 1.0;
    } else {
      const dist = track.bpm < lo ? lo - track.bpm : track.bpm - hi;
      bpmScore = Math.max(0, 1.0 - dist / 60);
    }
  }
  let valenceScore = 0.5;
  if (typeof track.valence === 'number') {
    const target = VALENCE_TARGETS[combo.mood] || 0.5;
    valenceScore = Math.max(0, 1.0 - Math.abs(track.valence - target) * 2);
  }
  let energyScore = 0.5;
  if (typeof track.energy === 'number') {
    const target = ENERGY_TARGETS[combo.setting] || 0.5;
    energyScore = Math.max(0, 1.0 - Math.abs(track.energy - target) * 2);
  }
  const jitter = (Math.random() - 0.5) * 0.1;
  return (bpmScore * 0.40) + (valenceScore * 0.35) + (energyScore * 0.25) + jitter;
}

function preFilterLibrary(combo, library) {
  const albumSizes = {};
  for (const t of library) {
    albumSizes[t.albumId] = (albumSizes[t.albumId] || 0) + 1;
  }
  const totalTracks = library.length;

  // Each album gets a share of TARGET_LIBRARY_SIZE proportional to its size,
  // with a minimum of 3 so small albums always get some representation,
  // and a maximum of 20 so no single album dominates even if it's huge.
  const perAlbumCap = {};
  for (const [albumId, count] of Object.entries(albumSizes)) {
    const proportional = Math.round((count / totalTracks) * TARGET_LIBRARY_SIZE);
    perAlbumCap[albumId] = Math.max(3, Math.min(20, proportional));
  }

  const scored = library.map(t => ({ track: t, score: scoreTrack(t, combo) }));
  scored.sort((a, b) => b.score - a.score);

  const albumCounts = {};
  const result = [];
  for (const { track } of scored) {
    const cap = perAlbumCap[track.albumId] || 3;
    const count = albumCounts[track.albumId] || 0;
    if (count >= cap) continue;
    albumCounts[track.albumId] = count + 1;
    result.push(track);
    if (result.length >= TARGET_LIBRARY_SIZE) break;
  }
  return result;
}

// ─── Main generation ──────────────────────────────────────────────────────────
async function generateBatch() {
  console.log(`[gacha-engine] generateBatch() started — curation: ${OLLAMA_MODEL} | naming: ${NAMING_MODEL}`);
  const library = loadFlatLibrary();
  if (library.length === 0) {
    console.log('[gacha-engine] No music found in library');
    return { batchId: 'empty-'+Date.now(), generatedAt: Date.now(), playlists: [], regenerationTriggerAt: null };
  }
  library.forEach((t, i) => { t._idx = i; });
  const libraryByIdx = new Map(library.map(t => [t._idx, t]));
  const libMin = Math.min(MIN_TRACKS, library.length);
  console.log(`[gacha-engine] Library after filtering: ${library.length} tracks across ${new Set(library.map(t=>t.albumId)).size} albums (capped OSTs at ${MAX_TRACKS_PER_ALBUM}/album, excluded <${MIN_TRACK_DURATION_SEC}s tracks + hidden albums)`);

  let playlists = null;
  try {
    // Step 1: get 5 tag combos — generated server-side for true randomness
    let combos = assignCombos();
    console.log(`[gacha-engine] Combos assigned: ${combos.map(c=>`${c.mood}/${c.speed}/${c.setting}`).join(', ')}`);

    // Step 2: pick tracks for each playlist sequentially, with up to 2 retries
    const MAX_RETRIES = 2;
    const hydrated = [];
    for (let i = 0; i < combos.length; i++) {
      // Pre-filter the library for this specific combo before sending to the model
      const filtered = preFilterLibrary(combos[i], library);
      // Re-index so the model sees 0..N-1 regardless of original library positions
      filtered.forEach((t, idx) => { t._idx = idx; });
      const filteredByIdx = new Map(filtered.map(t => [t._idx, t]));
      console.log(`[gacha-engine] Playlist ${i+1} pre-filter: ${filtered.length} tracks (from ${library.length})`);

      let playlist = null;
      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        try {
          const raw = await pickTracksForPlaylist(combos[i], filtered, i + 1);
          playlist = hydratePlaylist(raw, filteredByIdx, libMin);
          if (playlist) {
            if (raw.reasoning) playlist.reasoning = raw.reasoning;
            console.log(`[gacha-engine] Playlist ${i+1} tracks selected (${playlist.trackCount} tracks)${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
            break;
          } else {
            console.log(`[gacha-engine] Playlist ${i+1} had too few valid track indices — ${attempt <= MAX_RETRIES ? `retrying (${attempt}/${MAX_RETRIES})` : 'using fallback'}`);
          }
        } catch (e) {
          console.error(`[gacha-engine] Playlist ${i+1} failed: ${e.message} — ${attempt <= MAX_RETRIES ? `retrying (${attempt}/${MAX_RETRIES})` : 'using fallback'}`);
        }
      }
      hydrated.push(playlist || fallbackBatch(library)[0]);
    }

    // Stage 3: name all playlists in a single call so names stay distinct
    const validHydrated = hydrated.filter(p => p && !p.description?.includes('offline'));
    if (validHydrated.length > 0) {
      try {
        const names = await nameAllPlaylists(validHydrated, combos);
        validHydrated.forEach((p, i) => {
          if (names[i]) {
            p.name = names[i].name;
            p.description = names[i].description;
          }
          console.log(`[gacha-engine] Playlist ${i+1} OK: "${p.name}" (${p.trackCount} tracks)`);
        });
      } catch (e) {
        console.error('[gacha-engine] Naming failed:', e.message);
      }
    }

    playlists = hydrated;
  } catch (e) {
    console.error('gacha-engine: generation failed, using full fallback:', e.message);
  }

  if (!playlists) playlists = fallbackBatch(library);

  console.log(`[gacha-engine] Batch complete — ${playlists.filter(p=>!p.description.includes('offline')).length}/${BATCH_SIZE} AI-curated`);
  return { batchId: 'batch-'+Date.now(), generatedAt: Date.now(), playlists, regenerationTriggerAt: null };
}

async function regenerateNow() {
  if (isGenerating) return generationPromise;
  isGenerating = true;
  generationPromise = (async () => {
    try { state = await generateBatch(); saveStateToDisk(); }
    finally { isGenerating = false; }
  })();
  return generationPromise;
}

async function getState() {
  if (!state) state = loadStateFromDisk();
  if (!state) {
    await regenerateNow();
  } else if (state.regenerationTriggerAt && Date.now() >= state.regenerationTriggerAt + COOLDOWN_MS) {
    regenerateNow();
  }
  return { ...state, isGenerating };
}

async function markComplete(batchId) {
  await getState();
  if (state && state.batchId === batchId && !state.regenerationTriggerAt) {
    state.regenerationTriggerAt = Date.now();
    saveStateToDisk();
  }
  return { ...state, isGenerating };
}

module.exports = { getState, markComplete, regenerateNow, COOLDOWN_MS, BATCH_SIZE };
