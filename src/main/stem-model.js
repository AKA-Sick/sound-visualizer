const path = require('path');
const fs = require('fs');
const https = require('https');

const MODEL_NAME = 'htdemucs_6s.onnx';
const MODEL_URL = 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s.onnx';

// Confirmed against the actual downloaded model's session metadata (via
// src/main/scripts/inspect-model.mjs, since deleted) and the StemSplitio
// model card's stated `SOURCES` tuple and Python usage example — both agree
// with this order. Do not change this without re-confirming — a wrong order
// silently mislabels stems (e.g. "guitar" fader actually controls piano).
//
// Confirmed I/O contract (single onnx model, one inference call = all stems):
//   input  "mix"   float32 [1, 2, 343980]     -- fixed shape, no dynamic axes;
//                                                 stereo, 44.1kHz, 7.8s segment
//   output "stems" float32 [1, 6, 2, 343980]  -- stem axis order is STEM_ORDER
const STEM_ORDER = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

function modelPath(userDataPath) {
  return path.join(userDataPath, 'models', MODEL_NAME);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const request = (reqUrl) => {
      https.get(reqUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    request(url);
  });
}

async function ensureModel(userDataPath) {
  const dest = modelPath(userDataPath);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10_000_000) return dest;
  await downloadFile(MODEL_URL, dest);
  return dest;
}

let sessionPromise = null;
async function loadSession(userDataPath) {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const dest = await ensureModel(userDataPath);
    const ort = require('onnxruntime-node');
    try {
      return await ort.InferenceSession.create(dest, { executionProviders: ['dml', 'cpu'] });
    } catch {
      return await ort.InferenceSession.create(dest, { executionProviders: ['cpu'] });
    }
  })();
  // If this attempt ever rejects (a failed model download, or session
  // creation failing on both providers), forget it so the NEXT call to
  // loadSession() starts a completely fresh attempt instead of returning
  // the same broken/rejected promise forever.
  sessionPromise.catch(() => { sessionPromise = null; });
  return sessionPromise;
}

// Force-drop the memoized session so the next loadSession() call starts
// fresh. Used when a session was created successfully but later failed
// during actual session.run() (e.g. a DirectML runtime OOM) — creation-time
// success doesn't guarantee run-time success, so callers that hit that case
// should call this in addition to building a one-off CPU session for the
// rest of their current run via loadCpuOnlySession().
function resetSession() {
  sessionPromise = null;
}

// Build a brand-new CPU-only session, independent of the memoized
// sessionPromise. Used for same-run recovery when a memoized (possibly
// DML) session fails during session.run() — the caller swaps this in for
// the remainder of its current processing run without disturbing whatever
// loadSession() will hand out next time.
async function loadCpuOnlySession(userDataPath) {
  const dest = await ensureModel(userDataPath);
  const ort = require('onnxruntime-node');
  return ort.InferenceSession.create(dest, { executionProviders: ['cpu'] });
}

module.exports = {
  MODEL_NAME, MODEL_URL, STEM_ORDER, modelPath, ensureModel,
  loadSession, resetSession, loadCpuOnlySession
};
