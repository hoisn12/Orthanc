import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TraceManager } from '../src/trace-manager.js';

describe('TraceManager', () => {
  let tm: TraceManager;

  beforeEach(() => {
    tm = new TraceManager();
  });

  function startTrace(pid = 100, sessionId = 'sess-1', rootEventId = 'root-event-1') {
    const root = tm.assignTrace('user-prompt-submit', pid, sessionId);
    tm.setRootEventId(rootEventId, pid, sessionId);
    return root;
  }

  it('returns null trace for session-start', () => {
    const result = tm.assignTrace('session-start', 100, 'sess-1');
    assert.equal(result.traceId, null);
    assert.equal(result.parentId, null);
  });

  it('creates a new trace on user-prompt-submit', () => {
    const result = tm.assignTrace('user-prompt-submit', 100, 'sess-1');
    assert.ok(result.traceId, 'traceId should be set');
    assert.equal(result.parentId, null, 'root has no parent');
  });

  it('assigns subsequent events to the active trace', () => {
    const root = startTrace();
    const tool = tm.assignTrace('pre-tool-use', 100, 'sess-1');
    assert.equal(tool.traceId, root.traceId);
    assert.equal(tool.parentId, 'root-event-1');
  });

  it('returns null for events with no active trace', () => {
    const result = tm.assignTrace('pre-tool-use', 200, 'sess-2');
    assert.equal(result.traceId, null);
    assert.equal(result.parentId, null);
  });

  it('handles subagent nesting', () => {
    const root = startTrace();
    const sub = tm.assignTrace('subagent-start', 100, 'sess-1');
    assert.equal(sub.traceId, root.traceId);
    assert.equal(sub.parentId, 'root-event-1');

    // Simulate pushing the subagent event ID onto the stack
    tm.pushSpan('sub-event-1', 100, 'sess-1');

    // Tool inside subagent should be nested under the subagent
    const tool = tm.assignTrace('pre-tool-use', 100, 'sess-1');
    assert.equal(tool.traceId, root.traceId);
    assert.equal(tool.parentId, 'sub-event-1');

    // subagent-stop pops the stack
    const stop = tm.assignTrace('subagent-stop', 100, 'sess-1');
    assert.equal(stop.traceId, root.traceId);

    // Next event should be back at trace root level
    const after = tm.assignTrace('pre-tool-use', 100, 'sess-1');
    assert.equal(after.parentId, 'root-event-1');
  });

  it('stop event clears the trace', () => {
    const root = startTrace();
    assert.ok(root.traceId);

    const stop = tm.assignTrace('stop', 100, 'sess-1');
    assert.equal(stop.traceId, root.traceId);
    assert.equal(stop.parentId, 'root-event-1');

    // After stop, no active trace
    const after = tm.assignTrace('pre-tool-use', 100, 'sess-1');
    assert.equal(after.traceId, null);
  });

  it('session-end clears the trace', () => {
    tm.assignTrace('user-prompt-submit', 100, 'sess-1');
    tm.assignTrace('session-end', 100, 'sess-1');

    const after = tm.assignTrace('pre-tool-use', 100, 'sess-1');
    assert.equal(after.traceId, null);
  });

  it('assistant-streaming is direct child of trace root', () => {
    const root = startTrace();
    tm.pushSpan('sub-1', 100, 'sess-1');

    const msg = tm.assignTrace('assistant-streaming', 100, 'sess-1');
    assert.equal(msg.traceId, root.traceId);
    assert.equal(msg.parentId, 'root-event-1');
  });

  it('supports sessionId-only lookup (OTel events with pid=null)', () => {
    const root = startTrace();
    // OTel event with no pid but same sessionId
    const otel = tm.assignTrace('otel-api-request', null, 'sess-1');
    assert.equal(otel.traceId, root.traceId);
    assert.equal(otel.parentId, 'root-event-1');
  });

  it('isolates traces between different pids', () => {
    const root1 = startTrace(100, 'sess-1', 'root-event-1');
    const root2 = startTrace(200, 'sess-2', 'root-event-2');

    const tool1 = tm.assignTrace('pre-tool-use', 100, 'sess-1');
    const tool2 = tm.assignTrace('pre-tool-use', 200, 'sess-2');

    assert.equal(tool1.traceId, root1.traceId);
    assert.equal(tool2.traceId, root2.traceId);
    assert.equal(tool1.parentId, 'root-event-1');
    assert.equal(tool2.parentId, 'root-event-2');
    assert.notEqual(root1.traceId, root2.traceId);
  });

  it('new user-prompt-submit replaces the active trace', () => {
    const root1 = startTrace(100, 'sess-1', 'root-event-1');
    const root2 = startTrace(100, 'sess-1', 'root-event-2');

    assert.notEqual(root1.traceId, root2.traceId);

    const tool = tm.assignTrace('pre-tool-use', 100, 'sess-1');
    assert.equal(tool.traceId, root2.traceId);
    assert.equal(tool.parentId, 'root-event-2');
  });
});
