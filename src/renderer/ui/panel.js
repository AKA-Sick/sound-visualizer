import { setVisualizer, updateSettings, settings } from '../app.js';
import { fileAudioSource, setSourceMode } from '../app.js';
import { libraryManager, setCurrentPlayingHash } from '../app.js';
import { sortEntries, filterEntries } from '../audio/library-sort-filter.js';

const panel = document.getElementById('panel');
const menuBtn = document.getElementById('menu-btn');

// Toggle panel
menuBtn.addEventListener('click', () => panel.classList.toggle('open'));

export function togglePanel() {
  panel.classList.toggle('open');
}

// Resizable sidebar: a drag handle on the panel's right edge.
const panelResizeHandle = document.getElementById('panel-resize-handle');

function applyPanelWidth(width) {
  panel.style.width = `${width}px`;
  panelResizeHandle.style.left = `${width}px`;
}

(function setupPanelResize() {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  panelResizeHandle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    panelResizeHandle.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const minWidth = 180;
    const maxWidth = window.innerWidth * 0.7;
    const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + (e.clientX - startX)));
    applyPanelWidth(newWidth);
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panelResizeHandle.classList.remove('dragging');
    updateSettings({ panelWidth: panel.getBoundingClientRect().width });
    window.electronAPI.saveSettings(settings);
  });
})();

// Mode buttons
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setVisualizer(btn.dataset.mode);
    window.electronAPI.saveSettings(settings);
  });
});

// Theme select
document.getElementById('theme-select').addEventListener('change', (e) => {
  updateSettings({ theme: e.target.value });
  window.electronAPI.saveSettings(settings);
});

// Sensitivity slider
const sensitivitySlider = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivity-val');
sensitivitySlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  sensitivityVal.textContent = val.toFixed(1);
  updateSettings({ sensitivity: val });
  window.electronAPI.saveSettings(settings);
});

// Bar count slider
const barcountSlider = document.getElementById('barcount');
const barcountVal = document.getElementById('barcount-val');
barcountSlider.addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  barcountVal.textContent = val;
  updateSettings({ barCount: val });
  window.electronAPI.saveSettings(settings);
});

// Background select
document.getElementById('bg-select').addEventListener('change', (e) => {
  updateSettings({ background: e.target.value });
  if (e.target.value === 'transparent') {
    document.body.classList.add('transparent');
    window.electronAPI.setTransparent(true);
  } else {
    document.body.classList.remove('transparent');
    window.electronAPI.setTransparent(false);
  }
  window.electronAPI.saveSettings(settings);
});

// Beat flash toggle
document.getElementById('beat-flash').addEventListener('change', (e) => {
  updateSettings({ beatFlash: e.target.checked });
  window.electronAPI.saveSettings(settings);
});

// Source toggle (live system audio vs. loaded audio file)
const sourceSelect = document.getElementById('source-select');
const fileControls = document.getElementById('file-controls');
const loadFileBtn = document.getElementById('load-file-btn');
const fileProgress = document.getElementById('file-progress');
const fileProgressLabel = document.getElementById('file-progress-label');
const fileProgressBar = document.getElementById('file-progress-bar');
const fileError = document.getElementById('file-error');
const fileTransport = document.getElementById('file-transport');
const filePlayPauseBtn = document.getElementById('file-playpause-btn');
const filePrevBtn = document.getElementById('file-prev-btn');
const fileNextBtn = document.getElementById('file-next-btn');
const fileSeek = document.getElementById('file-seek');
const stemMixer = document.getElementById('stem-mixer');
const cacheSizeLabel = document.getElementById('cache-size-label');
const clearCacheBtn = document.getElementById('clear-cache-btn');

// loadFileBtn is already declared above (prior feature's Task 10) --
// do not redeclare it here, panel.js is a single module scope. Just reuse it below.
const loadFolderBtn = document.getElementById('load-folder-btn');
const librarySearch = document.getElementById('library-search');
const libraryGenreFilter = document.getElementById('library-genre-filter');
const libraryFavoritesOnly = document.getElementById('library-favorites-only');
const libraryRows = document.getElementById('library-rows');
const queueStatus = document.getElementById('queue-status');
const queueStatusLabel = document.getElementById('queue-status-label');

