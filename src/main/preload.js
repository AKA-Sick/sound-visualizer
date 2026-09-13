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

  pickAudioFile: () => ipcRenderer.invoke('pick-audio-file'),
  checkStemCache: (filePath) => ipcRenderer.invoke('check-stem-cache', filePath),
  readAudioFileBytes: (filePath) => ipcRenderer.invoke('read-audio-file-bytes', filePath),
  processAudioPcm: (payload) => ipcRenderer.invoke('process-audio-pcm', payload),
  onStemProgress: (callback) => { stemProgressCallback = callback; },
  readStemAudio: (dir) => ipcRenderer.invoke('read-stem-audio', dir),
  getStemCacheSize: () => ipcRenderer.invoke('read-stem-cache-size'),
  clearStemCache: () => ipcRenderer.invoke('clear-stem-cache'),
});

// A single persistent listener that forwards to whichever callback
// onStemProgress most recently registered — registering a fresh
// ipcRenderer.on(...) on every onStemProgress() call would stack a new
// listener per file load and fire stale callbacks alongside the current one.
let stemProgressCallback = null;
ipcRenderer.on('stem-progress', (_event, data) => {
  if (stemProgressCallback) stemProgressCallback(data.percent);
});
