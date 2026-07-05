#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze-albums.py — audio features + Genius genre tags + affinity scores for RETROCHUNG
Usage:
    python analyze-albums.py                      # analyze all albums
    python analyze-albums.py --album wings        # analyze one album
    python analyze-albums.py --force              # re-analyze even if already done
    python analyze-albums.py --skip-genres        # skip Genius genre fetching
    python analyze-albums.py --skip-affinities    # skip affinity computation
"""

import os, sys, json, argparse, time, re, urllib.request, urllib.parse
import warnings
warnings.filterwarnings('ignore', category=UserWarning)
warnings.filterwarnings('ignore', category=FutureWarning)

# ── Argument parsing ──────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--album",            type=str)
parser.add_argument("--force",            action="store_true")
parser.add_argument("--skip-genres",      action="store_true")
parser.add_argument("--skip-affinities",  action="store_true")
parser.add_argument("--music-dir",        type=str, default="music")
args = parser.parse_args()

# ── Check dependencies ────────────────────────────────────────────────────────
try:
    import librosa
    import numpy as np
except ImportError as e:
    print(f"ERROR: {e}\nRun: pip install librosa soundfile numpy")
    sys.exit(1)

MUSIC_DIR = args.music_dir
if not os.path.isdir(MUSIC_DIR):
    print(f"ERROR: Music directory not found: {MUSIC_DIR}")
    sys.exit(1)

ALL_FEATURES = ("bpm", "key", "mode", "energy", "brightness", "valence", "danceability")

# ── Genius genre fetching ─────────────────────────────────────────────────────
GENIUS_TOKEN    = os.environ.get("GENIUS_TOKEN", "")
if not GENIUS_TOKEN:
    print("WARNING: GENIUS_TOKEN not set in environment. Genre fetching via Genius will be skipped.")
GENIUS_API      = "https://api.genius.com"
GENIUS_SKIP     = {
    "tags","in english","usa","uk","south korea (대한민국)","genius korea",
    "korean (한국어)","japanese (日本語)","boy band","girl group","soundtrack",
    "lgbtq+ themes","independent","in spanish","in japanese","in korean",
}

def genius_search(artist, title):
    # Try with artist + title first
    params = urllib.parse.urlencode({"q": f"{title} {artist}"})
    req = urllib.request.Request(
        f"{GENIUS_API}/search?{params}",
        headers={"Authorization": f"Bearer {GENIUS_TOKEN}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
    except Exception:
        return None
    hits = data.get("response", {}).get("hits", [])
    # Only return hits where the artist actually matches — reject false positives
    for hit in hits:
        h = hit.get("result", {})
        h_artist = h.get("primary_artist", {}).get("name", "").lower()
        if artist.lower() in h_artist or h_artist in artist.lower():
            return h
    return None  # No confident match — don't guess

def scrape_genius_tags(page_url):
    req = urllib.request.Request(
        page_url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            html = r.read().decode("utf-8", errors="replace")
    except Exception:
        return []
    names = re.findall(r"SongTags[^\"]*\"[^>]*>\s*([A-Za-z][^<]{1,40}?)\s*<", html)
    cleaned = []
    for name in names:
        name = name.replace("&amp;", "&").replace("&#39;", "'").strip()
        if name.lower() not in GENIUS_SKIP and len(name) > 1:
            cleaned.append(name)
    return list(dict.fromkeys(cleaned))

def compute_subgenre(track):
    """
    Compute a subgenre bucket from audio features as fallback when Genius has no data.
    Returns a single string label. Conditions checked in priority order.
    """
    bpm          = track.get('bpm', 0) or 0
    energy       = track.get('energy', 0.5) or 0.5
    valence      = track.get('valence', 0.5) or 0.5
    danceability = track.get('danceability', 0.5) or 0.5
    mode         = track.get('mode', 'major')

    # pumped: high energy, fast, major — bangers, hype tracks
    if bpm >= 120 and energy >= 0.65 and mode == 'major':
        return 'pumped'
    # tense: high energy, fast, minor — battle music, dark intensity
    if bpm >= 120 and energy >= 0.65 and mode == 'minor':
        return 'tense'
    # groovy: strong danceability, mid tempo — trip-hop, jazz, funk
    if danceability >= 0.42 and 75 <= bpm <= 135:
        return 'groovy'
    # sunny: bright and positive, major key
    if valence >= 0.65 and mode == 'major' and energy >= 0.45:
        return 'sunny'
    # bittersweet: emotionally mixed, minor, mid energy
    if valence <= 0.50 and mode == 'minor' and energy >= 0.45:
        return 'bittersweet'
    # wistful: sad, low energy, minor
    if valence <= 0.45 and mode == 'minor':
        return 'wistful'
    # dreamy: slow and low energy
    if bpm <= 90 and energy <= 0.50:
        return 'dreamy'
    # mellow: low energy catch-all
    if energy <= 0.55:
        return 'mellow'
    # default
    return 'sunny'



# ── Affinity computation ───────────────────────────────────────────────────────
# Mood and setting feature vectors (valence, energy, brightness, danceability)
MOOD_VECTORS = {
    'sunny':  {'valence': 0.90, 'energy': 0.60, 'brightness': 0.75, 'danceability': 0.70},
    'cloudy': {'valence': 0.55, 'energy': 0.42, 'brightness': 0.55, 'danceability': 0.67},
    'rainy':  {'valence': 0.10, 'energy': 0.30, 'brightness': 0.35, 'danceability': 0.20},
    'snowy':  {'valence': 0.60, 'energy': 0.35, 'brightness': 0.40, 'danceability': 0.28},
    'windy':  {'valence': 0.50, 'energy': 0.72, 'brightness': 0.62, 'danceability': 0.35},
    'stormy': {'valence': 0.10, 'energy': 0.90, 'brightness': 0.50, 'danceability': 0.70},
}

SETTING_VECTORS = {
    'bedroom': {'valence': 0.52, 'energy': 0.25, 'brightness': 0.35, 'danceability': 0.20},
    'cafe':    {'valence': 0.60, 'energy': 0.42, 'brightness': 0.55, 'danceability': 0.50},
    'gym':     {'valence': 0.65, 'energy': 0.88, 'brightness': 0.72, 'danceability': 0.82},
    'work':    {'valence': 0.55, 'energy': 0.48, 'brightness': 0.52, 'danceability': 0.20},
    'drive':   {'valence': 0.60, 'energy': 0.65, 'brightness': 0.65, 'danceability': 0.55},
    'travel':  {'valence': 0.55, 'energy': 0.40, 'brightness': 0.50, 'danceability': 0.35},
}

# Directed graph edge weights — (from, to): weight
# Symmetric pairs appear once with same weight in both directions
# Asymmetric pairs appear twice with different weights
MOOD_GRAPH = {
    ('sunny',  'cloudy'): 0.883, ('cloudy', 'sunny'):  0.883,
    ('sunny',  'windy'):  0.746, ('windy',  'sunny'):  0.746,
    ('cloudy', 'snowy'):  0.851, ('snowy',  'cloudy'): 0.851,
    ('cloudy', 'rainy'):  0.762, ('rainy',  'cloudy'): 0.762,
    ('cloudy', 'windy'):  0.726, ('windy',  'cloudy'): 0.726,
    ('rainy',  'snowy'):  0.797, ('snowy',  'rainy'):  0.797,
    ('windy',  'stormy'): 0.603, ('stormy', 'windy'):  0.603,
    # Asymmetric pairs
    ('stormy', 'rainy'):  0.659, ('rainy',  'stormy'): 0.547,
    ('stormy', 'cloudy'): 0.617, ('cloudy', 'stormy'): 0.477,
    ('windy',  'snowy'):  0.635, ('snowy',  'windy'):  0.585,
}

SETTING_GRAPH = {
    ('bedroom', 'travel'): 0.858, ('travel',  'bedroom'): 0.858,
    ('cafe',    'travel'): 0.876, ('travel',  'cafe'):    0.876,
    ('work',    'travel'): 0.897, ('travel',  'work'):    0.897,
    ('bedroom', 'cafe'):   0.756, ('cafe',    'bedroom'): 0.756,
    ('work',    'bedroom'):0.705, ('bedroom', 'work'):    0.705,
    ('cafe',    'drive'):  0.736, ('drive',   'cafe'):    0.736,
    # Asymmetric pairs
    ('cafe',    'work'):   0.887, ('work',    'cafe'):    0.767,
    ('drive',   'travel'): 0.892, ('travel',  'drive'):   0.772,
    ('gym',     'drive'):  0.790, ('drive',   'gym'):     0.670,
}

FEATURES = ['valence', 'energy', 'brightness', 'danceability']
MAX_DIST  = len(FEATURES) ** 0.5  # 2.0

PROPAGATION_FACTOR = 0.15  # graph influence is a secondary correction

def euclidean_affinity(track_feats, target_vector):
    dist = sum((track_feats.get(f, 0.5) - target_vector[f]) ** 2 for f in FEATURES) ** 0.5
    return round(1.0 - dist / MAX_DIST, 3)

def propagate(base_affinities, graph):
    """Apply one hop of graph propagation as a secondary correction."""
    result = dict(base_affinities)
    for node in base_affinities:
        neighbors = [(src, w) for (src, dst), w in graph.items() if dst == node]
        if not neighbors:
            continue
        correction = sum(base_affinities[src] * w for src, w in neighbors) * PROPAGATION_FACTOR / len(neighbors)
        result[node] = round(min(1.0, base_affinities[node] + correction), 3)
    return result

def compute_affinities(track):
    """
    Compute mood and setting affinity scores for a track.
    Returns dict with moods and settings sub-dicts, each 0-1.
    Initial scores from Euclidean distance to feature vectors,
    corrected by one hop of graph propagation.
    """
    feats = {f: track.get(f, 0.5) or 0.5 for f in FEATURES}

    mood_base    = {m: euclidean_affinity(feats, v) for m, v in MOOD_VECTORS.items()}
    setting_base = {s: euclidean_affinity(feats, v) for s, v in SETTING_VECTORS.items()}

    mood_final    = propagate(mood_base,    MOOD_GRAPH)
    setting_final = propagate(setting_base, SETTING_GRAPH)

    return {'moods': mood_final, 'settings': setting_final}

# ── Key detection ─────────────────────────────────────────────────────────────
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
NOTE_NAMES    = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

def detect_key(y, sr):
    """Returns (key_name, mode) e.g. ('Am', 'minor') or ('C', 'major')"""
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    best_score, best_key, best_mode = -np.inf, 0, 'major'
    for i in range(12):
        s_maj = np.corrcoef(chroma_mean, np.roll(MAJOR_PROFILE, i))[0, 1]
        s_min = np.corrcoef(chroma_mean, np.roll(MINOR_PROFILE, i))[0, 1]
        if s_maj > best_score: best_score, best_key, best_mode = s_maj, i, 'major'
        if s_min > best_score: best_score, best_key, best_mode = s_min, i, 'minor'
    note = NOTE_NAMES[best_key]
    return (f'{note}m' if best_mode == 'minor' else note), best_mode

# ── Feature extraction ────────────────────────────────────────────────────────
def analyze_track(filepath):
    """
    Returns dict with bpm, key, mode, energy, brightness, valence, danceability.
    Loads at 22050 Hz mono — fine for feature extraction, much faster than full quality.
    """
    y, sr = librosa.load(filepath, sr=22050, mono=True)

    # ── BPM ──
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    bpm = round(float(np.atleast_1d(tempo)[0]), 1)

    # ── Key / mode ──
    key, mode = detect_key(y, sr)

    # ── Energy (RMS loudness) ──
    rms = librosa.feature.rms(y=y)[0]
    rms_mean = float(np.mean(rms))
    db = 20 * np.log10(rms_mean) if rms_mean > 0 else -60.0
    energy = round(float(np.clip((db - (-30.0)) / ((-3.0) - (-30.0)), 0.0, 1.0)), 3)

    # ── Brightness (spectral centroid) ──
    # High = airy/bright/cymbal-heavy. Low = bass-heavy/dark/muffled.
    # Normalize against typical music range 500Hz-4000Hz.
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    centroid_mean = float(np.mean(centroid))
    CENTROID_MIN, CENTROID_MAX = 500.0, 4000.0
    brightness = round(float(np.clip((centroid_mean - CENTROID_MIN) / (CENTROID_MAX - CENTROID_MIN), 0.0, 1.0)), 3)

    # ── Danceability (beat strength consistency) ──
    # Measures how steady and strong the beat is. High = clear groove.
    # Uses onset strength envelope variance — low variance = steady beat = high danceability.
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    if len(onset_env) > 1:
        # Normalize onset strength, then score by mean/std ratio (higher = more consistent)
        onset_norm = onset_env / (np.max(onset_env) + 1e-6)
        mean_strength = float(np.mean(onset_norm))
        std_strength  = float(np.std(onset_norm))
        # High mean + low std = strong consistent beat
        danceability = round(float(np.clip(mean_strength / (std_strength + 0.1), 0.0, 1.0)), 3)
    else:
        danceability = 0.0

    # ── Valence (approximated positivity) ──
    # Spotify's valence is proprietary but we can approximate from:
    #   - mode (major = +, minor = -)
    #   - brightness (brighter = more positive)
    #   - tempo (mid-tempo 100-130 bpm peaks positivity, very slow or very fast reduce it)
    # These are combined into a weighted score.
    mode_score   = 0.7 if mode == 'major' else 0.3
    bright_score = brightness  # already 0-1
    # BPM contribution: peaks at ~120bpm, falls off toward extremes
    bpm_norm     = float(np.clip((bpm - 40.0) / (200.0 - 40.0), 0.0, 1.0))
    bpm_score    = 1.0 - abs(bpm_norm - 0.5) * 2  # 0 at extremes, 1 at midpoint
    valence = round(float(np.clip(
        0.5 * mode_score + 0.3 * bright_score + 0.2 * bpm_score,
        0.0, 1.0
    )), 3)

    return {
        'bpm':         bpm,
        'key':         key,
        'mode':        mode,
        'energy':      energy,
        'brightness':  brightness,
        'danceability': danceability,
        'valence':     valence,
    }

# ── Main ──────────────────────────────────────────────────────────────────────
def process_album(album_id):
    album_dir = os.path.join(MUSIC_DIR, album_id)
    json_path = os.path.join(album_dir, 'album.json')

    if not os.path.isfile(json_path):
        print(f'  [SKIP] No album.json found in {album_dir}')
        return

    with open(json_path, 'r', encoding='utf-8') as f:
        album = json.load(f)

    print(f'\n-- {album.get("title", album_id)} ({len(album["tracks"])} tracks)')

    changed = False
    total   = len(album['tracks'])

    for i, track in enumerate(album['tracks']):
        skip_audio = not args.force and all(k in track for k in ALL_FEATURES)
        skip_affinity = not args.force and track.get('affinities')

        if skip_audio and skip_affinity:
            continue

        if skip_audio:
            # Audio already done — just need affinities
            if not skip_affinity and not args.skip_affinities:
                track['affinities'] = compute_affinities(track)
                changed = True
                print(f'  [{i+1:3d}/{total}] {track["title"][:45]:<45} — affinities computed')
            continue

        filepath = os.path.join(album_dir, track['file'])
        if not os.path.isfile(filepath):
            print(f'  [{i+1:3d}/{total}] {track["title"][:45]:<45} — FILE NOT FOUND, skipping')
            continue

        print(f'  [{i+1:3d}/{total}] {track["title"][:45]:<45} ', end='', flush=True)
        t_start = time.time()

        try:
            features = analyze_track(filepath)
            track.update(features)
            if not args.skip_affinities:
                track['affinities'] = compute_affinities(track)
            changed = True
            elapsed = time.time() - t_start
            print(
                f'BPM:{features["bpm"]:6.1f}  '
                f'Key:{features["key"]:<4}  '
                f'Energy:{features["energy"]:.2f}  '
                f'Bright:{features["brightness"]:.2f}  '
                f'Dance:{features["danceability"]:.2f}  '
                f'Val:{features["valence"]:.2f}  '
                f'({elapsed:.1f}s)'
            )
        except Exception as e:
            print(f'ERROR: {e}')

    if changed:
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(album, f, indent=2, ensure_ascii=False)
        print(f'  -> Saved {json_path}')
    else:
        print(f'  -> No changes')

    # ── Genius genre tags ─────────────────────────────────────────────────────
    if args.skip_genres:
        return

    artist = album.get('artist', '')
    album_genre = album.get('genre', '')

    # For game OSTs and instrumental albums, Genius won't have useful data
    # Just tag all tracks with the album genre directly
    skip_genius = any(kw in album_genre.lower() for kw in ['game ost', 'ost', 'video game', 'instrumental', 'developer'])
    if skip_genius:
        needs_genres = [t for t in album['tracks'] if args.force or not t.get('genres')]
        if needs_genres:
            print(f'  -> OST/instrumental album — using algorithmic subgenres for all tracks')
            for track in needs_genres:
                track['genres'] = [compute_subgenre(track)]
            with open(json_path, 'w', encoding='utf-8') as f:
                json.dump(album, f, indent=2, ensure_ascii=False)
        return

    needs_genres = [t for t in album['tracks'] if args.force or not t.get('genres')]
    if not needs_genres:
        print(f'  -> Genres already fetched, skipping')
        return

    print(f'  Fetching genres from Genius ({len(needs_genres)} tracks)...')
    genre_changed = False
    for track in needs_genres:
        song = genius_search(artist, track['title'])
        if song:
            try:
                tags = scrape_genius_tags("https://genius.com" + song["path"])
                time.sleep(0.4)
            except Exception:
                tags = []
        else:
            tags = []
            time.sleep(0.1)

        if tags:
            track['genres'] = tags
            genre_changed = True
            print(f'    {track["title"][:45]:<45} {tags[:4]}')
        else:
            # Fall back to algorithmic subgenre
            subgenre = compute_subgenre(track)
            track['genres'] = [subgenre]
            genre_changed = True
            print(f'    {track["title"][:45]:<45} [{subgenre}] (algorithmic fallback)')

    if genre_changed:
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(album, f, indent=2, ensure_ascii=False)
        print(f'  -> Saved genres to {json_path}')

# ── Run ───────────────────────────────────────────────────────────────────────
if args.album:
    process_album(args.album)
else:
    album_ids = [d for d in os.listdir(MUSIC_DIR) if os.path.isdir(os.path.join(MUSIC_DIR, d))]
    if not album_ids:
        print(f'No album folders found in {MUSIC_DIR}/')
        sys.exit(1)
    print(f'Found {len(album_ids)} album(s) in {MUSIC_DIR}/')
    total_start = time.time()
    for album_id in sorted(album_ids):
        process_album(album_id)
    print(f'\n✓ Done in {time.time() - total_start:.1f}s')
