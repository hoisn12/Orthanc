/**
 * OTLP HTTP/JSON receiver.
 * Parses OpenTelemetry log, metric, and trace payloads from Claude Code
 * and feeds them into EventStore (for SSE) and MetricsStore (for aggregation).
 */

const EVENT_MAP = {
  'claude_code.api_request': 'otel-api-request',
  'claude_code.api_error': 'otel-api-error',
  'claude_code.tool_result': 'otel-tool-result',
  'claude_code.tool_decision': 'otel-tool-decision',
  'claude_code.user_prompt': 'otel-user-prompt',
};

export class OtelReceiver {
  constructor(eventStore, metricsStore) {
    this.eventStore = eventStore;
    this.metricsStore = metricsStore;
  }

  ingestLogs(body) {
    const resourceLogs = body?.resourceLogs;
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

  ingestMetrics(body) {
    const resourceMetrics = body?.resourceMetrics;
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

  ingestTraces(body) {
    const resourceSpans = body?.resourceSpans;
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

  _processLogRecord(record, resourceAttrs) {
    const attrs = flattenAttributes(record.attributes);
    const eventName = attrs['event.name'] || attrs['name'] || '';
    const internalType = EVENT_MAP[eventName];
    if (!internalType) return;

    const timestamp = nanoToMs(record.timeUnixNano);
    const sessionId = attrs['session.id'] || resourceAttrs['session.id'] || null;

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
        model: attrs['model'] || attrs['gen_ai.request.model'] || 'unknown',
        durationMs: parseFloat(attrs['duration_ms'] || attrs['duration'] || 0),
        inputTokens: parseInt(attrs['input_tokens'] || attrs['gen_ai.usage.input_tokens'] || 0),
        outputTokens: parseInt(attrs['output_tokens'] || attrs['gen_ai.usage.output_tokens'] || 0),
        cacheReadTokens: parseInt(attrs['cache_read_input_tokens'] || 0),
        cacheCreateTokens: parseInt(attrs['cache_creation_input_tokens'] || 0),
        costUsd: parseFloat(attrs['cost_usd'] || attrs['cost'] || 0),
        timestamp,
      });
    } else if (internalType === 'otel-api-error') {
      this.metricsStore.recordApiError({
        model: attrs['model'] || attrs['gen_ai.request.model'] || 'unknown',
        errorType: attrs['error_type'] || attrs['error.type'] || 'unknown',
        statusCode: parseInt(attrs['status_code'] || attrs['http.status_code'] || 0),
        timestamp,
      });
    } else if (internalType === 'otel-tool-result') {
      this.metricsStore.recordToolExecution({
        toolName: attrs['tool_name'] || attrs['tool.name'] || 'unknown',
        durationMs: parseFloat(attrs['duration_ms'] || attrs['duration'] || 0),
        success: attrs['success'] !== 'false' && attrs['success'] !== false,
        timestamp,
      });
    }
  }

  _processMetric(metric) {
    // Extract data points from gauge, sum, or histogram
    const dataPoints =
      metric.gauge?.dataPoints ||
      metric.sum?.dataPoints ||
      metric.histogram?.dataPoints;
    if (!Array.isArray(dataPoints)) return;

    for (const dp of dataPoints) {
      const attrs = flattenAttributes(dp.attributes);
      const value = dp.asDouble ?? dp.asInt ?? dp.value ?? 0;
      const timestamp = nanoToMs(dp.timeUnixNano);

      // Map known metric names to store calls
      if (metric.name?.includes('token') || metric.name?.includes('cost')) {
        // Token/cost metrics are handled via logs; metrics endpoint is supplementary
      }
    }
  }

  _processSpan(span, resourceAttrs) {
    const attrs = flattenAttributes(span.attributes);
    const startMs = nanoToMs(span.startTimeUnixNano);
    const endMs = nanoToMs(span.endTimeUnixNano);
    const durationMs = endMs - startMs;
    const sessionId = attrs['session.id'] || resourceAttrs['session.id'] || null;

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
        toolName: attrs['tool.name'] || span.name,
        durationMs,
        success: span.status?.code !== 2,
        timestamp: startMs,
      });
    }
  }
}

/**
 * Convert OTLP attribute array to flat key-value object.
 * OTLP format: [{key: "foo", value: {stringValue: "bar"}}]
 * Output: {foo: "bar"}
 */
export function flattenAttributes(attrs) {
  if (!Array.isArray(attrs)) return {};
  const result = {};
  for (const attr of attrs) {
    if (!attr.key || !attr.value) continue;
    result[attr.key] = extractValue(attr.value);
  }
  return result;
}

function extractValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return parseInt(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue?.values) return v.arrayValue.values.map(extractValue);
  if (v.kvlistValue?.values) return flattenAttributes(v.kvlistValue.values);
  return null;
}

function nanoToMs(nanoStr) {
  if (!nanoStr) return Date.now();
  const nano = typeof nanoStr === 'string' ? BigInt(nanoStr) : BigInt(nanoStr);
  return Number(nano / 1000000n);
}
