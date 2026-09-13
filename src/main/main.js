const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AudioBridge = require('./audio-bridge');
const SettingsStore = require('./settings-store');
const stemModel = require('./stem-model');
const stemCache = require('./stem-cache');
const stemProcessor = require('./stem-processor');
const { encodeWavStereo } = require('./stem-wav');

const SEGMENT_SAMPLES = Math.round(7.8 * 44100); // confirmed via Task 1 model inspection (343980)
const OVERLAP_FRACTION = 0.25;

let mainWindow;
let audioBridge;
let settingsStore;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  settingsStore = new SettingsStore();

  ipcMain.handle('get-settings', () => settingsStore.get());
  ipcMain.handle('save-settings', (_event, newSettings) => {
    settingsStore.update(newSettings);
  });

  ipcMain.handle('pick-audio-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('check-stem-cache', async (_event, filePath) => {
    const hash = await stemCache.hashFile(filePath);
    const dir = stemCache.getCacheDir(app.getPath('userData'), hash);
    return { hash, cached: stemCache.isCached(dir), dir };
  });

  ipcMain.handle('read-audio-file-bytes', async (_event, filePath) => {
    return new Uint8Array(fs.readFileSync(filePath));
  });

  ipcMain.handle('process-audio-pcm', async (event, { hash, dir, left, right, sampleRate }) => {
    const session = await stemModel.loadSession(app.getPath('userData'));

    const runInference = async (chunkLeft, chunkRight) => {
      const ort = require('onnxruntime-node');
      const inputTensor = new ort.Tensor('float32',
        Float32Array.from([...chunkLeft, ...chunkRight]),
        [1, 2, chunkLeft.length]);
      const results = await session.run({ [session.inputNames[0]]: inputTensor });
      const outputData = results[session.outputNames[0]].data;
      const chunkLen = chunkLeft.length;
      const stems = {};
      stemModel.STEM_ORDER.forEach((name, stemIndex) => {
        const base = stemIndex * 2 * chunkLen;
        stems[name] = {
          left: outputData.slice(base, base + chunkLen),
          right: outputData.slice(base + chunkLen, base + 2 * chunkLen)
        };
      });
      return stems;
    };

    const leftArr = Float32Array.from(left);
    const rightArr = Float32Array.from(right);

    const stems = await stemProcessor.separate(
      leftArr, rightArr, SEGMENT_SAMPLES, OVERLAP_FRACTION, runInference,
      (percent) => event.sender.send('stem-progress', { percent })
    );

    stemCache.writeAtomic(dir, (tempDir) => {
      for (const name of stemCache.STEM_NAMES) {
        const wavBuffer = encodeWavStereo(stems[name].left, stems[name].right, sampleRate);
        fs.writeFileSync(path.join(tempDir, `${name}.wav`), wavBuffer);
      }
      fs.writeFileSync(path.join(tempDir, 'meta.json'), JSON.stringify({
        hash, sampleRate, createdAt: new Date().toISOString()
      }, null, 2));
    });

    return { dir };
  });

  ipcMain.handle('read-stem-audio', async (_event, dir) => {
    const result = {};
    for (const name of stemCache.STEM_NAMES) {
      result[name] = new Uint8Array(fs.readFileSync(path.join(dir, `${name}.wav`)));
    }
    return result;
  });

  ipcMain.handle('read-stem-cache-size', async () => {
    return stemCache.getCacheSize(app.getPath('userData'));
  });

  ipcMain.handle('clear-stem-cache', async () => {
    stemCache.clearCache(app.getPath('userData'));
  });

  ipcMain.on('set-transparent', (_event, enabled) => {
    if (!mainWindow) return;

    const bounds = mainWindow.getBounds();
    const currentSettings = settingsStore.get();

    if (audioBridge) audioBridge.stop();
    mainWindow.close();

    mainWindow = new BrowserWindow({
      ...bounds,
      minWidth: 600,
      minHeight: 400,
      frame: !enabled,
      transparent: enabled,
      alwaysOnTop: enabled,
      backgroundColor: enabled ? '#00000000' : '#0a0a0a',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    mainWindow.webContents.on('did-finish-load', () => {
      audioBridge = new AudioBridge(mainWindow);
      audioBridge.start();
      const newSettings = { ...currentSettings, background: enabled ? 'transparent' : 'solid' };
      mainWindow.webContents.send('apply-settings', newSettings);
    });

    mainWindow.on('closed', () => {
      if (audioBridge) audioBridge.stop();
      mainWindow = null;
    });
  });

  mainWindow.webContents.on('did-finish-load', () => {
    audioBridge = new AudioBridge(mainWindow);
    audioBridge.start();
  });

  mainWindow.on('closed', () => {
    if (audioBridge) audioBridge.stop();
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
