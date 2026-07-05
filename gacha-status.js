// gacha-engine.js — background playlist curation for the gacha slot machine
//
// Uses a chained prompt strategy designed for 8GB VRAM (llama3.1:8b):
//   Step 1: One small call — assign 5 distinct mood/speed/setting combos
//   Step 2: Five small calls — one per playlist, just pick 10-15 track indices
//   Step 3: Hydrate each result against the real library (invalid indices discarded)
//
// Each individual call is tiny and well within an 8B model's capabilities.
// Falls back to algorithmic shuffle if any step fails.

const fs   = require('fs');
const path = require('path');

const MUSIC_DIR    = path.join(__dirname, 'music');
const STATE_FILE   = path.join(__dirname, 'gacha-state.json');
const REASONING_FILE = path.join(__dirname, 'gacha-reasoning.log');
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

const { comboDescription } = require('./combo_descriptions');

const COOLDOWN_MS  = 30 * 60 * 1000;


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
const EXCLUDE_GENRES         = ['developer']; // skip dev/sample albums entirely

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

    // Skip dev/sample albums
    if (EXCLUDE_GENRES.includes((album.genre || '').toLowerCase())) continue;

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
        tags: track.tags || [],
        mood_phrase: track.mood_phrase || null,
      });
    }
  }
  return flat;
}

// ─── Ollama call ─────────────────────────────────────────────────────────────
const OLLAMA_TIMEOUT_MS = 2 * 60 * 1000;

async function callOllama(messages, label, options={}) {
  process.stdout.write(`[gacha-engine] ${label}...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        format: 'json',
        stream: true,
        options: { num_predict: 800, ...options },
      }),
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
  const cleaned = full.replace(/^```json\s*|^```\s*|```\s*$/g, '').trim();
  return JSON.parse(cleaned);
}

// ─── Step 1: assign 5 combos ─────────────────────────────────────────────────
// Single small call — no library data needed, just pick 5 distinct tag combos.
async function assignCombos() {
  const messages = [
    {
      role: 'system',
      content: `You are assigning tags for 5 music playlists. Each playlist needs one mood, one pace, and one setting.
Available moods: ${MOODS.join(', ')}
Available paces: ${SPEEDS.join(', ')}
Available settings: ${SETTINGS.join(', ')}
Rules: all 5 must have different mood values. Try to vary pace and setting too.
Respond with ONLY this JSON, no explanation:
{"combos":[{"mood":"string","speed":"string","setting":"string"}]}`
    },
    { role: 'user', content: 'Assign 5 distinct playlist tag combos.' }
  ];
  const result = await callOllama(messages, 'Step 1/2 assigning combos', { temperature: 0.8 });
  const combos = Array.isArray(result.combos) ? result.combos : [];
  // Validate and fill in any missing/invalid tags
  const usedMoods = new Set();
  return combos.slice(0, BATCH_SIZE).map(c => {
    const mood    = MOODS.includes(c.mood)    ? c.mood    : MOODS.find(m => !usedMoods.has(m)) || MOODS[0];
    const speed   = SPEEDS.includes(c.speed)  ? c.speed   : SPEEDS[Math.floor(Math.random()*SPEEDS.length)];
    const setting = SETTINGS.includes(c.setting) ? c.setting : SETTINGS[Math.floor(Math.random()*SETTINGS.length)];
    usedMoods.add(mood);
    return { mood, speed, setting };
  });
}

