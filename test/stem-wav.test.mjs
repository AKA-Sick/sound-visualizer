import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWavStereo } from '../src/main/stem-wav.js';

describe('encodeWavStereo', () => {
  it('writes a valid RIFF/WAVE header', () => {
    const left = new Float32Array([0, 0.5, -0.5]);
    const right = new Float32Array([0, -0.5, 0.5]);
    const buf = encodeWavStereo(left, right, 44100);

    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
    assert.equal(buf.readUInt16LE(20), 1); // PCM format
    assert.equal(buf.readUInt16LE(22), 2); // stereo
    assert.equal(buf.readUInt32LE(24), 44100); // sample rate
    assert.equal(buf.readUInt16LE(34), 16); // bits per sample
    assert.equal(buf.toString('ascii', 36, 40), 'data');
  });

  it('round-trips sample values within 16-bit quantization error', () => {
    const left = new Float32Array([0, 0.5, -1, 1]);
    const right = new Float32Array([0, -0.25, 1, -1]);
    const buf = encodeWavStereo(left, right, 44100);

    const dataStart = 44;
    const readSample = (i) => buf.readInt16LE(dataStart + i * 2) / 0x8000;

    // interleaved L,R,L,R,...
    assert.ok(Math.abs(readSample(0) - 0) < 0.001);
    assert.ok(Math.abs(readSample(1) - 0) < 0.001);
    assert.ok(Math.abs(readSample(2) - 0.5) < 0.001);
    assert.ok(Math.abs(readSample(3) - (-0.25)) < 0.001);
  });

  it('data chunk size matches sample count', () => {
    const left = new Float32Array(1000);
    const right = new Float32Array(1000);
    const buf = encodeWavStereo(left, right, 44100);
    const dataSize = buf.readUInt32LE(40);
    assert.equal(dataSize, 1000 * 2 /* channels */ * 2 /* bytes/sample */);
    assert.equal(buf.length, 44 + dataSize);
  });
});
