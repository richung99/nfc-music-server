/**
 * fetch-discoveries.js
 * Runs at 9AM and 9PM via node-cron in server.js.
 * 1. Reads music library to get all unique artists
 * 2. Picks a random artist as seed
 * 3. Queries Last.fm for similar artists not in library
 * 4. For each similar artist, gets their top track
 * 5. Checks Deezer for a 30s preview — skips if unavailable
 * 6. Collects 3 valid tracks, writes to discoveries.json
 */

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const LASTFM_KEY = process.env.LASTFM_KEY;
if (!LASTFM_KEY) throw new Error('LASTFM_KEY not set in environment. Copy .env.example to .env and add your key.');
const DISCOVERIES_PATH = path.join(__dirname, 'discoveries.json');
const MUSIC_DIR        = path.join(__dirname, 'music');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Library artists ───────────────────────────────────────────────────────────

function getLibraryArtists() {
  const artists = new Set();
  if (!fs.existsSync(MUSIC_DIR)) return artists;
  for (const albumId of fs.readdirSync(MUSIC_DIR)) {
    const jsonPath = path.join(MUSIC_DIR, albumId, 'album.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const album = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      if (album.artist) artists.add(album.artist.toLowerCase().trim());
      for (const track of (album.tracks || [])) {
        if (track.artist) artists.add(track.artist.toLowerCase().trim());
      }
    } catch(e) {}
  }
  return artists;
}

function pickRandomArtist(artists) {
  const arr = Array.from(artists);
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Last.fm ───────────────────────────────────────────────────────────────────

async function getSimilarArtists(artist) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getSimilar&artist=${encodeURIComponent(artist)}&api_key=${LASTFM_KEY}&format=json&limit=20`;
  const data = await fetchJSON(url);
  return (data.similarartists?.artist || []).map(a => ({
    name: a.name,
    match: parseFloat(a.match),
  }));
}

async function getTopTrack(artist) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getTopTracks&artist=${encodeURIComponent(artist)}&api_key=${LASTFM_KEY}&format=json&limit=10`;
  const data = await fetchJSON(url);
  const tracks = data.toptracks?.track || [];
  if (!tracks.length) return null;

  // Pick randomly from top 5 rather than always taking #1
  const pool = tracks.slice(0, 5);
  const t    = pool[Math.floor(Math.random() * pool.length)];

  let album = null;
  try {
    const infoUrl = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(t.name)}&api_key=${LASTFM_KEY}&format=json`;
    const info = await fetchJSON(infoUrl);
    album = info.track?.album?.title || null;
  } catch(e) {}

  return { title: t.name, album };
}

// ── Deezer ────────────────────────────────────────────────────────────────────

async function getDeezerPreview(artist, track) {
  const q = encodeURIComponent(`artist:"${artist}" track:"${track}"`);
  const url = `https://api.deezer.com/search?q=${q}&limit=3`;
  const data = await fetchJSON(url);
  const results = data.data || [];
  for (const r of results) {
    if (r.preview && r.preview.length > 0) {
      return {
        previewUrl: r.preview.replace(/^http:\/\//, 'https://'),
        albumTitle: r.album?.title || null,
        albumCover: r.album?.cover_medium || null,
        deezerUrl:  r.link || null,
      };
    }
  }
  return null;
}

// ── Load / save seen artist history ──────────────────────────────────────────
const HISTORY_SIZE = 30; // remember last 30 surfaced artists

function loadSeenArtists() {
  try {
    const state = JSON.parse(fs.readFileSync(DISCOVERIES_PATH, 'utf-8'));
    return new Set((state.seenArtists || []).map(a => a.toLowerCase().trim()));
  } catch(e) { return new Set(); }
}

function saveSeenArtists(seenArtists, state) {
  state.seenArtists = Array.from(seenArtists).slice(-HISTORY_SIZE);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function fetchDiscoveries() {
  console.log('[discoveries] Starting discovery fetch...');

  const libraryArtists = getLibraryArtists();
  if (libraryArtists.size === 0) {
    console.log('[discoveries] No library artists found, skipping.');
    return;
  }

  const seenArtists  = loadSeenArtists();
  const discoveries  = [];
  const usedSeeds    = new Set();
  // Exclude: library artists + previously surfaced artists
  const usedArtists  = new Set([...libraryArtists, ...seenArtists]);
  const artistArr    = Array.from(libraryArtists);

  let attempts = 0;
  while (discoveries.length < 3 && attempts < 15) {
    attempts++;

    const available = artistArr.filter(a => !usedSeeds.has(a));
    if (!available.length) break;
    const seedArtist = available[Math.floor(Math.random() * available.length)];
    usedSeeds.add(seedArtist);
    console.log(`[discoveries] Seed artist: ${seedArtist}`);

    let similar;
    try {
      similar = await getSimilarArtists(seedArtist);
    } catch(e) {
      console.error('[discoveries] Last.fm error:', e.message);
      continue;
    }

    // Skip the top 5 most obvious similar artists — go deeper into the list
    const candidates = similar
      .slice(5)
      .filter(a => !usedArtists.has(a.name.toLowerCase().trim()));

    // Fall back to full list if skipping top 5 left nothing
    const pool = candidates.length >= 3
      ? candidates
      : similar.filter(a => !usedArtists.has(a.name.toLowerCase().trim()));

    for (const candidate of pool) {
      if (discoveries.length >= 3) break;
      await sleep(300);

      try {
        const topTrack = await getTopTrack(candidate.name);
        if (!topTrack) continue;

        await sleep(300);

        const deezer = await getDeezerPreview(candidate.name, topTrack.title);
        if (!deezer) {
          console.log(`[discoveries] No Deezer preview for ${candidate.name} — skipping`);
          continue;
        }

        usedArtists.add(candidate.name.toLowerCase().trim());
        seenArtists.add(candidate.name.toLowerCase().trim());
        discoveries.push({
          artist:     candidate.name,
          similarTo:  seedArtist,
          match:      Math.round(candidate.match * 100),
          track:      topTrack.title,
          album:      deezer.albumTitle || topTrack.album,
          albumCover: deezer.albumCover,
          previewUrl: deezer.previewUrl,
          deezerUrl:  deezer.deezerUrl,
        });

        console.log(`[discoveries] Added: ${candidate.name} — ${topTrack.title} (via ${seedArtist})`);
        break;
      } catch(e) {
        console.log(`[discoveries] Error processing ${candidate.name}:`, e.message);
      }
    }
  }

  if (discoveries.length === 0) {
    console.log('[discoveries] No valid discoveries found.');
    return;
  }

  const state = {
    discoveries,
    generatedAt: new Date().toISOString(),
    seedArtists: Array.from(usedSeeds).slice(0, discoveries.length),
  };

  saveSeenArtists(seenArtists, state);
  fs.writeFileSync(DISCOVERIES_PATH, JSON.stringify(state, null, 2));
  console.log(`[discoveries] Wrote ${discoveries.length} discoveries to discoveries.json`);
  return state;
}

module.exports = { fetchDiscoveries };
