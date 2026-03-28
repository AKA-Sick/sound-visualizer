import { mapFrequencyBands, smoothBars } from './audio/processor.js';
import { SegmentedLED } from './visualizers/segmented-led.js';
import { NeonGlow } from './visualizers/neon-glow.js';
import { Mirrored } from './visualizers/mirrored.js';
import { togglePanel } from './ui/panel.js';

const canvas = document.getElementById('visualizer');
const ctx = canvas.getContext('2d');

let sampleRate = 48000;
let rawMidData = null;
let rawSideData = null;
let rawVocalMags = null;
let rawInstrumentMags = null;
let stemStatus = 'idle';
let currentBeat = false;
let currentVolume = 0;
let smoothedBars = new Float32Array(0);
let smoothedSideBars = new Float32Array(0);
let beatFlashIntensity = 0;

// Default settings
let settings = {
  mode: 'segmented-led',
  theme: 'neon',
  sensitivity: 1.0,
  vocalGain: 1.0,
  barCount: 64,
  barSize: 3,
  audioMode: 'normal',
  background: 'solid',
  freqLabels: false,
  beatEffect: 'none'
};

let currentVisualizer = null;
const visualizers = {};

// Receive audio data from main process
window.electronAPI.onSampleRate((rate) => { sampleRate = rate; });

