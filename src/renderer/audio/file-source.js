import { createBeatDetector } from './beat-detector.js';

export const STEM_NAMES = ['bass', 'drums', 'guitar', 'other', 'piano', 'vocals'];

export class FileAudioSource {
  constructor({ onAudioData }) {
    this.onAudioData = onAudioData;
    this.audioContext = null;
    this.stemBuffers = {};
    this.gainNodes = {};
    this.sourceNodes = {};
    this.analyser = null;
    this.mixBus = null;
    this.detectBeat = createBeatDetector();
    this.isPlaying = false;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.duration = 0;
    this.rafId = null;
    this._muted = {};
    this._volumes = {};
  }

  async loadFile(filePath, onProgress) {
    this.stopPlayback();
    if (!this.audioContext) this.audioContext = new AudioContext({ sampleRate: 44100 });

    const { hash, cached, dir } = await window.electronAPI.checkStemCache(filePath);

    if (!cached) {
      const fileBytes = await window.electronAPI.readAudioFileBytes(filePath);
      const decoded = await this.audioContext.decodeAudioData(fileBytes.buffer.slice(
        fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength));
      const left = decoded.getChannelData(0);
      const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);

      if (onProgress) window.electronAPI.onStemProgress(onProgress);
      await window.electronAPI.processAudioPcm({
        hash, dir, left, right, sampleRate: decoded.sampleRate
      });
    }

    const stemData = await window.electronAPI.readStemAudio(dir);
    this.stemBuffers = {};
    for (const name of STEM_NAMES) {
      const bytes = stemData[name];
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this.stemBuffers[name] = await this.audioContext.decodeAudioData(arrayBuffer);
    }
    this.duration = this.stemBuffers[STEM_NAMES[0]].duration;
    this.pausedAt = 0;
    this._buildGraph();
  }

  _buildGraph() {
    const ctx = this.audioContext;
    this.mixBus = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.mixBus.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.gainNodes = {};
    for (const name of STEM_NAMES) {
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      gain.connect(this.mixBus);
      this.gainNodes[name] = gain;
      this._muted[name] = false;
      this._volumes[name] = 1.0;
    }
  }

  _startSources(fromSeconds) {
    const ctx = this.audioContext;
    this.sourceNodes = {};
    for (const name of STEM_NAMES) {
      const src = ctx.createBufferSource();
      src.buffer = this.stemBuffers[name];
      src.connect(this.gainNodes[name]);
      src.start(0, fromSeconds);
      this.sourceNodes[name] = src;
    }
    this.startedAt = ctx.currentTime - fromSeconds;
    this.isPlaying = true;
  }

  play() {
    if (this.isPlaying || !this.stemBuffers[STEM_NAMES[0]]) return;
    this._startSources(this.pausedAt);
    this._runAnalysisLoop();
  }

  pause() {
    if (!this.isPlaying) return;
    this.pausedAt = this.getCurrentTime();
    this._stopSources();
    this.stopAnalysisLoop();
  }

  stopPlayback() {
    this._stopSources();
    this.stopAnalysisLoop();
    this.pausedAt = 0;
  }

  _stopSources() {
    for (const name of STEM_NAMES) {
      if (this.sourceNodes[name]) {
        try { this.sourceNodes[name].stop(); } catch { /* already stopped */ }
      }
    }
    this.sourceNodes = {};
    this.isPlaying = false;
  }

  seek(seconds) {
    const wasPlaying = this.isPlaying;
    const clamped = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) this._stopSources();
    this.pausedAt = clamped;
    if (wasPlaying) this._startSources(this.pausedAt);
  }

  getCurrentTime() {
    return this.isPlaying ? (this.audioContext.currentTime - this.startedAt) : this.pausedAt;
  }

  getDuration() {
    return this.duration;
  }

  setStemVolume(name, value) {
    this._volumes[name] = value;
    if (!this._muted[name]) this.gainNodes[name].gain.value = value;
  }

  setStemMute(name, muted) {
    this._muted[name] = muted;
    this.gainNodes[name].gain.value = muted ? 0 : this._volumes[name];
  }

  soloStem(name) {
    for (const other of STEM_NAMES) this.setStemMute(other, other !== name);
  }

  clearSolo() {
    for (const other of STEM_NAMES) this.setStemMute(other, false);
  }

  _runAnalysisLoop() {
    const freqData = new Float32Array(this.analyser.frequencyBinCount);
    const timeData = new Float32Array(this.analyser.fftSize);

    const tick = () => {
      if (!this.isPlaying) return;

      this.analyser.getFloatFrequencyData(freqData);
      const linear = new Float32Array(freqData.length);
      for (let i = 0; i < freqData.length; i++) {
        linear[i] = Math.pow(10, freqData[i] / 20);
      }

      this.analyser.getFloatTimeDomainData(timeData);
      let sumSquares = 0;
      for (let i = 0; i < timeData.length; i++) sumSquares += timeData[i] * timeData[i];
      const volume = Math.sqrt(sumSquares / timeData.length);

      let bassEnergy = 0;
      const bassBins = Math.min(8, linear.length);
      for (let i = 0; i < bassBins; i++) bassEnergy += linear[i];
      const beat = this.detectBeat(bassEnergy);

      this.onAudioData({ midData: linear, sideData: linear, beat, volume });

      if (this.getCurrentTime() >= this.duration) {
        this.pause();
        this.pausedAt = 0;
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopAnalysisLoop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }
}
