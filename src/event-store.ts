import type Database from 'better-sqlite3';
import { getDb } from './db.js';
import type { EventInput, EventEntry, DbInstance } from './types.js';

type EventListener = (event: EventEntry) => void;

interface EventRow {
  id: string;
  timestamp: string;
  type: string;
  session_id: string | null;
  pid: number | null;
  payload: string;
}

export class EventStore {
  maxSize: number;
  listeners: Set<EventListener>;
  db: DbInstance;

  private _stmtInsert: Database.Statement;
  private _stmtRecent: Database.Statement;
  private _stmtRecentByPid: Database.Statement;
  private _stmtCount: Database.Statement;
  private _stmtPrune: Database.Statement;
  private _stmtBySessionAndType: Database.Statement;
  private _stmtOlder: Database.Statement;
  private _stmtOlderByPid: Database.Statement;

  constructor(maxSize = 2000, { db }: { db?: DbInstance } = {}) {
    this.maxSize = maxSize;
    this.listeners = new Set();
    this.db = db || getDb();

    this._stmtInsert = this.db.prepare(
      'INSERT INTO events (id, timestamp, type, session_id, pid, payload) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this._stmtRecent = this.db.prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?');
    this._stmtRecentByPid = this.db.prepare('SELECT * FROM events WHERE pid = ? ORDER BY timestamp DESC LIMIT ?');
    this._stmtCount = this.db.prepare('SELECT COUNT(*) as cnt FROM events');
    this._stmtPrune = this.db.prepare(
      'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY timestamp ASC LIMIT ?)',
    );
    this._stmtBySessionAndType = this.db.prepare(
      'SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY timestamp ASC',
    );
    this._stmtOlder = this.db.prepare('SELECT * FROM events WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?');
    this._stmtOlderByPid = this.db.prepare(
      'SELECT * FROM events WHERE timestamp < ? AND pid = ? ORDER BY timestamp DESC LIMIT ?',
    );
  }

  add(event: EventInput): EventEntry {
    const entry: EventEntry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(),
      type: event.type || '',
      sessionId: event.sessionId || null,
      pid: event.pid || null,
      payload: event.payload || {},
    };

    this._stmtInsert.run(
      entry.id,
      entry.timestamp,
      entry.type,
      entry.sessionId,
      entry.pid,
      JSON.stringify(entry.payload),
    );

    // Prune old events
    const { cnt } = this._stmtCount.get() as { cnt: number };
    if (cnt > this.maxSize) {
      this._stmtPrune.run(cnt - this.maxSize);
    }

    for (const listener of this.listeners) {
      listener(entry);
    }
    return entry;
  }

  getRecent(limit = 50, filter: { pid?: number } = {}): EventEntry[] {
    let rows: EventRow[];
    if (filter.pid) {
      rows = this._stmtRecentByPid.all(filter.pid, limit) as EventRow[];
    } else {
      rows = this._stmtRecent.all(limit) as EventRow[];
    }
    return rows.map(rowToEvent).reverse();
  }

  getOlderThan(before: string, limit = 50, filter: { pid?: number } = {}): EventEntry[] {
    let rows: EventRow[];
    if (filter.pid) {
      rows = this._stmtOlderByPid.all(before, filter.pid, limit) as EventRow[];
    } else {
      rows = this._stmtOlder.all(before, limit) as EventRow[];
    }
    return rows.map(rowToEvent).reverse();
  }

  getBySessionAndType(sessionId: string, type: string): EventEntry[] {
    const rows = this._stmtBySessionAndType.all(sessionId, type) as EventRow[];
    return rows.map(rowToEvent);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function rowToEvent(row: EventRow): EventEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type,
    sessionId: row.session_id,
    pid: row.pid,
    payload: JSON.parse(row.payload || '{}') as Record<string, unknown>,
  };
}
