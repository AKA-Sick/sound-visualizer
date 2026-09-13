const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  mode: 'segmented-led',
  theme: 'neon',
  sensitivity: 1.0,
  barCount: 64,
  background: 'solid',
  beatFlash: false,
  source: 'live'
};

class SettingsStore {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'settings.json');
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  get() {
    return { ...this.data };
  }

  update(newSettings) {
    Object.assign(this.data, newSettings);
    this.save();
  }
}

module.exports = SettingsStore;
