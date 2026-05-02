import Database from 'better-sqlite3';
import type { DbInstance } from '../src/types.js';

/**
 * Create an isolated in-memory SQLite DB for tests.
 * Has the same schema as the production DB but no shared state.
 */
export function createTestDb(): DbInstance {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      session_id TEXT,
      pid INTEGER,
      payload TEXT,
      trace_id TEXT,
      parent_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_pid ON events(pid);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_trace_id ON events(trace_id);
    CREATE INDEX IF NOT EXISTS idx_events_parent_id ON events(parent_id);

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

  return db;
}
