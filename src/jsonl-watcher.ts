import fs from 'node:fs';
import path from 'node:path';
import { findProjectDir } from './token-tracker.js';
import type { Provider } from './providers/provider.js';
import type { SessionWatcher } from './session-watcher.js';
import type { EventStore } from './event-store.js';
import type { TokenStore } from './token-store.js';
import type { SessionInfo } from './types.js';

interface FileState {
  byteOffset: number;
  buffer: string;
  knownMessages: Map<string, number>;
}

interface JsonlWatcherOptions {
  provider: Provider;
  sessionWatcher: SessionWatcher;
  eventStore: EventStore;
  tokenStore: TokenStore;
  projectRoot: string;
  pollInterval?: number;
}

/**
 * Watches JSONL session files for active sessions and emits
 * assistant message events in real-time (streaming).
 */
export class JsonlWatcher {
  provider: Provider;
  sessionWatcher: SessionWatcher;
  eventStore: EventStore;
  tokenStore: TokenStore;
  projectRoot: string;
  pollInterval: number;
  timer: ReturnType<typeof setInterval> | null;
  fileState: Map<string, FileState>;
  projectDir: string | null;

  constructor({
    provider,
    sessionWatcher,
    eventStore,
    tokenStore,
    projectRoot,
    pollInterval = 1000,
  }: JsonlWatcherOptions) {
    this.provider = provider;
    this.sessionWatcher = sessionWatcher;
    this.eventStore = eventStore;
    this.tokenStore = tokenStore;
    this.projectRoot = projectRoot;
    this.pollInterval = pollInterval;
    this.timer = null;
    this.fileState = new Map();
    this.projectDir = null;
  }

  start(): void {
    this.projectDir = findProjectDir(this.provider.getProjectsDir(), this.projectRoot);
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setProjectRoot(projectRoot: string): void {
    this.projectRoot = projectRoot;
    this.fileState.clear();
    this.projectDir = findProjectDir(this.provider.getProjectsDir(), this.projectRoot);
  }

  poll(): void {
    if (!this.projectDir) return;

    const activeSessions = this.sessionWatcher.getSessions();
    if (activeSessions.length === 0) return;

    const activeIds = new Set(activeSessions.map((s) => s.sessionId));

    // Clean up state for dead sessions
    for (const sid of this.fileState.keys()) {
      if (!activeIds.has(sid)) this.fileState.delete(sid);
    }

    const projectsDir = this.provider.getProjectsDir();
    for (const session of activeSessions) {
      if (!session.sessionId) continue;
      // Try session's own cwd first (handles worktree sessions),
      // then fall back to the main project dir
      const sessionDir = session.cwd ? findProjectDir(projectsDir, session.cwd) : null;
      const dir = sessionDir || this.projectDir;
      const effectiveId = session.activeSessionId || session.sessionId;
      const filePath = path.join(dir, `${effectiveId}.jsonl`);
      this.pollFile(filePath, session);
    }
  }

  private pollFile(filePath: string, session: SessionInfo): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    const sid = session.sessionId;
    let state = this.fileState.get(sid);
    if (!state) {
      state = { byteOffset: stat.size, buffer: '', knownMessages: new Map() };
      this.fileState.set(sid, state);
      return; // Skip existing content on first poll
    }

    // Handle file truncation (recreated or rotated)
    if (stat.size < state.byteOffset) {
      state.byteOffset = 0;
      state.buffer = '';
    }

    if (stat.size <= state.byteOffset) return; // No new data

    // Read only new bytes (with try/finally to prevent fd leak)
    let fd: number | undefined;
    let raw: string;
    try {
      fd = fs.openSync(filePath, 'r');
      const newSize = stat.size - state.byteOffset;
      const buf = Buffer.alloc(newSize);
      fs.readSync(fd, buf, 0, newSize, state.byteOffset);
      raw = state.buffer + buf.toString('utf-8');
    } catch {
      return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    state.byteOffset = stat.size;

    const lines = raw.split('\n');
    // Last element might be incomplete line — keep in buffer
    state.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      this.processLine(line, session, state);
    }
  }

  private processLine(line: string, session: SessionInfo, state: FileState): void {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    // Extract token usage into DB (all record types may have usage)
    if (this.tokenStore) {
      try {
        const usage = this.provider.parseUsageRecord(record);
        if (usage) {
          this.tokenStore.upsert({
            id: usage.messageId || `${session.sessionId}-${usage.timestamp || new Date().toISOString()}-${usage.model}`,
            sessionId: session.sessionId,
            sessionFile: `${session.sessionId}.jsonl`,
            timestamp: usage.timestamp || new Date().toISOString(),
            model: usage.model,
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheCreate: usage.cacheCreate,
            cwd: session.cwd || '',
            startedAt: '',
            lastActivity: '',
          });
        }
      } catch {
        /* ignore upsert errors */
      }
    }

    // Only care about assistant messages with content
    if (record.type !== 'assistant') return;
    const msg = record.message;
    if (!msg || !msg.content) return;

    const msgId = msg.id;
    if (!msgId) return;

    // Extract text content
    const textParts: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      }
    }
    if (textParts.length === 0) return;

    const text = textParts.join('\n');
    const isComplete = msg.stop_reason != null;

    // Deduplicate: skip if same message at same or shorter content length
    const prevLength = state.knownMessages.get(msgId) || 0;
    if (text.length <= prevLength) return;
    state.knownMessages.set(msgId, text.length);

    // Prune old message IDs (keep most recent 200)
    if (state.knownMessages.size > 500) {
      const keys = Array.from(state.knownMessages.keys());
      for (let i = 0; i < keys.length - 200; i++) {
        state.knownMessages.delete(keys[i]!);
      }
    }

    this.eventStore.add({
      type: 'assistant-streaming',
      payload: {
        message_id: msgId,
        text,
        model: msg.model || record.model || '',
      },
      sessionId: session.sessionId,
      pid: session.pid,
    });
  }
}
