const path = require('path');
const addon = require(path.join(__dirname, '../native/build/Release/audio_capture.node'));

class AudioBridge {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.interval = null;
    this.sampleRate = 44100;
  }

  start() {
    addon.startCapture();
    this.sampleRate = addon.getSampleRate();

    this.mainWindow.webContents.send('sample-rate', this.sampleRate);

    this.interval = setInterval(() => {
      if (this.mainWindow.isDestroyed()) {
        this.stop();
        return;
      }
      const data = addon.getAudioData();
      if (data) {
        this.mainWindow.webContents.send('audio-data', {
          frequencyData: Array.from(data.frequencyData),
          beat: data.beat,
          volume: data.volume
        });
      }
    }, 16);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    addon.stopCapture();
  }
}

module.exports = AudioBridge;
