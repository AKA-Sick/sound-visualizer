# Song Library — Design Spec

## Overview

Add a persistent, browsable song library on top of the existing file-playback stem-separation feature: a "Load Folder…" option that recursively scans and eagerly (background, sequential) processes every audio file it finds, a sortable/filterable song list with metadata read from each file's embedded tags, favorites, and play tracking — so the app behaves like a normal music library browser instead of a one-file-at-a-time picker.

This spec explicitly does **not** cover playlists — that's a deliberate follow-up, built once this library foundation exists.

## What Already Exists (unchanged by this spec)

- `src/main/stem-cache.js` — content-hash-keyed disk cache of separated stems (`userData/stem-cache/<hash>/*.wav`), with atomic writes. **This is why "run it again days later, no delay" already works today** — this spec adds visibility into that cache, not the caching itself.
- `src/main/stem-model.js` / `stem-processor.js` / `stem-wav.js` — the ONNX model, overlap-add separation, WAV encoding.
- `src/renderer/audio/file-source.js`'s `FileAudioSource` — Web Audio playback/mixing engine (play/pause/seek/mute/solo/volume), driven by a single loaded file today.
- `main.js`'s 7 IPC handlers for the single-file flow (`pick-audio-file`, `check-stem-cache`, `read-audio-file-bytes`, `process-audio-pcm`, `read-stem-audio`, `read-stem-cache-size`, `clear-stem-cache`).
- The panel UI's file-controls section (Source toggle, Load File…, progress bar, transport, stem mixer, cache management).

## Architecture

```
Folder scan (main)              Library index (disk)           Processing queue (main)
┌──────────────────┐     ┌──────────────────────────┐    ┌─────────────────────────┐
│ recursively find  │     │ userData/library.json     │    │ FIFO of pending hashes   │
│ audio files       │────►│ [{ hash, filePath, title,  │◄──►│ drains one song at a     │
│ hash + read tags  │     │   artist, album, genre,    │    │ time through the         │
│ per file (fast,   │     │   featuredArtists, duration,│   │ existing separation      │
│ no decode)         │     │   dateAdded, lastPlayed,   │    │ pipeline (stem-model /   │
└──────────────────┘     │   playCount, favorite,     │    │ stem-processor / stem-   │
                          │   processed }]              │    │ wav / stem-cache)        │
                          └──────────────────────────┘    └─────────────────────────┘
                                     ▲                                │
                                     │ upsert on add / after each      │ progress events:
                                     │ processing completes /          │ { hash, title,
                                     │ on play (playCount, lastPlayed) │   queuePosition,
                                     │                                 │   queueTotal, percent }
                          ┌──────────────────────────┐
                          │ Renderer: song list       │
                          │ sort / filter / search /  │
                          │ favorite toggle / click-  │
                          │ to-play (jumps queue)     │
                          └──────────────────────────┘
```

## Library Index

**Storage**: `userData/library.json`, a flat JSON array, same simple-file pattern as the existing `settings-store.js` (no database needed — even a few thousand entries is a small file, sorted/filtered entirely in memory).

**Entry shape**:
```json
{
  "hash": "sha256 hex, same identity as the stem cache",
  "filePath": "original absolute path at time of adding",
  "title": "string (from tags, or filename if untagged)",
  "artist": "string (from tags, or \"Unknown Artist\")",
  "album": "string (from tags, or \"\")",
  "genre": "string (from tags, or \"\")",
  "featuredArtists": ["string", "..."],
  "duration": "seconds, number",
  "dateAdded": "ISO timestamp",
  "lastPlayed": "ISO timestamp or null",
  "playCount": "integer, default 0",
  "favorite": "boolean, default false",
  "processed": "boolean — mirrors stem-cache hit, avoids a disk check per row"
}
```

**Identity**: keyed by the same content hash as `stem-cache.js`. A song added via "Load Folder" that was previously loaded individually via "Load File…" (or vice versa) is recognized as the same entry — no duplicate rows, no reprocessing.

## Metadata Extraction

- **Library**: `music-metadata` (npm), reads ID3v1/v2, Vorbis comments (FLAC/OGG), and MP4 atoms — pure JS, no native build step. Also reports duration directly, so the list can show track length without a full audio decode.
- **Fallback**: an untagged file uses its filename (minus extension) as the title; artist/album/genre show as blank/"Unknown Artist".
- **"feat." parsing**: a regex over the title matches common patterns (`feat.`, `ft.`, `featuring`, `(with ...)`) and extracts the named artist into `featuredArtists` — **search/filter-only**, never overwrites the displayed title or artist field. E.g. "Song Name (feat. Artist B)" with main artist "Artist A" means searching "Artist B" also finds this song, but the row still displays "Artist A" as the artist.

## Folder Scan & Processing Queue

