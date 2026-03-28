// STFT utilities for ML stem separation
// Implements forward STFT needed for MDX-Net input

const N_FFT = 2048;
const HOP_LENGTH = 1024;
const NUM_FRAMES = 256;
const NUM_BINS = 1024; // n_fft/2, drop Nyquist

// Hann window
const hannWindow = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N_FFT - 1)));
}

// Radix-2 Cooley-Tukey FFT (in-place, complex interleaved)
// data = [re0, im0, re1, im1, ...] length = 2*n
function fftInPlace(data, n) {
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      let ti = i * 2, tj = j * 2;
      let tr = data[ti]; data[ti] = data[tj]; data[tj] = tr;
      tr = data[ti + 1]; data[ti + 1] = data[tj + 1]; data[tj + 1] = tr;
    }
  }

  // Butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uIdx = (i + j) * 2;
        const vIdx = (i + j + len / 2) * 2;
        const vRe = data[vIdx] * curRe - data[vIdx + 1] * curIm;
        const vIm = data[vIdx] * curIm + data[vIdx + 1] * curRe;
        data[vIdx] = data[uIdx] - vRe;
        data[vIdx + 1] = data[uIdx + 1] - vIm;
        data[uIdx] += vRe;
        data[uIdx + 1] += vIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

// Compute STFT of a single channel
// Returns { real: Float32Array[NUM_BINS * NUM_FRAMES], imag: Float32Array[NUM_BINS * NUM_FRAMES] }
function stft(signal) {
  const totalSamples = (NUM_FRAMES - 1) * HOP_LENGTH + N_FFT;
  // Pad signal if needed
  const padded = new Float32Array(totalSamples);
  const copyLen = Math.min(signal.length, totalSamples);
  padded.set(signal.subarray ? signal.subarray(0, copyLen) : signal.slice(0, copyLen));

  const real = new Float32Array(NUM_BINS * NUM_FRAMES);
  const imag = new Float32Array(NUM_BINS * NUM_FRAMES);
  const fftBuffer = new Float64Array(N_FFT * 2);

  for (let frame = 0; frame < NUM_FRAMES; frame++) {
    const start = frame * HOP_LENGTH;

    // Apply window and prepare complex input
    for (let i = 0; i < N_FFT; i++) {
      fftBuffer[i * 2] = padded[start + i] * hannWindow[i];
      fftBuffer[i * 2 + 1] = 0;
    }

    fftInPlace(fftBuffer, N_FFT);

    // Extract first NUM_BINS (drop Nyquist)
    const offset = frame * NUM_BINS;
    for (let i = 0; i < NUM_BINS; i++) {
      real[offset + i] = fftBuffer[i * 2];
      imag[offset + i] = fftBuffer[i * 2 + 1];
    }
  }

  return { real, imag };
}

// Build model input tensor [1, 4, NUM_BINS, NUM_FRAMES]
// from left and right channel audio
// Layout: [L_real, L_imag, R_real, R_imag]
function buildModelInput(leftAudio, rightAudio) {
  const leftSTFT = stft(leftAudio);
  const rightSTFT = stft(rightAudio);

  // Tensor layout: [1, 4, 1024, 256] stored as flat Float32Array
  // Channel 0: L real, Channel 1: L imag, Channel 2: R real, Channel 3: R imag
  const size = NUM_BINS * NUM_FRAMES;
  const tensor = new Float32Array(4 * size);

  // Transpose from [bins * frames] to [bins, frames] layout
  for (let b = 0; b < NUM_BINS; b++) {
    for (let f = 0; f < NUM_FRAMES; f++) {
      const srcIdx = f * NUM_BINS + b;
      const dstIdx = b * NUM_FRAMES + f;
      tensor[0 * size + dstIdx] = leftSTFT.real[srcIdx];
      tensor[1 * size + dstIdx] = leftSTFT.imag[srcIdx];
      tensor[2 * size + dstIdx] = rightSTFT.real[srcIdx];
      tensor[3 * size + dstIdx] = rightSTFT.imag[srcIdx];
    }
  }

  return tensor;
}

// Extract frequency magnitudes from the model output mask
// Returns { vocalMags: Float32Array[NUM_BINS], instrumentMags: Float32Array[NUM_BINS] }
function extractMagnitudes(inputTensor, maskTensor) {
  const size = NUM_BINS * NUM_FRAMES;

  // Average magnitudes across all time frames for visualization
  const vocalMags = new Float32Array(NUM_BINS);
  const instrumentMags = new Float32Array(NUM_BINS);

  for (let b = 0; b < NUM_BINS; b++) {
    let vocalSum = 0;
    let instrSum = 0;

    for (let f = 0; f < NUM_FRAMES; f++) {
      const idx = b * NUM_FRAMES + f;
      // Input magnitude (average L and R)
      const lReal = inputTensor[0 * size + idx];
      const lImag = inputTensor[1 * size + idx];
      const rReal = inputTensor[2 * size + idx];
      const rImag = inputTensor[3 * size + idx];
      const lMag = Math.sqrt(lReal * lReal + lImag * lImag);
      const rMag = Math.sqrt(rReal * rReal + rImag * rImag);
      const mag = (lMag + rMag) / 2;

      // Mask value (average across channels)
      const mask = (Math.abs(maskTensor[0 * size + idx]) +
                    Math.abs(maskTensor[1 * size + idx]) +
                    Math.abs(maskTensor[2 * size + idx]) +
                    Math.abs(maskTensor[3 * size + idx])) / 4;

      vocalSum += mag * Math.min(1, mask);
      instrSum += mag * Math.min(1, 1 - mask);
    }

    vocalMags[b] = vocalSum / NUM_FRAMES;
    instrumentMags[b] = instrSum / NUM_FRAMES;
  }

  return { vocalMags, instrumentMags };
}

module.exports = {
  buildModelInput,
  extractMagnitudes,
  N_FFT,
  HOP_LENGTH,
  NUM_FRAMES,
  NUM_BINS
};
