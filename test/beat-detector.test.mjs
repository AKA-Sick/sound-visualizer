// test/beat-detector.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBeatDetector } from '../src/renderer/audio/beat-detector.js';

describe('createBeatDetector', () => {
  it('does not flag a beat during a steady quiet baseline', () => {
    const detect = createBeatDetector();
    let anyBeat = false;
    for (let i = 0; i < 30; i++) {
      if (detect(0.1)) anyBeat = true;
    }
    assert.equal(anyBeat, false);
  });

  it('flags a beat on a sudden energy spike above the baseline', () => {
    const detect = createBeatDetector({ threshold: 1.3, cooldownFrames: 15 });
    for (let i = 0; i < 20; i++) detect(0.1); // establish baseline
    const spikeResult = detect(1.0);
    assert.equal(spikeResult, true);
  });

  it('does not re-flag immediately after a beat (cooldown)', () => {
    const detect = createBeatDetector({ threshold: 1.3, cooldownFrames: 15 });
    for (let i = 0; i < 20; i++) detect(0.1);
    assert.equal(detect(1.0), true);
    assert.equal(detect(1.0), false); // still within cooldown
  });
});
