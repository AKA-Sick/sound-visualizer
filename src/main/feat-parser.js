const FEAT_PATTERN = /[([]?\s*(?:feat\.?|ft\.?|featuring|with)\s+([^()[\]]+?)\s*[)\]]?$/i;

function extractFeaturedArtists(title) {
  if (!title) return [];
  const match = title.match(FEAT_PATTERN);
  if (!match) return [];
  return match[1]
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

module.exports = { extractFeaturedArtists };
