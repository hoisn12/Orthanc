import fs from 'node:fs';
import path from 'node:path';
import { findProjectDir } from './token-tracker.js';
import type { Provider } from './providers/provider.js';
import type { SessionWatcher } from './session-watcher.js';
import type { EventStore } from './event-store.js';
import type { TokenStore } from './token-store.js';
import type { SessionInfo } from './types.js';
import type { TraceManager } from './trace-manager.js';

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
  traceManager?: TraceManager;
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
  traceManager: TraceManager | null;
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
    traceManager,
    projectRoot,
    pollInterval = 1000,
  }: JsonlWatcherOptions) {
    this.provider = provider;
    this.sessionWatcher = sessionWatcher;
    this.eventStore = eventStore;
    this.tokenStore = tokenStore;
    this.traceManager = traceManager || null;
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
    if (!this.projectDir && this.provider.name !== 'codex') return;

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
      if (!session.sessionFilePath && !dir) continue;
      const filePath = session.sessionFilePath || path.join(dir!, `${effectiveId}.jsonl`);
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

    if (this.provider.name === 'codex' && this.processCodexLine(record, session)) return;

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

    this.addTracedEvent(
      'assistant-streaming',
      {
        message_id: msgId,
        text,
        model: msg.model || record.model || '',
      },
      session,
    );
  }

  private processCodexLine(record: any, session: SessionInfo): boolean {
    const payload = record.payload || {};

    if (record.type === 'event_msg' && payload.type === 'user_message') {
      this.addTracedEvent(
        'user-prompt-submit',
        {
          prompt: payload.message || '',
          session_id: session.sessionId,
          source: 'codex-jsonl',
        },
        session,
      );
      return true;
    }

    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const text = extractCodexText(payload.content);
      if (!text) return true;
      this.addTracedEvent(
        'assistant-streaming',
        {
          message_id: payload.id || `${session.sessionId}-${record.timestamp || Date.now()}`,
          text,
          phase: payload.phase || '',
          source: 'codex-jsonl',
        },
        session,
      );
      return true;
    }

    if (record.type === 'response_item' && payload.type === 'function_call') {
      this.addTracedEvent(
        'pre-tool-use',
        {
          tool_name: payload.name || 'unknown',
          tool_input: parseJsonMaybe(payload.arguments),
          call_id: payload.call_id,
          source: 'codex-jsonl',
        },
        session,
      );
      return true;
    }

    if (record.type === 'event_msg' && payload.type === 'exec_command_end') {
      this.addTracedEvent(
        'post-tool-use',
        {
          tool_name: 'exec_command',
          call_id: payload.call_id,
          command: payload.command,
          cwd: payload.cwd,
          exit_code: payload.exit_code,
          duration: payload.duration,
          stdout: payload.stdout,
          stderr: payload.stderr,
          source: 'codex-jsonl',
        },
        session,
      );
      return true;
    }

    return false;
  }

  private addTracedEvent(type: string, payload: Record<string, unknown>, session: SessionInfo): void {
    const trace = this.traceManager
      ? this.traceManager.assignTrace(type, session.pid, session.sessionId)
      : { traceId: null, parentId: null };

    const event = this.eventStore.add({
      type,
      payload,
      sessionId: session.sessionId,
      pid: session.pid,
      traceId: trace.traceId,
      parentId: trace.parentId,
    });

    if (type === 'user-prompt-submit') {
      this.traceManager?.setRootEventId(event.id, session.pid, session.sessionId);
    } else if (type === 'subagent-start') {
      this.traceManager?.pushSpan(event.id, session.pid, session.sessionId);
    }
  }
}

function extractCodexText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if ((b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
  }
  return parts.join('\n');
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
