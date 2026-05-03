import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceTree } from '../src/server.js';
import type { EventEntry } from '../src/types.js';

function event(id: string, type: string, traceId: string, parentId: string | null): EventEntry {
  return {
    id,
    timestamp: new Date(0).toISOString(),
    type,
    sessionId: 'sess-1',
    pid: 100,
    payload: {},
    traceId,
    parentId,
  };
}

describe('buildTraceTree', () => {
  it('attaches root-level trace children whose parentId is the traceId', () => {
    const traceId = 'trace-1';
    const tree = buildTraceTree([
      event('root-event', 'user-prompt-submit', traceId, null),
      event('tool-event', 'pre-tool-use', traceId, traceId),
      event('stop-event', 'stop', traceId, null),
    ]);

    assert.ok(tree);
    assert.equal(tree.id, 'root-event');
    assert.deepEqual(
      tree.children.map((child) => child.id),
      ['tool-event', 'stop-event'],
    );
  });

  it('preserves nested children when the parent event exists', () => {
    const traceId = 'trace-1';
    const tree = buildTraceTree([
      event('root-event', 'user-prompt-submit', traceId, null),
      event('subagent-event', 'subagent-start', traceId, traceId),
      event('nested-tool-event', 'pre-tool-use', traceId, 'subagent-event'),
    ]);

    assert.ok(tree);
    assert.equal(tree.children[0]?.id, 'subagent-event');
    assert.equal(tree.children[0]?.children[0]?.id, 'nested-tool-event');
  });
});
