import { setVisualizer, updateSettings, settings } from '../app.js';
import { fileAudioSource, setSourceMode } from '../app.js';

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
});

loadFileBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.pickAudioFile();
  if (!filePath) return;

  fileError.hidden = true;
  fileError.textContent = '';
  fileTransport.hidden = true;
  stemMixer.hidden = true;
  fileProgress.hidden = false;
  fileProgressLabel.textContent = 'Checking cache…';
  fileProgressBar.value = 0;

  try {
    await fileAudioSource.loadFile(filePath, (percent) => {
      fileProgressLabel.textContent = `Separating stems… ${Math.round(percent * 100)}%`;
      fileProgressBar.value = percent * 100;
    });

    fileProgress.hidden = true;
    fileTransport.hidden = false;
    stemMixer.hidden = false;
    fileSeek.max = fileAudioSource.getDuration();
    await refreshCacheSize();
  } catch (err) {
    console.error('Failed to load/process audio file:', err);
    fileProgress.hidden = true;
    fileError.hidden = false;
    fileError.textContent = `Failed to process file: ${err.message || err}`;
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
    document.getElementById('sensitivity').value = saved.sensitivity;
    document.getElementById('sensitivity-val').textContent = saved.sensitivity.toFixed(1);
    document.getElementById('barcount').value = saved.barCount;
    document.getElementById('barcount-val').textContent = saved.barCount;
    document.getElementById('bg-select').value = saved.background;
    document.getElementById('beat-flash').checked = saved.beatFlash;
  }
}
loadSettings();
