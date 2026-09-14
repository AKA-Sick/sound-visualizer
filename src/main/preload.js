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

  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  onFolderScanProgress: (callback) => { folderScanProgressCallback = callback; },
  getLibrary: () => ipcRenderer.invoke('get-library'),
  addSingleFileToLibrary: (filePath) => ipcRenderer.invoke('add-single-file-to-library', filePath),
  setFavorite: (hash, favorite) => ipcRenderer.invoke('set-favorite', hash, favorite),
  removeLibraryEntry: (hash) => ipcRenderer.invoke('remove-library-entry', hash),
  recordPlay: (hash) => ipcRenderer.invoke('record-play', hash),
  markLibraryProcessed: (hash, duration) => ipcRenderer.invoke('mark-library-processed', hash, duration),
  resetAllProcessed: () => ipcRenderer.invoke('reset-all-processed'),
});

// A single persistent listener that forwards to whichever callback
// onStemProgress most recently registered — registering a fresh
// ipcRenderer.on(...) on every onStemProgress() call would stack a new
// listener per file load and fire stale callbacks alongside the current one.
let stemProgressCallback = null;
ipcRenderer.on('stem-progress', (_event, data) => {
  if (stemProgressCallback) stemProgressCallback(data.percent);
});

// Same single-persistent-listener pattern as stem-progress above, applied to
// folder scan progress: one ipcRenderer.on(...) registered once at module
// scope, forwarding to whichever callback onFolderScanProgress most recently
// registered, rather than stacking a new listener per scanFolder() call.
let folderScanProgressCallback = null;
ipcRenderer.on('folder-scan-progress', (_event, data) => {
  if (folderScanProgressCallback) folderScanProgressCallback(data);
});
