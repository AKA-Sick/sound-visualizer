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
});
