# File Playback Mode with Cached Stem Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user load a local audio file, separate it into 6 stems (vocals/drums/bass/guitar/piano/other) via the `htdemucs_6s` ONNX model, cache the result to disk keyed by file hash, and play it back with per-stem mute/solo/volume — both audibly and driving the existing visualizers.

**Architecture:** Main process owns the ONNX model, the offline separation pipeline, and the disk cache (all Node-only concerns: `onnxruntime-node`, `fs`, `crypto`). Renderer owns file decoding (`AudioContext.decodeAudioData`), playback (`AudioBufferSourceNode` per stem), and mixing (per-stem `GainNode`s summed into one `AnalyserNode`). The `AnalyserNode`'s frequency data is fed into the exact same `mapFrequencyBands()`/visualizer pipeline the live WASAPI path already uses, via one shared `handleAudioData(data)` function in `app.js` — so no visualizer code changes at all.

One deliberate simplification vs. the spec's diagram: the live pipeline's `midData`/`sideData` split reflects true mid/side stereo processing done in the C++ addon. Reproducing that exactly in Web Audio would require a second, hand-built L-R difference signal graph. Instead, file mode uses a single mono-downmix `AnalyserNode` and passes the same array as both `midData` and `sideData`. All visualizers still work; stereo-width-specific modes (Mid/Side Split, Surround) just won't show true stereo width for file playback. This is called out here explicitly rather than left implicit.

**Tech Stack:** Electron (existing), `onnxruntime-node` (new dependency), Web Audio API (`AudioContext`, `AnalyserNode`, `AudioBufferSourceNode`, `GainNode` — all built into Chromium, no new dependency), Node `crypto`/`fs`/`https` (built-in).

**Spec:** `docs/superpowers/specs/2026-09-12-file-playback-stem-separation-design.md`

## Global Constraints

