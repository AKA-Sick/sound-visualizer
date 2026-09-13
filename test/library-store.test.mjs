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
