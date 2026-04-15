/**
 * OTLP HTTP/JSON receiver.
 * Parses OpenTelemetry log, metric, and trace payloads from Claude Code
 * and feeds them into EventStore (for SSE) and MetricsStore (for aggregation).
 */

import type { EventStore } from './event-store.js';
import type { MetricsStore } from './metrics-store.js';

const EVENT_MAP: Record<string, string> = {
  'claude_code.api_request': 'otel-api-request',
  'claude_code.api_error': 'otel-api-error',
  'claude_code.tool_result': 'otel-tool-result',
  'claude_code.tool_decision': 'otel-tool-decision',
  'claude_code.user_prompt': 'otel-user-prompt',
};

type OtelBody = Record<string, unknown>;
type FlatAttrs = Record<string, unknown>;

export class OtelReceiver {
  eventStore: EventStore;
  metricsStore: MetricsStore;

  constructor(eventStore: EventStore, metricsStore: MetricsStore) {
    this.eventStore = eventStore;
    this.metricsStore = metricsStore;
  }

  ingestLogs(body: OtelBody | null | undefined): void {
    const resourceLogs = (body as any)?.resourceLogs;
    if (!Array.isArray(resourceLogs)) return;

    for (const rl of resourceLogs) {
      const resourceAttrs = flattenAttributes(rl.resource?.attributes);
      const scopeLogs = rl.scopeLogs;
      if (!Array.isArray(scopeLogs)) continue;

      for (const sl of scopeLogs) {
        const logRecords = sl.logRecords;
        if (!Array.isArray(logRecords)) continue;

        for (const record of logRecords) {
          this._processLogRecord(record, resourceAttrs);
        }
      }
    }
  }

  ingestMetrics(body: OtelBody | null | undefined): void {
    const resourceMetrics = (body as any)?.resourceMetrics;
    if (!Array.isArray(resourceMetrics)) return;

    for (const rm of resourceMetrics) {
      const scopeMetrics = rm.scopeMetrics;
      if (!Array.isArray(scopeMetrics)) continue;

      for (const sm of scopeMetrics) {
        const metrics = sm.metrics;
        if (!Array.isArray(metrics)) continue;

        for (const metric of metrics) {
          this._processMetric(metric);
        }
      }
    }
  }

  ingestTraces(body: OtelBody | null | undefined): void {
    const resourceSpans = (body as any)?.resourceSpans;
    if (!Array.isArray(resourceSpans)) return;

    for (const rs of resourceSpans) {
      const resourceAttrs = flattenAttributes(rs.resource?.attributes);
      const scopeSpans = rs.scopeSpans;
      if (!Array.isArray(scopeSpans)) continue;

      for (const ss of scopeSpans) {
        const spans = ss.spans;
        if (!Array.isArray(spans)) continue;

        for (const span of spans) {
          this._processSpan(span, resourceAttrs);
        }
      }
    }
  }

  private _processLogRecord(record: any, resourceAttrs: FlatAttrs): void {
    const attrs = flattenAttributes(record.attributes);
    const eventName = (attrs['event.name'] || attrs['name'] || '') as string;
    const internalType = EVENT_MAP[eventName];
    if (!internalType) return;

    const timestamp = nanoToMs(record.timeUnixNano);
    const sessionId = (attrs['session.id'] || resourceAttrs['session.id'] || null) as string | null;

    // Push to EventStore for SSE streaming
    this.eventStore.add({
      type: internalType,
      payload: attrs,
      sessionId,
      pid: null,
      source: 'otel',
    });

    // Push to MetricsStore for aggregation
    if (internalType === 'otel-api-request') {
      this.metricsStore.recordApiCall({
        model: (attrs['model'] || attrs['gen_ai.request.model'] || 'unknown') as string,
        durationMs: parseFloat(String(attrs['duration_ms'] || attrs['duration'] || 0)),
        inputTokens: parseInt(String(attrs['input_tokens'] || attrs['gen_ai.usage.input_tokens'] || 0)),
        outputTokens: parseInt(String(attrs['output_tokens'] || attrs['gen_ai.usage.output_tokens'] || 0)),
        cacheReadTokens: parseInt(String(attrs['cache_read_input_tokens'] || 0)),
        cacheCreateTokens: parseInt(String(attrs['cache_creation_input_tokens'] || 0)),
        costUsd: parseFloat(String(attrs['cost_usd'] || attrs['cost'] || 0)),
        timestamp,
      });
    } else if (internalType === 'otel-api-error') {
      this.metricsStore.recordApiError({
        model: (attrs['model'] || attrs['gen_ai.request.model'] || 'unknown') as string,
        errorType: (attrs['error_type'] || attrs['error.type'] || 'unknown') as string,
        statusCode: parseInt(String(attrs['status_code'] || attrs['http.status_code'] || 0)),
        timestamp,
      });
    } else if (internalType === 'otel-tool-result') {
      this.metricsStore.recordToolExecution({
        toolName: (attrs['tool_name'] || attrs['tool.name'] || 'unknown') as string,
        durationMs: parseFloat(String(attrs['duration_ms'] || attrs['duration'] || 0)),
        success: attrs['success'] !== 'false' && attrs['success'] !== false,
        timestamp,
      });
    }
  }

  private _processMetric(metric: any): void {
    // Extract data points from gauge, sum, or histogram
    const dataPoints = metric.gauge?.dataPoints || metric.sum?.dataPoints || metric.histogram?.dataPoints;
    if (!Array.isArray(dataPoints)) return;

    for (const _dp of dataPoints) {
      // Token/cost metrics are handled via logs; metrics endpoint is supplementary
    }
  }

  private _processSpan(span: any, resourceAttrs: FlatAttrs): void {
    const attrs = flattenAttributes(span.attributes);
    const startMs = nanoToMs(span.startTimeUnixNano);
    const endMs = nanoToMs(span.endTimeUnixNano);
    const durationMs = endMs - startMs;
    const sessionId = (attrs['session.id'] || resourceAttrs['session.id'] || null) as string | null;

    this.eventStore.add({
      type: 'otel-span',
      payload: {
        name: span.name,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId || null,
        durationMs,
        status: span.status?.code === 2 ? 'error' : 'ok',
        ...attrs,
      },
      sessionId,
      pid: null,
      source: 'otel',
    });

    // If this looks like a tool execution span, record it
    if (span.name?.startsWith('tool.') || attrs['tool.name']) {
      this.metricsStore.recordToolExecution({
        toolName: (attrs['tool.name'] || span.name) as string,
        durationMs,
        success: span.status?.code !== 2,
        timestamp: startMs,
      });
    }
  }
}

/**
 * Convert OTLP attribute array to flat key-value object.
 */
export function flattenAttributes(attrs: unknown): FlatAttrs {
  if (!Array.isArray(attrs)) return {};
  const result: FlatAttrs = {};
  for (const attr of attrs) {
    if (!attr.key || !attr.value) continue;
    result[attr.key as string] = extractValue(attr.value);
  }
  return result;
}

function extractValue(v: any): unknown {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return parseInt(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue?.values) return v.arrayValue.values.map(extractValue);
  if (v.kvlistValue?.values) return flattenAttributes(v.kvlistValue.values);
  return null;
}

function nanoToMs(nanoStr: unknown): number {
  if (!nanoStr) return Date.now();
  const nano = typeof nanoStr === 'string' ? BigInt(nanoStr) : BigInt(nanoStr as number);
  return Number(nano / 1000000n);
}
