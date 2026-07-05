#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch-genres.py — fetch/recompute genre tags for RETROCHUNG albums
Does NOT re-run audio analysis.

Usage:
    python fetch-genres.py                    # fetch genres for all albums
    python fetch-genres.py --album golden     # one album only
    python fetch-genres.py --force            # overwrite existing genres
    python fetch-genres.py --skip-genius      # algorithmic only, no Genius API
"""

import os, sys, json, argparse, time, re, urllib.request, urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument('--album',        type=str)
parser.add_argument('--force',        action='store_true')
parser.add_argument('--skip-genius',  action='store_true')
parser.add_argument('--music-dir',    type=str, default='music')
args = parser.parse_args()

MUSIC_DIR = args.music_dir
if not os.path.isdir(MUSIC_DIR):
    print(f'ERROR: Music directory not found: {MUSIC_DIR}')
    sys.exit(1)

# ── Genius ────────────────────────────────────────────────────────────────────
GENIUS_TOKEN = os.environ.get('GENIUS_TOKEN', '')
if not GENIUS_TOKEN:
    print('WARNING: GENIUS_TOKEN not set in environment. Genre fetching via Genius will be skipped.')
GENIUS_API   = 'https://api.genius.com'
GENIUS_SKIP  = {
    'tags','in english','usa','uk','south korea (대한민국)','genius korea',
    'korean (한국어)','japanese (日本語)','boy band','girl group','soundtrack',
    'lgbtq+ themes','independent','in spanish','in japanese','in korean',
}

def genius_search(artist, title):
    params = urllib.parse.urlencode({'q': f'{title} {artist}'})
    req = urllib.request.Request(
        f'{GENIUS_API}/search?{params}',
        headers={'Authorization': f'Bearer {GENIUS_TOKEN}'}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
    except Exception:
        return None
    hits = data.get('response', {}).get('hits', [])
    for hit in hits:
        h = hit.get('result', {})
        h_artist = h.get('primary_artist', {}).get('name', '').lower()
        if artist.lower() in h_artist or h_artist in artist.lower():
            return h
    return None

def scrape_genius_tags(page_url):
    req = urllib.request.Request(
        page_url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            html = r.read().decode('utf-8', errors='replace')
    except Exception:
        return []
    names = re.findall(r'SongTags[^"]*"[^>]*>\s*([A-Za-z][^<]{1,40}?)\s*<', html)
    cleaned = []
    for name in names:
        name = name.replace('&amp;', '&').replace('&#39;', "'").strip()
        if name.lower() not in GENIUS_SKIP and len(name) > 1:
            cleaned.append(name)
    return list(dict.fromkeys(cleaned))

# ── Algorithmic fallback ──────────────────────────────────────────────────────
def compute_subgenre(track):
    """
    Compute a subgenre bucket from audio features.
    Conditions checked in priority order — first match wins.
    """
    bpm          = track.get('bpm', 0) or 0
    energy       = track.get('energy', 0.5) or 0.5
    valence      = track.get('valence', 0.5) or 0.5
    danceability = track.get('danceability', 0.5) or 0.5
    brightness   = track.get('brightness', 0.5) or 0.5
    mode         = track.get('mode', 'major')

    # pumped: fast, energetic, major — bangers, hype tracks
    if bpm >= 130 and energy >= 0.60 and mode == 'major':
        return 'pumped'

    # tense: fast, energetic, minor — battle music, dark intensity
    if bpm >= 120 and energy >= 0.55 and mode == 'minor' and valence <= 0.55:
        return 'tense'

    # eerie: minor, low valence, mid energy — spooky, unsettling, ghost house
    if mode == 'minor' and valence <= 0.42 and 0.40 <= energy <= 0.60:
        return 'eerie'

    # triumphant: fast major, bright, high valence — fanfares, rainbow roads, epic builds
    if mode == 'major' and bpm >= 120 and valence >= 0.60 and brightness >= 0.55:
        return 'triumphant'

    # groovy: strong danceability, mid tempo — trip-hop, jazz, funk
    if danceability >= 0.42 and 75 <= bpm <= 140:
        return 'groovy'

    # sunny: bright and positive, major key
    if valence >= 0.65 and mode == 'major' and energy >= 0.40:
        return 'sunny'

    # whimsical: bouncy major, not high danceability, mid valence — menu music, playful
    if mode == 'major' and 100 <= bpm <= 135 and danceability <= 0.30 and 0.45 <= valence <= 0.70:
        return 'whimsical'

    # bittersweet: minor, emotionally mixed, mid energy
    if mode == 'minor' and 0.40 <= valence <= 0.55 and energy >= 0.45:
        return 'bittersweet'

    # wistful: slow minor, low valence — sad ballads, melancholic folk
    if mode == 'minor' and valence <= 0.42 and bpm <= 100:
        return 'wistful'

    # dreamy: slow and low energy — ambient, floating, sleepy
    if bpm <= 90 and energy <= 0.52:
        return 'dreamy'

    # mellow: catch-all for low-mid energy
    return 'mellow'

# ── Main ──────────────────────────────────────────────────────────────────────
def process_album(album_id):
    json_path = os.path.join(MUSIC_DIR, album_id, 'album.json')
    if not os.path.isfile(json_path):
        print(f'  [SKIP] No album.json in {album_id}')
        return

    with open(json_path, 'r', encoding='utf-8') as f:
        album = json.load(f)

    album_genre = album.get('genre', '')
    artist      = album.get('artist', '')

    needs = [t for t in album['tracks'] if args.force or not t.get('genres')]
    if not needs:
        print(f'  [SKIP] {album.get("title", album_id)} — all tracks already have genres')
        return

    print(f'\n-- {album.get("title", album_id)} ({len(needs)} tracks to tag)')

    # OST/instrumental — skip Genius, use algorithmic
    use_genius = not args.skip_genius and not any(
        kw in album_genre.lower()
        for kw in ['game ost', 'ost', 'video game', 'instrumental', 'developer']
    )

    if not use_genius:
        print(f'  -> Using algorithmic subgenres (OST/instrumental or --skip-genius)')

    changed = False
    for track in needs:
        genres = []

        if use_genius:
            song = genius_search(artist, track['title'])
            if song:
                try:
                    genres = scrape_genius_tags('https://genius.com' + song['path'])
                except Exception:
                    genres = []
            time.sleep(0.4)

        if genres:
            track['genres'] = genres
            print(f'  {track["title"][:50]:<50} {genres[:4]}')
        else:
            subgenre = compute_subgenre(track)
            track['genres'] = [subgenre]
            suffix = ' (algorithmic)' if use_genius else ''
            print(f'  {track["title"][:50]:<50} [{subgenre}]{suffix}')

        changed = True

    if changed:
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(album, f, indent=2, ensure_ascii=False)
        print(f'  -> Saved {json_path}')

# ── Run ───────────────────────────────────────────────────────────────────────
if args.album:
    process_album(args.album)
else:
    album_ids = sorted(d for d in os.listdir(MUSIC_DIR) if os.path.isdir(os.path.join(MUSIC_DIR, d)))
    print(f'Found {len(album_ids)} album(s)')
    for album_id in album_ids:
        process_album(album_id)
    print('\nDone.')
