import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsStore } from '../src/metrics-store.js';
import { createTestDb } from './test-db.js';

describe('MetricsStore', () => {
  it('records and retrieves API call latency stats', () => {
    const store = new MetricsStore();
    store.recordApiCall({
      model: 'claude-sonnet-4-5',
      durationMs: 100,
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.001,
      timestamp: Date.now(),
    });
    store.recordApiCall({
      model: 'claude-sonnet-4-5',
      durationMs: 200,
      inputTokens: 600,
      outputTokens: 300,
      costUsd: 0.002,
      timestamp: Date.now(),
    });
    store.recordApiCall({
      model: 'claude-sonnet-4-5',
      durationMs: 500,
      inputTokens: 1000,
      outputTokens: 400,
      costUsd: 0.005,
      timestamp: Date.now(),
    });

    const stats = store.getApiLatencyStats();
    assert.equal(stats.count, 3);
    assert.ok(stats.p50 >= 100 && stats.p50 <= 500);
    assert.ok(stats.p95 >= 200);
    assert.ok(stats.avg > 0);
  });

  it('returns zeros when no data', () => {
    const store = new MetricsStore();
    const stats = store.getApiLatencyStats();
    assert.equal(stats.count, 0);
    assert.equal(stats.p50, 0);
    assert.equal(stats.avg, 0);
  });

  it('computes cost timeline with bucketing', () => {
    const store = new MetricsStore();
    const now = Date.now();
    const bucket = 60000;

    store.recordApiCall({
      model: 'm',
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 0.01,
      timestamp: now,
    });
    store.recordApiCall({
      model: 'm',
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 0.02,
      timestamp: now + 10,
    });
    store.recordApiCall({
      model: 'm',
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 0.03,
      timestamp: now + bucket + 10,
    });

    const timeline = store.getCostTimeline(bucket);
    assert.equal(timeline.length, 2);
    assert.ok(Math.abs(timeline[0]!.cost - 0.03) < 0.001);
    assert.ok(Math.abs(timeline[1]!.cost - 0.03) < 0.001);
  });

  it('tracks tool execution stats', () => {
    const store = new MetricsStore();
    store.recordToolExecution({ toolName: 'Bash', durationMs: 100, success: true, timestamp: Date.now() });
    store.recordToolExecution({ toolName: 'Bash', durationMs: 200, success: true, timestamp: Date.now() });
    store.recordToolExecution({ toolName: 'Bash', durationMs: 300, success: false, timestamp: Date.now() });

    const tools = store.getToolStats();
    assert.ok(tools['Bash']);
    assert.equal(tools['Bash']!.count, 3);
    assert.ok(tools['Bash']!.errorRate > 0.3 && tools['Bash']!.errorRate < 0.34);
  });

  it('tracks error rate by type', () => {
    const store = new MetricsStore();
    store.recordApiError({ model: 'm', errorType: 'rate_limit', statusCode: 429, timestamp: Date.now() });
    store.recordApiError({ model: 'm', errorType: 'rate_limit', statusCode: 429, timestamp: Date.now() });
    store.recordApiError({ model: 'm', errorType: 'server_error', statusCode: 500, timestamp: Date.now() });

    const errors = store.getErrorRate();
    assert.equal(errors.total, 3);
    assert.equal(errors.byType['rate_limit'], 2);
    assert.equal(errors.byType['server_error'], 1);
  });

  it('computes model breakdown', () => {
    const store = new MetricsStore();
    store.recordApiCall({
      model: 'claude-sonnet-4-5',
      durationMs: 100,
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.001,
      timestamp: Date.now(),
    });
    store.recordApiCall({
      model: 'claude-opus-4-5',
      durationMs: 300,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
      timestamp: Date.now(),
    });

    const breakdown = store.getModelBreakdown();
    assert.ok(breakdown['claude-sonnet-4-5']);
    assert.ok(breakdown['claude-opus-4-5']);
    assert.equal(breakdown['claude-sonnet-4-5']!.calls, 1);
    assert.equal(breakdown['claude-opus-4-5']!.calls, 1);
  });

  it('prunes old records beyond retention', () => {
    const store = new MetricsStore(1000);
    const old = Date.now() - 2000;
    store.recordApiCall({
      model: 'm',
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 0.01,
      timestamp: old,
    });
    store.recordApiCall({
      model: 'm',
      durationMs: 200,
      inputTokens: 200,
      outputTokens: 200,
      costUsd: 0.02,
      timestamp: Date.now(),
    });

    const stats = store.getApiLatencyStats(1000);
    assert.equal(stats.count, 1);
    assert.equal(stats.p50, 200);
  });

  it('getSummary returns all sections', () => {
    const store = new MetricsStore();
    store.recordApiCall({
      model: 'm',
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 0.01,
      timestamp: Date.now(),
    });

    const summary = store.getSummary();
    assert.ok(summary.latency);
    assert.ok(summary.costTimeline);
    assert.ok(summary.toolStats);
    assert.ok(summary.errorRate);
    assert.ok(summary.modelBreakdown);
  });
});