let sortField = 'title';
let sortDirection = 'asc';
let lastSortedEntries = [];
let currentPlayingHash = null;

// Resizable columns: a drag handle injected into each sortable header.
// Headers are static markup (not rebuilt per render), so this runs once.
function setupColumnResize() {
  for (const th of document.querySelectorAll('#library-table th[data-sort-field]')) {
    const handle = document.createElement('div');
    handle.className = 'column-resize-handle';
    th.appendChild(handle);

    // A click that both starts and ends inside the handle would otherwise
    // bubble up and also trigger the header's own sort-toggle click handler.
    handle.addEventListener('click', (e) => e.stopPropagation());

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = th.getBoundingClientRect().width;
      handle.classList.add('dragging');
      e.preventDefault();
      e.stopPropagation();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const newWidth = Math.max(40, startWidth + (e.clientX - startX));
      th.style.width = `${newWidth}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      const field = th.dataset.sortField;
      const widths = { ...settings.libraryColumnWidths, [field]: th.getBoundingClientRect().width };
      updateSettings({ libraryColumnWidths: widths });
      window.electronAPI.saveSettings(settings);
    });
  }
}

function applyColumnWidths(widths) {
  if (!widths) return;
  for (const th of document.querySelectorAll('#library-table th[data-sort-field]')) {
    const w = widths[th.dataset.sortField];
    if (w) th.style.width = `${w}px`;
  }
}

// Right-click context menu (Play / Delete / Genre submenu) for library rows.
const contextMenuEl = document.getElementById('library-context-menu');

function hideContextMenu() {
  contextMenuEl.hidden = true;
  contextMenuEl.innerHTML = '';
}

function buildMenuItem(label, onClick) {
  const item = document.createElement('div');
  item.className = 'context-menu-item';
  item.textContent = label;
  item.addEventListener('click', () => {
    hideContextMenu();
    onClick();
  });
  return item;
}

function showLibraryContextMenu(x, y, entry) {
  contextMenuEl.innerHTML = '';

  contextMenuEl.appendChild(buildMenuItem('Play', () => playLibraryEntry(entry)));
  contextMenuEl.appendChild(buildMenuItem('Delete', () => libraryManager.removeEntry(entry.hash)));

  const genreItem = document.createElement('div');
  genreItem.className = 'context-menu-item has-submenu';
  const genreLabel = document.createElement('span');
  genreLabel.textContent = 'Genre';
  genreItem.appendChild(genreLabel);

  const submenu = document.createElement('div');
  submenu.className = 'context-menu-submenu context-menu';
  const genres = [...new Set(libraryManager.entries.map((e) => e.genre).filter(Boolean))].sort();
  for (const g of genres) {
    submenu.appendChild(buildMenuItem(g, () => libraryManager.setGenre(entry.hash, g)));
  }
  submenu.appendChild(buildMenuItem('Add new genre…', () => {
    const newGenre = prompt('Enter a genre:', entry.genre || '');
    if (newGenre && newGenre.trim()) libraryManager.setGenre(entry.hash, newGenre.trim());
  }));
  genreItem.appendChild(submenu);
  contextMenuEl.appendChild(genreItem);

  contextMenuEl.style.left = `${x}px`;
  contextMenuEl.style.top = `${y}px`;
  contextMenuEl.hidden = false;
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

async function playLibraryEntry(entry) {
  try {
    const ready = await libraryManager.playWhenReady(entry.hash);
    currentPlayingHash = ready.hash;
    setCurrentPlayingHash(ready.hash);
    await fileAudioSource.loadFile(ready.filePath, null);
    fileAudioSource.play();
    fileSeek.max = fileAudioSource.getDuration();
    fileTransport.hidden = false;
    stemMixer.hidden = false;
    updatePlayPauseIcon();
  } catch (err) {
    console.error(`Failed to play "${entry.title}":`, err);
    fileError.hidden = false;
    fileError.textContent = `Failed to play "${entry.title}": ${err.message || err}`;
  }
}

function renderLibraryRows() {
  const filtered = filterEntries(libraryManager.entries, {
    searchText: librarySearch.value,
    favoritesOnly: libraryFavoritesOnly.checked,
    genre: libraryGenreFilter.value
  });
  const sorted = sortEntries(filtered, sortField, sortDirection);
  lastSortedEntries = sorted;

  const genres = [...new Set(libraryManager.entries.map((e) => e.genre).filter(Boolean))].sort();
  const currentGenreValue = libraryGenreFilter.value;
  libraryGenreFilter.innerHTML = '';
  libraryGenreFilter.appendChild(new Option('All Genres', ''));
  for (const g of genres) libraryGenreFilter.appendChild(new Option(g, g));
  libraryGenreFilter.value = currentGenreValue;

  // Rows are built via document.createElement/textContent rather than an
  // innerHTML template string -- title/artist/album/genre come from embedded
  // file tags (ID3/Vorbis/MP4), i.e. third-party content from whatever files
  // "Load Folder..." is pointed at. Interpolating that untrusted text into
  // .innerHTML would let a maliciously-tagged file inject a script with full
  // access to window.electronAPI (arbitrary file reads, cache clearing,
  // etc.); textContent renders it as inert literal text instead.
  libraryRows.innerHTML = '';
  for (const entry of sorted) {
    const row = document.createElement('tr');
    row.dataset.hash = entry.hash;

    const statusIcon = entry.error ? '⚠' : entry.processed ? '✓' : '⏳';
    const minutes = Math.floor(entry.duration / 60);
    const seconds = Math.floor(entry.duration % 60).toString().padStart(2, '0');
    const addedStr = entry.dateAdded ? new Date(entry.dateAdded).toLocaleDateString() : '';
    const lastPlayedStr = entry.lastPlayed ? new Date(entry.lastPlayed).toLocaleDateString() : 'Never';

    const titleCell = document.createElement('td');
    titleCell.className = 'library-title-cell';
    titleCell.textContent = entry.title;
    titleCell.style.cursor = 'pointer';

    const artistCell = document.createElement('td');
    artistCell.textContent = entry.artist;

    const albumCell = document.createElement('td');
    albumCell.textContent = entry.album;

    const genreCell = document.createElement('td');
    genreCell.textContent = entry.genre;

    const durationCell = document.createElement('td');
    durationCell.textContent = `${minutes}:${seconds}`;

    const playCountCell = document.createElement('td');
    playCountCell.textContent = String(entry.playCount);

    const addedCell = document.createElement('td');
    addedCell.textContent = addedStr;

    const lastPlayedCell = document.createElement('td');
    lastPlayedCell.textContent = lastPlayedStr;

    const favoriteCell = document.createElement('td');
    favoriteCell.className = 'library-favorite-cell';
    favoriteCell.textContent = entry.favorite ? '★' : '☆';

    const actionsCell = document.createElement('td');
    actionsCell.className = 'library-status-icon';
    actionsCell.textContent = statusIcon;

    row.append(titleCell, artistCell, albumCell, genreCell, durationCell, playCountCell, addedCell, lastPlayedCell, favoriteCell, actionsCell);

    titleCell.addEventListener('click', () => playLibraryEntry(entry));

    // Right-click anywhere on the row opens Play/Delete/Genre — replaces the
    // old always-visible ✕ button.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showLibraryContextMenu(e.clientX, e.clientY, entry);
    });

    // setFavorite already triggers onLibraryChanged internally (wired to
    // renderLibraryRows below) -- no need to also re-render here, that would
    // just render twice per click.
    favoriteCell.addEventListener('click', (e) => {
      e.stopPropagation();
      libraryManager.setFavorite(entry.hash, !entry.favorite);
    });

    libraryRows.appendChild(row);
  }
}

for (const th of document.querySelectorAll('#library-table th[data-sort-field]')) {
  th.addEventListener('click', () => {
    const field = th.dataset.sortField;
    if (sortField === field) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortField = field;
      sortDirection = 'asc';
    }
    renderLibraryRows();
  });
}

setupColumnResize();

librarySearch.addEventListener('input', renderLibraryRows);
libraryGenreFilter.addEventListener('change', renderLibraryRows);
libraryFavoritesOnly.addEventListener('change', renderLibraryRows);

loadFolderBtn.addEventListener('click', async () => {
  const folderPath = await window.electronAPI.pickFolder();
  if (!folderPath) return;

  // Same busy-guard pattern as loadFileBtn -- prevents a double-click from
  // re-scanning (re-hashing/re-tagging every file) while a scan is already
  // running. The actual processing queue is separately protected against
  // concurrent draining by LibraryManager's own `this.processing` flag.
  loadFolderBtn.disabled = true;
  try {
    await libraryManager.addFolder(folderPath);
    renderLibraryRows();
  } finally {
    loadFolderBtn.disabled = false;
  }
});

window.electronAPI.onFolderScanProgress(({ current, total, fileName }) => {
  queueStatus.hidden = false;
  queueStatusLabel.textContent = `Scanning folder… ${current}/${total}: ${fileName}`;
});

// Deferred via queueMicrotask: app.js (the entry module) imports panel.js
// (for togglePanel) *before* app.js's own top-level code reaches
// `export const libraryManager = new LibraryManager(...)`. Because of that
// circular import, touching `libraryManager` synchronously here at
// panel.js's module top level -- while app.js is still mid-evaluation --
// throws "Cannot access 'libraryManager' before initialization" (TDZ) and
// aborts the whole module graph. Static ES module evaluation (no top-level
// await anywhere in this graph) runs as a single synchronous job, so a
// microtask queued here is guaranteed to run only after that entire job
// -- including the rest of app.js -- has finished, by which point
// `libraryManager` is fully initialized.
queueMicrotask(() => {
  const originalLibraryManagerOnLibraryChanged = libraryManager.onLibraryChanged;
  libraryManager.onLibraryChanged = (entries) => {
    originalLibraryManagerOnLibraryChanged(entries);
    renderLibraryRows();
  };

  libraryManager.onQueueProgress = ({ hash, title, queueTotal, percent }) => {
    queueStatus.hidden = false;
    queueStatusLabel.textContent = `Processing "${title}" (${queueTotal} remaining) — ${Math.round(percent * 100)}%`;
    if (percent >= 1) {
      setTimeout(() => { if (libraryManager.queue.isEmpty) queueStatus.hidden = true; }, 500);
    }
  };

  libraryManager.loadLibrary();
});

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshCacheSize() {
  const size = await window.electronAPI.getStemCacheSize();
  cacheSizeLabel.textContent = `Cache: ${formatBytes(size)}`;
}

sourceSelect.addEventListener('change', (e) => {
  setSourceMode(e.target.value);
  fileControls.hidden = e.target.value !== 'file';
  if (e.target.value === 'file') refreshCacheSize();
  window.electronAPI.saveSettings(settings);
});

loadFileBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.pickAudioFile();
  if (!filePath) return;

  loadFileBtn.disabled = true;
  try {
    fileError.hidden = true;
    fileError.textContent = '';
    fileTransport.hidden = true;
    stemMixer.hidden = true;

    // Routed through libraryManager (the same queue folder-loaded songs use)
    // instead of calling fileAudioSource.loadFile() directly, so a full ONNX
    // separation triggered here can never run concurrently with one already
    // in flight from a background folder scan. Progress for this load now
    // surfaces via the shared queue-status line (see libraryManager.onQueueProgress
    // wiring below) instead of the fileProgress/fileProgressLabel/fileProgressBar
    // elements, which are no longer used by this handler.
    const entry = await libraryManager.addFile(filePath);
    if (!entry) throw new Error('Failed to add file to library');
    renderLibraryRows();

    // playLibraryEntry handles playWhenReady + setCurrentPlayingHash +
    // loadFile + play + unhiding the transport/mixer + the play/pause icon,
    // same as clicking a row in the table -- reused here so both paths stay
    // in sync (e.g. for Previous/Next to work correctly regardless of how
    // the current song was loaded).
    await playLibraryEntry(entry);
    await refreshCacheSize();
    renderLibraryRows();
  } catch (err) {
    console.error('Failed to load/process audio file:', err);
    fileError.hidden = false;
    fileError.textContent = `Failed to process file: ${err.message || err}`;
  } finally {
    loadFileBtn.disabled = false;
  }
});

function updatePlayPauseIcon() {
  const playing = fileAudioSource.isPlaying;
  filePlayPauseBtn.textContent = playing ? '⏸' : '▶';
  filePlayPauseBtn.title = playing ? 'Pause' : 'Play';
}

filePlayPauseBtn.addEventListener('click', () => {
  if (fileAudioSource.isPlaying) {
    fileAudioSource.pause();
  } else {
    fileAudioSource.play();
  }
  updatePlayPauseIcon();
});

function skipBy(delta) {
  if (!currentPlayingHash || lastSortedEntries.length === 0) return;
  const idx = lastSortedEntries.findIndex((e) => e.hash === currentPlayingHash);
  if (idx === -1) return;
  const nextIdx = (idx + delta + lastSortedEntries.length) % lastSortedEntries.length;
  playLibraryEntry(lastSortedEntries[nextIdx]);
}

filePrevBtn.addEventListener('click', () => skipBy(-1));
fileNextBtn.addEventListener('click', () => skipBy(1));

fileSeek.addEventListener('input', (e) => fileAudioSource.seek(Number(e.target.value)));

// Catches "track ended naturally" (fileAudioSource pauses itself internally
// when playback reaches the end) -- a plain click handler can't see that,
// since nothing else calls back into panel.js when it happens.
setInterval(updatePlayPauseIcon, 500);

// A single shared "which stem is soloed" value, not one boolean per button --
// the old per-button closures each tracked their own local `soloed` flag, so
// soloing stem B while stem A was already soloed left A's own button still
// thinking it was active, making a second click on A incorrectly clear solo
// entirely instead of re-soloing A.
let soloedStem = null;

for (const row of stemMixer.querySelectorAll('.stem-row')) {
  const stemName = row.dataset.stem;
  const enabledBox = row.querySelector('.stem-enabled');
  const volumeSlider = row.querySelector('.stem-volume');
  const volumeVal = row.querySelector('.stem-volume-val');
  const soloBtn = row.querySelector('.stem-solo');

  // The toggle reads as "on" when checked (the intuitive direction) --
  // fileAudioSource's API is mute-based, so invert here at the boundary.
  enabledBox.addEventListener('change', (e) => {
    fileAudioSource.setStemMute(stemName, !e.target.checked);
  });

  volumeSlider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    fileAudioSource.setStemVolume(stemName, val);
    volumeVal.textContent = `${Math.round(val * 100)}%`;
  });

  soloBtn.addEventListener('click', () => {
    if (soloedStem === stemName) {
      fileAudioSource.clearSolo();
      soloedStem = null;
      for (const otherRow of stemMixer.querySelectorAll('.stem-row')) {
        otherRow.querySelector('.stem-enabled').checked = true;
        otherRow.querySelector('.stem-solo').classList.remove('active');
      }
    } else {
      fileAudioSource.soloStem(stemName);
      soloedStem = stemName;
      for (const otherRow of stemMixer.querySelectorAll('.stem-row')) {
        const isThisOne = otherRow.dataset.stem === stemName;
        otherRow.querySelector('.stem-enabled').checked = isThisOne;
        otherRow.querySelector('.stem-solo').classList.toggle('active', isThisOne);
      }
    }
  });
}

clearCacheBtn.addEventListener('click', async () => {
  await window.electronAPI.clearStemCache();
  libraryManager.entries = await window.electronAPI.resetAllProcessed();
  renderLibraryRows();
  await refreshCacheSize();
});

// Load saved settings on startup
async function loadSettings() {
  const saved = await window.electronAPI.getSettings();
  if (saved) {
    updateSettings(saved);
    setVisualizer(saved.mode);
    // Update UI to reflect loaded settings
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === saved.mode);
    });
    document.getElementById('theme-select').value = saved.theme;
    document.getElementById('source-select').value = saved.source || 'live';
    setSourceMode(saved.source || 'live');
    fileControls.hidden = (saved.source || 'live') !== 'file';
    document.getElementById('sensitivity').value = saved.sensitivity;
    document.getElementById('sensitivity-val').textContent = saved.sensitivity.toFixed(1);
    document.getElementById('barcount').value = saved.barCount;
    document.getElementById('barcount-val').textContent = saved.barCount;
    document.getElementById('bg-select').value = saved.background;
    document.getElementById('beat-flash').checked = saved.beatFlash;
    applyPanelWidth(saved.panelWidth || 250);
    applyColumnWidths(saved.libraryColumnWidths);
  }
}
loadSettings();
