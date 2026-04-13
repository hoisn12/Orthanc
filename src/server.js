import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from './event-store.js';
import { parseProjectConfig } from './config-parser.js';
import { SessionWatcher } from './session-watcher.js';
import { installHooks, uninstallHooks } from './hook-installer.js';
import { getTokenUsage } from './token-tracker.js';
import { detectProvider, listProviders } from './providers/registry.js';
import { MetricsStore } from './metrics-store.js';
import { OtelReceiver } from './otel-receiver.js';
import { getDb, closeDb } from './db.js';
import { TokenStore } from './token-store.js';
import { syncAll } from './token-sync.js';
import { JsonlWatcher } from './jsonl-watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ projectRoot, port = 7432, provider: initialProvider }) {
  const app = express();
  const db = getDb();
  const eventStore = new EventStore(2000);
  const metricsStore = new MetricsStore();
  const otelReceiver = new OtelReceiver(eventStore, metricsStore);
  const tokenStore = new TokenStore();

  // Prepared statements for usage table
  const upsertUsage = db.prepare(
    'INSERT OR REPLACE INTO usage (session_id, data, received_at) VALUES (?, ?, ?)'
  );
  const selectUsage = db.prepare(
    'SELECT * FROM usage ORDER BY received_at DESC'
  );
  let currentProject = projectRoot;
  let provider = initialProvider;
  const sessionWatcher = new SessionWatcher(provider, currentProject, 5000);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'marked', 'lib')));

  // --- REST API ---

  app.get('/api/provider', (_req, res) => {
    res.json({
      name: provider.name,
      displayName: provider.displayName,
      hookEvents: provider.getHookEvents(),
      configDir: provider.getConfigDirName(),
      available: listProviders(),
    });
  });

  app.get('/api/config', (req, res) => {
    try {
      const target = req.query.project ? path.resolve(req.query.project) : currentProject;
      const config = parseProjectConfig(provider, target);
      config.projectRoot = target;
      config.projectName = path.basename(target);
      config.provider = provider.name;
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/project', (req, res) => {
    const { projectPath } = req.body;
    if (!projectPath) {
      return res.status(400).json({ error: 'projectPath is required' });
    }
    const resolved = path.resolve(projectPath);
    currentProject = resolved;
    // Re-detect provider based on the new project directory
    provider = detectProvider({ projectRoot: resolved });
    sessionWatcher.provider = provider;
    sessionWatcher.setProjectFilter(resolved);
    jsonlWatcher.setProjectRoot(resolved);
    try {
      const config = parseProjectConfig(provider, resolved);
      config.projectRoot = resolved;
      config.projectName = path.basename(resolved);
      config.provider = provider.name;
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/sessions', (_req, res) => {
    res.json(sessionWatcher.getSessions());
  });

  app.get('/api/sessions/:pid/config', (req, res) => {
    const pid = parseInt(req.params.pid);
    const session = sessionWatcher.getSessions().find((s) => s.pid === pid);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    try {
      const config = parseProjectConfig(provider, session.cwd);
      config.projectRoot = session.cwd;
      config.projectName = path.basename(session.cwd);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/events', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const filter = {};
    if (req.query.pid) filter.pid = parseInt(req.query.pid);
    res.json(eventStore.getRecent(limit, filter));
  });

  // SSE endpoint
  app.get('/api/events/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':\n\n'); // comment to establish connection

    const unsubscribe = eventStore.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  // Hook receiver
  app.post('/api/events/:type', (req, res) => {
    const payload = req.body || {};
    const type = req.params.type;

    // Resolve session info from payload
    let sessionId = payload.session_id || null;
    let pid = null;

    if (type === 'session-start') {
      sessionWatcher.poll();
    }

    if (sessionId) {
      const session = sessionWatcher.getBySessionId(sessionId);
      if (session) pid = session.pid;
    }
    if (!pid) {
      const fallback = sessionWatcher.getMostRecentAlive();
      if (fallback) {
        pid = fallback.pid;
        if (!sessionId) sessionId = fallback.sessionId;
      }
    }

    const event = eventStore.add({
      type,
      payload,
      sessionId: sessionId || null,
      pid: pid || null,
    });
    res.json({ ok: true, id: event.id });
  });

  // File reader (for viewing .md files in harness)
  app.get('/api/file', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path is required' });

    const resolved = path.resolve(filePath);
    if (!provider.isFileReadAllowed(resolved)) {
      return res.status(403).json({ error: 'Only .md files in config directories are allowed' });
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      res.json({ path: resolved, content });
    } catch (err) {
      res.status(404).json({ error: `File not found: ${err.message}` });
    }
  });

  // Token usage
  app.get('/api/tokens', (req, res) => {
    try {
      const { from, to } = req.query;
      const usage = getTokenUsage(provider, tokenStore, { from: from || null, to: to || null });
      usage.realtime = metricsStore.getCostTimeline(60000);
      usage.realtimeLatency = metricsStore.getApiLatencyStats(3600000);
      res.json(usage);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Hook management
  app.get('/api/hooks/status', (_req, res) => {
    try {
      const status = provider.getMonitorStatus(currentProject);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hooks/install', (req, res) => {
    try {
      const options = req.body || {};
      const result = installHooks(provider, currentProject, port, options);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hooks/uninstall', (req, res) => {
    try {
      const options = req.body || {};
      const result = uninstallHooks(provider, currentProject, options);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Statusline usage receiver ---

  app.post('/api/statusline', (req, res) => {
    const data = req.body || {};
    const sessionId = data.session_id;
    if (!sessionId) return res.status(400).json({ error: 'session_id required' });

    upsertUsage.run(sessionId, JSON.stringify(data), Date.now());
    res.json({ ok: true });
  });

  app.get('/api/usage', (_req, res) => {
    const rows = selectUsage.all();
    const entries = rows.map((r) => ({
      ...JSON.parse(r.data),
      _receivedAt: r.received_at,
    }));
    res.json(entries);
  });

  // --- OTLP HTTP/JSON receiver ---

  app.post('/v1/logs', (req, res) => {
    otelReceiver.ingestLogs(req.body);
    res.json({});
  });

  app.post('/v1/metrics', (req, res) => {
    otelReceiver.ingestMetrics(req.body);
    res.json({});
  });

  app.post('/v1/traces', (req, res) => {
    otelReceiver.ingestTraces(req.body);
    res.json({});
  });

  // --- Metrics query API ---

  app.get('/api/metrics', (req, res) => {
    const window = parseInt(req.query.window) || 3600000;
    res.json(metricsStore.getSummary(window));
  });

  app.get('/api/metrics/latency', (req, res) => {
    const window = parseInt(req.query.window) || 3600000;
    res.json(metricsStore.getApiLatencyStats(window));
  });

  app.get('/api/metrics/tools', (req, res) => {
    const window = parseInt(req.query.window) || 3600000;
    res.json(metricsStore.getToolStats(window));
  });

  app.get('/api/metrics/cost-timeline', (req, res) => {
    const bucket = parseInt(req.query.bucket) || 60000;
    res.json(metricsStore.getCostTimeline(bucket));
  });

  // JSONL watcher for streaming assistant responses
  const jsonlWatcher = new JsonlWatcher({
    provider,
    sessionWatcher,
    eventStore,
    tokenStore,
    projectRoot: currentProject,
    pollInterval: 1000,
  });

  // Start
  async function start() {
    // Initial sync: populate DB from JSONL files
    await syncAll(provider, currentProject, tokenStore);
    sessionWatcher.start();
    jsonlWatcher.start();
    return new Promise((resolve) => {
      const server = app.listen(port, () => {
        resolve(server);
      });
    });
  }

  function stop() {
    sessionWatcher.stop();
    jsonlWatcher.stop();
    closeDb();
  }

  return { app, start, stop };
}
