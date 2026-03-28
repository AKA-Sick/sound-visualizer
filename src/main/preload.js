const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onAudioData: (callback) => {
    ipcRenderer.on('audio-data', (_event, data) => callback(data));
  },
  onSampleRate: (callback) => {
    ipcRenderer.on('sample-rate', (_event, rate) => callback(rate));
  },
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  setTransparent: (enabled) => ipcRenderer.send('set-transparent', enabled),
  onApplySettings: (callback) => {
    ipcRenderer.on('apply-settings', (_event, settings) => callback(settings));
  },
});
