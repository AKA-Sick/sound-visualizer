# File Playback Mode with Cached Stem Separation — Design Spec

## Overview

Add a second audio source to the visualizer, alongside the existing live WASAPI capture: loading a local audio file, separating it into 6 real, playable stems (vocals, drums, bass, guitar, piano, other) via a Demucs ONNX model, and caching the result to disk so replaying the same file never reprocesses it. Unlike the earlier (deleted, never-functional) MDX-Net "ML Stems" live mode — which only produced magnitude data for visualization — this pipeline produces genuine separated waveform audio, so stems can be muted/soloed and actually heard, not just visualized.

This is additive: live capture mode is untouched. File mode is a new, separate source the user switches to.

## Model

- **Model**: `htdemucs_6s` (HTDemucs 6-stem, Hybrid Transformer Demucs), ONNX export from `StemSplitio/htdemucs-6s-onnx` on Hugging Face.
- **Stems produced**: vocals, drums, bass, guitar, piano, other.
- **Size**: ~258MB, downloaded once to `userData/models/htdemucs_6s.onnx` on first use of File mode (same download/progress pattern as the prior MDX-Net downloader: streamed to disk, redirect-following, existence+size sanity check to skip re-download).
- **Runtime**: `onnxruntime-node`, execution providers `['dml', 'cpu']` (DirectML with CPU fallback), matching the existing pattern in the (deleted) `stem-separator.js`.
- **Input**: raw stereo PCM at 44.1kHz, processed in overlapping chunks (Demucs standard: ~7.8s segment length with overlap, stitched via cross-fade/overlap-add — exact segment/overlap/stride constants come from the model's expected receptive field and are implemented per the reference Demucs inference procedure).
- **Output**: 6 stereo waveforms, same length as input.

## Architecture

```
Renderer                          Main Process                       Disk
─────────                         ────────────                       ────
"Load File" picker
  → AudioContext.decodeAudioData
    (native decode: mp3/wav/flac/m4a/ogg)
  → raw PCM, resampled to 44100 stereo
                    ──IPC(pcm)──►  hash file contents (sha256, streamed)
                                   cache hit? ───────────────────► userData/stem-cache/<hash>/
                                     │no                              vocals.wav, drums.wav,
                                     ▼                                bass.wav, guitar.wav,
                                   ensure model downloaded             piano.wav, other.wav,
                                   segment PCM into overlapping        meta.json
                                   chunks
                                   → ONNX inference per chunk
                                     (emit progress events)
                                   → overlap-add stitch per stem
                                   → write 6 stereo 16-bit PCM WAVs
                                   → write meta.json (source filename,
                                     duration, sample rate, created date)
                    ◄─IPC(progress/paths)── progress events, then
                                             final cache dir path

Renderer resumes:
  decode all 6 cached WAVs via AudioContext.decodeAudioData
  → one AudioBufferSourceNode + GainNode per stem
    (mute/solo/volume, all six start()'d in sync at t=0 offset
    by seek position)
  → sum all 6 GainNodes into existing AnalyserNode → destination
  → AnalyserNode frequency data feeds mapFrequencyBands() exactly
    as live mode does — every existing visualizer works unchanged
```

## Components

### Main process

- **`src/main/stem-cache.js`** — cache identity and lookup.
  - `hashFile(filePath)`: streamed sha256 of file contents.
  - `getCacheDir(hash)`: `userData/stem-cache/<hash>/`.
  - `isCached(hash)`: checks all 6 WAVs + `meta.json` exist.
  - `getCacheSize()` / `clearCache()`: for the panel's cache management UI.

- **`src/main/stem-model.js`** — model download/load, adapted from the deleted `stem-separator.js` pattern.
  - `ensureModel()`: downloads `htdemucs_6s.onnx` to `userData/models/` if missing.
  - `loadSession()`: creates the `onnxruntime-node` inference session (dml→cpu fallback).

- **`src/main/stem-processor.js`** — the offline separation pipeline.
  - `separate(pcmBuffer, sampleRate, onProgress)`: segments input, runs inference per chunk, overlap-add stitches, returns 6 `Float32Array` stereo buffers. Pure function of PCM in → PCM out, independent of caching/IPC, so it's unit-testable without a real model (inject a fake session).
  - `writeWavStems(dir, stems, sampleRate)`: encodes each stem to 16-bit PCM WAV.

- **IPC handlers** (in `main.js`, alongside existing `get-settings`/`save-settings` pattern):
  - `process-audio-file` (invoke): given a file path, returns `{ cached: true, dir }` immediately if cached, otherwise runs the full pipeline, emitting `stem-progress` events (`{ percent }`) via `webContents.send`, and resolves with `{ cached: false, dir }` when done.
  - `read-stem-cache-size` / `clear-stem-cache` (invoke): for the cache management UI.

### Renderer

- **`src/renderer/audio/file-source.js`** — new module, parallel to the existing native-addon-driven audio path.
  - Decodes the picked file via `AudioContext.decodeAudioData`.
  - Sends PCM to main via IPC, awaits cached stem paths (showing progress from `stem-progress` events).
  - Decodes the 6 cached WAVs, builds the `AudioBufferSourceNode` + `GainNode` × 6 → shared `AnalyserNode` graph.
  - Exposes: `play()`, `pause()`, `seek(seconds)`, `setStemGain(stem, value)`, `setStemMute(stem, bool)`, `setStemSolo(stem, bool)`, and `getFrequencyData()` (reads the `AnalyserNode`, same shape as the live addon's frequency arrays so `app.js`'s existing rendering loop can consume either source interchangeably).

- **`src/renderer/ui/panel.js`** — add a "Source" toggle (Live System Audio / Audio File). When Audio File is selected: file picker button, progress bar during first-time processing, 6 stem rows (mute/solo checkboxes + volume slider), transport controls (play/pause, seek bar), and a cache size readout + "Clear Cache" button.

- **`src/renderer/app.js`** — the main render loop currently pulls frequency data from IPC `audio-data` events (live mode). Add a branch: when Source = Audio File, pull frequency data from `file-source.js`'s `getFrequencyData()` each animation frame instead. Downstream bar-mapping and visualizer code is unchanged.

## Data Flow Detail: Caching

- Cache key: sha256 of the full file's bytes, computed streaming (no full-file read into memory).
- Cache location: `userData/stem-cache/<hash>/{vocals,drums,bass,guitar,piano,other}.wav` + `meta.json`.
- On "Load File": hash first (with a "Checking cache…" spinner in the UI), then check `isCached`. Hit → skip straight to decode-and-play. Miss → run full separation pipeline with a progress bar.
- No automatic eviction. A "Clear Cache" button in the panel removes the entire `stem-cache/` directory. Per-song size is roughly 500MB (6 × ~85MB for a 4-minute song at 16-bit/44.1kHz stereo); this is disclosed in the UI via the cache size readout, not silently accumulated.

## Error Handling

- **Unsupported/corrupt file**: `decodeAudioData` rejection is caught in the renderer and surfaced as an inline error before any IPC call — no wasted processing attempt.
- **Model download failure**: same retry-with-message pattern as the existing model downloader; File mode remains unusable until the model is present, with a clear "Retry Download" affordance.
- **Inference failure mid-chunk**: abort the whole `separate()` call, surface an error, and do **not** write partial WAVs or a `meta.json` — a cache directory only exists if it's complete, so a crash never leaves a corrupt cache that's mistaken for a hit.
- **Disk full during WAV write**: caught, same abort-without-partial-cache behavior (write to a temp dir, then rename to the final hash dir only on full success — this also makes cache writes atomic with respect to concurrent reads).

## Testing

- Unit tests (`test/`, using the existing `node --test` setup):
  - `stem-processor.js` overlap-add stitching: verify reconstructed length and that non-overlapping regions are passed through unchanged when given an identity "model" (mock session returning its input).
  - `stem-cache.js`: hash computation, `isCached` true/false paths, atomic write-then-rename behavior on a temp directory.
- Manual pass in the running app (per this project's UI-testing expectations): load a file → confirm processing progress UI → confirm playback + visualization once done → reload the same file → confirm instant cache hit (no reprocessing) → mute/solo each stem and confirm both the audible mix and the visualization respond correctly.

## Scope

**In scope:**
- File picker, decode, and playback via Web Audio in the renderer.
- Offline 6-stem separation via `htdemucs_6s` ONNX in the main process.
- Disk cache keyed by file content hash, with manual clear.
- Per-stem mute/solo/volume, both audibly and in the visualization.
- Progress reporting during first-time processing.

**Out of scope:**
- Automatic cache eviction/size limits.
- Exporting separated stems as standalone files for use outside the app.
- Any change to the existing live WASAPI capture path or its "Normal/Vocal Highlight/Mid-Side/Surround" audio modes.
- Batch/queued processing of multiple files at once.
- GPU providers beyond DirectML (no CUDA/CoreML — Windows-only app).
