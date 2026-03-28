import { setVisualizer, updateSettings, settings } from '../app.js';

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
    document.getElementById('sensitivity').value = saved.sensitivity;
    document.getElementById('sensitivity-val').textContent = saved.sensitivity.toFixed(1);
    document.getElementById('barcount').value = saved.barCount;
    document.getElementById('barcount-val').textContent = saved.barCount;
    document.getElementById('bg-select').value = saved.background;
    document.getElementById('beat-flash').checked = saved.beatFlash;
  }
}
loadSettings();
