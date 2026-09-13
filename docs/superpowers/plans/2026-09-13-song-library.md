# Song Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, browsable song library on top of the existing file-playback stem-separation feature: "Load Folder…" (recursive scan, eager sequential background processing, queue-jump on click), metadata read from embedded tags (title/artist/album/genre, with "feat." parsed as a secondary searchable artist), favorites, play tracking, and sort/filter — so the app works like a normal music library instead of a one-file-at-a-time picker.

**Architecture:** The library index (`library.json`, one JSON array keyed by the same content hash the stem cache already uses) and folder scanning/tag-reading live in the main process (`fs`/`music-metadata` access). The **processing queue itself lives in the renderer**, not the main process: it's a plain sequential loop that calls the *existing, unchanged* single-file IPC methods (`checkStemCache`/`readAudioFileBytes`/`processAudioPcm`) one hash at a time, exactly the way a manual "Load File…" click already does today. This is a deliberate refinement of the design spec's diagram (which showed the queue in "main") — main.js gains no new queue/ordering state at all, it just keeps doing one-song-at-a-time processing exactly as before; the renderer decides *which* song to hand it next and in what order. Queue-jump is a plain in-memory array reorder.

**Tech Stack:** `music-metadata` (new dependency, ESM-only as of v8+ — must be loaded via dynamic `import()` from this project's CommonJS main-process files, never `require()`). Everything else reuses what the file-playback feature already built (`onnxruntime-node`, Web Audio, the existing stem-cache/model/processor/wav modules).

**Spec:** `docs/superpowers/specs/2026-09-13-song-library-design.md`

## Global Constraints

- Library storage: `userData/library.json`, one JSON array, entries keyed by the same sha256 content hash as `stem-cache.js` — a song processed via "Load File…" and later found again via "Load Folder…" (or vice versa) is the same entry, never duplicated, never reprocessed.
- Processing is never parallel: exactly one song's separation runs at a time, anywhere in the app (a single song's separation can use several GB of memory, measured ~5.7GB peak for a 3.5-minute track in the prior feature).
- `music-metadata` is loaded via dynamic `import()`, not `require()` — it is a pure-ESM package and `require()` throws `ERR_REQUIRE_ESM`.
- This plan must not change the behavior of Live (WASAPI) mode, or of the existing single-file IPC handlers (`pick-audio-file`, `check-stem-cache`, `read-audio-file-bytes`, `process-audio-pcm`, `read-stem-audio`, `read-stem-cache-size`, `clear-stem-cache`) — it only adds new ones alongside them.
- Playlists are explicitly out of scope for this plan (separate follow-up spec).
- Files with pre-existing unrelated uncommitted content in this repo (confirmed via `git status`/`git diff` before each task that touches them) must never have that content swept into this plan's commits — use the `git hash-object`/`git update-index --cacheinfo` technique documented in the prior feature's Task 5/6/9/10 reports whenever `git add -p` can't cleanly separate hunks.

---

## Task 1: Featured-artist parsing (pure)

**Files:**
- Create: `src/main/feat-parser.js`
- Test: `test/feat-parser.test.mjs`

**Interfaces:**
- Produces: `extractFeaturedArtists(title: string): string[]`

- [ ] **Step 1: Write the failing tests**

```js
// test/feat-parser.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeaturedArtists } from '../src/main/feat-parser.js';

describe('extractFeaturedArtists', () => {
  it('returns an empty array when there is no feat mention', () => {
    assert.deepEqual(extractFeaturedArtists('Plain Song Title'), []);
  });

  it('returns an empty array for an empty/null title', () => {
    assert.deepEqual(extractFeaturedArtists(''), []);
    assert.deepEqual(extractFeaturedArtists(null), []);
  });

  it('parses "(feat. Artist)"', () => {
    assert.deepEqual(extractFeaturedArtists('Song Name (feat. Artist B)'), ['Artist B']);
  });

  it('parses "feat. Artist" with no parens', () => {
    assert.deepEqual(extractFeaturedArtists('Song Name feat. Artist B'), ['Artist B']);
  });

  it('parses "ft." case-insensitively', () => {
    assert.deepEqual(extractFeaturedArtists('Song Name FT. Artist B'), ['Artist B']);
  });

  it('parses "featuring"', () => {
    assert.deepEqual(extractFeaturedArtists('Song Name featuring Artist B'), ['Artist B']);
  });

  it('parses "(with Artist)"', () => {
    assert.deepEqual(extractFeaturedArtists('Song Name (with Artist B)'), ['Artist B']);
  });

  it('splits multiple featured artists on "&"', () => {
    assert.deepEqual(extractFeaturedArtists('Song Name (feat. Artist B & Artist C)'), ['Artist B', 'Artist C']);
  });

  it('splits multiple featured artists on ","', () => {
    assert.deepEqual(extractFeaturedArtists('Song Name (feat. Artist B, Artist C)'), ['Artist B', 'Artist C']);
  });

  it('does not match "ft" embedded inside an ordinary word', () => {
    assert.deepEqual(extractFeaturedArtists('Drift Away'), []);
    assert.deepEqual(extractFeaturedArtists('Swift Escape'), []);
  });

  it('does not match a bare "with" that is not inside parens/brackets', () => {
    assert.deepEqual(extractFeaturedArtists('Stuck With You'), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/feat-parser.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `feat-parser.js`**

```js
// Two branches, not one shared alternation:
//   1. "with" must be inside parens/brackets -- it's too common an ordinary
//      English word (e.g. "Stuck With You") to safely treat as a features
//      marker unless it's bracket-confined, which also matches how the
//      design spec itself writes the example ("(with ...)", parens included).
//   2. feat/ft/featuring may appear bare (no parens needed, e.g. "Song feat.
//      Artist") but must sit at a word boundary -- without `\b`, "ft" matches
//      the literal substring inside ordinary words like "Drift" or "Swift".
const FEAT_PATTERN = /(?:[([]\s*with\s+([^()[\]]+?)\s*[)\]]$|[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+?)\s*[)\]]?$)/i;

