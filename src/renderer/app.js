import { mapFrequencyBands, smoothBars } from './audio/processor.js';
import { SegmentedLED } from './visualizers/segmented-led.js';
import { NeonGlow } from './visualizers/neon-glow.js';
import { Mirrored } from './visualizers/mirrored.js';
import { togglePanel } from './ui/panel.js';

const canvas = document.getElementById('visualizer');
const ctx = canvas.getContext('2d');

let sampleRate = 48000;
let rawFrequencyData = null;
let currentBeat = false;
let currentVolume = 0;
let smoothedBars = new Float32Array(0);

// Default settings
let settings = {
  mode: 'segmented-led',
  theme: 'neon',
  sensitivity: 1.0,
  barCount: 64,
  background: 'solid',
  beatFlash: false
};

let currentVisualizer = null;
const visualizers = {};

// Receive audio data from main process
window.electronAPI.onSampleRate((rate) => { sampleRate = rate; });

window.electronAPI.onAudioData((data) => {
  rawFrequencyData = data.frequencyData;
  currentBeat = data.beat;
  currentVolume = data.volume;
});

window.electronAPI.onApplySettings((newSettings) => {
  updateSettings(newSettings);
  setVisualizer(newSettings.mode);
  if (newSettings.background === 'transparent') {
    document.body.classList.add('transparent');
  } else {
    document.body.classList.remove('transparent');
  }
});

function resize() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}

window.addEventListener('resize', resize);
resize();

function render() {
  if (rawFrequencyData) {
    const targetBars = mapFrequencyBands(
      rawFrequencyData, settings.barCount, sampleRate, settings.sensitivity
    );
    smoothedBars = smoothBars(smoothedBars, targetBars, 0.7);
  }

  // Clear canvas
  if (settings.background === 'solid') {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else if (settings.background === 'gradient') {
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#1a1a2e');
    grad.addColorStop(1, '#0a0a0a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Beat flash overlay
  if (settings.beatFlash && currentBeat) {
    const gradient = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, 0,
      canvas.width / 2, canvas.height / 2, canvas.width * 0.6
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (currentVisualizer && smoothedBars.length > 0) {
    currentVisualizer.draw(ctx, canvas, smoothedBars, settings, currentBeat);
  }

  // Reset beat after one frame
  currentBeat = false;

  requestAnimationFrame(render);
}

// Export for use by panel.js and other modules
export { settings, visualizers, resize };

export function setVisualizer(name) {
  settings.mode = name;
  currentVisualizer = visualizers[name] || null;
}

export function registerVisualizer(name, instance) {
  visualizers[name] = instance;
}

export function updateSettings(newSettings) {
  Object.assign(settings, newSettings);
  if (settings.barCount !== smoothedBars.length) {
    smoothedBars = new Float32Array(settings.barCount);
  }
}

registerVisualizer('segmented-led', new SegmentedLED());
registerVisualizer('neon-glow', new NeonGlow());
registerVisualizer('mirrored', new Mirrored());
setVisualizer('segmented-led');

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

  switch (e.key) {
    case 'Tab':
      e.preventDefault();
      togglePanel();
      break;
    case '1':
      setVisualizer('neon-glow');
      updateModeButtons('neon-glow');
      window.electronAPI.saveSettings(settings);
      break;
    case '2':
      setVisualizer('mirrored');
      updateModeButtons('mirrored');
      window.electronAPI.saveSettings(settings);
      break;
    case '3':
      setVisualizer('segmented-led');
      updateModeButtons('segmented-led');
      window.electronAPI.saveSettings(settings);
      break;
    case 't':
    case 'T': {
      const bg = settings.background === 'transparent' ? 'solid' : 'transparent';
      updateSettings({ background: bg });
      document.getElementById('bg-select').value = bg;
      if (bg === 'transparent') {
        document.body.classList.add('transparent');
        window.electronAPI.setTransparent(true);
      } else {
        document.body.classList.remove('transparent');
        window.electronAPI.setTransparent(false);
      }
      window.electronAPI.saveSettings(settings);
      break;
    }
    case 'Escape':
      window.close();
      break;
  }
});

function updateModeButtons(mode) {
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

render();
