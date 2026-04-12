import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsStore } from '../src/metrics-store.js';

describe('MetricsStore', () => {
  it('records and retrieves API call latency stats', () => {
    const store = new MetricsStore();
    store.recordApiCall({ model: 'claude-sonnet-4-5', durationMs: 100, inputTokens: 500, outputTokens: 200, costUsd: 0.001, timestamp: Date.now() });
    store.recordApiCall({ model: 'claude-sonnet-4-5', durationMs: 200, inputTokens: 600, outputTokens: 300, costUsd: 0.002, timestamp: Date.now() });
    store.recordApiCall({ model: 'claude-sonnet-4-5', durationMs: 500, inputTokens: 1000, outputTokens: 400, costUsd: 0.005, timestamp: Date.now() });

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

    store.recordApiCall({ model: 'm', durationMs: 100, inputTokens: 100, outputTokens: 100, costUsd: 0.01, timestamp: now });
    store.recordApiCall({ model: 'm', durationMs: 100, inputTokens: 100, outputTokens: 100, costUsd: 0.02, timestamp: now + 10 });
    store.recordApiCall({ model: 'm', durationMs: 100, inputTokens: 100, outputTokens: 100, costUsd: 0.03, timestamp: now + bucket + 10 });

    const timeline = store.getCostTimeline(bucket);
    assert.equal(timeline.length, 2);
    assert.ok(Math.abs(timeline[0].cost - 0.03) < 0.001);
    assert.ok(Math.abs(timeline[1].cost - 0.03) < 0.001);
  });

  it('tracks tool execution stats', () => {
    const store = new MetricsStore();
    store.recordToolExecution({ toolName: 'Bash', durationMs: 100, success: true, timestamp: Date.now() });
    store.recordToolExecution({ toolName: 'Bash', durationMs: 200, success: true, timestamp: Date.now() });
    store.recordToolExecution({ toolName: 'Bash', durationMs: 300, success: false, timestamp: Date.now() });

    const tools = store.getToolStats();
    assert.ok(tools['Bash']);
    assert.equal(tools['Bash'].count, 3);
    assert.ok(tools['Bash'].errorRate > 0.3 && tools['Bash'].errorRate < 0.34);
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
    store.recordApiCall({ model: 'claude-sonnet-4-5', durationMs: 100, inputTokens: 500, outputTokens: 200, costUsd: 0.001, timestamp: Date.now() });
    store.recordApiCall({ model: 'claude-opus-4-5', durationMs: 300, inputTokens: 1000, outputTokens: 500, costUsd: 0.01, timestamp: Date.now() });

    const breakdown = store.getModelBreakdown();
    assert.ok(breakdown['claude-sonnet-4-5']);
    assert.ok(breakdown['claude-opus-4-5']);
    assert.equal(breakdown['claude-sonnet-4-5'].calls, 1);
    assert.equal(breakdown['claude-opus-4-5'].calls, 1);
  });

  it('prunes old records beyond retention', () => {
    const store = new MetricsStore(1000); // 1 second retention
    const old = Date.now() - 2000;
    store.recordApiCall({ model: 'm', durationMs: 100, inputTokens: 100, outputTokens: 100, costUsd: 0.01, timestamp: old });
    store.recordApiCall({ model: 'm', durationMs: 200, inputTokens: 200, outputTokens: 200, costUsd: 0.02, timestamp: Date.now() });

    const stats = store.getApiLatencyStats(1000);
    assert.equal(stats.count, 1);
    assert.equal(stats.p50, 200);
  });

  it('getSummary returns all sections', () => {
    const store = new MetricsStore();
    store.recordApiCall({ model: 'm', durationMs: 100, inputTokens: 100, outputTokens: 100, costUsd: 0.01, timestamp: Date.now() });

    const summary = store.getSummary();
    assert.ok(summary.latency);
    assert.ok(summary.costTimeline);
    assert.ok(summary.toolStats);
    assert.ok(summary.errorRate);
    assert.ok(summary.modelBreakdown);
  });
});
