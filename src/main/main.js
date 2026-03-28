const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const AudioBridge = require('./audio-bridge');
const SettingsStore = require('./settings-store');

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
