const path = require('path');
const { extractFeaturedArtists } = require('./feat-parser');

async function readMetadata(filePath) {
  const filename = path.basename(filePath, path.extname(filePath));
  let title = filename;
  let artist = 'Unknown Artist';
  let album = '';
  let genre = '';
  let duration = 0;

  try {
    const mm = await import('music-metadata');
    const { common, format } = await mm.parseFile(filePath);
    if (common.title) title = common.title;
    if (common.artist) artist = common.artist;
    if (common.album) album = common.album;
    if (common.genre && common.genre.length > 0) genre = common.genre[0];
    if (format.duration) duration = format.duration;
  } catch {
    // Unreadable tags, unsupported format, or missing file -- fall back
    // to the filename-derived metadata already set above.
  }

  return {
    title, artist, album, genre, duration,
    featuredArtists: extractFeaturedArtists(title)
  };
}

module.exports = { readMetadata };