function extractFeaturedArtists(title) {
  if (!title) return [];
  const match = title.match(FEAT_PATTERN);
  if (!match) return [];
  const namesPart = match[1] || match[2];
  return namesPart
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

module.exports = { extractFeaturedArtists };
```

**Known, deliberately deferred limitation:** the trailing `$` anchor means a feat./with clause followed by something else at the very end of the title (e.g. `"Song (feat. Artist B) [Remix]"`) is not extracted at all (returns `[]`) rather than still finding "Artist B" — the spec doesn't explicitly require handling a trailing remix/live tag after the credit, and fixing it well (without reintroducing a false-positive risk) is a larger regex change than this pure-utility task warrants. Leave as-is; note it if it comes up in real use.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/feat-parser.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/feat-parser.js test/feat-parser.test.mjs
git commit -m "feat: add featured-artist parsing for song titles"
```

---

## Task 2: Library store (persistence)

**Files:**
- Create: `src/main/library-store.js`
- Test: `test/library-store.test.mjs`

**Interfaces:**
- Produces: `getLibraryPath(userDataPath): string`, `loadLibrary(userDataPath): Array<Entry>`, `saveLibrary(userDataPath, entries): void`, `upsertEntry(userDataPath, hash, fields): Entry`, `removeEntry(userDataPath, hash): void`, `setFavorite(userDataPath, hash, favorite): Entry`, `recordPlay(userDataPath, hash): Entry`, `markProcessed(userDataPath, hash, duration): Entry`, where `Entry = { hash, filePath, title, artist, album, genre, featuredArtists, duration, dateAdded, lastPlayed, playCount, favorite, processed }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/library-store.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadLibrary, saveLibrary, upsertEntry, removeEntry, setFavorite, recordPlay, markProcessed
} from '../src/main/library-store.js';

let userData;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'library-store-test-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('loadLibrary', () => {
  it('returns an empty array when no library file exists', () => {
    assert.deepEqual(loadLibrary(userData), []);
  });

  it('returns an empty array when the file is corrupt JSON', () => {
    fs.writeFileSync(path.join(userData, 'library.json'), 'not json{{{');
    assert.deepEqual(loadLibrary(userData), []);
  });
});

describe('upsertEntry', () => {
  it('creates a new entry with defaults when the hash is unknown', () => {
    const entry = upsertEntry(userData, 'hash1', { title: 'Song A', filePath: '/a.mp3' });
    assert.equal(entry.hash, 'hash1');
    assert.equal(entry.title, 'Song A');
    assert.equal(entry.favorite, false);
    assert.equal(entry.playCount, 0);
    assert.equal(entry.processed, false);
    assert.ok(entry.dateAdded);
  });

  it('updates an existing entry in place rather than duplicating it', () => {
    upsertEntry(userData, 'hash1', { title: 'Song A' });
    upsertEntry(userData, 'hash1', { title: 'Song A (renamed)' });
    const all = loadLibrary(userData);
    assert.equal(all.length, 1);
    assert.equal(all[0].title, 'Song A (renamed)');
  });

  it('persists across a fresh loadLibrary call', () => {
    upsertEntry(userData, 'hash1', { title: 'Song A' });
    const reloaded = loadLibrary(userData);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].title, 'Song A');
  });
});

describe('removeEntry', () => {
  it('removes only the matching entry', () => {
    upsertEntry(userData, 'hash1', { title: 'Song A' });
    upsertEntry(userData, 'hash2', { title: 'Song B' });
    removeEntry(userData, 'hash1');
    const all = loadLibrary(userData);
    assert.equal(all.length, 1);
    assert.equal(all[0].hash, 'hash2');
  });
});

describe('setFavorite / recordPlay / markProcessed', () => {
  it('setFavorite toggles the favorite flag and persists it', () => {
    upsertEntry(userData, 'hash1', { title: 'Song A' });
    setFavorite(userData, 'hash1', true);
    assert.equal(loadLibrary(userData)[0].favorite, true);
  });

  it('recordPlay increments playCount and sets lastPlayed', () => {
    upsertEntry(userData, 'hash1', { title: 'Song A' });
    recordPlay(userData, 'hash1');
    recordPlay(userData, 'hash1');
    const entry = loadLibrary(userData)[0];
    assert.equal(entry.playCount, 2);
    assert.ok(entry.lastPlayed);
  });

  it('markProcessed sets processed true and updates duration', () => {
    upsertEntry(userData, 'hash1', { title: 'Song A', duration: 0 });
    markProcessed(userData, 'hash1', 123.4);
    const entry = loadLibrary(userData)[0];
    assert.equal(entry.processed, true);
    assert.equal(entry.duration, 123.4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/library-store.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `library-store.js`**

```js
const fs = require('fs');
const path = require('path');

const DEFAULT_ENTRY = {
  filePath: '', title: '', artist: '', album: '', genre: '',
  featuredArtists: [], duration: 0, lastPlayed: null,
  playCount: 0, favorite: false, processed: false
};

function getLibraryPath(userDataPath) {
  return path.join(userDataPath, 'library.json');
}

function loadLibrary(userDataPath) {
  try {
    const raw = fs.readFileSync(getLibraryPath(userDataPath), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLibrary(userDataPath, entries) {
  fs.writeFileSync(getLibraryPath(userDataPath), JSON.stringify(entries, null, 2));
}

function upsertEntry(userDataPath, hash, fields) {
  const entries = loadLibrary(userDataPath);
  const existing = entries.find((e) => e.hash === hash);
  if (existing) {
    Object.assign(existing, fields);
  } else {
    entries.push({
      hash,
      ...DEFAULT_ENTRY,
      dateAdded: new Date().toISOString(),
      ...fields
    });
  }
  saveLibrary(userDataPath, entries);
  return entries.find((e) => e.hash === hash);
}

function removeEntry(userDataPath, hash) {
  const entries = loadLibrary(userDataPath).filter((e) => e.hash !== hash);
  saveLibrary(userDataPath, entries);
}

function setFavorite(userDataPath, hash, favorite) {
  return upsertEntry(userDataPath, hash, { favorite });
}

function recordPlay(userDataPath, hash) {
  const existing = loadLibrary(userDataPath).find((e) => e.hash === hash);
  const playCount = (existing?.playCount || 0) + 1;
  return upsertEntry(userDataPath, hash, { playCount, lastPlayed: new Date().toISOString() });
}

function markProcessed(userDataPath, hash, duration) {
  return upsertEntry(userDataPath, hash, { processed: true, duration });
}

module.exports = {
  getLibraryPath, loadLibrary, saveLibrary, upsertEntry, removeEntry,
  setFavorite, recordPlay, markProcessed
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/library-store.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/library-store.js test/library-store.test.mjs
git commit -m "feat: add persistent library index store"
```

---

## Task 3: Folder scanner (pure)

**Files:**
- Create: `src/main/folder-scanner.js`
- Test: `test/folder-scanner.test.mjs`

**Interfaces:**
- Produces: `scanFolder(folderPath: string): string[]` (absolute paths of every supported audio file found, recursively), `SUPPORTED_EXTENSIONS: Set<string>`.

- [ ] **Step 1: Write the failing tests**

```js
// test/folder-scanner.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanFolder } from '../src/main/folder-scanner.js';

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-scanner-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scanFolder', () => {
  it('finds supported audio files at the top level', () => {
    fs.writeFileSync(path.join(root, 'a.mp3'), '');
    fs.writeFileSync(path.join(root, 'notes.txt'), '');
    const found = scanFolder(root);
    assert.equal(found.length, 1);
    assert.ok(found[0].endsWith('a.mp3'));
  });

  it('recurses into subdirectories', () => {
    const sub = path.join(root, 'Artist', 'Album');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'song.flac'), '');
    const found = scanFolder(root);
    assert.equal(found.length, 1);
    assert.ok(found[0].endsWith(path.join('Artist', 'Album', 'song.flac')));
  });

  it('finds every supported extension', () => {
    for (const ext of ['.mp3', '.wav', '.flac', '.m4a', '.ogg']) {
      fs.writeFileSync(path.join(root, `song${ext}`), '');
    }
    fs.writeFileSync(path.join(root, 'cover.jpg'), '');
    const found = scanFolder(root);
    assert.equal(found.length, 5);
  });

  it('returns an empty array for an empty folder', () => {
    assert.deepEqual(scanFolder(root), []);
  });

  it('returns an empty array without throwing for a nonexistent path', () => {
    assert.deepEqual(scanFolder(path.join(root, 'does-not-exist')), []);
  });

  it('returns absolute paths even when given a relative folderPath', () => {
    fs.writeFileSync(path.join(root, 'a.mp3'), '');
    const relative = path.relative(process.cwd(), root);
    const found = scanFolder(relative);
    assert.equal(found.length, 1);
    assert.ok(path.isAbsolute(found[0]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/folder-scanner.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `folder-scanner.js`**

```js
const fs = require('fs');
const path = require('path');

const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg']);

function scanFolder(folderPath) {
  const results = [];
  // Resolve to absolute up front -- path.join preserves absoluteness from
  // here on for every entry pushed below, so a relative folderPath (the
  // interface's documented contract requires absolute paths out; Electron's
  // folder picker always returns one, but this makes it true unconditionally
  // rather than only by caller convention) doesn't leak into the results.
  const stack = [path.resolve(folderPath)];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

module.exports = { scanFolder, SUPPORTED_EXTENSIONS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/folder-scanner.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/folder-scanner.js test/folder-scanner.test.mjs
git commit -m "feat: add recursive folder scanner for supported audio files"
```

---

## Task 4: Metadata reader

**Files:**
- Create: `src/main/metadata-reader.js`
- Test: `test/metadata-reader.test.mjs`
- Modify: `package.json` (add `music-metadata` dependency)

**Interfaces:**
- Consumes: `extractFeaturedArtists` (Task 1).
- Produces: `readMetadata(filePath: string): Promise<{ title, artist, album, genre, duration, featuredArtists }>`.

- [ ] **Step 1: Add the dependency**

Run: `npm install music-metadata@^11.15.0`

Expected: `package.json`'s `dependencies` gains `music-metadata`; `node_modules/music-metadata` exists.

**Note:** `music-metadata` v8+ is a pure ESM package. `require('music-metadata')` from this project's CommonJS files throws `ERR_REQUIRE_ESM` — it must be loaded via dynamic `import('music-metadata')` instead (this works fine from a CommonJS file; Node resolves it at runtime).

- [ ] **Step 2: Write the failing test**

```js
// test/metadata-reader.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readMetadata } from '../src/main/metadata-reader.js';
import { encodeWavStereo } from '../src/main/stem-wav.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-reader-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readMetadata', () => {
  it('falls back to the filename as title for an untagged file', async () => {
    const left = new Float32Array(4410);
    const right = new Float32Array(4410);
    const wav = encodeWavStereo(left, right, 44100);
    const filePath = path.join(dir, 'My Untagged Song.wav');
    fs.writeFileSync(filePath, wav);

    const meta = await readMetadata(filePath);
    assert.equal(meta.title, 'My Untagged Song');
    assert.equal(meta.artist, 'Unknown Artist');
    assert.equal(meta.album, '');
    assert.equal(meta.genre, '');
    assert.deepEqual(meta.featuredArtists, []);
  });

  it('extracts featured artists from a filename-derived title', async () => {
    const left = new Float32Array(4410);
    const right = new Float32Array(4410);
    const wav = encodeWavStereo(left, right, 44100);
    const filePath = path.join(dir, 'Song Name (feat. Artist B).wav');
    fs.writeFileSync(filePath, wav);

    const meta = await readMetadata(filePath);
    assert.deepEqual(meta.featuredArtists, ['Artist B']);
  });

  it('returns filename-derived metadata without throwing for a nonexistent file', async () => {
    const meta = await readMetadata(path.join(dir, 'missing.mp3'));
    assert.equal(meta.title, 'missing');
    assert.equal(meta.artist, 'Unknown Artist');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/metadata-reader.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `metadata-reader.js`**

```js
const path = require('path');
const { extractFeaturedArtists } = require('./feat-parser');

async function readMetadata(filePath) {
  const filename = path.basename(filePath, path.extname(filePath));
  let title = filename;
  let artist = 'Unknown Artist';
  let album = '';
  let genre = '';
  let duration = 0;

  try {
    const mm = await import('music-metadata');
    const { common, format } = await mm.parseFile(filePath);
    if (common.title) title = common.title;
    if (common.artist) artist = common.artist;
    if (common.album) album = common.album;
    if (common.genre && common.genre.length > 0) genre = common.genre[0];
    if (format.duration) duration = format.duration;
  } catch {
    // Unreadable tags, unsupported format, or missing file -- fall back
    // to the filename-derived metadata already set above.
  }

  return {
    title, artist, album, genre, duration,
    featuredArtists: extractFeaturedArtists(title)
  };
}

module.exports = { readMetadata };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/metadata-reader.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/metadata-reader.js test/metadata-reader.test.mjs
git commit -m "feat: add embedded-tag metadata reader with filename fallback"
```

Note: `package.json` currently has unrelated pre-existing uncommitted content in this repo (confirmed via `git status` — same situation the prior feature's Task 1 hit with `onnxruntime-node`). Because `npm install` reads whatever's on disk, running it against a dirty `package.json` can regenerate `package-lock.json` from that dirty state too, silently pulling unrelated fields into the lockfile even if `package.json` itself is committed cleanly — this exact failure happened once already in this codebase and was caught by a task review, then fixed by regenerating the lockfile via `npm install --package-lock-only` against the already-clean committed `package.json`. After running `npm install music-metadata`, explicitly verify: `git diff <base-commit-before-this-task>..HEAD -- package-lock.json` contains only `music-metadata`/its transitive-dependency entries — no unrelated `devDependencies`/`name`/`scripts` changes — before considering this task done. Fix the same way (regenerate the lockfile from the clean committed `package.json`) if it doesn't.

---

## Task 5: Main-process IPC wiring for the library

**Files:**
- Modify: `src/main/main.js`

**Interfaces:**
- Consumes: `library-store.js` (all exports, Task 2), `folder-scanner.js` (`scanFolder`, Task 3), `metadata-reader.js` (`readMetadata`, Task 4), `stem-cache.js` (`hashFile`, `getCacheDir`, `isCached` — already exists from the prior feature).
- Produces (new IPC channels, all `ipcMain.handle` unless noted): `pick-folder` → `Promise<string|null>`; `scan-folder(folderPath)` → `Promise<Array<Entry>>` (the full updated library after scanning, hashing, tagging, and upserting every file found — emits `folder-scan-progress` events `{ current, total, fileName }` via `webContents.send` while scanning); `get-library` → `Promise<Array<Entry>>`; `add-single-file-to-library(filePath)` → `Promise<Array<Entry>>` (same shape as `scan-folder`'s return, for consistency); `set-favorite(hash, favorite)` → `Promise<Entry>`; `remove-library-entry(hash)` → `Promise<void>`; `record-play(hash)` → `Promise<Entry>`; `mark-library-processed(hash, duration)` → `Promise<Entry>`.

- [ ] **Step 1: Add the IPC handlers**

At the top of `main.js`, alongside the existing requires:

```js
const libraryStore = require('./library-store');
const { scanFolder } = require('./folder-scanner');
const { readMetadata } = require('./metadata-reader');
```

Inside `createWindow()`, alongside the existing IPC handlers:

```js
  ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  async function addFileToLibrary(filePath) {
    const hash = await stemCache.hashFile(filePath);
    const cacheDir = stemCache.getCacheDir(app.getPath('userData'), hash);
    const processed = stemCache.isCached(cacheDir);
    const meta = await readMetadata(filePath);
    return libraryStore.upsertEntry(app.getPath('userData'), hash, {
      filePath, ...meta, processed
    });
  }

  ipcMain.handle('scan-folder', async (event, folderPath) => {
    const files = scanFolder(folderPath);
    for (let i = 0; i < files.length; i++) {
      await addFileToLibrary(files[i]);
      event.sender.send('folder-scan-progress', {
        current: i + 1, total: files.length, fileName: path.basename(files[i])
      });
    }
    return libraryStore.loadLibrary(app.getPath('userData'));
  });

  ipcMain.handle('get-library', async () => {
    return libraryStore.loadLibrary(app.getPath('userData'));
  });

  ipcMain.handle('add-single-file-to-library', async (_event, filePath) => {
    await addFileToLibrary(filePath);
    return libraryStore.loadLibrary(app.getPath('userData'));
  });

  ipcMain.handle('set-favorite', async (_event, hash, favorite) => {
    return libraryStore.setFavorite(app.getPath('userData'), hash, favorite);
  });

  ipcMain.handle('remove-library-entry', async (_event, hash) => {
    libraryStore.removeEntry(app.getPath('userData'), hash);
  });

  ipcMain.handle('record-play', async (_event, hash) => {
    return libraryStore.recordPlay(app.getPath('userData'), hash);
  });

  ipcMain.handle('mark-library-processed', async (_event, hash, duration) => {
    return libraryStore.markProcessed(app.getPath('userData'), hash, duration);
  });
```

`main.js` already has `path` and `stemCache` (named `stemCache` in the existing requires from the prior feature — confirm the exact local variable name already in the file via `require('./stem-cache')` and reuse it; do not add a second require under a different name).

- [ ] **Step 2: Manual verification**

Run: `npm start`, confirm the app launches with no errors from the new requires/handlers. Since preload isn't updated until Task 6, verify via the main-process console only at this stage.

- [ ] **Step 3: Commit**

```bash
git add src/main/main.js
git commit -m "feat: wire library IPC handlers into main process"
```

Check `git status`/`git diff HEAD -- src/main/main.js` before staging — this file has pre-existing unrelated uncommitted content in this repo (confirmed in the prior feature's Tasks 5/9); stage/commit only this task's additions, using the `git hash-object`/`update-index --cacheinfo` technique from those tasks' reports if `git add -p` can't cleanly separate them.

---

## Task 6: Preload bridge for the library

**Files:**
- Modify: `src/main/preload.js`

**Interfaces:**
- Produces (on `window.electronAPI`): `pickFolder()`, `scanFolder(folderPath)`, `onFolderScanProgress(callback)`, `getLibrary()`, `addSingleFileToLibrary(filePath)`, `setFavorite(hash, favorite)`, `removeLibraryEntry(hash)`, `recordPlay(hash)`, `markLibraryProcessed(hash, duration)`.

- [ ] **Step 1: Add the new bridge methods**

```js
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  onFolderScanProgress: (callback) => { folderScanProgressCallback = callback; },
  getLibrary: () => ipcRenderer.invoke('get-library'),
  addSingleFileToLibrary: (filePath) => ipcRenderer.invoke('add-single-file-to-library', filePath),
  setFavorite: (hash, favorite) => ipcRenderer.invoke('set-favorite', hash, favorite),
  removeLibraryEntry: (hash) => ipcRenderer.invoke('remove-library-entry', hash),
  recordPlay: (hash) => ipcRenderer.invoke('record-play', hash),
  markLibraryProcessed: (hash, duration) => ipcRenderer.invoke('mark-library-processed', hash, duration),
```

Add these inside the existing `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, alongside the file-playback bridge methods already there.

And, following the same single-persistent-listener pattern already used for `stem-progress` (to avoid stacking a new `ipcRenderer.on` per call), add near that existing listener:

```js
let folderScanProgressCallback = null;
ipcRenderer.on('folder-scan-progress', (_event, data) => {
  if (folderScanProgressCallback) folderScanProgressCallback(data);
});
```

- [ ] **Step 2: Manual verification**

Run: `npm start`, open DevTools console, run `await window.electronAPI.getLibrary()`.
Expected: returns `[]` (empty array, no errors, no songs added yet).

- [ ] **Step 3: Commit**

```bash
git add src/main/preload.js
git commit -m "feat: expose library IPC in preload bridge"
```

Check `git status`/`git diff HEAD -- src/main/preload.js` before staging — this file has pre-existing unrelated uncommitted content; stage/commit only this task's additions.

---

## Task 7: Renderer queue primitives (pure)

**Files:**
- Create: `src/renderer/audio/processing-queue.js`
- Create: `src/renderer/audio/waiter-registry.js`
- Test: `test/processing-queue.test.mjs`
- Test: `test/waiter-registry.test.mjs`

**Interfaces:**
- Produces: `class ProcessingQueue` with `enqueue(hash)`, `jumpToFront(hash)`, `next(): string|null`, `remove(hash)`, `size: number` (getter), `isEmpty: boolean` (getter). `class WaiterRegistry` with `wait(key): Promise<any>`, `resolveAll(key, value)`, `rejectAll(key, err)`.

- [ ] **Step 1: Write the failing tests**

```js
// test/processing-queue.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessingQueue } from '../src/renderer/audio/processing-queue.js';

describe('ProcessingQueue', () => {
  it('dequeues in FIFO order', () => {
    const q = new ProcessingQueue();
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    assert.equal(q.next(), 'a');
    assert.equal(q.next(), 'b');
    assert.equal(q.next(), 'c');
    assert.equal(q.next(), null);
  });

  it('does not enqueue the same hash twice', () => {
    const q = new ProcessingQueue();
    q.enqueue('a'); q.enqueue('a');
    assert.equal(q.size, 1);
  });

  it('jumpToFront moves an existing mid-queue item to the front', () => {
    const q = new ProcessingQueue();
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    q.jumpToFront('c');
    assert.equal(q.next(), 'c');
    assert.equal(q.next(), 'a');
    assert.equal(q.next(), 'b');
  });

  it('jumpToFront on a not-yet-enqueued hash adds it at the front', () => {
    const q = new ProcessingQueue();
    q.enqueue('a');
    q.jumpToFront('z');
    assert.equal(q.next(), 'z');
    assert.equal(q.next(), 'a');
  });

  it('remove takes a hash out without disturbing the order of the rest', () => {
    const q = new ProcessingQueue();
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    q.remove('b');
    assert.equal(q.next(), 'a');
    assert.equal(q.next(), 'c');
  });

  it('isEmpty reflects queue state', () => {
    const q = new ProcessingQueue();
    assert.equal(q.isEmpty, true);
    q.enqueue('a');
    assert.equal(q.isEmpty, false);
    q.next();
    assert.equal(q.isEmpty, true);
  });
});
```

```js
// test/waiter-registry.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WaiterRegistry } from '../src/renderer/audio/waiter-registry.js';

describe('WaiterRegistry', () => {
  it('resolves all waiters registered for the same key with the same value', async () => {
    const reg = new WaiterRegistry();
    const p1 = reg.wait('hash1');
    const p2 = reg.wait('hash1');
    reg.resolveAll('hash1', { title: 'done' });
    assert.deepEqual(await p1, { title: 'done' });
    assert.deepEqual(await p2, { title: 'done' });
  });

  it('rejects all waiters registered for the same key with the same error', async () => {
    const reg = new WaiterRegistry();
    const p1 = reg.wait('hash1');
    reg.rejectAll('hash1', new Error('boom'));
    await assert.rejects(p1, /boom/);
  });

  it('resolving a key with no waiters is a no-op', () => {
    const reg = new WaiterRegistry();
    assert.doesNotThrow(() => reg.resolveAll('nobody-waiting', 'value'));
  });

  it('does not resolve waiters registered for a different key', async () => {
    const reg = new WaiterRegistry();
    const p1 = reg.wait('hash1');
    reg.resolveAll('hash2', 'wrong');
    reg.resolveAll('hash1', 'right');
    assert.equal(await p1, 'right');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/processing-queue.test.mjs test/waiter-registry.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `processing-queue.js`**

```js
export class ProcessingQueue {
  constructor() {
    this.pending = [];
  }

  enqueue(hash) {
    if (!this.pending.includes(hash)) this.pending.push(hash);
  }

  jumpToFront(hash) {
    const idx = this.pending.indexOf(hash);
    if (idx > 0) {
      this.pending.splice(idx, 1);
      this.pending.unshift(hash);
    } else if (idx === -1) {
      this.pending.unshift(hash);
    }
  }

  next() {
    return this.pending.shift() || null;
  }

  remove(hash) {
    this.pending = this.pending.filter((h) => h !== hash);
  }

  get size() {
    return this.pending.length;
  }

  get isEmpty() {
    return this.pending.length === 0;
  }
}
```

- [ ] **Step 4: Write `waiter-registry.js`**

```js
export class WaiterRegistry {
  constructor() {
    this.waiters = new Map();
  }

  wait(key) {
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(key) || [];
      list.push({ resolve, reject });
      this.waiters.set(key, list);
    });
  }

  resolveAll(key, value) {
    const list = this.waiters.get(key) || [];
    this.waiters.delete(key);
    for (const { resolve } of list) resolve(value);
  }

  rejectAll(key, err) {
    const list = this.waiters.get(key) || [];
    this.waiters.delete(key);
    for (const { reject } of list) reject(err);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/processing-queue.test.mjs test/waiter-registry.test.mjs`
Expected: PASS (6 + 4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/audio/processing-queue.js src/renderer/audio/waiter-registry.js test/processing-queue.test.mjs test/waiter-registry.test.mjs
git commit -m "feat: add renderer-side processing queue and waiter registry primitives"
```

---

## Task 8: Library sort/filter (pure)

**Files:**
- Create: `src/renderer/audio/library-sort-filter.js`
- Test: `test/library-sort-filter.test.mjs`

**Interfaces:**
- Produces: `sortEntries(entries, field, direction): Array<Entry>`, `filterEntries(entries, { searchText, favoritesOnly, genre }): Array<Entry>`.

- [ ] **Step 1: Write the failing tests**

```js
// test/library-sort-filter.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sortEntries, filterEntries } from '../src/renderer/audio/library-sort-filter.js';

const sample = [
  { hash: '1', title: 'Beta', artist: 'Artist A', album: 'Album X', genre: 'Rock', featuredArtists: [], duration: 200, playCount: 3, favorite: false, dateAdded: '2026-01-02T00:00:00Z', lastPlayed: null },
  { hash: '2', title: 'Alpha', artist: 'Artist B', album: 'Album Y', genre: 'Pop', featuredArtists: ['Guest Star'], duration: 100, playCount: 10, favorite: true, dateAdded: '2026-01-01T00:00:00Z', lastPlayed: '2026-01-05T00:00:00Z' },
  { hash: '3', title: 'Gamma', artist: 'Artist A', album: 'Album X', genre: 'Rock', featuredArtists: [], duration: 300, playCount: 1, favorite: false, dateAdded: '2026-01-03T00:00:00Z', lastPlayed: null }
];

describe('sortEntries', () => {
  it('sorts by title ascending', () => {
    const sorted = sortEntries(sample, 'title', 'asc');
    assert.deepEqual(sorted.map((e) => e.title), ['Alpha', 'Beta', 'Gamma']);
  });

  it('sorts by title descending', () => {
    const sorted = sortEntries(sample, 'title', 'desc');
    assert.deepEqual(sorted.map((e) => e.title), ['Gamma', 'Beta', 'Alpha']);
  });

  it('sorts by playCount ascending', () => {
    const sorted = sortEntries(sample, 'playCount', 'asc');
    assert.deepEqual(sorted.map((e) => e.hash), ['3', '1', '2']);
  });

  it('sorts by lastPlayed ascending, treating a null lastPlayed as earliest (epoch)', () => {
    const sorted = sortEntries(sample, 'lastPlayed', 'asc');
    // hash1 and hash3 have null lastPlayed (treated as earliest); hash2 has
    // a real timestamp, so it sorts last in ascending order.
    assert.equal(sorted[sorted.length - 1].hash, '2');
  });

  it('does not mutate the original array', () => {
    const copy = [...sample];
    sortEntries(sample, 'title', 'asc');
    assert.deepEqual(sample, copy);
  });
});

describe('filterEntries', () => {
  it('matches search text against title', () => {
    const result = filterEntries(sample, { searchText: 'alpha' });
    assert.equal(result.length, 1);
    assert.equal(result[0].hash, '2');
  });

  it('matches search text against featuredArtists', () => {
    const result = filterEntries(sample, { searchText: 'guest star' });
    assert.equal(result.length, 1);
    assert.equal(result[0].hash, '2');
  });

  it('filters to favorites only', () => {
    const result = filterEntries(sample, { favoritesOnly: true });
    assert.equal(result.length, 1);
    assert.equal(result[0].hash, '2');
  });

  it('filters by exact genre', () => {
    const result = filterEntries(sample, { genre: 'Pop' });
    assert.equal(result.length, 1);
    assert.equal(result[0].hash, '2');
  });

  it('combines multiple filters', () => {
    const result = filterEntries(sample, { genre: 'Rock', searchText: 'gamma' });
    assert.equal(result.length, 1);
    assert.equal(result[0].hash, '3');
  });

  it('returns everything when no filters are set', () => {
    assert.equal(filterEntries(sample, {}).length, 3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/library-sort-filter.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `library-sort-filter.js`**

```js
function compareEntries(a, b, field, direction) {
  let result;
  switch (field) {
    case 'title':
    case 'artist':
    case 'album':
      result = a[field].localeCompare(b[field]);
      break;
    case 'dateAdded':
    case 'lastPlayed':
      result = (a[field] ? new Date(a[field]).getTime() : 0) - (b[field] ? new Date(b[field]).getTime() : 0);
      break;
    case 'playCount':
    case 'duration':
      result = a[field] - b[field];
      break;
    default:
      result = 0;
  }
  return direction === 'desc' ? -result : result;
}

export function sortEntries(entries, field, direction) {
  return [...entries].sort((a, b) => compareEntries(a, b, field, direction));
}

export function filterEntries(entries, { searchText = '', favoritesOnly = false, genre = '' } = {}) {
  const needle = searchText.trim().toLowerCase();
  return entries.filter((e) => {
    if (favoritesOnly && !e.favorite) return false;
    if (genre && e.genre !== genre) return false;
    if (needle) {
      const haystack = [e.title, e.artist, e.album, ...(e.featuredArtists || [])].join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/library-sort-filter.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/audio/library-sort-filter.js test/library-sort-filter.test.mjs
git commit -m "feat: add library sort and filter functions"
```

---

## Task 9: LibraryManager (renderer orchestrator)

**Files:**
- Create: `src/renderer/audio/library-manager.js`

**Interfaces:**
- Consumes: `window.electronAPI.{getLibrary, scanFolder, addSingleFileToLibrary, onFolderScanProgress, onStemProgress, checkStemCache, readAudioFileBytes, processAudioPcm, markLibraryProcessed, setFavorite, removeLibraryEntry, recordPlay}` (Task 6 + prior feature), `ProcessingQueue`, `WaiterRegistry` (Task 7).
- Produces: `class LibraryManager` with constructor `({ onLibraryChanged, onQueueProgress })` and methods `loadLibrary(): Promise<void>`, `addFolder(folderPath): Promise<void>`, `addFile(filePath): Promise<Entry|undefined>`, `playWhenReady(hash): Promise<Entry>` (jumps the queue if needed, resolves once that hash is processed — resolves immediately if already processed), `setFavorite(hash, favorite): Promise<void>`, `removeEntry(hash): Promise<void>`, `recordPlay(hash): Promise<void>`, and a readable `entries` array kept in sync via the `onLibraryChanged` callback.

- [ ] **Step 1: Write `library-manager.js`**

```js
import { ProcessingQueue } from './processing-queue.js';
import { WaiterRegistry } from './waiter-registry.js';

export class LibraryManager {
  constructor({ onLibraryChanged, onQueueProgress }) {
    this.entries = [];
    this.queue = new ProcessingQueue();
    this.waiters = new WaiterRegistry();
    this.processing = false;
    this.onLibraryChanged = onLibraryChanged;
    this.onQueueProgress = onQueueProgress;
    this.audioContext = null;
  }

  async loadLibrary() {
    this.entries = await window.electronAPI.getLibrary();
    this.onLibraryChanged(this.entries);
  }

  async addFolder(folderPath) {
    this.entries = await window.electronAPI.scanFolder(folderPath);
    this.onLibraryChanged(this.entries);
    for (const entry of this.entries) {
      if (!entry.processed) this.queue.enqueue(entry.hash);
    }
    this._runQueue();
  }

  async addFile(filePath) {
    this.entries = await window.electronAPI.addSingleFileToLibrary(filePath);
    this.onLibraryChanged(this.entries);
    const entry = this.entries.find((e) => e.filePath === filePath);
    if (entry && !entry.processed) {
      this.queue.enqueue(entry.hash);
      this._runQueue();
    }
    return entry;
  }

  async playWhenReady(hash) {
    const entry = this.entries.find((e) => e.hash === hash);
    if (!entry) throw new Error(`Unknown library entry: ${hash}`);
    if (entry.processed) return entry;

    this.queue.jumpToFront(hash);
    this._runQueue();
    return this.waiters.wait(hash);
  }

  async setFavorite(hash, favorite) {
    const updated = await window.electronAPI.setFavorite(hash, favorite);
    this._replaceEntry(updated);
  }

  async removeEntry(hash) {
    await window.electronAPI.removeLibraryEntry(hash);
    this.entries = this.entries.filter((e) => e.hash !== hash);
    this.queue.remove(hash);
    this.onLibraryChanged(this.entries);
  }

  async recordPlay(hash) {
    const updated = await window.electronAPI.recordPlay(hash);
    this._replaceEntry(updated);
  }

  _replaceEntry(updated) {
    if (!updated) return;
    this.entries = this.entries.map((e) => (e.hash === updated.hash ? updated : e));
    this.onLibraryChanged(this.entries);
  }

  async _runQueue() {
    if (this.processing) return;
    this.processing = true;

    if (!this.audioContext) this.audioContext = new AudioContext({ sampleRate: 44100 });

    while (!this.queue.isEmpty) {
      const hash = this.queue.next();
      const entry = this.entries.find((e) => e.hash === hash);
      if (!entry) continue;

      try {
        let finalDuration = entry.duration;
        const { cached, dir } = await window.electronAPI.checkStemCache(entry.filePath);

        if (!cached) {
          const fileBytes = await window.electronAPI.readAudioFileBytes(entry.filePath);
          const decoded = await this.audioContext.decodeAudioData(
            fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength)
          );
          finalDuration = decoded.duration;
          const left = decoded.getChannelData(0);
          const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);

          window.electronAPI.onStemProgress((percent) => {
            if (this.onQueueProgress) {
              this.onQueueProgress({ hash, title: entry.title, queueTotal: this.queue.size + 1, percent });
            }
          });

          await window.electronAPI.processAudioPcm({ hash, dir, left, right, sampleRate: decoded.sampleRate });
        }

        const updated = await window.electronAPI.markLibraryProcessed(hash, finalDuration);
        this._replaceEntry(updated);
        this.waiters.resolveAll(hash, updated);
      } catch (err) {
        console.error(`Failed to process "${entry.title}":`, err);
        this._replaceEntry({ ...entry, processed: false, error: err.message || String(err) });
        this.waiters.rejectAll(hash, err);
      }
    }

    this.processing = false;
  }
}
```

Note on reusing `checkStemCache(entry.filePath)`: this re-hashes the file even though the hash is already known from the library entry — a deliberate, small redundant cost to reuse the existing single-file IPC contract as-is rather than adding a parallel "check-by-hash" method. Hashing a typical song file is fast (streamed SHA256 over a few-to-tens-of-MB file).

This task has no automated tests of its own (it's an Electron/IPC integration orchestrator — `window.electronAPI` and `AudioContext` don't exist under `node --test`). It's covered by Task 10's manual end-to-end verification. Its two pure dependencies (`ProcessingQueue`, `WaiterRegistry`) already have full unit coverage from Task 7.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/audio/library-manager.js
git commit -m "feat: add LibraryManager orchestrating folder scans, the processing queue, and library mutations"
```

---

## Task 10: app.js integration (library manager wiring + play tracking)

**Files:**
- Modify: `src/renderer/app.js`

**Interfaces:**
- Consumes: `LibraryManager` (Task 9).
- Produces: `export const libraryManager` (a live `LibraryManager` instance), a currently-selected-song tracker, and a play-tracking check wired into the existing render loop.

- [ ] **Step 1: Instantiate `libraryManager` and track the current song**

Add near the existing `fileAudioSource` export (added in the prior feature's app.js integration):

```js
import { LibraryManager } from './audio/library-manager.js';
```

```js
let currentLibraryEntries = [];
let currentPlayingHash = null;
let playRecordedForCurrentHash = false;

export const libraryManager = new LibraryManager({
  onLibraryChanged: (entries) => { currentLibraryEntries = entries; },
  onQueueProgress: (info) => { /* consumed by panel.js in Task 11 via a small setter it defines there */ }
});

export function setCurrentPlayingHash(hash) {
  currentPlayingHash = hash;
  playRecordedForCurrentHash = false;
}
```

- [ ] **Step 2: Wire play-tracking into the existing render loop**

Find the `render()` function's existing `requestAnimationFrame(render);` line (added in the prior feature, near the bottom of `render()`). Immediately before it, add:

```js
  if (settings.source === 'file' && currentPlayingHash && !playRecordedForCurrentHash) {
    const duration = fileAudioSource.getDuration();
    const current = fileAudioSource.getCurrentTime();
    if (duration > 0 && (current >= duration || current / duration >= 0.5)) {
      playRecordedForCurrentHash = true;
      libraryManager.recordPlay(currentPlayingHash);
    }
  }
```

- [ ] **Step 3: Manual verification**

Run: `npm start`. Confirm the app launches with no console errors. This task should be behaviorally invisible until Task 11 wires the UI to actually call `libraryManager.addFolder`/`addFile`/`playWhenReady` and `setCurrentPlayingHash`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app.js
git commit -m "feat: wire LibraryManager into app.js with play-tracking"
```

Check `git status`/`git diff HEAD -- src/renderer/app.js` before staging — this file has pre-existing unrelated uncommitted content; stage/commit only this task's additions.

---

## Task 11: Library UI (song table, folder/file loading, favorites, sort/filter)

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/ui/panel.js`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `libraryManager`, `setCurrentPlayingHash` (Task 10), `fileAudioSource` (prior feature), `sortEntries`/`filterEntries` (Task 8), `window.electronAPI.onFolderScanProgress` (Task 6).

- [ ] **Step 1: Add markup to `index.html`**

Replace the prior feature's single-file section (`#file-controls`'s Load File button + progress area) with the library view — keep the existing `#file-progress`/`#file-error`/`#file-transport`/`#stem-mixer`/`#cache-info` elements from the prior feature as-is (they still drive playback of whichever song is currently selected), and add above them:

```html
<div class="panel-section" id="library-controls">
  <button id="load-file-btn">Load File…</button>
  <button id="load-folder-btn">Load Folder…</button>
  <input type="text" id="library-search" placeholder="Search title, artist, album…">
  <select id="library-genre-filter">
    <option value="">All Genres</option>
  </select>
  <label><input type="checkbox" id="library-favorites-only"> Favorites only</label>
</div>

<div class="panel-section" id="library-list-section">
  <table id="library-table">
    <thead>
      <tr>
        <th data-sort-field="title">Title</th>
        <th data-sort-field="artist">Artist</th>
        <th data-sort-field="album">Album</th>
        <th data-sort-field="genre">Genre</th>
        <th data-sort-field="duration">Duration</th>
        <th data-sort-field="playCount">Plays</th>
        <th>★</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="library-rows"></tbody>
  </table>
</div>

<div class="panel-section" id="queue-status" hidden>
  <span id="queue-status-label"></span>
</div>
```

(The existing `#file-progress`, `#file-error`, `#file-transport`, `#stem-mixer`, `#cache-info` markup from the prior feature stays exactly where it is, below this.)

- [ ] **Step 2: Wire it up in `panel.js`**

```js
// `fileAudioSource` is already imported on the existing
// `import { fileAudioSource, setSourceMode } from '../app.js';` line near the
// top of this file (from the prior feature) -- do NOT add it to this new
// import statement too, that would be a duplicate-binding SyntaxError.
import { libraryManager, setCurrentPlayingHash } from '../app.js';
import { sortEntries, filterEntries } from '../audio/library-sort-filter.js';

// loadFileBtn is already declared earlier in this file (prior feature's Task 10) --
// do not redeclare it here, panel.js is a single module scope. Just reuse it below.
const loadFolderBtn = document.getElementById('load-folder-btn');
const librarySearch = document.getElementById('library-search');
const libraryGenreFilter = document.getElementById('library-genre-filter');
const libraryFavoritesOnly = document.getElementById('library-favorites-only');
const libraryRows = document.getElementById('library-rows');
const queueStatus = document.getElementById('queue-status');
const queueStatusLabel = document.getElementById('queue-status-label');

let sortField = 'title';
let sortDirection = 'asc';

function renderLibraryRows() {
  const filtered = filterEntries(libraryManager.entries, {
    searchText: librarySearch.value,
    favoritesOnly: libraryFavoritesOnly.checked,
    genre: libraryGenreFilter.value
  });
  const sorted = sortEntries(filtered, sortField, sortDirection);

  const genres = [...new Set(libraryManager.entries.map((e) => e.genre).filter(Boolean))].sort();
  const currentGenreValue = libraryGenreFilter.value;
  libraryGenreFilter.innerHTML = '<option value="">All Genres</option>' +
    genres.map((g) => `<option value="${g}">${g}</option>`).join('');
  libraryGenreFilter.value = currentGenreValue;

  libraryRows.innerHTML = '';
  for (const entry of sorted) {
    const row = document.createElement('tr');
    row.dataset.hash = entry.hash;

    const statusIcon = entry.error ? '⚠' : entry.processed ? '✓' : '⏳';
    const minutes = Math.floor(entry.duration / 60);
    const seconds = Math.floor(entry.duration % 60).toString().padStart(2, '0');

    row.innerHTML = `
      <td class="library-title-cell">${entry.title}</td>
      <td>${entry.artist}</td>
      <td>${entry.album}</td>
      <td>${entry.genre}</td>
      <td>${minutes}:${seconds}</td>
      <td>${entry.playCount}</td>
      <td class="library-favorite-cell">${entry.favorite ? '★' : '☆'}</td>
      <td><button class="library-remove-btn" title="Remove from library">✕</button> <span class="library-status-icon">${statusIcon}</span></td>
    `;

    row.querySelector('.library-title-cell').addEventListener('click', async () => {
      // fileSeek/fileTransport/stemMixer are the same consts already declared
      // earlier in this file by the prior feature's panel.js wiring.
      const ready = await libraryManager.playWhenReady(entry.hash);
      setCurrentPlayingHash(ready.hash);
      await fileAudioSource.loadFile(ready.filePath, null);
      fileAudioSource.play();
      fileSeek.max = fileAudioSource.getDuration();
      fileTransport.hidden = false;
      stemMixer.hidden = false;
    });

    // Both setFavorite and removeEntry already trigger onLibraryChanged
    // internally (wired to renderLibraryRows below) -- no need to also
    // re-render here, that would just render twice per click.
    row.querySelector('.library-favorite-cell').addEventListener('click', (e) => {
      e.stopPropagation();
      libraryManager.setFavorite(entry.hash, !entry.favorite);
    });

    row.querySelector('.library-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      libraryManager.removeEntry(entry.hash);
    });

    libraryRows.appendChild(row);
  }
}

for (const th of document.querySelectorAll('#library-table th[data-sort-field]')) {
  th.addEventListener('click', () => {
    const field = th.dataset.sortField;
    if (sortField === field) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortField = field;
      sortDirection = 'asc';
    }
    renderLibraryRows();
  });
}

librarySearch.addEventListener('input', renderLibraryRows);
libraryGenreFilter.addEventListener('change', renderLibraryRows);
libraryFavoritesOnly.addEventListener('change', renderLibraryRows);

loadFolderBtn.addEventListener('click', async () => {
  const folderPath = await window.electronAPI.pickFolder();
  if (!folderPath) return;

  // Same busy-guard pattern as loadFileBtn -- prevents a double-click from
  // re-scanning (re-hashing/re-tagging every file) while a scan is already
  // running. The actual processing queue is separately protected against
  // concurrent draining by LibraryManager's own `this.processing` flag.
  loadFolderBtn.disabled = true;
  try {
    await libraryManager.addFolder(folderPath);
    renderLibraryRows();
  } finally {
    loadFolderBtn.disabled = false;
  }
});

window.electronAPI.onFolderScanProgress(({ current, total, fileName }) => {
  queueStatus.hidden = false;
  queueStatusLabel.textContent = `Scanning folder… ${current}/${total}: ${fileName}`;
});

const originalLibraryManagerOnLibraryChanged = libraryManager.onLibraryChanged;
libraryManager.onLibraryChanged = (entries) => {
  originalLibraryManagerOnLibraryChanged(entries);
  renderLibraryRows();
};

libraryManager.onQueueProgress = ({ hash, title, queueTotal, percent }) => {
  queueStatus.hidden = false;
  queueStatusLabel.textContent = `Processing "${title}" (${queueTotal} remaining) — ${Math.round(percent * 100)}%`;
  if (percent >= 1) {
    setTimeout(() => { if (libraryManager.queue.isEmpty) queueStatus.hidden = true; }, 500);
  }
};

libraryManager.loadLibrary();
```

The existing `loadFileBtn` click handler (from the prior feature) currently reads exactly as follows — find this block in `panel.js`:

```js
loadFileBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.pickAudioFile();
  if (!filePath) return;

  loadFileBtn.disabled = true;
  try {
    fileError.hidden = true;
    fileError.textContent = '';
    fileTransport.hidden = true;
    stemMixer.hidden = true;
    fileProgress.hidden = false;
    // First use may need to download the ~258MB separation model, which can
    // take several minutes with no per-byte progress available yet — show a
    // reassuring static message instead of leaving the user on "Checking
    // cache…" indistinguishable from a hang. Real progress (below) overwrites
    // this as soon as separation actually starts reporting percentages.
    fileProgressLabel.textContent = 'Checking cache… (first use downloads a ~258MB model — this may take several minutes)';
    fileProgressBar.value = 0;

    await fileAudioSource.loadFile(filePath, (percent) => {
      fileProgressLabel.textContent = `Separating stems… ${Math.round(percent * 100)}%`;
      fileProgressBar.value = percent * 100;
    });

    fileProgress.hidden = true;
    fileTransport.hidden = false;
    stemMixer.hidden = false;
    fileSeek.max = fileAudioSource.getDuration();
    await refreshCacheSize();
  } catch (err) {
    console.error('Failed to load/process audio file:', err);
    fileProgress.hidden = true;
    fileError.hidden = false;
    fileError.textContent = `Failed to process file: ${err.message || err}`;
  } finally {
    loadFileBtn.disabled = false;
  }
});
```

Replace it with this version — the only changes are the added `const { hash } = ...` line and the `addSingleFileToLibrary`/`setCurrentPlayingHash`/`renderLibraryRows()` calls after a successful load; every other line is unchanged:

```js
loadFileBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.pickAudioFile();
  if (!filePath) return;

  loadFileBtn.disabled = true;
  try {
    fileError.hidden = true;
    fileError.textContent = '';
    fileTransport.hidden = true;
    stemMixer.hidden = true;
    fileProgress.hidden = false;
    fileProgressLabel.textContent = 'Checking cache… (first use downloads a ~258MB model — this may take several minutes)';
    fileProgressBar.value = 0;

    await fileAudioSource.loadFile(filePath, (percent) => {
      fileProgressLabel.textContent = `Separating stems… ${Math.round(percent * 100)}%`;
      fileProgressBar.value = percent * 100;
    });

    fileProgress.hidden = true;
    fileTransport.hidden = false;
    stemMixer.hidden = false;
    fileSeek.max = fileAudioSource.getDuration();
    await refreshCacheSize();

    // Register this file with the library too, so it shows up as a row
    // (same small redundant re-hash tradeoff as LibraryManager's own
    // checkStemCache reuse — see Task 9's note).
    const { hash } = await window.electronAPI.checkStemCache(filePath);
    setCurrentPlayingHash(hash);
    const entries = await window.electronAPI.addSingleFileToLibrary(filePath);
    libraryManager.entries = entries;
    renderLibraryRows();
  } catch (err) {
    console.error('Failed to load/process audio file:', err);
    fileProgress.hidden = true;
    fileError.hidden = false;
    fileError.textContent = `Failed to process file: ${err.message || err}`;
  } finally {
    loadFileBtn.disabled = false;
  }
});
```

- [ ] **Step 3: Minimal styling in `styles.css`**

```css
#library-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85em;
}

#library-table th {
  cursor: pointer;
  text-align: left;
  padding: 4px 8px;
  user-select: none;
}

#library-table td {
  padding: 4px 8px;
}

#library-table tbody tr:hover {
  background: rgba(255, 255, 255, 0.05);
}

.library-favorite-cell {
  cursor: pointer;
}

#queue-status {
  font-size: 0.85em;
  opacity: 0.8;
  margin-top: 8px;
}
```

- [ ] **Step 4: Manual end-to-end verification**

Run: `npm start`. In the app:
1. Switch Source to "Audio File". Confirm the library table renders (empty initially).
2. Click "Load Folder…", pick a folder containing several tagged audio files (mix of formats if possible) plus at least one untagged file.
3. Confirm every file appears in the list immediately (before separation finishes), with correct title/artist/album/genre for tagged files and filename-derived title for the untagged one.
4. Confirm background processing proceeds one file at a time, with the queue-status line showing the current song and percent, and each row's status icon flipping from ⏳ to ✓ as it completes.
5. While processing is still working through the folder, click a song further back in the list — confirm it jumps to the front of the queue (processes next) and that clicking it also starts playback once that specific song becomes ready.
6. Toggle a favorite star on a couple of songs; confirm the "Favorites only" filter shows just those.
7. Use the search box to find a song by a featured artist parsed from its title (not its main artist).
8. Sort by each column; confirm ascending/descending toggles correctly.
9. Remove a song from the library; confirm it disappears from the list but re-adding the same file afterward is instant (cache untouched).
10. Quit and relaunch the app; confirm the whole library (metadata, favorites, play counts, processed status) is exactly as left, with no reprocessing.
11. Confirm the existing single "Load File…" flow, transport controls, and stem mixer still work exactly as before for whichever song is selected.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/ui/panel.js src/renderer/styles.css
git commit -m "feat: add library UI with folder loading, sort/filter, and favorites"
```

Check `git status`/`git diff HEAD` on all three files before staging — they have pre-existing unrelated uncommitted content in this repo; stage/commit only this task's additions.

---

## Plan Self-Review Notes

- **Spec coverage:** Load Folder with recursive scan + eager sequential background processing (Tasks 3, 9, 11), queue-jump on click (Tasks 7, 9, 11), metadata extraction with feat-parsing (Tasks 1, 4), persistent library index surviving restarts (Task 2), favorites/play-count/last-played (Tasks 2, 9, 10), sort/filter including genre and search (Tasks 8, 11), remove-from-library (Tasks 2, 9, 11), per-file failure isolation (Task 9). Playlists explicitly out of scope per the spec, not touched anywhere in this plan.
- **Deliberate implementation refinement flagged, not hidden:** the processing queue lives in the renderer rather than main process (stated up front in this plan's Architecture section) because PCM decoding requires Web Audio, which only exists in the renderer — main.js's existing single-file IPC surface is reused unchanged rather than duplicated.
- **Known ESM/CJS gotcha flagged, not hidden:** `music-metadata` is ESM-only and must be loaded via dynamic `import()`, called out explicitly in Task 4 rather than left as an assumed detail.
