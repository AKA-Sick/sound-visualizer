export class ProcessingQueue {
  constructor() {
    this.pending = [];
  }

  enqueue(hash) {
    if (!this.pending.includes(hash)) this.pending.push(hash);
  }

  jumpToFront(hash) {
    const idx = this.pending.indexOf(hash);
    if (idx > 0) {
      this.pending.splice(idx, 1);
      this.pending.unshift(hash);
    } else if (idx === -1) {
      this.pending.unshift(hash);
    }
  }

  next() {
    return this.pending.shift() || null;
  }

  remove(hash) {
    this.pending = this.pending.filter((h) => h !== hash);
  }

  get size() {
    return this.pending.length;
  }

  get isEmpty() {
    return this.pending.length === 0;
  }
}
