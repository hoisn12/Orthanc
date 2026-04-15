import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/event-store.js';
import { createTestDb } from './test-db.js';

describe('EventStore', () => {
  it('adds events and returns them', () => {
    const store = new EventStore(10, { db: createTestDb() });
    store.add({ type: 'test', payload: { foo: 1 } });
    store.add({ type: 'test2', payload: { bar: 2 } });

    const events = store.getRecent(10);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, 'test');
    assert.equal(events[1]!.type, 'test2');
    assert.ok(events[0]!.id);
    assert.ok(events[0]!.timestamp);
  });

  it('enforces maxSize', () => {
    const store = new EventStore(3, { db: createTestDb() });
    for (let i = 0; i < 5; i++) {
      store.add({ type: `event-${i}` });
    }
    const events = store.getRecent(10);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.type, 'event-2');
  });

  it('notifies subscribers', () => {
    const store = new EventStore(100, { db: createTestDb() });
    const received: unknown[] = [];
    store.subscribe((e) => received.push(e));
    store.add({ type: 'ping' });

    assert.equal(received.length, 1);
    assert.equal((received[0] as any).type, 'ping');
  });

  it('unsubscribe stops notifications', () => {
    const store = new EventStore(100, { db: createTestDb() });
    const received: unknown[] = [];
    const unsub = store.subscribe((e) => received.push(e));
    store.add({ type: 'a' });
    unsub();
    store.add({ type: 'b' });

    assert.equal(received.length, 1);
  });

  it('getRecent respects limit', () => {
    const store = new EventStore(100, { db: createTestDb() });
    for (let i = 0; i < 10; i++) store.add({ type: `e-${i}` });
    const events = store.getRecent(3);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.type, 'e-7');
  });
});
