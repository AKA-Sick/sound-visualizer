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
