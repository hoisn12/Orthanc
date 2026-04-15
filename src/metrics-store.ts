import type {
  ApiCallRecord,
  ToolExecutionRecord,
  ApiErrorRecord,
  LatencyStats,
  ToolStats,
  ModelBreakdown,
  MetricsSummary,
} from './types.js';

export class MetricsStore {
  retentionMs: number;
  apiCalls: ApiCallRecord[];
  toolExecutions: ToolExecutionRecord[];
  apiErrors: ApiErrorRecord[];

  constructor(retentionMs = 3600000) {
    this.retentionMs = retentionMs;
    this.apiCalls = [];
    this.toolExecutions = [];
    this.apiErrors = [];
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
  }: Partial<ApiCallRecord> & { model: string; durationMs: number; inputTokens: number; outputTokens: number }): void {
    this.apiCalls.push({
      model,
      durationMs,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheReadTokens || 0,
      cacheCreateTokens: cacheCreateTokens || 0,
      costUsd: costUsd || 0,
      timestamp: timestamp || Date.now(),
    });
    this._prune(this.apiCalls);
  }

  recordToolExecution({ toolName, durationMs, success, timestamp }: Partial<ToolExecutionRecord> & { toolName: string; durationMs: number; success: boolean }): void {
    this.toolExecutions.push({
      toolName,
      durationMs,
      success,
      timestamp: timestamp || Date.now(),
    });
    this._prune(this.toolExecutions);
  }

  recordApiError({ model, errorType, statusCode, timestamp }: Partial<ApiErrorRecord> & { model: string; errorType: string; statusCode: number }): void {
    this.apiErrors.push({
      model,
      errorType,
      statusCode,
      timestamp: timestamp || Date.now(),
    });
    this._prune(this.apiErrors);
  }

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
      if (!byModel[c.model]) byModel[c.model] = { calls: 0, totalLatency: 0, totalCost: 0, totalTokens: 0, avgLatency: 0 };
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
