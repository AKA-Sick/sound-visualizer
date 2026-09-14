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

function resetAllProcessed(userDataPath) {
  const entries = loadLibrary(userDataPath).map((e) => ({ ...e, processed: false }));
  saveLibrary(userDataPath, entries);
  return entries;
}

module.exports = {
  getLibraryPath, loadLibrary, saveLibrary, upsertEntry, removeEntry,
  setFavorite, recordPlay, markProcessed, resetAllProcessed
};
