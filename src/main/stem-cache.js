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
