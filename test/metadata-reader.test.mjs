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
