import { ProcessingQueue } from './processing-queue.js';
import { WaiterRegistry } from './waiter-registry.js';

export class LibraryManager {
  constructor({ onLibraryChanged, onQueueProgress }) {
    this.entries = [];
    this.queue = new ProcessingQueue();
    this.waiters = new WaiterRegistry();
    this.processing = false;
    this.onLibraryChanged = onLibraryChanged;
    this.onQueueProgress = onQueueProgress;
    this.audioContext = null;
  }

  async loadLibrary() {
    this.entries = await window.electronAPI.getLibrary();
    this.onLibraryChanged(this.entries);
    for (const entry of this.entries) {
      if (!entry.processed) this.queue.enqueue(entry.hash);
    }
    this._runQueue();
  }

  async addFolder(folderPath) {
    this.entries = await window.electronAPI.scanFolder(folderPath);
    this.onLibraryChanged(this.entries);
    for (const entry of this.entries) {
      if (!entry.processed) this.queue.enqueue(entry.hash);
    }
    this._runQueue();
  }

  async addFile(filePath) {
    this.entries = await window.electronAPI.addSingleFileToLibrary(filePath);
    this.onLibraryChanged(this.entries);
    const entry = this.entries.find((e) => e.filePath === filePath);
    if (entry && !entry.processed) {
      this.queue.enqueue(entry.hash);
      this._runQueue();
    }
    return entry;
  }

  async playWhenReady(hash) {
    const entry = this.entries.find((e) => e.hash === hash);
    if (!entry) throw new Error(`Unknown library entry: ${hash}`);
    if (entry.processed) return entry;

    this.queue.jumpToFront(hash);
    this._runQueue();
    return this.waiters.wait(hash);
  }

  async setFavorite(hash, favorite) {
    const updated = await window.electronAPI.setFavorite(hash, favorite);
    this._replaceEntry(updated);
  }

  async setGenre(hash, genre) {
    const updated = await window.electronAPI.setGenre(hash, genre);
    this._replaceEntry(updated);
  }

  async removeEntry(hash) {
    await window.electronAPI.removeLibraryEntry(hash);
    this.entries = this.entries.filter((e) => e.hash !== hash);
    this.queue.remove(hash);
    this.onLibraryChanged(this.entries);
  }

  async recordPlay(hash) {
    const updated = await window.electronAPI.recordPlay(hash);
    this._replaceEntry(updated);
  }

  _replaceEntry(updated) {
    if (!updated) return;
    this.entries = this.entries.map((e) => (e.hash === updated.hash ? updated : e));
    this.onLibraryChanged(this.entries);
  }

  async _runQueue() {
    if (this.processing) return;
    this.processing = true;

    // Everything below runs under a try/finally so `this.processing` is
    // guaranteed to reset even if something throws outside the per-entry
    // try/catch (e.g. AudioContext construction) — otherwise the queue would
    // be permanently stuck for the rest of the session, since `_runQueue` is
    // called fire-and-forget from addFolder/addFile/playWhenReady and no one
    // else would ever clear the guard flag.
    try {
      if (!this.audioContext) this.audioContext = new AudioContext({ sampleRate: 44100 });

      while (!this.queue.isEmpty) {
        const hash = this.queue.next();
        const entry = this.entries.find((e) => e.hash === hash);
        if (!entry) continue;

        try {
          let finalDuration = entry.duration;
          const { cached, dir } = await window.electronAPI.checkStemCache(entry.filePath);

          if (!cached) {
            const fileBytes = await window.electronAPI.readAudioFileBytes(entry.filePath);
            const decoded = await this.audioContext.decodeAudioData(
              fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength)
            );
            finalDuration = decoded.duration;
            const left = decoded.getChannelData(0);
            const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);

            window.electronAPI.onStemProgress((percent) => {
              if (this.onQueueProgress) {
                this.onQueueProgress({ hash, title: entry.title, queueTotal: this.queue.size + 1, percent });
              }
            });

            await window.electronAPI.processAudioPcm({ hash, dir, left, right, sampleRate: decoded.sampleRate });
          }

          const updated = await window.electronAPI.markLibraryProcessed(hash, finalDuration);
          this._replaceEntry(updated);
          this.waiters.resolveAll(hash, updated);
        } catch (err) {
          console.error(`Failed to process "${entry.title}":`, err);
          this._replaceEntry({ ...entry, processed: false, error: err.message || String(err) });
          this.waiters.rejectAll(hash, err);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
