import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const addon = require('../src/native/build/Release/audio_capture.node');

console.log('Starting capture...');
const ok = addon.startCapture();
console.log('Started:', ok);
console.log('Sample rate:', addon.getSampleRate());

// Wait 1 second, then read audio data
setTimeout(() => {
  const data = addon.getAudioData();
  if (data) {
    console.log('Frequency bins:', data.frequencyData.length);
    console.log('Beat:', data.beat);
    console.log('Volume:', data.volume.toFixed(4));
    const nonZero = Array.from(data.frequencyData).filter(v => v > 0).length;
    console.log('Non-zero bins:', nonZero);
  } else {
    console.log('No data (null)');
  }
  addon.stopCapture();
  console.log('Stopped.');
}, 1000);