describe('MetricsStore (SQLite persistence)', () => {
  it('persists api calls to SQLite and queries historically', () => {
    const db = createTestDb();
    const store = new MetricsStore(3600000, { db });
    const now = Date.now();

    store.recordApiCall({
      model: 'sonnet',
      durationMs: 100,
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.01,
      timestamp: now,
      sessionId: 'sess-1',
    });
    store.recordApiCall({
      model: 'opus',
      durationMs: 300,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
      timestamp: now + 1,
      sessionId: 'sess-1',
    });

    const stats = store.getApiLatencyStatsHistorical({});
    assert.equal(stats.count, 2);
    assert.ok(stats.avg > 0);

    // Filter by model
    const sonnetStats = store.getApiLatencyStatsHistorical({ model: 'sonnet' });
    assert.equal(sonnetStats.count, 1);
    assert.equal(sonnetStats.p50, 100);
  });

  it('persists tool executions and queries historically', () => {
    const db = createTestDb();
    const store = new MetricsStore(3600000, { db });

    store.recordToolExecution({
      toolName: 'Bash',
      durationMs: 100,
      success: true,
      timestamp: Date.now(),
      sessionId: 'sess-1',
    });
    store.recordToolExecution({
      toolName: 'Read',
      durationMs: 200,
      success: true,
      timestamp: Date.now(),
      sessionId: 'sess-1',
    });
    store.recordToolExecution({
      toolName: 'Bash',
      durationMs: 300,
      success: false,
      timestamp: Date.now(),
      sessionId: 'sess-1',
    });

    const tools = store.getToolStatsHistorical({});
    assert.ok(tools['Bash']);
    assert.equal(tools['Bash']!.count, 2);
    assert.ok(tools['Read']);
    assert.equal(tools['Read']!.count, 1);
  });

  it('ignores model filters for tool execution historical queries', () => {
    const db = createTestDb();
    const store = new MetricsStore(3600000, { db });

    store.recordToolExecution({
      toolName: 'Bash',
      durationMs: 100,
      success: true,
      timestamp: Date.now(),
      sessionId: 'sess-1',
    });

    const tools = store.getToolStatsHistorical({ model: 'sonnet' });
    assert.ok(tools['Bash']);
    assert.equal(tools['Bash']!.count, 1);
  });

  it('applies model filters to model-backed historical queries', () => {
    const db = createTestDb();
    const store = new MetricsStore(3600000, { db });

    store.recordApiCall({
      model: 'sonnet',
      durationMs: 100,
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.01,
      timestamp: Date.now(),
    });
    store.recordApiCall({
      model: 'opus',
      durationMs: 300,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
      timestamp: Date.now(),
    });

    const stats = store.getApiLatencyStatsHistorical({ model: 'sonnet' });
    assert.equal(stats.count, 1);
    assert.equal(stats.p50, 100);
  });

  it('persists api errors and queries historically', () => {
    const db = createTestDb();
    const store = new MetricsStore(3600000, { db });

    store.recordApiError({
      model: 'm',
      errorType: 'rate_limit',
      statusCode: 429,
      timestamp: Date.now(),
      sessionId: 'sess-1',
    });
    store.recordApiError({ model: 'm', errorType: 'server_error', statusCode: 500, timestamp: Date.now() });

    const errors = store.getErrorRateHistorical({});
    assert.equal(errors.total, 2);
    assert.equal(errors.byType['rate_limit'], 1);
    assert.equal(errors.byType['server_error'], 1);
  });

  it('model breakdown works from SQLite', () => {
    const db = createTestDb();
    const store = new MetricsStore(3600000, { db });

    store.recordApiCall({
      model: 'sonnet',
      durationMs: 100,
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.01,
      timestamp: Date.now(),
    });
    store.recordApiCall({
      model: 'opus',
      durationMs: 300,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
      timestamp: Date.now(),
    });

    const breakdown = store.getModelBreakdownHistorical({});
    assert.ok(breakdown['sonnet']);
    assert.ok(breakdown['opus']);
    assert.equal(breakdown['sonnet']!.calls, 1);
    assert.equal(breakdown['opus']!.calls, 1);
  });

  it('getDistinctModels and getDistinctTools return correct values', () => {
    const db = createTestDb();
    const store = new MetricsStore(3600000, { db });

    store.recordApiCall({
      model: 'sonnet',
      durationMs: 100,
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.01,
      timestamp: Date.now(),
    });
    store.recordApiCall({
      model: 'opus',
      durationMs: 300,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
      timestamp: Date.now(),
    });
    store.recordToolExecution({ toolName: 'Bash', durationMs: 100, success: true, timestamp: Date.now() });

    const models = store.getDistinctModels();
    assert.ok(models.includes('sonnet'));
    assert.ok(models.includes('opus'));

    const tools = store.getDistinctTools();
    assert.ok(tools.includes('Bash'));
  });

  it('works in memory-only mode when no db provided', () => {
    const store = new MetricsStore();
    store.recordApiCall({
      model: 'm',
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 0.01,
      timestamp: Date.now(),
    });

    // Historical queries return empty without db
    const stats = store.getApiLatencyStatsHistorical({});
    assert.equal(stats.count, 0);

    // In-memory still works
    const memStats = store.getApiLatencyStats();
    assert.equal(memStats.count, 1);
  });

  it('filters by time range', () => {
    const db = createTestDb();
    const store = new MetricsStore(3600000, { db });
    const now = Date.now();

    store.recordApiCall({
      model: 'm',
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 0.01,
      timestamp: now - 5000,
    });
    store.recordApiCall({
      model: 'm',
      durationMs: 200,
      inputTokens: 200,
      outputTokens: 200,
      costUsd: 0.02,
      timestamp: now,
    });

    const all = store.getApiLatencyStatsHistorical({});
    assert.equal(all.count, 2);

    const recent = store.getApiLatencyStatsHistorical({ from: now - 1000 });
    assert.equal(recent.count, 1);
  });
});
