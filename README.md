# NFC Music Server

A self-hosted music server for your NFC cartridge collection.
Tap a cartridge → phone opens the album → music plays. You own everything.

---

## Setup

### 1. Install Node.js
Download from https://nodejs.org (LTS version). Verify with:
```
node --version
npm --version
```

### 2. Install dependencies
```
npm install
```

### 3. Configure environment
Copy `.env.example` to `.env` and fill in your values:
```
cp .env.example .env
```

### 4. Start the server
```
node server.js
```

The server runs on port 3000. Find your PC's local IP address:
- Windows: run `ipconfig` in Command Prompt, look for IPv4 Address
- Linux/Mac: run `ip addr` or `ifconfig`

Your server address will be something like `http://192.168.1.42:3000`

---

## Adding Albums

Each album lives in its own folder under `/music`:

```
music/
├── persona5/
│   ├── album.json    ← required: metadata
│   ├── cover.jpg     ← required: album art (any reasonable size, square preferred)
│   ├── 01.mp3        ← audio files (mp3, flac, ogg, opus, aac, m4a, wav all work)
│   ├── 02.mp3
│   └── ...
├── animal-crossing-nh/
│   ├── album.json
│   ├── cover.jpg
│   └── ...
```

### album.json format

```json
{
  "title": "Album Title",
  "artist": "Artist Name",
  "year": 2024,
  "genre": "Game Soundtrack",
  "tracks": [
    { "title": "Track Name", "file": "01.mp3", "duration": 234 },
    { "title": "Track Name", "file": "02.mp3", "duration": 180 }
  ]
}
```

- `file` must match the actual filename in the same folder
- `duration` is in seconds (optional but enables the progress bar)
- The folder name becomes the album ID used in URLs

---

## NFC Tag Setup

Program each tag with the URL:
```
http://YOUR_PC_IP:3000/play/ALBUM_FOLDER_NAME
```

Examples:
- `http://192.168.1.42:3000/play/persona5`
- `http://192.168.1.42:3000/play/animal-crossing-nh`

---

## API Endpoints

These are used by the frontend automatically, but useful to know:

| Endpoint | Description |
|---|---|
| `GET /api/albums` | List all albums |
| `GET /api/album/:id` | Get metadata for one album |
| `GET /audio/:id/:file` | Stream an audio file or image |
| `GET /play/:id` | NFC landing page (loads the player) |

---

## Audio Format Tips

- **MP3** — works everywhere, smallest files, fine for portable use
- **FLAC** — lossless, large files, works in most modern browsers
- **OPUS** — best quality/size ratio, great for this use case
- **AAC/M4A** — good quality, universal support

For commute/gym use, MP3 at 320kbps or OPUS at 192kbps is the sweet spot.
Use **FFmpeg** to batch-convert: `ffmpeg -i input.flac -b:a 320k output.mp3`

---

## Making It Accessible Outside Your Home (Optional)

To tap a cartridge away from home WiFi, expose the server via:

- **Tailscale** (recommended) — free, install on phone + PC, done
- **Cloudflare Tunnel** — free, more setup but works without installing anything on the phone
