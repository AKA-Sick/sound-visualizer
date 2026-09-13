export class WaiterRegistry {
  constructor() {
    this.waiters = new Map();
  }

  wait(key) {
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(key) || [];
      list.push({ resolve, reject });
      this.waiters.set(key, list);
    });
  }

  resolveAll(key, value) {
    const list = this.waiters.get(key) || [];
    this.waiters.delete(key);
    for (const { resolve } of list) resolve(value);
  }

  rejectAll(key, err) {
    const list = this.waiters.get(key) || [];
    this.waiters.delete(key);
    for (const { reject } of list) reject(err);
  }
}
