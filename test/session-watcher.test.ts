import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionWatcher } from '../src/session-watcher.js';
import { ClaudeProvider } from '../src/providers/claude-provider.js';
import type { SessionInfo } from '../src/types.js';

/**
 * SessionWatcher depends on live processes and filesystem,
 * so we test the lookup/mapping methods by injecting sessions
 * directly into the internal Map.
 */
function createWatcherWithSessions(sessions: SessionInfo[]): SessionWatcher {
  const watcher = new SessionWatcher(new ClaudeProvider(), null);
  for (const s of sessions) {
    watcher.sessions.set(s.pid, s);
  }
  return watcher;
}

const sessionA: SessionInfo = {
  pid: 1001,
  sessionId: 'file-session-aaa',
  cwd: '/projects/alpha',
  startedAt: 1000,
  name: 'session-1001',
  alive: true,
  uptime: 5000,
};

const sessionB: SessionInfo = {
  pid: 1002,
  sessionId: 'file-session-bbb',
  cwd: '/projects/beta',
  startedAt: 2000,
  name: 'session-1002',
  alive: true,
  uptime: 3000,
};

describe('SessionWatcher activeSessionId', () => {
  it('getBySessionId matches by sessionId', () => {
    const watcher = createWatcherWithSessions([sessionA, sessionB]);
    const found = watcher.getBySessionId('file-session-aaa');
    assert.ok(found);
    assert.equal(found.pid, 1001);
  });

  it('getBySessionId matches by activeSessionId', () => {
    const watcher = createWatcherWithSessions([sessionA, sessionB]);
    watcher.setActiveSessionId(1001, 'hook-session-xxx');
    const found = watcher.getBySessionId('hook-session-xxx');
    assert.ok(found);
    assert.equal(found.pid, 1001);
    assert.equal(found.activeSessionId, 'hook-session-xxx');
  });

  it('getBySessionId returns null for unknown id', () => {
    const watcher = createWatcherWithSessions([sessionA]);
    assert.equal(watcher.getBySessionId('nonexistent'), null);
  });

  it('setActiveSessionId ignores unknown pid', () => {
    const watcher = createWatcherWithSessions([sessionA]);
    watcher.setActiveSessionId(9999, 'whatever');
    assert.equal(watcher.getBySessionId('whatever'), null);
  });

  it('setActiveSessionId updates existing session', () => {
    const fresh: SessionInfo = { ...sessionA, activeSessionId: undefined };
    const watcher = createWatcherWithSessions([fresh]);
    assert.equal(watcher.sessions.get(1001)!.activeSessionId, undefined);
    watcher.setActiveSessionId(1001, 'active-id-1');
    assert.equal(watcher.sessions.get(1001)!.activeSessionId, 'active-id-1');

    // Update again
    watcher.setActiveSessionId(1001, 'active-id-2');
    assert.equal(watcher.sessions.get(1001)!.activeSessionId, 'active-id-2');
  });
});

describe('SessionWatcher getByCwd', () => {
  it('finds session by cwd', () => {
    const watcher = createWatcherWithSessions([sessionA, sessionB]);
    const found = watcher.getByCwd('/projects/beta');
    assert.ok(found);
    assert.equal(found.pid, 1002);
  });

  it('returns null for unknown cwd', () => {
    const watcher = createWatcherWithSessions([sessionA]);
    assert.equal(watcher.getByCwd('/projects/unknown'), null);
  });

  it('skips dead sessions', () => {
    const deadSession: SessionInfo = { ...sessionA, alive: false };
    const watcher = createWatcherWithSessions([deadSession]);
    assert.equal(watcher.getByCwd('/projects/alpha'), null);
  });
});
