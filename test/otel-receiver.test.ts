import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OtelReceiver, flattenAttributes } from '../src/otel-receiver.js';
import { EventStore } from '../src/event-store.js';
import { MetricsStore } from '../src/metrics-store.js';
import { createTestDb } from './test-db.js';

describe('flattenAttributes', () => {
  it('handles stringValue', () => {
    const attrs = [{ key: 'model', value: { stringValue: 'claude-sonnet-4-5' } }];
    assert.deepEqual(flattenAttributes(attrs), { model: 'claude-sonnet-4-5' });
  });

  it('handles intValue (string format)', () => {
    const attrs = [{ key: 'tokens', value: { intValue: '1234' } }];
    assert.deepEqual(flattenAttributes(attrs), { tokens: 1234 });
  });

  it('handles doubleValue', () => {
    const attrs = [{ key: 'cost', value: { doubleValue: 0.0015 } }];
    assert.deepEqual(flattenAttributes(attrs), { cost: 0.0015 });
  });

  it('handles boolValue', () => {
    const attrs = [{ key: 'success', value: { boolValue: true } }];
    assert.deepEqual(flattenAttributes(attrs), { success: true });
  });

  it('handles arrayValue', () => {
    const attrs = [
      {
        key: 'tags',
        value: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
      },
    ];
    assert.deepEqual(flattenAttributes(attrs), { tags: ['a', 'b'] });
  });

  it('returns empty object for non-array input', () => {
    assert.deepEqual(flattenAttributes(null), {});
    assert.deepEqual(flattenAttributes(undefined), {});
  });

  it('skips entries without key or value', () => {
    const attrs = [{ key: 'a', value: { stringValue: '1' } }, { key: 'b' }, { value: { stringValue: '2' } }];
    assert.deepEqual(flattenAttributes(attrs), { a: '1' });
  });
});

describe('OtelReceiver.ingestLogs', () => {
  it('processes api_request log into EventStore and MetricsStore', () => {
    const eventStore = new EventStore(100, { db: createTestDb() });
    const metricsStore = new MetricsStore();
    const receiver = new OtelReceiver(eventStore, metricsStore);

    const body = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'session.id', value: { stringValue: 'sess-123' } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(Date.now() * 1000000),
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
                    { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
                    { key: 'input_tokens', value: { intValue: '500' } },
                    { key: 'output_tokens', value: { intValue: '200' } },
                    { key: 'duration_ms', value: { doubleValue: 1500.5 } },
                    { key: 'cost_usd', value: { doubleValue: 0.003 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    receiver.ingestLogs(body);

    const events = eventStore.getRecent(10);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'otel-api-request');
    assert.equal(events[0]!.sessionId, 'sess-123');
    assert.equal(events[0]!.payload.model, 'claude-sonnet-4-5');

    const latency = metricsStore.getApiLatencyStats();
    assert.equal(latency.count, 1);
    assert.ok(latency.p50 > 0);
  });

  it('processes api_error log', () => {
    const eventStore = new EventStore(100, { db: createTestDb() });
    const metricsStore = new MetricsStore();
    const receiver = new OtelReceiver(eventStore, metricsStore);

    const body = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(Date.now() * 1000000),
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'claude_code.api_error' } },
                    { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
                    { key: 'error_type', value: { stringValue: 'rate_limit' } },
                    { key: 'status_code', value: { intValue: '429' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    receiver.ingestLogs(body);

    const events = eventStore.getRecent(10);
    assert.equal(events[0]!.type, 'otel-api-error');

    const errors = metricsStore.getErrorRate();
    assert.equal(errors.total, 1);
    assert.equal(errors.byType['rate_limit'], 1);
  });

  it('processes tool_result log', () => {
    const eventStore = new EventStore(100, { db: createTestDb() });
    const metricsStore = new MetricsStore();
    const receiver = new OtelReceiver(eventStore, metricsStore);

    const body = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(Date.now() * 1000000),
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'claude_code.tool_result' } },
                    { key: 'tool_name', value: { stringValue: 'Bash' } },
                    { key: 'duration_ms', value: { doubleValue: 250 } },
                    { key: 'success', value: { boolValue: true } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    receiver.ingestLogs(body);

    const tools = metricsStore.getToolStats();
    assert.ok(tools['Bash']);
    assert.equal(tools['Bash']!.count, 1);
  });

  it('ignores unknown event names', () => {
    const eventStore = new EventStore(100, { db: createTestDb() });
    const metricsStore = new MetricsStore();
    const receiver = new OtelReceiver(eventStore, metricsStore);

    const body = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(Date.now() * 1000000),
                  attributes: [{ key: 'event.name', value: { stringValue: 'some.other.event' } }],
                },
              ],
            },
          ],
        },
      ],
    };

    receiver.ingestLogs(body);
    assert.equal(eventStore.getRecent(10).length, 0);
  });

  it('handles empty/invalid body gracefully', () => {
    const eventStore = new EventStore(100, { db: createTestDb() });
    const metricsStore = new MetricsStore();
    const receiver = new OtelReceiver(eventStore, metricsStore);

    receiver.ingestLogs({});
    receiver.ingestLogs(null);
    receiver.ingestLogs({ resourceLogs: 'not-array' });
    assert.equal(eventStore.getRecent(10).length, 0);
  });
});

describe('OtelReceiver.ingestTraces', () => {
  it('processes spans into EventStore and MetricsStore', () => {
    const eventStore = new EventStore(100, { db: createTestDb() });
    const metricsStore = new MetricsStore();
    const receiver = new OtelReceiver(eventStore, metricsStore);

    const now = BigInt(Date.now()) * 1000000n;
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  name: 'tool.Bash',
                  spanId: 'abc123',
                  parentSpanId: 'parent1',
                  startTimeUnixNano: String(now),
                  endTimeUnixNano: String(now + 500000000n), // 500ms
                  status: { code: 1 },
                  attributes: [{ key: 'tool.name', value: { stringValue: 'Bash' } }],
                },
              ],
            },
          ],
        },
      ],
    };

    receiver.ingestTraces(body);

    const events = eventStore.getRecent(10);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'otel-span');
    assert.equal(events[0]!.payload.durationMs, 500);
    assert.equal(events[0]!.payload.parentSpanId, 'parent1');

    const tools = metricsStore.getToolStats();
    assert.ok(tools['Bash']);
  });
});
