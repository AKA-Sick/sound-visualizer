// Two branches, not one shared alternation:
//   1. "with" must be inside parens/brackets -- it's too common an ordinary
//      English word (e.g. "Stuck With You") to safely treat as a features
//      marker unless it's bracket-confined, which also matches how the
//      design spec itself writes the example ("(with ...)", parens included).
//   2. feat/ft/featuring may appear bare (no parens needed, e.g. "Song feat.
//      Artist") but must sit at a word boundary -- without `\b`, "ft" matches
//      the literal substring inside ordinary words like "Drift" or "Swift".
const FEAT_PATTERN = /(?:[([]\s*with\s+([^()[\]]+?)\s*[)\]]$|[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+?)\s*[)\]]?$)/i;

function extractFeaturedArtists(title) {
  if (!title) return [];
  const match = title.match(FEAT_PATTERN);
  if (!match) return [];
  const namesPart = match[1] || match[2];
  return namesPart
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

module.exports = { extractFeaturedArtists };
