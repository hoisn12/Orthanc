import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider } from '../src/providers/codex-provider.js';
import { JsonlWatcher } from '../src/jsonl-watcher.js';
import { EventStore } from '../src/event-store.js';
import { TraceManager } from '../src/trace-manager.js';
import { MetricsStore } from '../src/metrics-store.js';
import { OtelReceiver } from '../src/otel-receiver.js';
import { createTestDb } from './test-db.js';
import type { SessionInfo } from '../src/types.js';
import type { SessionWatcher } from '../src/session-watcher.js';
import type { TokenStore } from '../src/token-store.js';

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe('CodexProvider sessions', () => {
  it('discovers recursive rollout jsonl files and parses session_meta without pid', () => {
    const codexHome = makeTempCodexHome();
    const sessionPath = path.join(codexHome, 'sessions', '2026', '05', '04', 'rollout-2026-05-04T02-10-50-abc.jsonl');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({
        timestamp: '2026-05-04T02:10:50.000Z',
        type: 'session_meta',
        payload: {
          id: 'sess-codex-1',
          timestamp: '2026-05-04T02:10:50.000Z',
          cwd: '/tmp/project',
          originator: 'codex-tui',
        },
      }) + '\n',
    );

    const provider = new CodexProvider();
    const files = provider.listSessionFiles();
    assert.deepEqual(files, [path.join('2026', '05', '04', 'rollout-2026-05-04T02-10-50-abc.jsonl')]);

    const session = provider.parseSessionFile(sessionPath);
    assert.ok(session);
    assert.equal(session.sessionId, 'sess-codex-1');
    assert.equal(session.cwd, '/tmp/project');
    assert.equal(session.hasRealPid, false);
    assert.equal(session.sessionFilePath, sessionPath);
    assert.ok(session.pid < 0);
  });
});

describe('CodexProvider monitor install', () => {
  it('installs command hooks under global hooks.json and removes only monitor hooks', () => {
    const codexHome = makeTempCodexHome();
    const hooksPath = path.join(codexHome, 'hooks.json');
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { PreToolUse: [{ command: 'echo user hook', timeout: 1 }] } }, null, 2) + '\n',
    );

    const provider = new CodexProvider();
    const installed = provider.installHooks('/tmp/project', 7999, { hooks: true, otel: false });
    assert.equal(installed.path, hooksPath);
    assert.equal(installed.installed, 5);

    const hooksFile = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as any;
    assert.equal(hooksFile.hooks.PreToolUse.length, 2);
    assert.ok(hooksFile.hooks.PreToolUse.some((h: any) => String(h.command).includes('__claude_monitor__')));
    assert.ok(hooksFile.hooks.UserPromptSubmit[0].command.includes('codex-hook.js'));

    const status = provider.getMonitorStatus('/tmp/project');
    assert.equal(status.hooks, true);

    const removed = provider.uninstallHooks('/tmp/project', { hooks: true, otel: false });
    assert.equal(removed.removed, 5);
    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as any;
    assert.deepEqual(after.hooks.PreToolUse, [{ command: 'echo user hook', timeout: 1 }]);
    assert.equal(after.hooks.UserPromptSubmit, undefined);
  });

  it('removes monitor hooks from legacy top-level hooks.json', () => {
    const codexHome = makeTempCodexHome();
    const hooksPath = path.join(codexHome, 'hooks.json');
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          PreToolUse: [
            { command: 'echo user hook', timeout: 1 },
            { command: 'node /tmp/codex-hook.js --marker __claude_monitor__', timeout: 5 },
          ],
        },
        null,
        2,
      ) + '\n',
    );

    const provider = new CodexProvider();
    const removed = provider.uninstallHooks('/tmp/project', { hooks: true, otel: false });
    assert.equal(removed.removed, 1);

    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as any;
    assert.deepEqual(after.PreToolUse, [{ command: 'echo user hook', timeout: 1 }]);
  });

  it('does not treat user hooks with similar command names or urls as monitor hooks', () => {
    const codexHome = makeTempCodexHome();
    const hooksPath = path.join(codexHome, 'hooks.json');
    const similarCommand = 'node /tmp/codex-hook.js --event PreToolUse';
    const similarUrl = 'http://localhost:7999/api/events/pre-tool-use';
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { command: similarCommand, timeout: 1 },
              { url: similarUrl, type: 'http', timeout: 1 },
              { command: 'node /tmp/codex-hook.js --marker __claude_monitor__', timeout: 5 },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    );

    const provider = new CodexProvider();
    assert.equal(provider.getMonitorStatus('/tmp/project').hooks, true);

    const removed = provider.uninstallHooks('/tmp/project', { hooks: true, otel: false });
    assert.equal(removed.removed, 1);

    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as any;
    assert.deepEqual(after.hooks.PreToolUse, [
      { command: similarCommand, timeout: 1 },
      { url: similarUrl, type: 'http', timeout: 1 },
    ]);
    assert.equal(provider.getMonitorStatus('/tmp/project').hooks, false);
  });

  it('installs marked otel config and refuses to overwrite user otel config', () => {
    const codexHome = makeTempCodexHome();
    const provider = new CodexProvider();

    const installed = provider.installHooks('/tmp/project', 7999, { hooks: false, otel: true });
    assert.equal(installed.otel, true);
    const configPath = path.join(codexHome, 'config.toml');
    const content = fs.readFileSync(configPath, 'utf-8');
    assert.match(content, /__claude_monitor__ OTel config/);
    assert.match(content, /log_user_prompt = true/);
    assert.match(content, /http:\/\/localhost:7999\/v1\/logs/);
    assert.match(content, /trace_exporter/);

    provider.uninstallHooks('/tmp/project', { hooks: false, otel: true });
    assert.equal(fs.readFileSync(configPath, 'utf-8').includes('__claude_monitor__ OTel'), false);

    fs.writeFileSync(configPath, '[otel]\nlog_user_prompt = false\n');
    const conflict = provider.installHooks('/tmp/project', 7999, { hooks: false, otel: true });
    assert.equal(conflict.otel, false);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), '[otel]\nlog_user_prompt = false\n');
  });
});