- Model: `htdemucs_6s` ONNX export from Hugging Face repo `StemSplitio/htdemucs-6s-onnx`, file `htdemucs_6s.onnx`, downloaded to `userData/models/htdemucs_6s.onnx`.
- Cache: `userData/stem-cache/<sha256-of-file>/{vocals,drums,bass,guitar,piano,other}.wav` + `meta.json`. A cache dir is only ever created via write-to-temp-then-rename (atomic) — never partially.
- Cache format: 16-bit PCM WAV, stereo, 44.1kHz.
- No new npm dependency beyond `onnxruntime-node@^1.29.0` — no ffmpeg, no fft library, no audio-decode library (Web Audio's built-in decoder covers mp3/wav/flac/m4a/ogg).
- Execution providers: `['dml', 'cpu']` with automatic fallback, matching the project's existing (deleted) ONNX pattern.
- This plan only adds File mode. It must not change the behavior of Live (WASAPI) mode, its IPC channels, or its existing "Normal/Vocal Highlight/Mid-Side/Surround" audio-mode logic.

---

## Task 1: Model download + session loading + I/O contract discovery

**Files:**
- Create: `src/main/stem-model.js`
- Create: `src/main/scripts/inspect-model.mjs` (throwaway discovery script, not shipped — deleted at the end of this task once its findings are recorded)

**Interfaces:**
- Produces: `ensureModel(userDataPath): Promise<string>` (resolves to the local model file path, downloading if missing), `loadSession(userDataPath): Promise<ort.InferenceSession>` (memoized — repeated calls return the same session), `MODEL_NAME`, `MODEL_URL`, `STEM_ORDER` (array of 6 stem name strings, in the exact order the model's output tensor produces them).

- [ ] **Step 1: Add the dependency**

Run: `npm install onnxruntime-node@^1.29.0`

Expected: `package.json` gains a `"dependencies"` block containing `onnxruntime-node`; `node_modules/onnxruntime-node` exists after install.

- [ ] **Step 2: Write `stem-model.js`**

```js
const path = require('path');
const fs = require('fs');
const https = require('https');

const MODEL_NAME = 'htdemucs_6s.onnx';
const MODEL_URL = 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s.onnx';

// Order confirmed in Step 3 below against the actual downloaded model's
// metadata and the StemSplitio model card. Do not change this without
// re-confirming — a wrong order silently mislabels stems (e.g. "guitar"
// fader actually controls piano).
const STEM_ORDER = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

function modelPath(userDataPath) {
  return path.join(userDataPath, 'models', MODEL_NAME);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const request = (reqUrl) => {
      https.get(reqUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    request(url);
  });
}

async function ensureModel(userDataPath) {
  const dest = modelPath(userDataPath);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10_000_000) return dest;
  await downloadFile(MODEL_URL, dest);
  return dest;
}

let sessionPromise = null;
async function loadSession(userDataPath) {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const dest = await ensureModel(userDataPath);
    const ort = require('onnxruntime-node');
    try {
      return await ort.InferenceSession.create(dest, { executionProviders: ['dml', 'cpu'] });
    } catch {
      return await ort.InferenceSession.create(dest, { executionProviders: ['cpu'] });
    }
  })();
  return sessionPromise;
}

module.exports = { MODEL_NAME, MODEL_URL, STEM_ORDER, modelPath, ensureModel, loadSession };
```

- [ ] **Step 3: Discover and confirm the model's real I/O contract**

Write `src/main/scripts/inspect-model.mjs`:

```js
import { ensureModel } from '../stem-model.js';
import ort from 'onnxruntime-node';
import os from 'os';
import path from 'path';

const fakeUserData = path.join(os.tmpdir(), 'stem-inspect');
const modelFile = await ensureModel(fakeUserData);
const session = await ort.InferenceSession.create(modelFile, { executionProviders: ['cpu'] });

console.log('inputNames:', session.inputNames);
console.log('outputNames:', session.outputNames);
for (const name of session.inputNames) {
  console.log('input', name, session.inputMetadata?.[name] ?? '(no metadata exposed)');
}
for (const name of session.outputNames) {
  console.log('output', name, session.outputMetadata?.[name] ?? '(no metadata exposed)');
}
```

(`stem-model.js` is CommonJS; either add a tiny `require`-based variant of this script, or run it via `node --experimental-vm-modules` / rename `stem-model.js`'s export usage to `require` — whichever is simplest given the Node version installed. The point of this script is only ever to print information once.)

Run: `node src/main/scripts/inspect-model.mjs` (this triggers the ~258MB download on first run — expect it to take a few minutes).

Record the answers to these questions (cross-check against `https://huggingface.co/StemSplitio/htdemucs-6s-onnx`'s README/model card):
1. Does the input tensor have a fixed or dynamic time-axis dimension? If fixed, what exact sample count?
2. Is there one output tensor shaped `[6, 2, samples]` (or similar, one call = all 6 stems), or 6 separate named outputs?
3. What order are the 6 stems in the output? Confirm or correct `STEM_ORDER` in `stem-model.js` based on this.

Update `STEM_ORDER` in `stem-model.js` if the discovered order differs from the placeholder above. Delete `src/main/scripts/inspect-model.mjs` once these are recorded (its job was only to inform this step and Task 4).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/main/stem-model.js
git commit -m "feat: add htdemucs_6s ONNX model download and session loading"
```

---

## Task 2: Stem cache (hashing, lookup, atomic writes)

**Files:**
- Create: `src/main/stem-cache.js`
- Test: `test/stem-cache.test.mjs`

**Interfaces:**
- Produces: `STEM_NAMES` (array of 6 strings, same set as `stem-model.js`'s `STEM_ORDER` but alphabetical — used for on-disk filenames), `hashFile(filePath): Promise<string>`, `getCacheRoot(userDataPath): string`, `getCacheDir(userDataPath, hash): string`, `isCached(cacheDir): boolean`, `getCacheSize(userDataPath): number` (bytes), `clearCache(userDataPath): void`, `writeAtomic(finalDir, (tempDir) => void): void`.

- [ ] **Step 1: Write the failing tests**

```js
// test/stem-cache.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  hashFile, getCacheRoot, getCacheDir, isCached, getCacheSize, clearCache, writeAtomic, STEM_NAMES
} from '../src/main/stem-cache.js';

let userData;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stem-cache-test-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('hashFile', () => {
  it('produces the same hash for the same content', async () => {
    const file = path.join(userData, 'a.txt');
    fs.writeFileSync(file, 'hello world');
    const h1 = await hashFile(file);
    const h2 = await hashFile(file);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // sha256 hex
  });

  it('produces different hashes for different content', async () => {
    const fileA = path.join(userData, 'a.txt');
    const fileB = path.join(userData, 'b.txt');
    fs.writeFileSync(fileA, 'hello world');
    fs.writeFileSync(fileB, 'goodbye world');
    assert.notEqual(await hashFile(fileA), await hashFile(fileB));
  });
});

describe('isCached', () => {
  it('is false when the directory does not exist', () => {
    assert.equal(isCached(path.join(userData, 'stem-cache', 'nope')), false);
  });

  it('is false when some stem files are missing', () => {
    const dir = getCacheDir(userData, 'abc123');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
    fs.writeFileSync(path.join(dir, 'vocals.wav'), '');
    assert.equal(isCached(dir), false);
  });

  it('is true when all 6 stem files and meta.json exist', () => {
    const dir = getCacheDir(userData, 'abc123');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
    for (const name of STEM_NAMES) fs.writeFileSync(path.join(dir, `${name}.wav`), '');
    assert.equal(isCached(dir), true);
  });
});

describe('writeAtomic', () => {
  it('creates the final directory with all written files on success', () => {
    const finalDir = getCacheDir(userData, 'xyz');
    writeAtomic(finalDir, (tempDir) => {
      fs.writeFileSync(path.join(tempDir, 'vocals.wav'), 'data');
    });
    assert.equal(fs.existsSync(path.join(finalDir, 'vocals.wav')), true);
  });

  it('leaves no trace of the final directory if the writer throws', () => {
    const finalDir = getCacheDir(userData, 'broken');
    assert.throws(() => {
      writeAtomic(finalDir, () => { throw new Error('boom'); });
    });
    assert.equal(fs.existsSync(finalDir), false);
    assert.equal(fs.existsSync(path.dirname(finalDir)) &&
      fs.readdirSync(path.dirname(finalDir)).some((n) => n.includes('broken')), false);
  });
});

describe('getCacheSize / clearCache', () => {
  it('sums file sizes across all cached hash directories', () => {
    const dir = getCacheDir(userData, 'abc123');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'vocals.wav'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(dir, 'drums.wav'), Buffer.alloc(2000));
    assert.equal(getCacheSize(userData), 3000);
  });

  it('clearCache removes everything and getCacheSize returns to 0', () => {
    const dir = getCacheDir(userData, 'abc123');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'vocals.wav'), Buffer.alloc(1000));
    clearCache(userData);
    assert.equal(getCacheSize(userData), 0);
    assert.equal(fs.existsSync(getCacheRoot(userData)), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/stem-cache.test.mjs`
Expected: FAIL — `src/main/stem-cache.js` does not exist yet.

- [ ] **Step 3: Write `stem-cache.js`**

```js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STEM_NAMES = ['bass', 'drums', 'guitar', 'other', 'piano', 'vocals'];

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function getCacheRoot(userDataPath) {
  return path.join(userDataPath, 'stem-cache');
}

function getCacheDir(userDataPath, hash) {
  return path.join(getCacheRoot(userDataPath), hash);
}

function isCached(cacheDir) {
  if (!fs.existsSync(path.join(cacheDir, 'meta.json'))) return false;
  return STEM_NAMES.every((name) => fs.existsSync(path.join(cacheDir, `${name}.wav`)));
}

function getCacheSize(userDataPath) {
  const root = getCacheRoot(userDataPath);
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const hashDir of fs.readdirSync(root)) {
    const dirPath = path.join(root, hashDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath)) {
      total += fs.statSync(path.join(dirPath, file)).size;
    }
  }
  return total;
}

function clearCache(userDataPath) {
  fs.rmSync(getCacheRoot(userDataPath), { recursive: true, force: true });
}

// Writes into a temp sibling directory first, then renames it into place —
// so a crash or thrown error mid-write can never leave a partial cache dir
// that isCached() would wrongly treat as a hit.
function writeAtomic(finalDir, writeFilesFn) {
  const tempDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    writeFilesFn(tempDir);
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    fs.renameSync(tempDir, finalDir);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

module.exports = {
  STEM_NAMES, hashFile, getCacheRoot, getCacheDir, isCached, getCacheSize, clearCache, writeAtomic
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/stem-cache.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/stem-cache.js test/stem-cache.test.mjs
git commit -m "feat: add content-hash stem cache with atomic writes"
```

---

## Task 3: WAV encoding

**Files:**
- Create: `src/main/stem-wav.js`
- Test: `test/stem-wav.test.mjs`

**Interfaces:**
- Produces: `encodeWavStereo(left: Float32Array, right: Float32Array, sampleRate: number): Buffer`

- [ ] **Step 1: Write the failing test**

```js
// test/stem-wav.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWavStereo } from '../src/main/stem-wav.js';

describe('encodeWavStereo', () => {
  it('writes a valid RIFF/WAVE header', () => {
    const left = new Float32Array([0, 0.5, -0.5]);
    const right = new Float32Array([0, -0.5, 0.5]);
    const buf = encodeWavStereo(left, right, 44100);

    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
    assert.equal(buf.readUInt16LE(20), 1); // PCM format
    assert.equal(buf.readUInt16LE(22), 2); // stereo
    assert.equal(buf.readUInt32LE(24), 44100); // sample rate
    assert.equal(buf.readUInt16LE(34), 16); // bits per sample
    assert.equal(buf.toString('ascii', 36, 40), 'data');
  });

  it('round-trips sample values within 16-bit quantization error', () => {
    const left = new Float32Array([0, 0.5, -1, 1]);
    const right = new Float32Array([0, -0.25, 1, -1]);
    const buf = encodeWavStereo(left, right, 44100);

    const dataStart = 44;
    const readSample = (i) => buf.readInt16LE(dataStart + i * 2) / 0x8000;

    // interleaved L,R,L,R,...
    assert.ok(Math.abs(readSample(0) - 0) < 0.001);
    assert.ok(Math.abs(readSample(1) - 0) < 0.001);
    assert.ok(Math.abs(readSample(2) - 0.5) < 0.001);
    assert.ok(Math.abs(readSample(3) - (-0.25)) < 0.001);
  });

  it('data chunk size matches sample count', () => {
    const left = new Float32Array(1000);
    const right = new Float32Array(1000);
    const buf = encodeWavStereo(left, right, 44100);
    const dataSize = buf.readUInt32LE(40);
    assert.equal(dataSize, 1000 * 2 /* channels */ * 2 /* bytes/sample */);
    assert.equal(buf.length, 44 + dataSize);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/stem-wav.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `stem-wav.js`**

```js
function floatTo16BitPCM(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function interleaveStereo(left, right) {
  const length = Math.min(left.length, right.length);
  const result = new Float32Array(length * 2);
  for (let i = 0; i < length; i++) {
    result[i * 2] = left[i];
    result[i * 2 + 1] = right[i];
  }
  return result;
}

function encodeWavStereo(left, right, sampleRate) {
  const interleaved = interleaveStereo(left, right);
  const pcm16 = floatTo16BitPCM(interleaved);
  const numChannels = 2;
  const bytesPerSample = 2;
  const dataSize = pcm16.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcm16.length; i++) {
    buffer.writeInt16LE(pcm16[i], 44 + i * 2);
  }

  return buffer;
}

module.exports = { encodeWavStereo, floatTo16BitPCM, interleaveStereo };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/stem-wav.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/stem-wav.js test/stem-wav.test.mjs
git commit -m "feat: add 16-bit stereo WAV encoder for stem cache files"
```

---

## Task 4: Offline separation pipeline (segmentation + overlap-add)

**Files:**
- Create: `src/main/stem-processor.js`
- Test: `test/stem-processor.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (pure module — the injected `runInference` function is what Task 5 will wire to the real ONNX session from Task 1).
- Produces: `STEM_NAMES` (same 6-name set, drums/bass/other/vocals/guitar/piano order — matches `stem-model.js`'s `STEM_ORDER`), `buildChunkWindow(segmentSamples, overlapSamples, chunkIndex, totalChunks): Float32Array`, `separate(left, right, segmentSamples, overlapFraction, runInference, onProgress?): Promise<{ [stemName]: { left: Float32Array, right: Float32Array } }>` where `runInference(chunkLeft: Float32Array, chunkRight: Float32Array): Promise<{ [stemName]: { left: Float32Array, right: Float32Array } }>`.

This task's `separate()` doesn't know or care about the model's real segment length — Task 5 supplies `segmentSamples`/`overlapFraction` (defaulting to Demucs' documented ~7.8s segment / 25% overlap, in samples at 44.1kHz, adjusted if Task 1 Step 3 found the model requires an exact fixed length).

- [ ] **Step 1: Write the failing tests**

```js
// test/stem-processor.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { separate, buildChunkWindow, STEM_NAMES } from '../src/main/stem-processor.js';

describe('buildChunkWindow', () => {
  it('is all 1.0 for a single chunk (both first and last)', () => {
    const w = buildChunkWindow(100, 20, 0, 1);
    assert.ok(Array.from(w).every((v) => v === 1));
  });

  it('fades in at the start for a non-first chunk, full weight elsewhere', () => {
    const w = buildChunkWindow(100, 20, 1, 3);
    assert.equal(w[0], 0);
    assert.ok(Math.abs(w[10] - 0.5) < 0.001);
    assert.ok(Math.abs(w[19] - 0.95) < 0.001);
    assert.equal(w[50], 1);
  });

  it('fades out at the end for a non-last chunk, full weight elsewhere', () => {
    const w = buildChunkWindow(100, 20, 0, 3);
    assert.equal(w[0], 1);
    assert.equal(w[50], 1);
    assert.ok(w[99] < 0.1);
  });
});

describe('separate', () => {
  it('reconstructs the exact input length', async () => {
    const totalSamples = 1000;
    const left = new Float32Array(totalSamples).fill(1);
    const right = new Float32Array(totalSamples).fill(1);
    const identityInference = async (chunkLeft, chunkRight) => {
      const result = {};
      for (const name of STEM_NAMES) result[name] = { left: chunkLeft, right: chunkRight };
      return result;
    };

    const outputs = await separate(left, right, 300, 0.25, identityInference);
    assert.equal(outputs.vocals.left.length, totalSamples);
  });

  it('reconstructs identical signal exactly when every stem echoes the input', async () => {
    const totalSamples = 1000;
    const left = new Float32Array(totalSamples).fill(0.7);
    const right = new Float32Array(totalSamples).fill(-0.3);
    const identityInference = async (chunkLeft, chunkRight) => {
      const result = {};
      for (const name of STEM_NAMES) result[name] = { left: chunkLeft, right: chunkRight };
      return result;
    };

    const outputs = await separate(left, right, 300, 0.25, identityInference);
    for (let i = 0; i < totalSamples; i++) {
      assert.ok(Math.abs(outputs.vocals.left[i] - 0.7) < 0.0001, `sample ${i}`);
      assert.ok(Math.abs(outputs.vocals.right[i] - (-0.3)) < 0.0001, `sample ${i}`);
    }
  });

  it('linearly crossfades between adjacent chunks whose output differs by position', async () => {
    const totalSamples = 900;
    const left = new Float32Array(totalSamples);
    const right = new Float32Array(totalSamples);
    let callIndex = 0;
    const positionMarkingInference = async () => {
      const value = callIndex; // 0, 1, 2, ... one per chunk call, in order
      callIndex++;
      const filled = new Float32Array(300).fill(value);
      const result = {};
      for (const name of STEM_NAMES) result[name] = { left: filled, right: filled };
      return result;
    };

    const outputs = await separate(left, right, 300, 0.25, positionMarkingInference);
    // Chunk 0 covers [0,300), chunk 1 [225,525), chunk 2 [450,750), chunk3 [675, 975) clipped to 900
    // Deep in chunk 0's core (before any overlap) should be exactly 0
    assert.ok(Math.abs(outputs.vocals.left[100] - 0) < 0.001);
    // In the crossfade between chunk 0 (value 0) and chunk 1 (value 1),
    // the blend should be strictly between 0 and 1
    const midOverlap = outputs.vocals.left[237]; // partway through [225,300) overlap
    assert.ok(midOverlap > 0 && midOverlap < 1, `expected 0<value<1, got ${midOverlap}`);
  });

  it('progress callback fires once per chunk reaching 1.0 at the end', async () => {
    const totalSamples = 900;
    const left = new Float32Array(totalSamples);
    const right = new Float32Array(totalSamples);
    const identityInference = async (chunkLeft, chunkRight) => {
      const result = {};
      for (const name of STEM_NAMES) result[name] = { left: chunkLeft, right: chunkRight };
      return result;
    };
    const progressValues = [];
    await separate(left, right, 300, 0.25, identityInference, (p) => progressValues.push(p));
    assert.ok(progressValues.length > 0);
    assert.equal(progressValues[progressValues.length - 1], 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/stem-processor.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `stem-processor.js`**

```js
const STEM_NAMES = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

// Per-sample weight curve for ONE chunk at position `chunkIndex` of
// `totalChunks`. Adjacent chunks crossfade linearly across their overlap;
// the very first/last chunk get full weight (1.0) at the true start/end
// of the track, where there is no neighboring chunk to blend with.
function buildChunkWindow(segmentSamples, overlapSamples, chunkIndex, totalChunks) {
  const window = new Float32Array(segmentSamples).fill(1);
  if (chunkIndex > 0) {
    for (let i = 0; i < overlapSamples; i++) window[i] = i / overlapSamples;
  }
  if (chunkIndex < totalChunks - 1) {
    for (let i = 0; i < overlapSamples; i++) {
      window[segmentSamples - overlapSamples + i] = 1 - i / overlapSamples;
    }
  }
  return window;
}

async function separate(left, right, segmentSamples, overlapFraction, runInference, onProgress) {
  const totalSamples = left.length;
  const overlapSamples = Math.floor(segmentSamples * overlapFraction);
  const step = segmentSamples - overlapSamples;

  const positions = [];
  for (let start = 0; start < totalSamples; start += step) {
    positions.push(start);
    if (start + segmentSamples >= totalSamples) break;
  }
  const totalChunks = positions.length;

  const outputs = {};
  for (const name of STEM_NAMES) {
    outputs[name] = { left: new Float32Array(totalSamples), right: new Float32Array(totalSamples) };
  }
  const weightSum = new Float32Array(totalSamples);

  for (let i = 0; i < totalChunks; i++) {
    const start = positions[i];
    const end = Math.min(start + segmentSamples, totalSamples);
    const chunkLen = end - start;

    const chunkLeft = new Float32Array(segmentSamples);
    const chunkRight = new Float32Array(segmentSamples);
    chunkLeft.set(left.subarray(start, end));
    chunkRight.set(right.subarray(start, end));

    const result = await runInference(chunkLeft, chunkRight);
    const window = buildChunkWindow(segmentSamples, overlapSamples, i, totalChunks);

    for (let s = 0; s < chunkLen; s++) {
      const w = window[s];
      weightSum[start + s] += w;
      for (const name of STEM_NAMES) {
        outputs[name].left[start + s] += result[name].left[s] * w;
        outputs[name].right[start + s] += result[name].right[s] * w;
      }
    }

    if (onProgress) onProgress((i + 1) / totalChunks);
  }

  for (let s = 0; s < totalSamples; s++) {
    const w = weightSum[s] || 1;
    for (const name of STEM_NAMES) {
      outputs[name].left[s] /= w;
      outputs[name].right[s] /= w;
    }
  }

  return outputs;
}

module.exports = { STEM_NAMES, buildChunkWindow, separate };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/stem-processor.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/stem-processor.js test/stem-processor.test.mjs
git commit -m "feat: add overlap-add offline stem separation pipeline"
```

---

## Task 5: Main-process IPC wiring

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/main/settings-store.js` (add `source: 'live'` to `DEFAULTS`)

**Interfaces:**
- Consumes: `stem-model.js` (`loadSession`, `STEM_ORDER`), `stem-cache.js` (`hashFile`, `getCacheDir`, `isCached`, `getCacheSize`, `clearCache`, `writeAtomic`, `STEM_NAMES`), `stem-processor.js` (`separate`), `stem-wav.js` (`encodeWavStereo`).
- Produces (new IPC channels, all `ipcMain.handle` unless noted): `pick-audio-file` → `Promise<string|null>` (absolute file path or null if cancelled); `check-stem-cache(filePath)` → `Promise<{ hash: string, cached: boolean, dir: string }>`; `read-audio-file-bytes(filePath)` → `Promise<Uint8Array>`; `process-audio-pcm({ hash, dir, left: Float32Array, right: Float32Array, sampleRate })` → `Promise<{ dir: string }>`, and emits `stem-progress` events (`{ percent: number }`) via `webContents.send` to the requesting window during processing; `read-stem-audio(dir)` → `Promise<{ [stemName]: Uint8Array }>`; `read-stem-cache-size` → `Promise<number>`; `clear-stem-cache` → `Promise<void>`.

- [ ] **Step 1: Add `source` to settings defaults**

In `src/main/settings-store.js`, add to `DEFAULTS`:

```js
const DEFAULTS = {
  mode: 'segmented-led',
  theme: 'neon',
  sensitivity: 1.0,
  vocalGain: 1.0,
  barCount: 64,
  barSize: 3,
  audioMode: 'normal',
  background: 'solid',
  freqLabels: false,
  beatEffect: 'none',
  source: 'live'
};
```

- [ ] **Step 2: Add the IPC handlers to `main.js`**

At the top of `main.js`, alongside the existing requires:

```js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AudioBridge = require('./audio-bridge');
const SettingsStore = require('./settings-store');
const stemModel = require('./stem-model');
const stemCache = require('./stem-cache');
const stemProcessor = require('./stem-processor');
const { encodeWavStereo } = require('./stem-wav');

const SEGMENT_SAMPLES = Math.round(7.8 * 44100); // confirm/adjust per Task 1 Step 3 findings
const OVERLAP_FRACTION = 0.25;
```

Inside `createWindow()`, alongside the existing `ipcMain.handle('get-settings', ...)` block, add:

```js
  ipcMain.handle('pick-audio-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('check-stem-cache', async (_event, filePath) => {
    const hash = await stemCache.hashFile(filePath);
    const dir = stemCache.getCacheDir(app.getPath('userData'), hash);
    return { hash, cached: stemCache.isCached(dir), dir };
  });

  ipcMain.handle('read-audio-file-bytes', async (_event, filePath) => {
    return new Uint8Array(fs.readFileSync(filePath));
  });

  ipcMain.handle('process-audio-pcm', async (event, { hash, dir, left, right, sampleRate }) => {
    const session = await stemModel.loadSession(app.getPath('userData'));

    const runInference = async (chunkLeft, chunkRight) => {
      const ort = require('onnxruntime-node');
      const inputTensor = new ort.Tensor('float32',
        Float32Array.from([...chunkLeft, ...chunkRight]),
        [1, 2, chunkLeft.length]);
      const results = await session.run({ [session.inputNames[0]]: inputTensor });
      const outputData = results[session.outputNames[0]].data;
      const chunkLen = chunkLeft.length;
      const stems = {};
      stemModel.STEM_ORDER.forEach((name, stemIndex) => {
        const base = stemIndex * 2 * chunkLen;
        stems[name] = {
          left: outputData.slice(base, base + chunkLen),
          right: outputData.slice(base + chunkLen, base + 2 * chunkLen)
        };
      });
      return stems;
    };

    const leftArr = Float32Array.from(left);
    const rightArr = Float32Array.from(right);

    const stems = await stemProcessor.separate(
      leftArr, rightArr, SEGMENT_SAMPLES, OVERLAP_FRACTION, runInference,
      (percent) => event.sender.send('stem-progress', { percent })
    );

    stemCache.writeAtomic(dir, (tempDir) => {
      for (const name of stemCache.STEM_NAMES) {
        const wavBuffer = encodeWavStereo(stems[name].left, stems[name].right, sampleRate);
        fs.writeFileSync(path.join(tempDir, `${name}.wav`), wavBuffer);
      }
      fs.writeFileSync(path.join(tempDir, 'meta.json'), JSON.stringify({
        hash, sampleRate, createdAt: new Date().toISOString()
      }, null, 2));
    });

    return { dir };
  });

  ipcMain.handle('read-stem-audio', async (_event, dir) => {
    const result = {};
    for (const name of stemCache.STEM_NAMES) {
      result[name] = new Uint8Array(fs.readFileSync(path.join(dir, `${name}.wav`)));
    }
    return result;
  });

  ipcMain.handle('read-stem-cache-size', async () => {
    return stemCache.getCacheSize(app.getPath('userData'));
  });

  ipcMain.handle('clear-stem-cache', async () => {
    stemCache.clearCache(app.getPath('userData'));
  });
```

**Confirmed tensor contract (Task 1's discovery):** input tensor `mix`, shape `[1, 2, 343980]` — fixed length, not dynamic (343980 = 7.8s × 44100Hz, matching `SEGMENT_SAMPLES` above exactly). Output tensor `stems`, shape `[1, 6, 2, 343980]`, stem order `drums, bass, other, vocals, guitar, piano` (matches `stemModel.STEM_ORDER`). The leading batch dimension of 1 doesn't change flat-buffer offsets, so the input tensor shape `[1, 2, chunkLeft.length]` and the output slicing math (`stemIndex * 2 * chunkLen`) in the handler below are already correct as written — no changes needed.

- [ ] **Step 3: Manual verification**

Run: `npm start`, open DevTools console, and run:

```js
await window.electronAPI?.pickAudioFile ? 'preload wired (Task 6 pending)' : 'expected — preload not done yet'
```

Since preload isn't updated until Task 6, verify instead via the main-process console: confirm the app starts with no errors from the new `require()` calls (i.e. `stem-model.js`/`stem-cache.js`/`stem-processor.js`/`stem-wav.js` all load without throwing). Expected: app window opens normally, DevTools console shows no red errors related to the new modules.

- [ ] **Step 4: Commit**

```bash
git add src/main/main.js src/main/settings-store.js
git commit -m "feat: wire stem separation IPC handlers into main process"
```

---

## Task 6: Preload bridge

**Files:**
- Modify: `src/main/preload.js`

**Interfaces:**
- Produces (on `window.electronAPI`): `pickAudioFile()`, `checkStemCache(filePath)`, `readAudioFileBytes(filePath)`, `processAudioPcm(payload)`, `onStemProgress(callback)`, `readStemAudio(dir)`, `getStemCacheSize()`, `clearStemCache()`.

- [ ] **Step 1: Add the new bridge methods**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onAudioData: (callback) => {
    ipcRenderer.on('audio-data', (_event, data) => callback(data));
  },
  onSampleRate: (callback) => {
    ipcRenderer.on('sample-rate', (_event, rate) => callback(rate));
  },
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  setTransparent: (enabled) => ipcRenderer.send('set-transparent', enabled),
  onApplySettings: (callback) => {
    ipcRenderer.on('apply-settings', (_event, settings) => callback(settings));
  },
  setClickThrough: (enabled) => ipcRenderer.send('set-click-through', enabled),

  pickAudioFile: () => ipcRenderer.invoke('pick-audio-file'),
  checkStemCache: (filePath) => ipcRenderer.invoke('check-stem-cache', filePath),
  readAudioFileBytes: (filePath) => ipcRenderer.invoke('read-audio-file-bytes', filePath),
  processAudioPcm: (payload) => ipcRenderer.invoke('process-audio-pcm', payload),
  onStemProgress: (callback) => { stemProgressCallback = callback; },
  readStemAudio: (dir) => ipcRenderer.invoke('read-stem-audio', dir),
  getStemCacheSize: () => ipcRenderer.invoke('read-stem-cache-size'),
  clearStemCache: () => ipcRenderer.invoke('clear-stem-cache'),
});

// A single persistent listener that forwards to whichever callback
// onStemProgress most recently registered — registering a fresh
// ipcRenderer.on(...) on every onStemProgress() call would stack a new
// listener per file load and fire stale callbacks alongside the current one.
let stemProgressCallback = null;
ipcRenderer.on('stem-progress', (_event, data) => {
  if (stemProgressCallback) stemProgressCallback(data.percent);
});
```

- [ ] **Step 2: Manual verification**

Run: `npm start`, open DevTools console, run `await window.electronAPI.getStemCacheSize()`.
Expected: returns `0` (no errors, no stems processed yet).

- [ ] **Step 3: Commit**

```bash
git add src/main/preload.js
git commit -m "feat: expose stem separation IPC in preload bridge"
```

---

## Task 7: Beat detector (renderer, pure)

**Files:**
- Create: `src/renderer/audio/beat-detector.js`
- Test: `test/beat-detector.test.mjs`

**Interfaces:**
- Produces: `createBeatDetector(options?: { threshold?: number, cooldownFrames?: number }): (bassEnergy: number) => boolean`

- [ ] **Step 1: Write the failing test**

```js
// test/beat-detector.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBeatDetector } from '../src/renderer/audio/beat-detector.js';

describe('createBeatDetector', () => {
  it('does not flag a beat during a steady quiet baseline', () => {
    const detect = createBeatDetector();
    let anyBeat = false;
    for (let i = 0; i < 30; i++) {
      if (detect(0.1)) anyBeat = true;
    }
    assert.equal(anyBeat, false);
  });

  it('flags a beat on a sudden energy spike above the baseline', () => {
    const detect = createBeatDetector({ threshold: 1.3, cooldownFrames: 15 });
    for (let i = 0; i < 20; i++) detect(0.1); // establish baseline
    const spikeResult = detect(1.0);
    assert.equal(spikeResult, true);
  });

  it('does not re-flag immediately after a beat (cooldown)', () => {
    const detect = createBeatDetector({ threshold: 1.3, cooldownFrames: 15 });
    for (let i = 0; i < 20; i++) detect(0.1);
    assert.equal(detect(1.0), true);
    assert.equal(detect(1.0), false); // still within cooldown
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/beat-detector.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `beat-detector.js`**

```js
export function createBeatDetector({ threshold = 1.3, cooldownFrames = 15 } = {}) {
  let runningAverage = null;
  let framesSinceLastBeat = cooldownFrames;

  return function detect(bassEnergy) {
    framesSinceLastBeat++;

    // Seed the average with the first sample instead of starting from 0 --
    // starting from 0 makes any steady, non-zero signal look like a huge
    // spike relative to the still-near-zero average during ramp-up, firing
    // false beats before the average has had a chance to converge.
    if (runningAverage === null) {
      runningAverage = bassEnergy;
      return false;
    }

    const isBeat = bassEnergy > runningAverage * threshold && framesSinceLastBeat >= cooldownFrames;
    runningAverage = runningAverage * 0.95 + bassEnergy * 0.05;
    if (isBeat) framesSinceLastBeat = 0;
    return isBeat;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/beat-detector.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/audio/beat-detector.js test/beat-detector.test.mjs
git commit -m "feat: add energy-based beat detector for file playback"
```

---

## Task 8: FileAudioSource (renderer playback + mixing engine)

**Files:**
- Create: `src/renderer/audio/file-source.js`

**Interfaces:**
- Consumes: `window.electronAPI.{pickAudioFile, checkStemCache, readAudioFileBytes, processAudioPcm, onStemProgress, readStemAudio}` (Task 6), `createBeatDetector` (Task 7).
- Produces: `class FileAudioSource` with constructor `({ onAudioData: (data: {midData: Float32Array, sideData: Float32Array, beat: boolean, volume: number}) => void })`, and methods `loadFile(filePath, onProgress?: (percent: number) => void): Promise<void>`, `play(): void`, `pause(): void`, `seek(seconds: number): void`, `setStemVolume(name: string, value: number): void`, `setStemMute(name: string, muted: boolean): void`, `soloStem(name: string): void`, `clearSolo(): void`, `getCurrentTime(): number`, `getDuration(): number`, `STEM_NAMES` (exported const, same 6 names as `stem-cache.js`).

- [ ] **Step 1: Write `file-source.js`**

```js
import { createBeatDetector } from './beat-detector.js';

export const STEM_NAMES = ['bass', 'drums', 'guitar', 'other', 'piano', 'vocals'];

export class FileAudioSource {
  constructor({ onAudioData }) {
    this.onAudioData = onAudioData;
    this.audioContext = null;
    this.stemBuffers = {};
    this.gainNodes = {};
    this.sourceNodes = {};
    this.analyser = null;
    this.mixBus = null;
    this.detectBeat = createBeatDetector();
    this.isPlaying = false;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.duration = 0;
    this.rafId = null;
    this._muted = {};
    this._volumes = {};
  }

  async loadFile(filePath, onProgress) {
    this.stopPlayback();
    if (!this.audioContext) this.audioContext = new AudioContext({ sampleRate: 44100 });

    const { hash, cached, dir } = await window.electronAPI.checkStemCache(filePath);

    if (!cached) {
      const fileBytes = await window.electronAPI.readAudioFileBytes(filePath);
      const decoded = await this.audioContext.decodeAudioData(fileBytes.buffer.slice(
        fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength));
      const left = decoded.getChannelData(0);
      const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);

      if (onProgress) window.electronAPI.onStemProgress(onProgress);
      await window.electronAPI.processAudioPcm({
        hash, dir, left, right, sampleRate: decoded.sampleRate
      });
    }

    const stemData = await window.electronAPI.readStemAudio(dir);
    this.stemBuffers = {};
    for (const name of STEM_NAMES) {
      const bytes = stemData[name];
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this.stemBuffers[name] = await this.audioContext.decodeAudioData(arrayBuffer);
    }
    this.duration = this.stemBuffers[STEM_NAMES[0]].duration;
    this.pausedAt = 0;
    this._buildGraph();
  }

  _buildGraph() {
    const ctx = this.audioContext;
    this.mixBus = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.mixBus.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.gainNodes = {};
    for (const name of STEM_NAMES) {
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      gain.connect(this.mixBus);
      this.gainNodes[name] = gain;
      this._muted[name] = false;
      this._volumes[name] = 1.0;
    }
  }

  _startSources(fromSeconds) {
    const ctx = this.audioContext;
    this.sourceNodes = {};
    for (const name of STEM_NAMES) {
      const src = ctx.createBufferSource();
      src.buffer = this.stemBuffers[name];
      src.connect(this.gainNodes[name]);
      src.start(0, fromSeconds);
      this.sourceNodes[name] = src;
    }
    this.startedAt = ctx.currentTime - fromSeconds;
    this.isPlaying = true;
  }

  play() {
    if (this.isPlaying || !this.stemBuffers[STEM_NAMES[0]]) return;
    this._startSources(this.pausedAt);
    this._runAnalysisLoop();
  }

  pause() {
    if (!this.isPlaying) return;
    this.pausedAt = this.getCurrentTime();
    this._stopSources();
    this.stopAnalysisLoop();
  }

  stopPlayback() {
    this._stopSources();
    this.stopAnalysisLoop();
    this.pausedAt = 0;
  }

  _stopSources() {
    for (const name of STEM_NAMES) {
      if (this.sourceNodes[name]) {
        try { this.sourceNodes[name].stop(); } catch { /* already stopped */ }
      }
    }
    this.sourceNodes = {};
    this.isPlaying = false;
  }

  seek(seconds) {
    const wasPlaying = this.isPlaying;
    const clamped = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) this._stopSources();
    this.pausedAt = clamped;
    if (wasPlaying) this._startSources(this.pausedAt);
  }

  getCurrentTime() {
    return this.isPlaying ? (this.audioContext.currentTime - this.startedAt) : this.pausedAt;
  }

  getDuration() {
    return this.duration;
  }

  setStemVolume(name, value) {
    this._volumes[name] = value;
    if (!this._muted[name]) this.gainNodes[name].gain.value = value;
  }

  setStemMute(name, muted) {
    this._muted[name] = muted;
    this.gainNodes[name].gain.value = muted ? 0 : this._volumes[name];
  }

  soloStem(name) {
    for (const other of STEM_NAMES) this.setStemMute(other, other !== name);
  }

  clearSolo() {
    for (const other of STEM_NAMES) this.setStemMute(other, false);
  }

  _runAnalysisLoop() {
    const freqData = new Float32Array(this.analyser.frequencyBinCount);
    const timeData = new Float32Array(this.analyser.fftSize);

    const tick = () => {
      if (!this.isPlaying) return;

      this.analyser.getFloatFrequencyData(freqData);
      const linear = new Float32Array(freqData.length);
      for (let i = 0; i < freqData.length; i++) {
        linear[i] = Math.pow(10, freqData[i] / 20);
      }

      this.analyser.getFloatTimeDomainData(timeData);
      let sumSquares = 0;
      for (let i = 0; i < timeData.length; i++) sumSquares += timeData[i] * timeData[i];
      const volume = Math.sqrt(sumSquares / timeData.length);

      let bassEnergy = 0;
      const bassBins = Math.min(8, linear.length);
      for (let i = 0; i < bassBins; i++) bassEnergy += linear[i];
      const beat = this.detectBeat(bassEnergy);

      this.onAudioData({ midData: linear, sideData: linear, beat, volume });

      if (this.getCurrentTime() >= this.duration) {
        this.pause();
        this.pausedAt = 0;
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopAnalysisLoop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/audio/file-source.js
git commit -m "feat: add FileAudioSource for file playback, mixing, and analysis"
```

(No automated test here — this class only does anything meaningful against real `AudioContext`/`AnalyserNode` behavior, which `node --test` can't exercise headlessly. It's covered by the manual end-to-end pass in Task 10.)

---

## Task 9: app.js integration (source gating)

**Files:**
- Modify: `src/renderer/app.js`

**Interfaces:**
- Consumes: `FileAudioSource` (Task 8).
- Produces: module-level `handleAudioData(data)` (used by both the live IPC listener and `FileAudioSource`'s `onAudioData` callback), `fileAudioSource` instance exported for `panel.js` (Task 10) to drive.

- [ ] **Step 1: Extract `handleAudioData` and gate live IPC by source**

Find this block near the top of `app.js`:

```js
window.electronAPI.onAudioData((data) => {
  rawMidData = data.midData;
  rawSideData = data.sideData;
  currentBeat = data.beat;
  currentVolume = data.volume;
});
```

Replace it with:

```js
function handleAudioData(data) {
  rawMidData = data.midData;
  rawSideData = data.sideData;
  currentBeat = data.beat;
  currentVolume = data.volume;
}

window.electronAPI.onAudioData((data) => {
  if (settings.source !== 'file') handleAudioData(data);
});

export const fileAudioSource = new FileAudioSource({
  onAudioData: (data) => {
    if (settings.source === 'file') handleAudioData(data);
  }
});

const LIVE_SAMPLE_RATE_FALLBACK = 48000;
let liveSampleRate = LIVE_SAMPLE_RATE_FALLBACK;
```

Add the import at the top of the file:

```js
import { FileAudioSource } from './audio/file-source.js';
```

- [ ] **Step 2: Track live vs. file sample rate separately**

Find:

```js
window.electronAPI.onSampleRate((rate) => { sampleRate = rate; });
```

Replace with:

```js
window.electronAPI.onSampleRate((rate) => {
  liveSampleRate = rate;
  if (settings.source !== 'file') sampleRate = rate;
});

export function setSourceMode(mode) {
  settings.source = mode;
  if (mode === 'file') {
    sampleRate = 44100; // FileAudioSource always uses a 44.1kHz AudioContext
  } else {
    sampleRate = liveSampleRate;
    fileAudioSource.pause();
  }
}
```

- [ ] **Step 3: Add default `source` to the in-memory settings object**

Find the `let settings = { ... }` default block and add `source: 'live',` to it (matching the default added to `settings-store.js` in Task 5).

- [ ] **Step 4: Manual verification**

Run: `npm start`. Confirm the app launches with no console errors and live visualization still works exactly as before (this task should be behaviorally invisible until Task 10 wires up UI to actually call `setSourceMode('file')`).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app.js
git commit -m "feat: gate audio data handling between live and file sources"
```

---

## Task 10: Panel UI — source toggle, file controls, stem mixer, cache management

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/ui/panel.js`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `fileAudioSource`, `setSourceMode` (from `app.js`, Task 9), `window.electronAPI.{pickAudioFile, getStemCacheSize, clearStemCache}` (Task 6).

- [ ] **Step 1: Add markup to `index.html`**

Add a new `panel-section` near the top of `#panel` (right after the existing theme/audio-mode sections), matching the existing section markup style:

```html
<div class="panel-section">
  <label>Source</label>
  <select id="source-select">
    <option value="live">Live System Audio</option>
    <option value="file">Audio File</option>
  </select>
</div>

<div class="panel-section" id="file-controls" hidden>
  <button id="load-file-btn">Load File…</button>
  <div id="file-progress" hidden>
    <span id="file-progress-label">Separating stems… 0%</span>
    <progress id="file-progress-bar" max="100" value="0"></progress>
  </div>
  <div id="file-transport" hidden>
    <button id="file-play-btn">Play</button>
    <button id="file-pause-btn">Pause</button>
    <input type="range" id="file-seek" min="0" max="100" step="0.1" value="0">
  </div>
  <div id="stem-mixer" hidden>
    <div class="stem-row" data-stem="vocals">
      <label>Vocals</label>
      <input type="checkbox" class="stem-mute">
      <input type="range" class="stem-volume" min="0" max="1" step="0.01" value="1">
      <button class="stem-solo">Solo</button>
    </div>
    <div class="stem-row" data-stem="drums">
      <label>Drums</label>
      <input type="checkbox" class="stem-mute">
      <input type="range" class="stem-volume" min="0" max="1" step="0.01" value="1">
      <button class="stem-solo">Solo</button>
    </div>
    <div class="stem-row" data-stem="bass">
      <label>Bass</label>
      <input type="checkbox" class="stem-mute">
      <input type="range" class="stem-volume" min="0" max="1" step="0.01" value="1">
      <button class="stem-solo">Solo</button>
    </div>
    <div class="stem-row" data-stem="guitar">
      <label>Guitar</label>
      <input type="checkbox" class="stem-mute">
      <input type="range" class="stem-volume" min="0" max="1" step="0.01" value="1">
      <button class="stem-solo">Solo</button>
    </div>
    <div class="stem-row" data-stem="piano">
      <label>Piano</label>
      <input type="checkbox" class="stem-mute">
      <input type="range" class="stem-volume" min="0" max="1" step="0.01" value="1">
      <button class="stem-solo">Solo</button>
    </div>
    <div class="stem-row" data-stem="other">
      <label>Other</label>
      <input type="checkbox" class="stem-mute">
      <input type="range" class="stem-volume" min="0" max="1" step="0.01" value="1">
      <button class="stem-solo">Solo</button>
    </div>
  </div>
  <div id="cache-info">
    <span id="cache-size-label">Cache: 0 MB</span>
    <button id="clear-cache-btn">Clear Cache</button>
  </div>
</div>
```

- [ ] **Step 2: Wire it up in `panel.js`**

Add near the other `document.getElementById(...).addEventListener(...)` blocks, alongside an import of the new pieces from `app.js`:

```js
import { fileAudioSource, setSourceMode } from '../app.js';

const sourceSelect = document.getElementById('source-select');
const fileControls = document.getElementById('file-controls');
const loadFileBtn = document.getElementById('load-file-btn');
const fileProgress = document.getElementById('file-progress');
const fileProgressLabel = document.getElementById('file-progress-label');
const fileProgressBar = document.getElementById('file-progress-bar');
const fileTransport = document.getElementById('file-transport');
const filePlayBtn = document.getElementById('file-play-btn');
const filePauseBtn = document.getElementById('file-pause-btn');
const fileSeek = document.getElementById('file-seek');
const stemMixer = document.getElementById('stem-mixer');
const cacheSizeLabel = document.getElementById('cache-size-label');
const clearCacheBtn = document.getElementById('clear-cache-btn');

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshCacheSize() {
  const size = await window.electronAPI.getStemCacheSize();
  cacheSizeLabel.textContent = `Cache: ${formatBytes(size)}`;
}

sourceSelect.addEventListener('change', (e) => {
  setSourceMode(e.target.value);
  fileControls.hidden = e.target.value !== 'file';
  if (e.target.value === 'file') refreshCacheSize();
});

loadFileBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.pickAudioFile();
  if (!filePath) return;

  fileTransport.hidden = true;
  stemMixer.hidden = true;
  fileProgress.hidden = false;
  fileProgressLabel.textContent = 'Checking cache…';
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
});

filePlayBtn.addEventListener('click', () => fileAudioSource.play());
filePauseBtn.addEventListener('click', () => fileAudioSource.pause());
fileSeek.addEventListener('input', (e) => fileAudioSource.seek(Number(e.target.value)));

for (const row of stemMixer.querySelectorAll('.stem-row')) {
  const stemName = row.dataset.stem;
  const muteBox = row.querySelector('.stem-mute');
  const volumeSlider = row.querySelector('.stem-volume');
  const soloBtn = row.querySelector('.stem-solo');

  muteBox.addEventListener('change', (e) => fileAudioSource.setStemMute(stemName, e.target.checked));
  volumeSlider.addEventListener('input', (e) => fileAudioSource.setStemVolume(stemName, Number(e.target.value)));

  let soloed = false;
  soloBtn.addEventListener('click', () => {
    soloed = !soloed;
    if (soloed) {
      fileAudioSource.soloStem(stemName);
      for (const otherRow of stemMixer.querySelectorAll('.stem-row')) {
        otherRow.querySelector('.stem-mute').checked = otherRow.dataset.stem !== stemName;
      }
    } else {
      fileAudioSource.clearSolo();
      for (const otherRow of stemMixer.querySelectorAll('.stem-row')) {
        otherRow.querySelector('.stem-mute').checked = false;
      }
    }
  });
}

clearCacheBtn.addEventListener('click', async () => {
  await window.electronAPI.clearStemCache();
  await refreshCacheSize();
});
```

Also find wherever `panel.js` restores saved settings into form controls on load (the `saved.audioMode || 'normal'` line found in the existing diff) and add alongside it:

```js
document.getElementById('source-select').value = saved.source || 'live';
```

- [ ] **Step 3: Minimal styling in `styles.css`**

Add:

```css
#file-controls #stem-mixer .stem-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

#file-controls #stem-mixer .stem-row label {
  width: 60px;
}

#cache-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  font-size: 0.85em;
  opacity: 0.8;
}
```

- [ ] **Step 4: Manual end-to-end verification**

Run: `npm start`. In the app:
1. Switch Source to "Audio File", click "Load File…", pick a short (under 1 minute) local mp3/wav.
2. Confirm "Checking cache…" then a progress bar advancing during separation (first run will also download the ~258MB model — expect several minutes on first ever use).
3. Confirm playback starts, audio is audible, and the visualizer bars respond to it.
4. Mute all stems except Vocals (or use the Vocals "Solo" button) — confirm you hear only vocals and the bars still animate.
5. Pause, drag the seek bar, resume — confirm playback resumes from the new position.
6. Reload the same file (Load File… → same path) — confirm it skips straight to "Cache: X MB" already reflecting the prior run, with no re-processing progress bar shown, and playback starts immediately.
7. Click "Clear Cache" — confirm the cache size label returns to "Cache: 0.0 MB".
8. Switch Source back to "Live System Audio" — confirm live visualization still works exactly as before.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/ui/panel.js src/renderer/styles.css
git commit -m "feat: add file playback panel UI with stem mixer and cache management"
```

---

## Plan Self-Review Notes

- **Spec coverage:** file decode/playback (Task 8), offline separation (Tasks 1/4/5), disk cache keyed by content hash (Task 2), per-stem mute/solo/volume audibly and visually (Task 8/9/10), progress reporting (Tasks 5/6/10), manual cache clear (Task 10) — all covered. Automatic eviction, stem export, and live-mode changes are explicitly out of scope per the spec and untouched by this plan.
- **Known unknown flagged, not hidden:** the exact ONNX tensor shape/stem order for `process-audio-pcm` in Task 5 is explicitly marked as needing correction against Task 1 Step 3's discovery findings, rather than silently assumed — this is the one place in the plan where a downstream implementer must go back and confirm a detail against a live artifact before it can be considered done.
