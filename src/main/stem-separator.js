const path = require('path');
const fs = require('fs');
const https = require('https');
const { app } = require('electron');
const { buildModelInput, extractMagnitudes, NUM_BINS } = require('./fft-utils');

// Model config
const MODEL_NAME = 'UVR-MDX-NET-Inst_HQ_4.onnx';
const MODEL_URL = `https://huggingface.co/seanghay/uvr_models/resolve/main/${MODEL_NAME}`;

class StemSeparator {
  constructor(addon) {
    this.addon = addon;
    this.session = null;
    this.loading = false;
    this.ready = false;
    this.interval = null;
    this.lastVocalMags = null;
    this.lastInstrumentMags = null;
    this.processing = false;
    this.modelPath = path.join(app.getPath('userData'), 'models', MODEL_NAME);
    this.inputName = null;
    this.outputName = null;
  }

  async start() {
    if (this.loading || this.ready) return;
    this.loading = true;

    try {
      // Ensure model is downloaded
      await this.ensureModel();

      // Load ONNX Runtime
      const ort = require('onnxruntime-node');

      // Create session with DirectML (GPU) if available, fall back to CPU
      const opts = { executionProviders: ['dml', 'cpu'] };
      try {
        this.session = await ort.InferenceSession.create(this.modelPath, opts);
      } catch {
        // DirectML may not be available, try CPU only
        this.session = await ort.InferenceSession.create(this.modelPath, {
          executionProviders: ['cpu']
        });
      }

      this.inputName = this.session.inputNames[0];
      this.outputName = this.session.outputNames[0];
      this.ready = true;
      this.loading = false;

      console.log('Stem separator ready. Input:', this.inputName, 'Output:', this.outputName);

      // Start processing loop — run inference every 2 seconds
      this.interval = setInterval(() => this.process(), 2000);
    } catch (err) {
      console.error('Failed to load stem separator:', err.message);
      this.loading = false;
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.session = null;
    this.ready = false;
  }

  async ensureModel() {
    const dir = path.dirname(this.modelPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(this.modelPath)) {
      const stat = fs.statSync(this.modelPath);
      if (stat.size > 1000000) return; // Model exists and is reasonable size
    }

    console.log('Downloading ML model (~100-200MB)...');
    await this.downloadFile(MODEL_URL, this.modelPath);
    console.log('Model downloaded.');
  }

  downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      const request = (reqUrl) => {
        https.get(reqUrl, (response) => {
          // Follow redirects
          if (response.statusCode === 301 || response.statusCode === 302) {
            file.close();
            fs.unlinkSync(dest);
            const newFile = fs.createWriteStream(dest);
            request(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            file.close();
            fs.unlinkSync(dest);
            reject(new Error(`Download failed: HTTP ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => {
          fs.unlinkSync(dest);
          reject(err);
        });
      };
      request(url);
    });
  }

  async process() {
    if (!this.ready || this.processing) return;

    const rawAudio = this.addon.getRawAudio();
    if (!rawAudio || rawAudio.left.length < 264600) return; // Need ~6 seconds

    this.processing = true;

    try {
      const ort = require('onnxruntime-node');

      // Take the last ~6 seconds of audio
      const neededSamples = 263168; // (256-1)*1024 + 2048
      const leftAudio = rawAudio.left.slice(-neededSamples);
      const rightAudio = rawAudio.right.slice(-neededSamples);

      // Build STFT input tensor
      const inputData = buildModelInput(leftAudio, rightAudio);
      const inputTensor = new ort.Tensor('float32', inputData, [1, 4, 1024, 256]);

      // Run inference
      const results = await this.session.run({ [this.inputName]: inputTensor });
      const maskData = results[this.outputName].data;

      // Extract frequency magnitudes
      const { vocalMags, instrumentMags } = extractMagnitudes(inputData, maskData);

      this.lastVocalMags = Array.from(vocalMags);
      this.lastInstrumentMags = Array.from(instrumentMags);
    } catch (err) {
      console.error('Stem separation error:', err.message);
    }

    this.processing = false;
  }

  getStemData() {
    if (!this.lastVocalMags) return null;
    return {
      vocalMags: this.lastVocalMags,
      instrumentMags: this.lastInstrumentMags
    };
  }

  getStatus() {
    if (this.ready) return 'ready';
    if (this.loading) return 'loading';
    return 'idle';
  }
}

module.exports = StemSeparator;
