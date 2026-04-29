import type Database from 'better-sqlite3';
import type {
  ApiCallRecord,
  ToolExecutionRecord,
  ApiErrorRecord,
  LatencyStats,
  ToolStats,
  ModelBreakdown,
  MetricsSummary,
  MetricsFilter,
  DbInstance,
} from './types.js';

export class MetricsStore {
  retentionMs: number;
  apiCalls: ApiCallRecord[];
  toolExecutions: ToolExecutionRecord[];
  apiErrors: ApiErrorRecord[];

  private db: DbInstance | null;
  private _insertApiCall: Database.Statement | null = null;
  private _insertToolExec: Database.Statement | null = null;
  private _insertApiError: Database.Statement | null = null;

  constructor(retentionMs = 3600000, { db }: { db?: DbInstance } = {}) {
    this.retentionMs = retentionMs;
    this.apiCalls = [];
    this.toolExecutions = [];
    this.apiErrors = [];
    this.db = db || null;

    if (this.db) {
      this._insertApiCall = this.db.prepare(
        'INSERT INTO api_calls (timestamp, session_id, model, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      this._insertToolExec = this.db.prepare(
        'INSERT INTO tool_executions (timestamp, session_id, tool_name, duration_ms, success) VALUES (?, ?, ?, ?, ?)',
      );
      this._insertApiError = this.db.prepare(
        'INSERT INTO api_errors (timestamp, session_id, model, error_type, status_code) VALUES (?, ?, ?, ?, ?)',
      );
    }
  }

  recordApiCall({
    model,
    durationMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    costUsd,
    timestamp,
    sessionId,
  }: Partial<ApiCallRecord> & { model: string; durationMs: number; inputTokens: number; outputTokens: number }): void {
    const ts = timestamp || Date.now();
    this.apiCalls.push({
      model,
      durationMs,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheReadTokens || 0,
      cacheCreateTokens: cacheCreateTokens || 0,
      costUsd: costUsd || 0,
      timestamp: ts,
      sessionId,
    });
    this._prune(this.apiCalls);

    if (this._insertApiCall) {
      this._insertApiCall.run(
        ts,
        sessionId || null,
        model,
        durationMs,
        inputTokens,
        outputTokens,
        cacheReadTokens || 0,
        cacheCreateTokens || 0,
        costUsd || 0,
      );
    }
  }

  recordToolExecution({
    toolName,
    durationMs,
    success,
    timestamp,
    sessionId,
  }: Partial<ToolExecutionRecord> & { toolName: string; durationMs: number; success: boolean }): void {
    const ts = timestamp || Date.now();
    this.toolExecutions.push({
      toolName,
      durationMs,
      success,
      timestamp: ts,
      sessionId,
    });
    this._prune(this.toolExecutions);

    if (this._insertToolExec) {
      this._insertToolExec.run(ts, sessionId || null, toolName, durationMs, success ? 1 : 0);
    }
  }

  recordApiError({
    model,
    errorType,
    statusCode,
    timestamp,
    sessionId,
  }: Partial<ApiErrorRecord> & { model: string; errorType: string; statusCode: number }): void {
    const ts = timestamp || Date.now();
    this.apiErrors.push({
      model,
      errorType,
      statusCode,
      timestamp: ts,
      sessionId,
    });
    this._prune(this.apiErrors);

    if (this._insertApiError) {
      this._insertApiError.run(ts, sessionId || null, model, errorType, statusCode);
    }
  }

  // ── In-memory real-time queries (unchanged) ────────────────

  getApiLatencyStats(windowMs = 3600000): LatencyStats {
    const cutoff = Date.now() - windowMs;
    const calls = this.apiCalls.filter((c) => c.timestamp >= cutoff);
    if (calls.length === 0) return { p50: 0, p95: 0, p99: 0, avg: 0, count: 0 };

    const durations = calls.map((c) => c.durationMs).sort((a, b) => a - b);
    return {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      avg: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
      count: durations.length,
    };
  }

