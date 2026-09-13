export function createBeatDetector({ threshold = 1.3, cooldownFrames = 15 } = {}) {
  let runningAverage = null;
  let framesSinceLastBeat = cooldownFrames;

  return function detect(bassEnergy) {
    framesSinceLastBeat++;

    // Seed the average with the first sample instead of starting from 0 --
    // starting from 0 makes any steady, non-zero signal look like a huge
    // spike relative to the still-near-zero average during ramp-up, firing
    // false beats before the average has had a chance to converge.
    if (runningAverage === null) {
      runningAverage = bassEnergy;
      return false;
    }

    const isBeat = bassEnergy > runningAverage * threshold && framesSinceLastBeat >= cooldownFrames;
    runningAverage = runningAverage * 0.95 + bassEnergy * 0.05;
    if (isBeat) framesSinceLastBeat = 0;
    return isBeat;
  };
}
