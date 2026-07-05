#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cleanup-tracks.py — remove deprecated tags and mood_phrase fields from all album.json files
Usage: python cleanup-tracks.py
       python cleanup-tracks.py --album golden
       python cleanup-tracks.py --dry-run   # preview without writing
"""

import os, sys, json, argparse

parser = argparse.ArgumentParser()
parser.add_argument('--album',   type=str, help='Only clean a specific album ID')
parser.add_argument('--dry-run', action='store_true', help='Preview changes without writing')
parser.add_argument('--music-dir', type=str, default='music')
args = parser.parse_args()

MUSIC_DIR   = args.music_dir
REMOVE_KEYS = {'tags', 'mood_phrase'}

if not os.path.isdir(MUSIC_DIR):
    print(f'ERROR: Music directory not found: {MUSIC_DIR}')
    sys.exit(1)

def clean_album(album_id):
    json_path = os.path.join(MUSIC_DIR, album_id, 'album.json')
    if not os.path.isfile(json_path):
        return

    with open(json_path, 'r', encoding='utf-8') as f:
        album = json.load(f)

    removed_count = 0
    for track in album.get('tracks', []):
        for key in REMOVE_KEYS:
            if key in track:
                del track[key]
                removed_count += 1

    if removed_count == 0:
        print(f'  [SKIP] {album.get("title", album_id)} — nothing to clean')
        return

    print(f'  {album.get("title", album_id)} — removed {removed_count} fields across {len(album["tracks"])} tracks')

    if not args.dry_run:
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(album, f, indent=2, ensure_ascii=False)

if args.dry_run:
    print('DRY RUN — no files will be written\n')

if args.album:
    clean_album(args.album)
else:
    album_ids = sorted(d for d in os.listdir(MUSIC_DIR) if os.path.isdir(os.path.join(MUSIC_DIR, d)))
    print(f'Cleaning {len(album_ids)} albums...\n')
    for album_id in album_ids:
        clean_album(album_id)
    print('\nDone.' if not args.dry_run else '\nDry run complete — rerun without --dry-run to apply.')
