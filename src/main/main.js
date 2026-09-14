const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AudioBridge = require('./audio-bridge');
const SettingsStore = require('./settings-store');
const stemModel = require('./stem-model');
const stemCache = require('./stem-cache');
const stemProcessor = require('./stem-processor');
const { encodeWavStereo } = require('./stem-wav');
const libraryStore = require('./library-store');
const { scanFolder } = require('./folder-scanner');
const { readMetadata } = require('./metadata-reader');

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

  // Serializes every process-audio-pcm call through a single promise chain so
  // two full ONNX separations can never run concurrently, no matter which
  // renderer-side code path (single-file load or the library queue) invoked
  // this handler -- the plan's "never run two separations in parallel,
  // anywhere in the app" constraint enforced at the one chokepoint every
  // code path must pass through. The handler body itself (extracted verbatim
  // into processAudioPcmHandler below) is completely unchanged.
  let processingChain = Promise.resolve();
  const processAudioPcmHandler = async (event, { hash, dir, left, right, sampleRate }) => {
    let session = await stemModel.loadSession(app.getPath('userData'));
    let cpuFallbackAttempted = false;

    const runInference = async (chunkLeft, chunkRight) => {
      const ort = require('onnxruntime-node');
      const inputTensor = new ort.Tensor('float32',
        Float32Array.from([...chunkLeft, ...chunkRight]),
        [1, 2, chunkLeft.length]);
      let results;
      try {
        results = await session.run({ [session.inputNames[0]]: inputTensor });
      } catch (err) {
        if (cpuFallbackAttempted) throw err;
        // Session *creation* can succeed (e.g. with the 'dml' execution
        // provider) while actual session.run() still fails at runtime (a
        // real DirectML OOM was observed on some GPUs). Rebuild a CPU-only
        // session for the rest of THIS run instead of failing the whole
        // file, and drop the memoized session so the NEXT file-load also
        // gets a fresh session-creation-and-fallback cycle rather than
        // reusing this broken one.
        cpuFallbackAttempted = true;
        console.error('process-audio-pcm: session.run failed, retrying with a fresh CPU-only session:', err);
        stemModel.resetSession();
        session = await stemModel.loadCpuOnlySession(app.getPath('userData'));
        results = await session.run({ [session.inputNames[0]]: inputTensor });
      }
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
  };
  ipcMain.handle('process-audio-pcm', (event, payload) => {
    const run = processingChain.then(() => processAudioPcmHandler(event, payload));
    processingChain = run.catch(() => {}); // keep the chain alive even if one call rejects
    return run;
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

  ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  async function addFileToLibrary(filePath) {
    const hash = await stemCache.hashFile(filePath);
    const cacheDir = stemCache.getCacheDir(app.getPath('userData'), hash);
    const processed = stemCache.isCached(cacheDir);
    const meta = await readMetadata(filePath);
    return libraryStore.upsertEntry(app.getPath('userData'), hash, {
      filePath, ...meta, processed
    });
  }

  ipcMain.handle('scan-folder', async (event, folderPath) => {
    const files = scanFolder(folderPath);
    for (let i = 0; i < files.length; i++) {
      try {
        await addFileToLibrary(files[i]);
      } catch (err) {
        // Spec requires per-file failure isolation during a folder scan
        // (unreadable/permission-denied/vanished file): skip it and keep
        // going, don't abort the whole scan and silently drop every file
        // after the bad one.
        console.error(`Failed to add "${files[i]}" to library:`, err.message || err);
      }
      event.sender.send('folder-scan-progress', {
        current: i + 1, total: files.length, fileName: path.basename(files[i])
      });
    }
    return libraryStore.loadLibrary(app.getPath('userData'));
  });

  ipcMain.handle('get-library', async () => {
    return libraryStore.loadLibrary(app.getPath('userData'));
  });

  ipcMain.handle('add-single-file-to-library', async (_event, filePath) => {
    await addFileToLibrary(filePath);
    return libraryStore.loadLibrary(app.getPath('userData'));
  });

  ipcMain.handle('set-favorite', async (_event, hash, favorite) => {
    return libraryStore.setFavorite(app.getPath('userData'), hash, favorite);
  });

  ipcMain.handle('remove-library-entry', async (_event, hash) => {
    libraryStore.removeEntry(app.getPath('userData'), hash);
  });

  ipcMain.handle('record-play', async (_event, hash) => {
    return libraryStore.recordPlay(app.getPath('userData'), hash);
  });

  ipcMain.handle('mark-library-processed', async (_event, hash, duration) => {
    return libraryStore.markProcessed(app.getPath('userData'), hash, duration);
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
