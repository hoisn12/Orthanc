import { getDb } from './db.js';

export class EventStore {
  constructor(maxSize = 2000, { db } = {}) {
    this.maxSize = maxSize;
    this.listeners = new Set();
    this.db = db || getDb();

    this._stmtInsert = this.db.prepare(
      'INSERT INTO events (id, timestamp, type, session_id, pid, payload) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this._stmtRecent = this.db.prepare(
      'SELECT * FROM events ORDER BY timestamp DESC LIMIT ?'
    );
    this._stmtRecentByPid = this.db.prepare(
      'SELECT * FROM events WHERE pid = ? ORDER BY timestamp DESC LIMIT ?'
    );
    this._stmtCount = this.db.prepare('SELECT COUNT(*) as cnt FROM events');
    this._stmtPrune = this.db.prepare(
      'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY timestamp ASC LIMIT ?)'
    );
  }

  add(event) {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(),
      ...event,
    };

    this._stmtInsert.run(
      entry.id,
      entry.timestamp,
      entry.type || '',
      entry.sessionId || null,
      entry.pid || null,
      JSON.stringify(entry.payload || {})
    );

    // Prune old events
    const { cnt } = this._stmtCount.get();
    if (cnt > this.maxSize) {
      this._stmtPrune.run(cnt - this.maxSize);
    }

    for (const listener of this.listeners) {
      listener(entry);
    }
    return entry;
  }

  getRecent(limit = 50, filter = {}) {
    let rows;
    if (filter.pid) {
      rows = this._stmtRecentByPid.all(filter.pid, limit);
    } else {
      rows = this._stmtRecent.all(limit);
    }
    return rows.map(rowToEvent).reverse();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function rowToEvent(row) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type,
    sessionId: row.session_id,
    pid: row.pid,
    payload: JSON.parse(row.payload || '{}'),
  };
}
