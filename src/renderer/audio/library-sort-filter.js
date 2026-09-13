function compareEntries(a, b, field, direction) {
  let result;
  switch (field) {
    case 'title':
    case 'artist':
    case 'album':
      result = a[field].localeCompare(b[field]);
      break;
    case 'dateAdded':
    case 'lastPlayed':
      result = (a[field] ? new Date(a[field]).getTime() : 0) - (b[field] ? new Date(b[field]).getTime() : 0);
      break;
    case 'playCount':
    case 'duration':
      result = a[field] - b[field];
      break;
    default:
      result = 0;
  }
  return direction === 'desc' ? -result : result;
}

export function sortEntries(entries, field, direction) {
  return [...entries].sort((a, b) => compareEntries(a, b, field, direction));
}

export function filterEntries(entries, { searchText = '', favoritesOnly = false, genre = '' } = {}) {
  const needle = searchText.trim().toLowerCase();
  return entries.filter((e) => {
    if (favoritesOnly && !e.favorite) return false;
    if (genre && e.genre !== genre) return false;
    if (needle) {
      const haystack = [e.title, e.artist, e.album, ...(e.featuredArtists || [])].join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}
