function floatTo16BitPCM(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function interleaveStereo(left, right) {
  const length = Math.min(left.length, right.length);
  const result = new Float32Array(length * 2);
  for (let i = 0; i < length; i++) {
    result[i * 2] = left[i];
    result[i * 2 + 1] = right[i];
  }
  return result;
}

function encodeWavStereo(left, right, sampleRate) {
  const interleaved = interleaveStereo(left, right);
  const pcm16 = floatTo16BitPCM(interleaved);
  const numChannels = 2;
  const bytesPerSample = 2;
  const dataSize = pcm16.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcm16.length; i++) {
    buffer.writeInt16LE(pcm16[i], 44 + i * 2);
  }

  return buffer;
}

module.exports = { encodeWavStereo, floatTo16BitPCM, interleaveStereo };
