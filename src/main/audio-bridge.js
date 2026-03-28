const path = require('path');
const addon = require(path.join(__dirname, '../native/build/Release/audio_capture.node'));
const StemSeparator = require('./stem-separator');

class AudioBridge {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.interval = null;
    this.sampleRate = 44100;
    this.stemSeparator = new StemSeparator(addon);
  }

  start() {
    addon.startCapture();
    this.sampleRate = addon.getSampleRate();

    this.mainWindow.webContents.send('sample-rate', this.sampleRate);

    // Start stem separator (loads model async, doesn't block)
    this.stemSeparator.start();

    this.interval = setInterval(() => {
      if (this.mainWindow.isDestroyed()) {
        this.stop();
        return;
      }
      const data = addon.getAudioData();
      if (data) {
        const msg = {
          midData: Array.from(data.midData),
          sideData: Array.from(data.sideData),
          beat: data.beat,
          volume: data.volume,
          stemStatus: this.stemSeparator.getStatus()
        };

        // Include stem data if available
        const stemData = this.stemSeparator.getStemData();
        if (stemData) {
          msg.vocalMags = stemData.vocalMags;
          msg.instrumentMags = stemData.instrumentMags;
        }

        this.mainWindow.webContents.send('audio-data', msg);
      }
    }, 16);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.stemSeparator.stop();
    addon.stopCapture();
  }
}

module.exports = AudioBridge;