  getCostTimeline(bucketMs = 60000): { timestamp: number; cost: number }[] {
    const cutoff = Date.now() - this.retentionMs;
    const calls = this.apiCalls.filter((c) => c.timestamp >= cutoff);
    const buckets = new Map<number, number>();
    for (const c of calls) {
      const key = Math.floor(c.timestamp / bucketMs) * bucketMs;
      buckets.set(key, (buckets.get(key) || 0) + c.costUsd);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, cost]) => ({ timestamp, cost }));
  }

  getToolStats(windowMs = 3600000): Record<string, ToolStats> {
    const cutoff = Date.now() - windowMs;
    const execs = this.toolExecutions.filter((t) => t.timestamp >= cutoff);
    const byTool = new Map<string, ToolExecutionRecord[]>();
    for (const e of execs) {
      if (!byTool.has(e.toolName)) byTool.set(e.toolName, []);
      byTool.get(e.toolName)!.push(e);
    }
    const result: Record<string, ToolStats> = {};
    for (const [name, entries] of byTool) {
      const durations = entries.map((e) => e.durationMs).sort((a, b) => a - b);
      const errors = entries.filter((e) => !e.success).length;
      result[name] = {
        count: entries.length,
        avg: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
        p95: percentile(durations, 0.95),
        errorRate: entries.length > 0 ? errors / entries.length : 0,
      };
    }
    return result;
  }

  getErrorRate(windowMs = 3600000): { total: number; byType: Record<string, number> } {
    const cutoff = Date.now() - windowMs;
    const errors = this.apiErrors.filter((e) => e.timestamp >= cutoff);
    const byType: Record<string, number> = {};
    for (const e of errors) {
      const key = e.errorType || `status_${e.statusCode}`;
      byType[key] = (byType[key] || 0) + 1;
    }
    return { total: errors.length, byType };
  }

  getModelBreakdown(windowMs = 3600000): Record<string, ModelBreakdown> {
    const cutoff = Date.now() - windowMs;
    const calls = this.apiCalls.filter((c) => c.timestamp >= cutoff);
    const byModel: Record<string, ModelBreakdown> = {};
    for (const c of calls) {
      if (!byModel[c.model])
        byModel[c.model] = { calls: 0, totalLatency: 0, totalCost: 0, totalTokens: 0, avgLatency: 0 };
      const m = byModel[c.model]!;
      m.calls++;
      m.totalLatency += c.durationMs;
      m.totalCost += c.costUsd;
      m.totalTokens += (c.inputTokens || 0) + (c.outputTokens || 0);
    }
    for (const m of Object.values(byModel)) {
      m.avgLatency = m.calls > 0 ? Math.round(m.totalLatency / m.calls) : 0;
    }
    return byModel;
  }

  getSummary(windowMs = 3600000): MetricsSummary {
    return {
      latency: this.getApiLatencyStats(windowMs),
      costTimeline: this.getCostTimeline(60000),
      toolStats: this.getToolStats(windowMs),
      errorRate: this.getErrorRate(windowMs),
      modelBreakdown: this.getModelBreakdown(windowMs),
    };
  }

  // ── Historical SQLite queries ──────────────────────────────

  getApiLatencyStatsHistorical(filter: MetricsFilter = {}): LatencyStats {
    if (!this.db) return { p50: 0, p95: 0, p99: 0, avg: 0, count: 0 };
    const { where, params } = buildMetricsWhere(filter, 'api_calls');
    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM api_calls ${where}`).get(...params) as {
      cnt: number;
    };
    if (countRow.cnt === 0) return { p50: 0, p95: 0, p99: 0, avg: 0, count: 0 };

    const avg = this.db.prepare(`SELECT AVG(duration_ms) as avg FROM api_calls ${where}`).get(...params) as {
      avg: number;
    };
    const p50 = this.db
      .prepare(`SELECT duration_ms FROM api_calls ${where} ORDER BY duration_ms ASC LIMIT 1 OFFSET ?`)
      .get(...params, Math.floor(countRow.cnt * 0.5)) as { duration_ms: number } | undefined;
    const p95 = this.db
      .prepare(`SELECT duration_ms FROM api_calls ${where} ORDER BY duration_ms ASC LIMIT 1 OFFSET ?`)
      .get(...params, Math.floor(countRow.cnt * 0.95)) as { duration_ms: number } | undefined;
    const p99 = this.db
      .prepare(`SELECT duration_ms FROM api_calls ${where} ORDER BY duration_ms ASC LIMIT 1 OFFSET ?`)
      .get(...params, Math.floor(countRow.cnt * 0.99)) as { duration_ms: number } | undefined;

    return {
      p50: p50?.duration_ms || 0,
      p95: p95?.duration_ms || 0,
      p99: p99?.duration_ms || 0,
      avg: Math.round(avg.avg || 0),
      count: countRow.cnt,
    };
  }

  getCostTimelineHistorical(filter: MetricsFilter = {}, bucketMs = 60000): { timestamp: number; cost: number }[] {
    if (!this.db) return [];
    const { where, params } = buildMetricsWhere(filter, 'api_calls');
    const rows = this.db
      .prepare(
        `SELECT (timestamp / ? * ?) as bucket, SUM(cost_usd) as cost FROM api_calls ${where} GROUP BY bucket ORDER BY bucket`,
      )
      .all(bucketMs, bucketMs, ...params) as { bucket: number; cost: number }[];
    return rows.map((r) => ({ timestamp: r.bucket, cost: r.cost }));
  }

  getToolStatsHistorical(filter: MetricsFilter = {}): Record<string, ToolStats> {
    if (!this.db) return {};
    const { where, params } = buildMetricsWhere(filter, 'tool_executions');
    const rows = this.db
      .prepare(
        `SELECT tool_name, COUNT(*) as cnt, AVG(duration_ms) as avg_ms,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors
         FROM tool_executions ${where} GROUP BY tool_name`,
      )
      .all(...params) as { tool_name: string; cnt: number; avg_ms: number; errors: number }[];

    const result: Record<string, ToolStats> = {};
    for (const r of rows) {
      // p95 per tool
      const p95Row = this.db
        .prepare(
          `SELECT duration_ms FROM tool_executions ${where ? where + ' AND' : 'WHERE'} tool_name = ? ORDER BY duration_ms ASC LIMIT 1 OFFSET ?`,
        )
        .get(...params, r.tool_name, Math.floor(r.cnt * 0.95)) as { duration_ms: number } | undefined;

      result[r.tool_name] = {
        count: r.cnt,
        avg: Math.round(r.avg_ms),
        p95: p95Row?.duration_ms || 0,
        errorRate: r.cnt > 0 ? r.errors / r.cnt : 0,
      };
    }
    return result;
  }

  getModelBreakdownHistorical(filter: MetricsFilter = {}): Record<string, ModelBreakdown> {
    if (!this.db) return {};
    const { where, params } = buildMetricsWhere(filter, 'api_calls');
    const rows = this.db
      .prepare(
        `SELECT model, COUNT(*) as calls, SUM(duration_ms) as total_latency,
                SUM(cost_usd) as total_cost, SUM(input_tokens + output_tokens) as total_tokens
         FROM api_calls ${where} GROUP BY model`,
      )
      .all(...params) as {
      model: string;
      calls: number;
      total_latency: number;
      total_cost: number;
      total_tokens: number;
    }[];

    const result: Record<string, ModelBreakdown> = {};
    for (const r of rows) {
      result[r.model] = {
        calls: r.calls,
        totalLatency: r.total_latency,
        totalCost: r.total_cost,
        totalTokens: r.total_tokens,
        avgLatency: r.calls > 0 ? Math.round(r.total_latency / r.calls) : 0,
      };
    }
    return result;
  }

  getErrorRateHistorical(filter: MetricsFilter = {}): { total: number; byType: Record<string, number> } {
    if (!this.db) return { total: 0, byType: {} };
    const { where, params } = buildMetricsWhere(filter, 'api_errors');
    const rows = this.db
      .prepare(`SELECT error_type, COUNT(*) as cnt FROM api_errors ${where} GROUP BY error_type`)
      .all(...params) as { error_type: string; cnt: number }[];

    const byType: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byType[r.error_type] = r.cnt;
      total += r.cnt;
    }
    return { total, byType };
  }

  getSummaryHistorical(filter: MetricsFilter = {}): MetricsSummary {
    return {
      latency: this.getApiLatencyStatsHistorical(filter),
      costTimeline: this.getCostTimelineHistorical(filter, 60000),
      toolStats: this.getToolStatsHistorical(filter),
      errorRate: this.getErrorRateHistorical(filter),
      modelBreakdown: this.getModelBreakdownHistorical(filter),
    };
  }

  // ── Filter metadata ────────────────────────────────────────

  getDistinctModels(): string[] {
    if (!this.db) return [];
    return (this.db.prepare('SELECT DISTINCT model FROM api_calls ORDER BY model').all() as { model: string }[]).map(
      (r) => r.model,
    );
  }

  getDistinctTools(): string[] {
    if (!this.db) return [];
    return (
      this.db.prepare('SELECT DISTINCT tool_name FROM tool_executions ORDER BY tool_name').all() as {
        tool_name: string;
      }[]
    ).map((r) => r.tool_name);
  }

  getDistinctSessions(): string[] {
    if (!this.db) return [];
    return (
      this.db
        .prepare(
          'SELECT DISTINCT session_id FROM api_calls WHERE session_id IS NOT NULL UNION SELECT DISTINCT session_id FROM tool_executions WHERE session_id IS NOT NULL ORDER BY session_id',
        )
        .all() as { session_id: string }[]
    ).map((r) => r.session_id);
  }

  // ── Internal ───────────────────────────────────────────────

  private _prune(arr: { timestamp: number }[]): void {
    const cutoff = Date.now() - this.retentionMs;
    while (arr.length > 0 && arr[0]!.timestamp < cutoff) {
      arr.shift();
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function buildMetricsWhere(filter: MetricsFilter, table: string): { where: string; params: (string | number)[] } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter.from != null) {
    conditions.push('timestamp >= ?');
    params.push(filter.from);
  }
  if (filter.to != null) {
    conditions.push('timestamp < ?');
    params.push(filter.to);
  }
  if (filter.model) {
    conditions.push('model = ?');
    params.push(filter.model);
  }
  if (filter.sessionId) {
    conditions.push('session_id = ?');
    params.push(filter.sessionId);
  }
  if (filter.toolName && table === 'tool_executions') {
    conditions.push('tool_name = ?');
    params.push(filter.toolName);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}
