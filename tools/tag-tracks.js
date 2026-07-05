#!/usr/bin/env node
/**
 * tag-tracks.js — adds track-level genre/mood tags to album.json using a local Ollama model.
 *
 * Tags each track with 2-3 descriptors from a fixed vocabulary based on its
 * title, artist, album context, and existing audio features. This gives the
 * gacha pre-filter semantic signal beyond just BPM/energy numbers.
 *
 * Tag vocabulary:
 *   ambient      — atmospheric, textural, background
 *   upbeat       — cheerful, energetic, positive
 *   melancholic  — sad, wistful, introspective
 *   intense      — dramatic, powerful, high-stakes
 *   playful      — lighthearted, whimsical, fun
 *   driving      — forward-motion, rhythmic momentum
 *   gentle       — soft, quiet, delicate
 *   atmospheric  — cinematic, immersive, world-building
 *
 * Usage:
 *   node tag-tracks.js                    # tag all albums
 *   node tag-tracks.js --album wings      # tag one album
 *   node tag-tracks.js --force            # re-tag even if tags exist
 *
 * Safe to re-run — skips tracks that already have tags unless --force.
 * Run from your project root (same folder as server.js).
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const MUSIC_DIR    = path.join(__dirname, 'music');
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.NAMING_MODEL || process.env.OLLAMA_MODEL || 'gemma3:12b';

const TAG_VOCAB = ['ambient','upbeat','melancholic','intense','playful','driving','gentle','atmospheric'];

const args = process.argv.slice(2);
const albumArg = args.includes('--album') ? args[args.indexOf('--album') + 1] : null;
const force    = args.includes('--force');

// ── Ollama call ───────────────────────────────────────────────────────────────
function callOllama(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      options: { temperature: 0.8 }, // higher temp for more varied mood phrases
    });
    const url = new URL('/api/chat', OLLAMA_URL);
    const req = http.request({
      hostname: url.hostname,
      port:     url.port || 11434,
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.message?.content || '');
        } catch (e) { reject(new Error('Invalid JSON from Ollama')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4 * 60 * 1000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Tag one album ─────────────────────────────────────────────────────────────
async function tagAlbum(albumId) {
  const jsonPath = path.join(MUSIC_DIR, albumId, 'album.json');
  if (!fs.existsSync(jsonPath)) {
    console.log(`  [SKIP] No album.json in ${albumId}`);
    return;
  }

  const album = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const tracks = album.tracks || [];

  // Skip if all tracks already have both tags and mood_phrase and not forcing
  const untagged = tracks.filter(t => force || !t.tags || t.tags.length === 0 || !t.mood_phrase);
  if (untagged.length === 0) {
    console.log(`  [SKIP] ${album.title} — all tracks already tagged`);
    return;
  }

  console.log(`\n-- ${album.title} (${untagged.length} tracks to tag)`);

  const CHUNK_SIZE = 20;
  let totalUpdated = 0;
  let changed = false;
  const albumStart = Date.now();

  for (let chunkStart = 0; chunkStart < untagged.length; chunkStart += CHUNK_SIZE) {
    const chunk = untagged.slice(chunkStart, chunkStart + CHUNK_SIZE);
    console.log(`  Tagging tracks ${chunkStart + 1}–${chunkStart + chunk.length} of ${untagged.length}...`);

    const trackLines = chunk.map((t, i) => {
      const hints = [];
      if (typeof t.bpm === 'number')    hints.push(`${Math.round(t.bpm)}bpm`);
      if (t.mode)                        hints.push(t.mode);
      if (typeof t.energy === 'number') hints.push(`energy:${t.energy.toFixed(2)}`);
      if (typeof t.valence === 'number') hints.push(`valence:${t.valence.toFixed(2)}`);
      return `${i}: "${t.title}"${hints.length ? ' [' + hints.join(', ') + ']' : ''}`;
    }).join('\n');

    const prompt = `You are tagging tracks from the album "${album.title}" by ${album.artist} (genre: ${album.genre || 'unknown'}).

IMPORTANT: If you recognize a track, base your tags and mood_phrase on how the song ACTUALLY sounds and feels — not on what its title suggests. Trust your knowledge of the actual music over the title.

For each track, assign exactly 2-3 tags from this fixed vocabulary ONLY:
${TAG_VOCAB.join(', ')}

Also write a mood_phrase: 6-12 words describing the emotional texture of the music. Rules:
- Respond in English only
- Must be unique — no two tracks in this batch can share similar wording, imagery, or metaphor
- Must be specific to THIS track — not a generic description that could apply to any song
- Write in concrete sensory or situational language, not abstract adjectives
- Do NOT use the track title words in the phrase
- Do NOT repeat words like: moonlight, whisper, shadow, echo, shimmer, glow, drift, fade

Tag guidelines:
- ambient: background music, atmospheric textures, no strong melody focus
- upbeat: cheerful energy, positive feeling, makes you want to move
- melancholic: sad, wistful, bittersweet, introspective
- intense: dramatic, powerful, high-stakes, climactic
- playful: whimsical, lighthearted, fun, not serious
- driving: strong forward momentum, rhythmic pulse, good for movement
- gentle: soft, quiet, delicate, calm
- atmospheric: cinematic, world-building, immersive soundscape

Tracks to tag:
${trackLines}

Respond with ONLY a JSON array, one entry per track in the same order, no explanation:
[{"title":"track title","tags":["tag1","tag2"],"mood_phrase":"string"},...]`;

    let rawResponse;
    try {
      process.stdout.write(`  Calling ${OLLAMA_MODEL}...`);
      const start = Date.now();
      const spinner = setInterval(() => process.stdout.write('.'), 3000);
      rawResponse = await callOllama([{ role: 'user', content: prompt }]);
      clearInterval(spinner);
      process.stdout.write(` done (${((Date.now()-start)/1000).toFixed(0)}s)\n`);
    } catch (e) {
      process.stdout.write('\n');
      console.error(`  ERROR calling Ollama on chunk ${chunkStart}–${chunkStart + chunk.length}: ${e.message}`);
      continue;
    }

    let tagResults;
    try {
      const cleaned = rawResponse.replace(/```json|```/g, '').trim();
      tagResults = JSON.parse(cleaned);
    } catch (e) {
      console.error(`  ERROR parsing response for chunk: ${e.message}`);
      console.error(`  Raw: ${rawResponse.slice(0, 200)}`);
      continue;
    }

    for (const result of tagResults) {
      if (!result.title || !Array.isArray(result.tags)) continue;
      const validTags = result.tags.filter(t => TAG_VOCAB.includes(t));
      if (validTags.length === 0) continue;
      const track = chunk.find(t => t.title === result.title);
      if (track) {
        track.tags = validTags;
        if (result.mood_phrase && typeof result.mood_phrase === 'string') {
          track.mood_phrase = result.mood_phrase.slice(0, 100);
        }
        totalUpdated++;
        changed = true;
        const phrase = track.mood_phrase ? ` — "${track.mood_phrase}"` : '';
        console.log(`  ✓ "${result.title}" → [${validTags.join(', ')}]${phrase}`);
      }
    }
  }

  if (changed) {
    const elapsed = ((Date.now() - albumStart) / 1000).toFixed(0);
    fs.writeFileSync(jsonPath, JSON.stringify(album, null, 2));
    console.log(`  -> Saved ${jsonPath} (${totalUpdated} tracks tagged, ${elapsed}s)`);
  } else {
    console.log(`  -> No tracks updated`);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(MUSIC_DIR)) {
    console.error(`ERROR: Music directory not found: ${MUSIC_DIR}`);
    process.exit(1);
  }

  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log(`Tags: ${TAG_VOCAB.join(', ')}\n`);

  if (albumArg) {
    await tagAlbum(albumArg);
  } else {
    const albumIds = fs.readdirSync(MUSIC_DIR)
      .filter(name => fs.statSync(path.join(MUSIC_DIR, name)).isDirectory());

    if (albumIds.length === 0) {
      console.error('No album folders found in music/');
      process.exit(1);
    }

    console.log(`Found ${albumIds.length} album(s)`);
    for (const albumId of albumIds.sort()) {
      await tagAlbum(albumId);
    }
  }

  console.log('\n✓ Done');
})();
