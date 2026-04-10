export class EventStore {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.events = [];
    this.listeners = new Set();
  }

  add(event) {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.events.push(entry);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
    for (const listener of this.listeners) {
      listener(entry);
    }
    return entry;
  }

  getRecent(limit = 50, filter = {}) {
    let results = this.events;
    if (filter.pid) {
      results = results.filter((e) => e.pid === filter.pid);
    }
    return results.slice(-limit);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
