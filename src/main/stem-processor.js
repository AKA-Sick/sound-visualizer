const STEM_NAMES = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

// Per-sample weight curve for ONE chunk at position `chunkIndex` of
// `totalChunks`. Adjacent chunks crossfade linearly across their overlap;
// the very first/last chunk get full weight (1.0) at the true start/end
// of the track, where there is no neighboring chunk to blend with.
function buildChunkWindow(segmentSamples, overlapSamples, chunkIndex, totalChunks) {
  const window = new Float32Array(segmentSamples).fill(1);
  if (chunkIndex > 0) {
    for (let i = 0; i < overlapSamples; i++) window[i] = i / overlapSamples;
  }
  if (chunkIndex < totalChunks - 1) {
    for (let i = 0; i < overlapSamples; i++) {
      window[segmentSamples - overlapSamples + i] = 1 - i / overlapSamples;
    }
  }
  return window;
}

async function separate(left, right, segmentSamples, overlapFraction, runInference, onProgress) {
  const totalSamples = left.length;
  const overlapSamples = Math.floor(segmentSamples * overlapFraction);
  const step = segmentSamples - overlapSamples;

  const positions = [];
  for (let start = 0; start < totalSamples; start += step) {
    positions.push(start);
    if (start + segmentSamples >= totalSamples) break;
  }
  const totalChunks = positions.length;

  const outputs = {};
  for (const name of STEM_NAMES) {
    outputs[name] = { left: new Float32Array(totalSamples), right: new Float32Array(totalSamples) };
  }
  const weightSum = new Float32Array(totalSamples);

  for (let i = 0; i < totalChunks; i++) {
    const start = positions[i];
    const end = Math.min(start + segmentSamples, totalSamples);
    const chunkLen = end - start;

    const chunkLeft = new Float32Array(segmentSamples);
    const chunkRight = new Float32Array(segmentSamples);
    chunkLeft.set(left.subarray(start, end));
    chunkRight.set(right.subarray(start, end));

    const result = await runInference(chunkLeft, chunkRight);
    const window = buildChunkWindow(segmentSamples, overlapSamples, i, totalChunks);

    for (let s = 0; s < chunkLen; s++) {
      const w = window[s];
      weightSum[start + s] += w;
      for (const name of STEM_NAMES) {
        outputs[name].left[start + s] += result[name].left[s] * w;
        outputs[name].right[start + s] += result[name].right[s] * w;
      }
    }

    if (onProgress) onProgress((i + 1) / totalChunks);
  }

  for (let s = 0; s < totalSamples; s++) {
    const w = weightSum[s] || 1;
    for (const name of STEM_NAMES) {
      outputs[name].left[s] /= w;
      outputs[name].right[s] /= w;
    }
  }

  return outputs;
}

module.exports = { STEM_NAMES, buildChunkWindow, separate };
