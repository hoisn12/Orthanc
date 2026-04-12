import { getDb } from './db.js';

export class TokenStore {
  constructor() {
    this.db = getDb();

    this._upsert = this.db.prepare(`
      INSERT OR REPLACE INTO token_usage
      (id, session_id, session_file, timestamp, model, input, output, cache_read, cache_create, cwd, started_at, last_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._getSyncState = this.db.prepare(
      'SELECT byte_offset FROM token_sync_state WHERE file_path = ?'
    );
    this._setSyncState = this.db.prepare(
      'INSERT OR REPLACE INTO token_sync_state (file_path, byte_offset, last_synced) VALUES (?, ?, ?)'
    );
    this._getSessionMeta = this.db.prepare(
      'SELECT session_id, cwd, started_at FROM token_usage WHERE session_file = ? LIMIT 1'
    );
  }

  upsert(record) {
    this._upsert.run(
      record.id,
      record.sessionId,
      record.sessionFile,
      record.timestamp,
      record.model,
      record.input,
      record.output,
      record.cacheRead,
      record.cacheCreate,
      record.cwd || null,
      record.startedAt || null,
      record.lastActivity || null,
    );
  }

  bulkUpsert(records) {
    const tx = this.db.transaction((rows) => {
      for (const r of rows) this.upsert(r);
    });
    tx(records);
  }

  // ── Aggregated queries (no full-row loading) ──────────────

  queryAggregated({ from, to } = {}) {
    const where = buildWhere(from, to);
    const params = buildParams(from, to);

    const totals = this.db.prepare(`
      SELECT COALESCE(SUM(input),0) as input, COALESCE(SUM(output),0) as output,
             COALESCE(SUM(cache_read),0) as cache_read, COALESCE(SUM(cache_create),0) as cache_create,
             COUNT(*) as message_count
      FROM token_usage ${where}
    `).get(...params);

    const byModel = this.db.prepare(`
      SELECT model, SUM(input) as input, SUM(output) as output,
             SUM(cache_read) as cache_read, SUM(cache_create) as cache_create
      FROM token_usage ${where}
      GROUP BY model
    `).all(...params);

    const hourly = this.db.prepare(`
      SELECT substr(timestamp, 1, 13) as hour,
             SUM(input) as input, SUM(output) as output
      FROM token_usage ${where}
      GROUP BY hour ORDER BY hour
    `).all(...params);

    const sessions = this.db.prepare(`
      SELECT session_id, session_file, cwd,
             MIN(timestamp) as started_at, MAX(timestamp) as last_activity,
             SUM(input) as input, SUM(output) as output,
             SUM(cache_read) as cache_read, SUM(cache_create) as cache_create,
             COUNT(*) as message_count,
             GROUP_CONCAT(DISTINCT model) as models
      FROM token_usage ${where}
      GROUP BY session_id
      ORDER BY started_at DESC
    `).all(...params);

    // recent24h: always relative to now, independent of filter
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent24h = this.db.prepare(`
      SELECT COALESCE(SUM(input),0) as input, COALESCE(SUM(output),0) as output,
             COALESCE(SUM(cache_read),0) as cache_read, COALESCE(SUM(cache_create),0) as cache_create
      FROM token_usage WHERE timestamp >= ?
    `).get(cutoff24h);

    // recent24h by model (for cost calculation)
    const recent24hByModel = this.db.prepare(`
      SELECT model, SUM(input) as input, SUM(output) as output,
             SUM(cache_read) as cache_read, SUM(cache_create) as cache_create
      FROM token_usage WHERE timestamp >= ?
      GROUP BY model
    `).all(cutoff24h);

    return {
      totals: {
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cache_read,
        cacheCreate: totals.cache_create,
      },
      messageCount: totals.message_count,
      byModel: byModel.map(r => ({
        model: r.model,
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
        cacheCreate: r.cache_create,
      })),
      hourly: Object.fromEntries(hourly.map(r => [r.hour, { input: r.input, output: r.output }])),
      sessions: sessions.map(r => ({
        sessionId: r.session_id,
        file: r.session_file,
        cwd: r.cwd || '',
        startedAt: r.started_at,
        lastActivity: r.last_activity,
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
        cacheCreate: r.cache_create,
        messageCount: r.message_count,
        models: r.models ? r.models.split(',') : [],
      })),
      recent24h: {
        input: recent24h.input,
        output: recent24h.output,
        cacheRead: recent24h.cache_read,
        cacheCreate: recent24h.cache_create,
      },
      recent24hByModel: recent24hByModel.map(r => ({
        model: r.model,
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
        cacheCreate: r.cache_create,
      })),
    };
  }

  // ── Sync state ────────────────────────────────────────────

  getSyncState(filePath) {
    const row = this._getSyncState.get(filePath);
    return row ? row.byte_offset : 0;
  }

  setSyncState(filePath, byteOffset) {
    this._setSyncState.run(filePath, byteOffset, new Date().toISOString());
  }

  getSessionMeta(sessionFile) {
    const row = this._getSessionMeta.get(sessionFile);
    if (!row) return null;
    return {
      sessionId: row.session_id,
      cwd: row.cwd || '',
      startedAt: row.started_at || '',
    };
  }
}

function buildWhere(from, to) {
  if (from && to) return 'WHERE timestamp >= ? AND timestamp < ?';
  if (from) return 'WHERE timestamp >= ?';
  if (to) return 'WHERE timestamp < ?';
  return '';
}

function buildParams(from, to) {
  const params = [];
  if (from) params.push(from);
  if (to) params.push(to);
  return params;
}
