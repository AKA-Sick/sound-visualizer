const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onAudioData: (callback) => {
    ipcRenderer.on('audio-data', (_event, data) => callback(data));
  },
  onSampleRate: (callback) => {
    ipcRenderer.on('sample-rate', (_event, rate) => callback(rate));
  }
});
