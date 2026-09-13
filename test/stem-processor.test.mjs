// test/stem-processor.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { separate, buildChunkWindow, STEM_NAMES } from '../src/main/stem-processor.js';

describe('buildChunkWindow', () => {
  it('is all 1.0 for a single chunk (both first and last)', () => {
    const w = buildChunkWindow(100, 20, 0, 1);
    assert.ok(Array.from(w).every((v) => v === 1));
  });

  it('fades in at the start for a non-first chunk, full weight elsewhere', () => {
    const w = buildChunkWindow(100, 20, 1, 3);
    assert.equal(w[0], 0);
    assert.ok(Math.abs(w[10] - 0.5) < 0.001);
    assert.ok(Math.abs(w[19] - 0.95) < 0.001);
    assert.equal(w[50], 1);
  });

  it('fades out at the end for a non-last chunk, full weight elsewhere', () => {
    const w = buildChunkWindow(100, 20, 0, 3);
    assert.equal(w[0], 1);
    assert.equal(w[50], 1);
    assert.ok(w[99] < 0.1);
  });
});

describe('separate', () => {
  it('reconstructs the exact input length', async () => {
    const totalSamples = 1000;
    const left = new Float32Array(totalSamples).fill(1);
    const right = new Float32Array(totalSamples).fill(1);
    const identityInference = async (chunkLeft, chunkRight) => {
      const result = {};
      for (const name of STEM_NAMES) result[name] = { left: chunkLeft, right: chunkRight };
      return result;
    };

    const outputs = await separate(left, right, 300, 0.25, identityInference);
    assert.equal(outputs.vocals.left.length, totalSamples);
  });

  it('reconstructs identical signal exactly when every stem echoes the input', async () => {
    const totalSamples = 1000;
    const left = new Float32Array(totalSamples).fill(0.7);
    const right = new Float32Array(totalSamples).fill(-0.3);
    const identityInference = async (chunkLeft, chunkRight) => {
      const result = {};
      for (const name of STEM_NAMES) result[name] = { left: chunkLeft, right: chunkRight };
      return result;
    };

    const outputs = await separate(left, right, 300, 0.25, identityInference);
    for (let i = 0; i < totalSamples; i++) {
      assert.ok(Math.abs(outputs.vocals.left[i] - 0.7) < 0.0001, `sample ${i}`);
      assert.ok(Math.abs(outputs.vocals.right[i] - (-0.3)) < 0.0001, `sample ${i}`);
    }
  });

  it('linearly crossfades between adjacent chunks whose output differs by position', async () => {
    const totalSamples = 900;
    const left = new Float32Array(totalSamples);
    const right = new Float32Array(totalSamples);
    let callIndex = 0;
    const positionMarkingInference = async () => {
      const value = callIndex; // 0, 1, 2, ... one per chunk call, in order
      callIndex++;
      const filled = new Float32Array(300).fill(value);
      const result = {};
      for (const name of STEM_NAMES) result[name] = { left: filled, right: filled };
      return result;
    };

    const outputs = await separate(left, right, 300, 0.25, positionMarkingInference);
    // Chunk 0 covers [0,300), chunk 1 [225,525), chunk 2 [450,750), chunk3 [675, 975) clipped to 900
    // Deep in chunk 0's core (before any overlap) should be exactly 0
    assert.ok(Math.abs(outputs.vocals.left[100] - 0) < 0.001);
    // In the crossfade between chunk 0 (value 0) and chunk 1 (value 1),
    // the blend should be strictly between 0 and 1
    const midOverlap = outputs.vocals.left[237]; // partway through [225,300) overlap
    assert.ok(midOverlap > 0 && midOverlap < 1, `expected 0<value<1, got ${midOverlap}`);
  });

  it('progress callback fires once per chunk reaching 1.0 at the end', async () => {
    const totalSamples = 900;
    const left = new Float32Array(totalSamples);
    const right = new Float32Array(totalSamples);
    const identityInference = async (chunkLeft, chunkRight) => {
      const result = {};
      for (const name of STEM_NAMES) result[name] = { left: chunkLeft, right: chunkRight };
      return result;
    };
    const progressValues = [];
    await separate(left, right, 300, 0.25, identityInference, (p) => progressValues.push(p));
    assert.ok(progressValues.length > 0);
    assert.equal(progressValues[progressValues.length - 1], 1);
  });
});