describe('Codex JSONL tracing', () => {
  it('creates a trace root from user_message and attaches assistant/tool events', () => {
    const provider = new CodexProvider();
    const eventStore = new EventStore(100, { db: createTestDb() });
    const traceManager = new TraceManager();
    const watcher = new JsonlWatcher({
      provider,
      sessionWatcher: {} as SessionWatcher,
      eventStore,
      tokenStore: { upsert() {} } as unknown as TokenStore,
      traceManager,
      projectRoot: '/tmp/project',
    });
    const session: SessionInfo = {
      pid: -123,
      sessionId: 'sess-codex-1',
      cwd: '/tmp/project',
      startedAt: Date.now(),
      name: 'codex',
      alive: true,
      uptime: 0,
      hasRealPid: false,
    };
    const state = { byteOffset: 0, buffer: '', knownMessages: new Map<string, number>() };
    const processLine = (
      watcher as unknown as {
        processLine(line: string, session: SessionInfo, stateArg: typeof state): void;
      }
    ).processLine.bind(watcher);

    processLine(
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
      session,
      state,
    );
    processLine(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      }),
      session,
      state,
    );
    processLine(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'call-1' },
      }),
      session,
      state,
    );

    const events = eventStore.getRecent(10);
    assert.equal(events.map((e) => e.type).join(','), 'user-prompt-submit,assistant-streaming,pre-tool-use');
    assert.ok(events[0]!.traceId);
    assert.equal(events[1]!.traceId, events[0]!.traceId);
    assert.equal(events[1]!.parentId, events[0]!.id);
    assert.equal(events[2]!.payload.tool_name, 'exec_command');
  });

  it('creates a new trace root for each Codex user_message', () => {
    const provider = new CodexProvider();
    const eventStore = new EventStore(100, { db: createTestDb() });
    const traceManager = new TraceManager();
    const watcher = new JsonlWatcher({
      provider,
      sessionWatcher: {} as SessionWatcher,
      eventStore,
      tokenStore: { upsert() {} } as unknown as TokenStore,
      traceManager,
      projectRoot: '/tmp/project',
    });
    const session: SessionInfo = {
      pid: -123,
      sessionId: 'sess-codex-1',
      cwd: '/tmp/project',
      startedAt: Date.now(),
      name: 'codex',
      alive: true,
      uptime: 0,
      hasRealPid: false,
    };
    const state = { byteOffset: 0, buffer: '', knownMessages: new Map<string, number>() };
    const processLine = (
      watcher as unknown as {
        processLine(line: string, session: SessionInfo, stateArg: typeof state): void;
      }
    ).processLine.bind(watcher);

    processLine(
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'first' } }),
      session,
      state,
    );
    processLine(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one' }] },
      }),
      session,
      state,
    );
    processLine(
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'second' } }),
      session,
      state,
    );
    processLine(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two' }] },
      }),
      session,
      state,
    );

    const events = eventStore.getRecent(10);
    assert.equal(
      events.map((e) => e.type).join(','),
      'user-prompt-submit,assistant-streaming,user-prompt-submit,assistant-streaming',
    );
    assert.ok(events[0]!.traceId);
    assert.ok(events[2]!.traceId);
    assert.notEqual(events[0]!.traceId, events[2]!.traceId);
    assert.equal(events[1]!.traceId, events[0]!.traceId);
    assert.equal(events[3]!.traceId, events[2]!.traceId);
    assert.equal(events[3]!.parentId, events[2]!.id);
  });
});

describe('Codex OTel tracing', () => {
  it('maps codex log events and conversation.id into traced events', () => {
    const eventStore = new EventStore(100, { db: createTestDb() });
    const metricsStore = new MetricsStore();
    const traceManager = new TraceManager();
    const root = traceManager.assignTrace('user-prompt-submit', null, 'conv-1');
    assert.ok(root.traceId);
    traceManager.setRootEventId('root-event-id', null, 'conv-1');
    const receiver = new OtelReceiver(eventStore, metricsStore, traceManager);

    receiver.ingestLogs({
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'conversation.id', value: { stringValue: 'conv-1' } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'codex.api_request' } },
                    { key: 'model', value: { stringValue: 'gpt-5.5' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const events = eventStore.getRecent(10);
    assert.equal(events[0]!.type, 'otel-api-request');
    assert.equal(events[0]!.sessionId, 'conv-1');
    assert.equal(events[0]!.traceId, root.traceId);
    assert.equal(events[0]!.parentId, 'root-event-id');
  });
});

function makeTempCodexHome(): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orthanc-codex-'));
  process.env.CODEX_HOME = codexHome;
  return codexHome;
}