// ─── Step 2: pick tracks for one playlist ────────────────────────────────────
// One small call per playlist — library is sampled to TRACKS_IN_PLAYLIST_PROMPT
// tracks so the prompt stays tiny. The model only needs to output a list of
// numbers and a name/description.
function formatTrackLine(t) {
  const bits = [`${t.artist||'Unknown'} - ${t.title}`];
  if (t.mood_phrase) bits.push(`"${t.mood_phrase}"`);
  else if (t.tags && t.tags.length) bits.push(t.tags.join('/'));
  if (typeof t.bpm === 'number') bits.push(`${Math.round(t.bpm)}bpm`);
  if (t.mode) bits.push(t.mode);
  if (typeof t.valence === 'number') bits.push(`val:${t.valence.toFixed(2)}`);
  if (typeof t.energy === 'number') bits.push(`nrg:${t.energy.toFixed(2)}`);
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

Pick ${TRACKS_PER_PLAYLIST} tracks from the numbered library below that best match this feeling.
IMPORTANT: trackIndices must only contain numbers between 0 and ${maxIdx}. Any number outside this range is invalid.
BPM is your primary guide for pace — favor tracks in the range but don't exclude a great fit that's slightly outside it.
Key and mode are mood signals: minor keys tend darker and more interior, major keys brighter and more outward.
Energy reflects intensity — lean higher for active settings, lower for passive or reflective ones.
Track titles and artists carry emotional context — use your knowledge of them.
Spread picks across at least 3 different artists.

Name this playlist like a real person named it for themselves at 2am — casual, a little weird, never generic.

NAMING RULES (strictly follow these):
- mostly lowercase
- ALL CAPS on one or two words MAX, used sparingly for emphasis
- BANNED words and phrases: vibes, chill, stroll, sunset, nostalgia, lane, journey, feels, mood, energy, beats, flow, wave — these are algorithm words
- NEVER describe the mood/pace/setting directly
- NEVER copy or rephrase the style examples below — they show register only
- Style examples: "songs to cry in a running car", "it's giving tuesday morning", "IDGAF playlist vol. 3", "pov ur at a sleepover in 2009", "i should be sleeping but", "the one where i'm fine actually"

Description: one sentence, lowercase, like a caption on a photo of nothing in particular. No clichés, no "perfect for".

Respond with ONLY this JSON — trackIndices MUST contain exactly ${TRACKS_PER_PLAYLIST} numbers:
{"trackIndices":[0,1,2],"reasoning":"brief note on curation","name":"string","description":"string"}`
    },
    { role: 'user', content: `Library:\n${trackList}` }
  ];

  const result = await callOllama(messages, `Step 2/${BATCH_SIZE} playlist ${playlistNum}`);
  if (result.reasoning) {
    console.log(`[gacha-engine] Playlist ${playlistNum} reasoning: ${result.reasoning}`);
    const line = `[${new Date().toISOString()}] #${playlistNum} "${result.name}" (${combo.mood}/${combo.speed}/${combo.setting})\n  ${result.reasoning}\n\n`;
    fs.appendFileSync(REASONING_FILE, line);
  }
  return { ...combo, ...result };
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
  console.log(`[gacha-engine] DEBUG: returned indices [${returnedIndices.join(',')}] | valid range 0-${maxIdx} | valid count: ${returnedIndices.filter(idx => libraryByIdx.has(Number(idx))).length}/${returnedIndices.length}`);
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
    name: String(raw.name || 'Untitled Playlist').slice(0, 60),
    description: String(raw.description || '').slice(0, 200),
    mood, speed, setting,
    trackCount: trimmed.length,
    totalDuration: trimmed.reduce((s, t) => s + (t.duration || 0), 0),
    covers: [...seenAlbums].slice(0, 4).map(a => `/audio/${a}/cover.jpg`),
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
      covers: [...albums].slice(0,4).map(a=>`/audio/${a}/cover.jpg`),
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