1. **Load Folder…** opens a directory picker, then recursively walks it for files matching the already-supported extensions (mp3, wav, flac, m4a, ogg).
2. For each file found: compute its content hash (streamed, fast) and read its tags (fast, no decode). Upsert into `library.json` immediately — the list shows every song right away, before any separation happens.
3. Any entry not already `processed` (i.e., no cache hit) is pushed onto an in-memory FIFO **processing queue** in the main process.
4. The queue drains **one song at a time** — never in parallel, since a single song's separation can use several GB of memory (measured ~5.7GB peak for a 3.5-minute track in the prior feature's testing). Each dequeued song runs through the existing separation pipeline unchanged; on completion, `library.json` is updated (`processed: true`, `duration` reconciled if it changed).
5. **Queue-jump**: clicking a song in the list that isn't yet processed moves it to the front of the remaining queue (after whatever song is currently mid-separation — an in-flight job is never interrupted, only what comes next is reordered). This is a simple in-memory reorder of the pending-hash array, not a cancellation mechanism.
6. **Progress reporting**: extends the existing `stem-progress` IPC event to also carry which song is currently processing and its position in the queue (e.g., `{ hash, title, queuePosition: 3, queueTotal: 47, percent: 0.62 }`), so the UI can show "Processing 3 of 47: *Song Title* — 62%" while still updating that song's own per-chunk percent.
7. **Per-file failure isolation**: if one song's separation throws (corrupt file, inference error), that entry is marked failed with an error indicator on its row (not silently retried, not blocking); the queue moves on to the next song. A bad file in a folder of 50 doesn't stop the other 49.

## Play Tracking

A play is counted — incrementing `playCount` and setting `lastPlayed` — once playback reaches the natural end of the track, **or** passes 50% of its duration, whichever comes first (standard "scrobble"-style convention; avoids over-counting from quick skips while still counting a song you stopped partway through on purpose).

## Sort & Filter

- **Sort**: title, artist, album, date added, last played, play count, duration (click a column header, same direction-toggle convention as any table).
- **Filter**: a text search box matching title, artist, album, and `featuredArtists`; a favorites-only toggle; a genre dropdown populated from the distinct genres actually present in the library (not a fixed list).
- **Remove from library**: removes the index entry only — does not delete the cached stems, so re-adding the same file later is still instant. (Not explicitly requested, but a basic expectation for any list like this; manual tag editing and album art remain out of scope.)

## UI Layout

When Source = Audio File, the panel's file-controls section changes from today's single-file flow to a library view:

```
┌─ Load File…  Load Folder…  [search box]  [Genre ▾]  [☆ Favorites only] ─┐
│ Title              Artist         Album        Genre   Duration  ★  ●  │
│ Song A             Artist X       Album 1       Rock    3:45      ☆  ✓ │
│ Song B (feat. Y)   Artist Z       Album 2       Pop     4:12      ★  ⏳ │
│ ...                                                      (sortable cols)│
├──────────────────────────────────────────────────────────────────────── │
│ Processing 3 of 47: "Song B" — 62%                                      │
├──────────────────────────────────────────────────────────────────────── │
│ ▶ Now playing: Song A            [seek bar]      Vocals Drums Bass ...  │
└──────────────────────────────────────────────────────────────────────── ┘
```

`✓` = cached/instant, `⏳` = queued/processing, an error icon (not shown above) marks a failed entry. `★`/`☆` toggles favorite directly from the row. The existing transport controls and 6-stem mixer stay exactly as they are today, now driven by whichever library entry is selected/playing rather than "the last file you picked" — `FileAudioSource.loadFile()` is unchanged; the library just decides which hash/path to hand it.

## Error Handling

- **Folder scan errors** (unreadable file, permission denied): skip that file, continue the scan, don't abort the whole folder add.
- **Tag-read failure** on an otherwise-valid audio file: fall back to filename-derived metadata rather than failing to add the song.
- **Per-song processing failure**: see queue step 7 above — isolated, non-blocking, visible per-row.
- **Library index corruption/missing** (`library.json` unreadable): start from an empty library rather than crashing, same defensive pattern as `settings-store.js`'s `load()`.

## Testing

- **Unit tests** (`node --test`, pure logic, no Electron): feat-artist regex extraction (various "feat./ft./featuring/(with …)" phrasings, and titles with none); sort comparators for each field; filter matching (text search across title/artist/album/featuredArtists, favorites-only, genre); the hash-keyed upsert logic (adding a new entry, updating an existing one by hash, not creating duplicates); queue reorder-on-click logic (front-of-remaining-queue insertion, no-op if the song is already mid-processing or already at the front).
- **Manual end-to-end verification**: load a real folder of tagged audio files, confirm the list populates immediately with correct metadata, confirm sequential background processing with correct progress/queue-position display, confirm clicking an unprocessed song jumps the queue, confirm favorites/sort/filter/search all work, confirm a song processed via folder-load is recognized instantly if also picked via "Load File…" (and vice versa), confirm quitting and relaunching the app preserves the full library (metadata, favorites, play counts) with no reprocessing needed.

## Scope

**In scope:**
- Load Folder (recursive scan, eager sequential background processing, per-file failure isolation)
- Load File kept alongside Load Folder, both feeding the same library index
- Metadata extraction (title/artist/album/genre via embedded tags, filename fallback, feat-parsing)
- Persistent library index surviving restarts, with favorites, play count, last played
- Sort (6 fields) and filter (search + favorites + genre)
- Remove from library (index-only, cache untouched)
- Processing queue with progress/position reporting and click-to-jump-queue

**Out of scope (this spec):**
- Playlists (deliberate follow-up spec, built once this library exists)
- Manual metadata editing in-app
- Album art
- Queue pause/cancel (only reordering; an in-flight separation always runs to completion or failure)
- Multi-library / multi-folder-source management beyond "the one library everything gets added to"
