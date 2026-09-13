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
