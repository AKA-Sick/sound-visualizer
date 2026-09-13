export function createBeatDetector({ threshold = 1.3, cooldownFrames = 15 } = {}) {
  let runningAverage = 0;
  let framesSinceLastBeat = cooldownFrames;

  return function detect(bassEnergy) {
    framesSinceLastBeat++;
    const isBeat = runningAverage > 0 &&
      bassEnergy > runningAverage * threshold &&
      framesSinceLastBeat >= cooldownFrames;
    runningAverage = runningAverage * 0.95 + bassEnergy * 0.05;
    if (isBeat) framesSinceLastBeat = 0;
    return isBeat;
  };
}
