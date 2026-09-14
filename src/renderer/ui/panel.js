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
const filePlayBtn = document.getElementById('file-play-btn');
const filePauseBtn = document.getElementById('file-pause-btn');
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

function renderLibraryRows() {
  const filtered = filterEntries(libraryManager.entries, {
    searchText: librarySearch.value,
    favoritesOnly: libraryFavoritesOnly.checked,
    genre: libraryGenreFilter.value
  });
  const sorted = sortEntries(filtered, sortField, sortDirection);

  const genres = [...new Set(libraryManager.entries.map((e) => e.genre).filter(Boolean))].sort();
  const currentGenreValue = libraryGenreFilter.value;
  libraryGenreFilter.innerHTML = '<option value="">All Genres</option>' +
    genres.map((g) => `<option value="${g}">${g}</option>`).join('');
  libraryGenreFilter.value = currentGenreValue;

  libraryRows.innerHTML = '';
  for (const entry of sorted) {
    const row = document.createElement('tr');
    row.dataset.hash = entry.hash;

    const statusIcon = entry.error ? '⚠' : entry.processed ? '✓' : '⏳';
    const minutes = Math.floor(entry.duration / 60);
    const seconds = Math.floor(entry.duration % 60).toString().padStart(2, '0');

    row.innerHTML = `
      <td class="library-title-cell">${entry.title}</td>
      <td>${entry.artist}</td>
      <td>${entry.album}</td>
      <td>${entry.genre}</td>
      <td>${minutes}:${seconds}</td>
      <td>${entry.playCount}</td>
      <td class="library-favorite-cell">${entry.favorite ? '★' : '☆'}</td>
      <td><button class="library-remove-btn" title="Remove from library">✕</button> <span class="library-status-icon">${statusIcon}</span></td>
    `;

    row.querySelector('.library-title-cell').addEventListener('click', async () => {
      // fileSeek/fileTransport/stemMixer are the same consts already declared
      // earlier in this file by the prior feature's panel.js wiring.
      const ready = await libraryManager.playWhenReady(entry.hash);
      setCurrentPlayingHash(ready.hash);
      await fileAudioSource.loadFile(ready.filePath, null);
      fileAudioSource.play();
      fileSeek.max = fileAudioSource.getDuration();
      fileTransport.hidden = false;
      stemMixer.hidden = false;
    });

    // Both setFavorite and removeEntry already trigger onLibraryChanged
    // internally (wired to renderLibraryRows below) -- no need to also
    // re-render here, that would just render twice per click.
    row.querySelector('.library-favorite-cell').addEventListener('click', (e) => {
      e.stopPropagation();
      libraryManager.setFavorite(entry.hash, !entry.favorite);
    });

    row.querySelector('.library-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      libraryManager.removeEntry(entry.hash);
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
    fileProgress.hidden = false;
    // First use may need to download the ~258MB separation model, which can
    // take several minutes with no per-byte progress available yet — show a
    // reassuring static message instead of leaving the user on "Checking
    // cache…" indistinguishable from a hang. Real progress (below) overwrites
    // this as soon as separation actually starts reporting percentages.
    fileProgressLabel.textContent = 'Checking cache… (first use downloads a ~258MB model — this may take several minutes)';
    fileProgressBar.value = 0;

    await fileAudioSource.loadFile(filePath, (percent) => {
      fileProgressLabel.textContent = `Separating stems… ${Math.round(percent * 100)}%`;
      fileProgressBar.value = percent * 100;
    });

    fileProgress.hidden = true;
    fileTransport.hidden = false;
    stemMixer.hidden = false;
    fileSeek.max = fileAudioSource.getDuration();
    await refreshCacheSize();

    // Register this file with the library too, so it shows up as a row
    // (same small redundant re-hash tradeoff as LibraryManager's own
    // checkStemCache reuse — see Task 9's note).
    const { hash } = await window.electronAPI.checkStemCache(filePath);
    setCurrentPlayingHash(hash);
    const entries = await window.electronAPI.addSingleFileToLibrary(filePath);
    libraryManager.entries = entries;
    renderLibraryRows();
  } catch (err) {
    console.error('Failed to load/process audio file:', err);
    fileProgress.hidden = true;
    fileError.hidden = false;
    fileError.textContent = `Failed to process file: ${err.message || err}`;
  } finally {
    loadFileBtn.disabled = false;
  }
});

filePlayBtn.addEventListener('click', () => fileAudioSource.play());
filePauseBtn.addEventListener('click', () => fileAudioSource.pause());
fileSeek.addEventListener('input', (e) => fileAudioSource.seek(Number(e.target.value)));

for (const row of stemMixer.querySelectorAll('.stem-row')) {
  const stemName = row.dataset.stem;
  const muteBox = row.querySelector('.stem-mute');
  const volumeSlider = row.querySelector('.stem-volume');
  const soloBtn = row.querySelector('.stem-solo');

  muteBox.addEventListener('change', (e) => fileAudioSource.setStemMute(stemName, e.target.checked));
  volumeSlider.addEventListener('input', (e) => fileAudioSource.setStemVolume(stemName, Number(e.target.value)));

  let soloed = false;
  soloBtn.addEventListener('click', () => {
    soloed = !soloed;
    if (soloed) {
      fileAudioSource.soloStem(stemName);
      for (const otherRow of stemMixer.querySelectorAll('.stem-row')) {
        otherRow.querySelector('.stem-mute').checked = otherRow.dataset.stem !== stemName;
      }
    } else {
      fileAudioSource.clearSolo();
      for (const otherRow of stemMixer.querySelectorAll('.stem-row')) {
        otherRow.querySelector('.stem-mute').checked = false;
      }
    }
  });
}

clearCacheBtn.addEventListener('click', async () => {
  await window.electronAPI.clearStemCache();
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
  }
}
loadSettings();
