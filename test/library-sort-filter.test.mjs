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
