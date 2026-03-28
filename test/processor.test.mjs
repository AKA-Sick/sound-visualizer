import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapFrequencyBands, smoothBars } from '../src/renderer/audio/processor.js';

describe('mapFrequencyBands', () => {
  it('returns correct number of bars', () => {
    const fakeData = new Float32Array(1024).fill(0.5);
    const bars = mapFrequencyBands(fakeData, 32, 48000, 1.0);
    assert.equal(bars.length, 32);
  });

  it('applies sensitivity multiplier', () => {
    const fakeData = new Float32Array(1024).fill(0.1);
    const bars1x = mapFrequencyBands(fakeData, 16, 48000, 1.0);
    const bars2x = mapFrequencyBands(fakeData, 16, 48000, 2.0);
    for (let i = 0; i < 16; i++) {
      assert.ok(Math.abs(bars2x[i] - bars1x[i] * 2) < 0.001,
        `Bar ${i}: ${bars2x[i]} should be ~2x ${bars1x[i]}`);
    }
  });

  it('uses logarithmic scaling (bass gets more bars)', () => {
    const fakeData = new Float32Array(1024).fill(0);
    for (let i = 0; i < 10; i++) fakeData[i] = 1.0;
    const bars = mapFrequencyBands(fakeData, 32, 48000, 1.0);
    const nonZero = Array.from(bars).filter(v => v > 0).length;
    assert.ok(nonZero >= 3, `Expected >=3 non-zero bars for bass, got ${nonZero}`);
  });
});

describe('smoothBars', () => {
  it('interpolates toward target', () => {
    const current = new Float32Array([0, 0, 0]);
    const target = new Float32Array([1, 1, 1]);
    const result = smoothBars(current, target, 0.8);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(result[i] - 0.2) < 0.001);
    }
  });

  it('preserves values when smoothing is 0', () => {
    const current = new Float32Array([0.5, 0.5]);
    const target = new Float32Array([1.0, 0.0]);
    const result = smoothBars(current, target, 0);
    assert.ok(Math.abs(result[0] - 1.0) < 0.001);
    assert.ok(Math.abs(result[1] - 0.0) < 0.001);
  });
});
