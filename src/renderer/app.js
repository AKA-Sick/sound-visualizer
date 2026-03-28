import { mapFrequencyBands, smoothBars } from './audio/processor.js';
import { SegmentedLED } from './visualizers/segmented-led.js';
import { NeonGlow } from './visualizers/neon-glow.js';
import { Mirrored } from './visualizers/mirrored.js';

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

import './ui/panel.js';

render();
