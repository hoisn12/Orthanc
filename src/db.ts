import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DbInstance } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

let _db: DbInstance | null = null;

export function getDb(): DbInstance {
  if (_db) return _db;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _db = new Database(path.join(DATA_DIR, 'monitor.db'));
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 3000');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      session_id TEXT,
      pid INTEGER,
      payload TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_pid ON events(pid);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

    CREATE TABLE IF NOT EXISTS usage (
      session_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_file TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      model TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_create INTEGER NOT NULL DEFAULT 0,
      cwd TEXT,
      started_at TEXT,
      last_activity TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);

    CREATE TABLE IF NOT EXISTS token_sync_state (
      file_path TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_synced TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_id TEXT,
      model TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_api_calls_timestamp ON api_calls(timestamp);
    CREATE INDEX IF NOT EXISTS idx_api_calls_model ON api_calls(model);
    CREATE INDEX IF NOT EXISTS idx_api_calls_session ON api_calls(session_id);

    CREATE TABLE IF NOT EXISTS tool_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      success INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_tool_execs_timestamp ON tool_executions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_execs_tool ON tool_executions(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_execs_session ON tool_executions(session_id);

    CREATE TABLE IF NOT EXISTS api_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_id TEXT,
      model TEXT NOT NULL,
      error_type TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_api_errors_timestamp ON api_errors(timestamp);
    CREATE INDEX IF NOT EXISTS idx_api_errors_session ON api_errors(session_id);
  `);

  // Migration: add trace_id and parent_id columns to events table
  const columns = _db.pragma('table_info(events)') as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));
  if (!columnNames.has('trace_id')) {
    _db.exec(`
      ALTER TABLE events ADD COLUMN trace_id TEXT;
      ALTER TABLE events ADD COLUMN parent_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_events_trace_id ON events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_events_parent_id ON events(parent_id);
    `);
  }

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
