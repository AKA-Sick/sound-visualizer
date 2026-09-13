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