const TAG_AFFINITIES = {
  mood: {
    sunny:  { prefer: ['upbeat','playful'],               anti: ['melancholic','intense'] },
    rainy:  { prefer: ['melancholic','atmospheric'],      anti: ['upbeat','driving'] },
    stormy: { prefer: ['intense','driving','atmospheric'], anti: ['gentle','playful'] },
    windy:  { prefer: ['driving','upbeat'],               anti: ['ambient','gentle'] },
    snowy:  { prefer: ['ambient','gentle','atmospheric'],  anti: ['intense','driving'] },
    cloudy: { prefer: ['atmospheric','ambient'],          anti: ['intense','upbeat'] },
  },
  speed: {
    snail:  { prefer: ['ambient','gentle'],               anti: ['driving','intense'] },
    stroll: { prefer: ['gentle','atmospheric'],           anti: ['intense','driving'] },
    quick:  { prefer: ['upbeat','playful'],               anti: ['ambient','gentle'] },
    fast:   { prefer: ['driving','intense','upbeat'],     anti: ['ambient','gentle'] },
    ultra:  { prefer: ['intense','driving'],              anti: ['ambient','gentle','melancholic'] },
  },
  setting: {
    bedroom: { prefer: ['ambient','gentle','melancholic'], anti: ['driving','intense'] },
    cafe:    { prefer: ['atmospheric','gentle','upbeat'],  anti: ['intense','driving'] },
    drive:   { prefer: ['driving','upbeat'],               anti: ['ambient','gentle'] },
    travel:  { prefer: ['atmospheric','upbeat'],           anti: ['intense'] },
    gym:     { prefer: ['intense','driving','upbeat'],     anti: ['ambient','gentle','melancholic'] },
    work:    { prefer: ['atmospheric','ambient','upbeat'], anti: ['intense','melancholic'] },
  },
};

function scoreTrack(track, combo) {
  // BPM score
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
  // Valence score
  let valenceScore = 0.5;
  if (typeof track.valence === 'number') {
    const target = VALENCE_TARGETS[combo.mood] || 0.5;
    valenceScore = Math.max(0, 1.0 - Math.abs(track.valence - target) * 2);
  }
  // Energy score
  let energyScore = 0.5;
  if (typeof track.energy === 'number') {
    const target = ENERGY_TARGETS[combo.setting] || 0.5;
    energyScore = Math.max(0, 1.0 - Math.abs(track.energy - target) * 2);
  }
  // Tag score
  let tagScore = 0.5;
  if (track.tags && track.tags.length) {
    let bonus = 0;
    for (const axis of ['mood', 'speed', 'setting']) {
      const key = axis === 'speed' ? combo.speed : combo[axis];
      const aff = TAG_AFFINITIES[axis]?.[key];
      if (!aff) continue;
      for (const tag of track.tags) {
        if (aff.prefer.includes(tag)) bonus += 0.15;
        if (aff.anti.includes(tag))   bonus -= 0.10;
      }
    }
    tagScore = Math.max(0, Math.min(1, 0.5 + bonus));
  }
  // Jitter so different tracks surface each batch
  const jitter = (Math.random() - 0.5) * 0.1;
  return (bpmScore * 0.35) + (valenceScore * 0.30) + (energyScore * 0.25) + (tagScore * 0.10) + jitter;
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
  console.log(`[gacha-engine] generateBatch() started — model: ${OLLAMA_MODEL}`);
  const library = loadFlatLibrary();
  if (library.length === 0) {
    console.log('[gacha-engine] No music found in library');
    return { batchId: 'empty-'+Date.now(), generatedAt: Date.now(), playlists: [], regenerationTriggerAt: null };
  }
  library.forEach((t, i) => { t._idx = i; });
  const libraryByIdx = new Map(library.map(t => [t._idx, t]));
  const libMin = Math.min(MIN_TRACKS, library.length);
  console.log(`[gacha-engine] Library after filtering: ${library.length} tracks across ${new Set(library.map(t=>t.albumId)).size} albums (capped OSTs at ${MAX_TRACKS_PER_ALBUM}/album, excluded <${MIN_TRACK_DURATION_SEC}s tracks + dev albums)`);

  let playlists = null;
  try {
    // Step 1: get 5 tag combos
    let combos = await assignCombos();
    // Pad if we got fewer than 5 back
    while (combos.length < BATCH_SIZE) {
      const mood = MOODS[combos.length % MOODS.length];
      combos.push({ mood, speed: SPEEDS[Math.floor(Math.random()*SPEEDS.length)], setting: SETTINGS[Math.floor(Math.random()*SETTINGS.length)] });
    }
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
            console.log(`[gacha-engine] Playlist ${i+1} OK: "${playlist.name}" (${playlist.trackCount} tracks)${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
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