window.electronAPI.onAudioData((data) => {
  rawMidData = data.midData;
  rawSideData = data.sideData;
  currentBeat = data.beat;
  currentVolume = data.volume;
  stemStatus = data.stemStatus || 'idle';
  if (data.vocalMags) rawVocalMags = data.vocalMags;
  if (data.instrumentMags) rawInstrumentMags = data.instrumentMags;
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

// In transparent mode, enable click-through except over interactive elements
const menuArea = document.getElementById('menu-area');
const panel = document.getElementById('panel');

document.addEventListener('mouseenter', () => {
  // forward: true means Electron still gets mouse position for hover detection
}, true);

menuArea.addEventListener('mouseenter', () => {
  window.electronAPI.setClickThrough(false);
});
menuArea.addEventListener('mouseleave', () => {
  if (settings.background === 'transparent' && !panel.classList.contains('open')) {
    window.electronAPI.setClickThrough(true);
  }
});
panel.addEventListener('mouseenter', () => {
  window.electronAPI.setClickThrough(false);
});
panel.addEventListener('mouseleave', () => {
  if (settings.background === 'transparent' && !panel.classList.contains('open')) {
    window.electronAPI.setClickThrough(true);
  }
});

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

window.addEventListener('resize', resize);
resize();

function render() {
  if (rawMidData) {
    // Vocal gain stacks with master sensitivity
    const vocalSens = settings.sensitivity * (settings.vocalGain || 1.0);

    // Map mid (center/vocal) and side (stereo/instrument) channels
    const halfCount = Math.ceil(settings.barCount / 2);
    const midBars = mapFrequencyBands(rawMidData, halfCount, sampleRate, vocalSens);
    const sideBars = mapFrequencyBands(rawSideData, halfCount, sampleRate, settings.sensitivity);

    const third = Math.floor(halfCount / 3);
    const bass = midBars.slice(0, third);
    const treble = midBars.slice(third, third * 2);
    const mids = midBars.slice(third * 2);

    // Left half: bass | treble | mids
    const leftBars = new Float32Array(halfCount);
    let pos = 0;
    for (const section of [bass, treble, mids]) {
      for (let i = 0; i < section.length; i++) leftBars[pos++] = section[i];
    }

    // Mirror: left half + left half reversed
    const targetBars = new Float32Array(settings.barCount);
    for (let i = 0; i < halfCount; i++) {
      targetBars[i] = leftBars[i];
      targetBars[settings.barCount - 1 - i] = leftBars[i];
    }
    smoothedBars = smoothBars(smoothedBars, targetBars, 0.7);

    // Side channel bars (same layout) for mid/side mode
    const sideBass = sideBars.slice(0, third);
    const sideTreble = sideBars.slice(third, third * 2);
    const sideMids = sideBars.slice(third * 2);
    const leftSide = new Float32Array(halfCount);
    let spos = 0;
    for (const section of [sideBass, sideTreble, sideMids]) {
      for (let i = 0; i < section.length; i++) leftSide[spos++] = section[i];
    }
    const targetSide = new Float32Array(settings.barCount);
    for (let i = 0; i < halfCount; i++) {
      targetSide[i] = leftSide[i];
      targetSide[settings.barCount - 1 - i] = leftSide[i];
    }
    smoothedSideBars = smoothBars(smoothedSideBars, targetSide, 0.7);

    // ML Stems mode: override with ML-separated data when available
    if (settings.audioMode === 'ml-stems' && rawVocalMags && rawInstrumentMags) {
      const mlVocal = mapFrequencyBands(rawVocalMags, halfCount, sampleRate, vocalSens);
      const mlInstr = mapFrequencyBands(rawInstrumentMags, halfCount, sampleRate, settings.sensitivity);

      // Same bass|treble|mids layout + mirror
      const vBass = mlVocal.slice(0, third);
      const vTreble = mlVocal.slice(third, third * 2);
      const vMids = mlVocal.slice(third * 2);
      const leftV = new Float32Array(halfCount);
      let vp = 0;
      for (const s of [vBass, vTreble, vMids]) {
        for (let i = 0; i < s.length; i++) leftV[vp++] = s[i];
      }
      const targetV = new Float32Array(settings.barCount);
      for (let i = 0; i < halfCount; i++) {
        targetV[i] = leftV[i];
        targetV[settings.barCount - 1 - i] = leftV[i];
      }
      smoothedBars = smoothBars(smoothedBars, targetV, 0.7);

      const iBass = mlInstr.slice(0, third);
      const iTreble = mlInstr.slice(third, third * 2);
      const iMids = mlInstr.slice(third * 2);
      const leftI = new Float32Array(halfCount);
      let ip = 0;
      for (const s of [iBass, iTreble, iMids]) {
        for (let i = 0; i < s.length; i++) leftI[ip++] = s[i];
      }
      const targetI = new Float32Array(settings.barCount);
      for (let i = 0; i < halfCount; i++) {
        targetI[i] = leftI[i];
        targetI[settings.barCount - 1 - i] = leftI[i];
      }
      smoothedSideBars = smoothBars(smoothedSideBars, targetI, 0.7);
    }
  }

  // Frequency labels drawing
  function drawFrequencyLabels(ctx, canvas) {
    const padLeft = 50;
    const drawWidth = canvas.width - padLeft;
    const sixth = drawWidth / 6;
    const audioMode = settings.audioMode || 'normal';
    const sectionNames = ['BASS', 'TREBLE', 'MIDS', 'MIDS', 'TREBLE', 'BASS'];
    const sectionRanges = ['20-200Hz', '2-20kHz', '200Hz-2kHz', '200Hz-2kHz', '2-20kHz', '20-200Hz'];
    const vocalSections = [false, false, true, true, false, false];
    const y = canvas.height - 8;

    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';

    for (let i = 0; i < 6; i++) {
      const sectionX = padLeft + i * sixth;
      const centerX = sectionX + sixth / 2;

      // Section divider line
      if (i > 0) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sectionX, 0);
        ctx.lineTo(sectionX, canvas.height);
        ctx.stroke();
      }

      // Background for label readability
      const isVocal = vocalSections[i] && (audioMode === 'vocal-highlight' || audioMode === 'mid-side');
      ctx.fillStyle = isVocal ? 'rgba(0, 80, 100, 0.7)' : 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(centerX - 35, y - 22, 70, 24);

      // Section name
      ctx.fillStyle = isVocal ? '#00eeff' : '#ffffff';
      const label = isVocal && audioMode === 'mid-side' ? 'MID' : sectionNames[i];
      ctx.fillText(label, centerX, y - 10);

      // Frequency range / mode label
      ctx.fillStyle = isVocal ? '#00aacc' : '#888888';
      const sublabel = isVocal ? 'VOCAL' : sectionRanges[i];
      ctx.fillText(sublabel, centerX, y);
    }
  }

  // Clear canvas
  if (settings.background === 'solid') {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else if (settings.background === 'gradient') {
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#16213e');
    grad.addColorStop(0.5, '#0f3460');
    grad.addColorStop(1, '#0a0a0a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Beat effects
  const effect = settings.beatEffect || 'none';
  if (currentBeat && effect !== 'none') {
    beatFlashIntensity = 1.0;
  }
  const beatActive = beatFlashIntensity > 0.01;

  // Pre-draw effects (flash, shake, scale)
  if (beatActive && effect === 'flash') {
    const gradient = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, 0,
      canvas.width / 2, canvas.height / 2, canvas.width * 0.6
    );
    gradient.addColorStop(0, `rgba(255, 255, 255, ${beatFlashIntensity * 0.4})`);
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (beatActive && effect === 'shake') {
    const shakeX = (Math.random() - 0.5) * 8 * beatFlashIntensity;
    ctx.save();
    ctx.translate(shakeX, 0);
  }

  if (beatActive && effect === 'scale') {
    const s = 1 + 0.05 * beatFlashIntensity;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(s, s);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }

  // Apply bounce: temporarily boost bar values
  let drawBars = smoothedBars;
  if (beatActive && effect === 'bounce') {
    drawBars = new Float32Array(smoothedBars.length);
    const boost = 1 + 0.4 * beatFlashIntensity;
    for (let i = 0; i < smoothedBars.length; i++) {
      drawBars[i] = Math.min(1, smoothedBars[i] * boost);
    }
  }

  // Apply color shift: pass to visualizer via settings override
  if (beatActive && effect === 'colorshift') {
    ctx._beatColorShift = beatFlashIntensity;
  } else {
    ctx._beatColorShift = 0;
  }

  // Pass side channel data and audio mode to visualizers
  // ml-stems uses the same visual treatment as mid-side (two bar sets)
  ctx._sideBars = smoothedSideBars;
  const mode = settings.audioMode || 'normal';
  ctx._audioMode = (mode === 'ml-stems' && rawVocalMags) ? 'mid-side' : mode;
  ctx._mlStemsActive = mode === 'ml-stems' && rawVocalMags != null;

  if (currentVisualizer && drawBars.length > 0) {
    currentVisualizer.draw(ctx, canvas, drawBars, settings, currentBeat);
  }

  // Post-draw effects: glow pulse overlay
  if (beatActive && effect === 'glow') {
    ctx.save();
    ctx.shadowBlur = 30 * beatFlashIntensity;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
    ctx.globalAlpha = beatFlashIntensity * 0.3;
    if (currentVisualizer && drawBars.length > 0) {
      currentVisualizer.draw(ctx, canvas, drawBars, settings, currentBeat);
    }
    ctx.restore();
  }

  // Border pulse
  if (beatActive && effect === 'border') {
    ctx.save();
    ctx.strokeStyle = `rgba(255, 255, 255, ${beatFlashIntensity * 0.6})`;
    ctx.lineWidth = 3 * beatFlashIntensity;
    ctx.shadowBlur = 15 * beatFlashIntensity;
    ctx.shadowColor = 'rgba(100, 200, 255, 0.8)';
    ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    ctx.restore();
  }

  // Restore transforms for shake/scale
  if (beatActive && (effect === 'shake' || effect === 'scale')) {
    ctx.restore();
  }

  // Frequency labels
  if (settings.freqLabels) {
    drawFrequencyLabels(ctx, canvas);
  }

  // ML Stems status indicator
  if (settings.audioMode === 'ml-stems') {
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    if (stemStatus === 'loading' || (stemStatus === 'ready' && !rawVocalMags)) {
      ctx.fillStyle = 'rgba(255, 200, 0, 0.7)';
      ctx.fillText('ML Model loading...', canvas.width - 10, 20);
    } else if (rawVocalMags) {
      ctx.fillStyle = 'rgba(0, 238, 255, 0.5)';
      ctx.fillText('ML Stems active', canvas.width - 10, 20);
    }
    ctx.textAlign = 'left';
  }

  // Decay beat intensity
  if (beatFlashIntensity > 0.01) {
    beatFlashIntensity *= 0.85;
  } else {
    beatFlashIntensity = 0;
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
