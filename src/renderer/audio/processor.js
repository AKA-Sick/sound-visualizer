export function mapFrequencyBands(frequencyData, barCount, sampleRate, sensitivity) {
  const bars = new Float32Array(barCount);
  const nyquist = sampleRate / 2;
  const minFreq = 20;
  const maxFreq = Math.min(20000, nyquist);
  const logMin = Math.log10(minFreq);
  const logMax = Math.log10(maxFreq);
  const binCount = frequencyData.length;
  const binSize = nyquist / binCount;

  for (let i = 0; i < barCount; i++) {
    const logLow = logMin + (logMax - logMin) * (i / barCount);
    const logHigh = logMin + (logMax - logMin) * ((i + 1) / barCount);
    const freqLow = Math.pow(10, logLow);
    const freqHigh = Math.pow(10, logHigh);
    const binLow = Math.max(0, Math.floor(freqLow / binSize));
    const binHigh = Math.min(binCount - 1, Math.floor(freqHigh / binSize));

    let sum = 0;
    let count = 0;
    for (let b = binLow; b <= binHigh; b++) {
      sum += frequencyData[b];
      count++;
    }
    bars[i] = count > 0 ? (sum / count) * sensitivity : 0;
  }
  return bars;
}

export function smoothBars(current, target, smoothing) {
  const result = new Float32Array(target.length);
  for (let i = 0; i < target.length; i++) {
    const prev = i < current.length ? current[i] : 0;
    result[i] = prev + (target[i] - prev) * (1 - smoothing);
  }
  return result;
}
