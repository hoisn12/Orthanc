import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
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
import type { Provider } from './providers/provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ServerInstance {
  app: ReturnType<typeof express>;
  start: () => Promise<import('node:http').Server>;
  stop: () => void;
}

type CacheHealthStatus = 'healthy' | 'degraded' | 'broken' | 'unknown';

function computeCacheHealth(trend: { cacheRead: number; input: number }[]): CacheHealthStatus {
  // Filter out messages where we can't compute a meaningful hit rate
  const valid = trend.filter((m) => m.input + m.cacheRead > 0);
  if (valid.length < 3) return 'unknown';

  const hitRate = (m: { cacheRead: number; input: number }) => m.cacheRead / (m.input + m.cacheRead);

  const recentMsgs = valid.slice(-5);
  const earlierMsgs = valid.slice(0, -5);

  const avg = (msgs: typeof valid) => msgs.reduce((s, m) => s + hitRate(m), 0) / msgs.length;

  const recentAvg = avg(recentMsgs);

  if (earlierMsgs.length >= 3) {
    const earlierAvg = avg(earlierMsgs);
    if (earlierAvg >= 0.3 && recentAvg < 0.1) return 'broken';
  }

  if (recentAvg < 0.2) return 'degraded';
  return 'healthy';
}

export function createServer({
  projectRoot,
  port = 7432,
  provider: initialProvider,
  explicitProject = true,
}: {
  projectRoot: string;
  port?: number;
  provider: Provider;
  explicitProject?: boolean;
}): ServerInstance {
  const app = express();
  const db = getDb();
  const eventStore = new EventStore(2000);
  const metricsStore = new MetricsStore();
  const otelReceiver = new OtelReceiver(eventStore, metricsStore);
  const toolStartTimes = new Map<string, number>(); // key: `${pid ?? sessionId}:${toolName}`
  const MAX_TOOL_START_ENTRIES = 1000;
  const tokenStore = new TokenStore();

  // Prepared statements
  const upsertUsage = db.prepare('INSERT OR REPLACE INTO usage (session_id, data, received_at) VALUES (?, ?, ?)');
  const selectUsage = db.prepare('SELECT * FROM usage ORDER BY received_at DESC');
  const getUsageBySession = db.prepare('SELECT data FROM usage WHERE session_id = ?');
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  // Resolve initial project: CLI explicit > DB saved > CLI default
  let currentProject = projectRoot;
  if (!explicitProject) {
    const saved = getSetting.get('projectPath') as { value: string } | undefined;
    if (saved && fs.existsSync(saved.value)) {
      currentProject = saved.value;
    }
  }
  let provider = explicitProject ? initialProvider : detectProvider({ projectRoot: currentProject });
  const sessionWatcher = new SessionWatcher(provider, currentProject, 5000);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  app.use('/vendor', express.static(path.join(__dirname, '..', '..', 'node_modules', 'marked', 'lib')));

  // --- REST API ---

  app.get('/api/provider', (_req: Request, res: Response) => {
    res.json({
      name: provider.name,
      displayName: provider.displayName,
      hookEvents: provider.getHookEvents(),
      configDir: provider.getConfigDirName(),
      available: listProviders(),
    });
  });

  app.get('/api/config', (req: Request, res: Response) => {
    try {
      const target = req.query.project ? path.resolve(String(req.query.project)) : currentProject;
      const config = parseProjectConfig(provider, target);
      config.projectRoot = target;
      config.projectName = path.basename(target);
      config.provider = provider.name;
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/project', (req: Request, res: Response) => {
    const { projectPath } = req.body as { projectPath?: string };
    if (!projectPath) {
      res.status(400).json({ error: 'projectPath is required' });
      return;
    }
    const resolved = path.resolve(projectPath);
    currentProject = resolved;
    setSetting.run('projectPath', resolved);
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
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/directories', (req: Request, res: Response) => {
    const dirPath = String(req.query.path || os.homedir());
    const showHidden = req.query.showHidden === 'true';
    try {
      const resolved = path.resolve(dirPath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const directories = entries
        .filter((e) => {
          try {
            return e.isDirectory() && (showHidden || !e.name.startsWith('.'));
          } catch {
            return false;
          }
        })
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      res.json({ path: resolved, parent: path.dirname(resolved), directories });
    } catch (err: any) {
      const status = err.code === 'ENOENT' ? 400 : err.code === 'EACCES' ? 403 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  app.get('/api/sessions', (_req: Request, res: Response) => {
    res.json(sessionWatcher.getSessions());
  });

  app.get('/api/sessions/:pid/config', (req: Request, res: Response) => {
    const pid = parseInt(String(req.params.pid));
    const session = sessionWatcher.getSessions().find((s) => s.pid === pid);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    try {
      const config = parseProjectConfig(provider, session.cwd);
      config.projectRoot = session.cwd;
      config.projectName = path.basename(session.cwd);

      // Attach actual loaded instructions from InstructionsLoaded hook events
      if (session.sessionId) {
        const events = eventStore.getBySessionAndType(session.sessionId, 'instructions-loaded');
        if (events.length > 0) {
          const seen = new Set<string>();
          config.loadedInstructions = events
            .filter((e) => {
              const fp = String(e.payload?.file_path || '');
              if (!fp || seen.has(fp)) return false;
              seen.add(fp);
              return true;
            })
            .map((e) => ({
              path: String(e.payload?.file_path || ''),
              memoryType: String(e.payload?.memory_type || ''),
              loadReason: String(e.payload?.load_reason || ''),
              timestamp: e.timestamp,
            }));
        }
      }

      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/events', (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit)) || 50;
    const filter: { pid?: number } = {};
    if (req.query.pid) filter.pid = parseInt(String(req.query.pid));
    res.json(eventStore.getRecent(limit, filter));
  });

  app.get('/api/events/older', (req: Request, res: Response) => {
    const before = String(req.query.before || '');
    if (!before) {
      res.status(400).json({ error: 'before is required' });
      return;
    }
    const limit = parseInt(String(req.query.limit)) || 50;
    const filter: { pid?: number } = {};
    if (req.query.pid) filter.pid = parseInt(String(req.query.pid));
    res.json(eventStore.getOlderThan(before, limit, filter));
  });

  // SSE endpoint
  app.get('/api/events/stream', (req: Request, res: Response) => {
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
  app.post('/api/events/:type', (req: Request, res: Response) => {
    const payload = (req.body || {}) as Record<string, unknown>;
    const type = String(req.params.type);

    // Resolve session info from payload
    let sessionId = (payload.session_id as string) || null;
    let pid: number | null = null;

    if (type === 'session-start') {
      sessionWatcher.poll();
    }

    if (sessionId) {
      // Try direct match (includes activeSessionId lookup)
      const session = sessionWatcher.getBySessionId(sessionId);
      if (session) {
        pid = session.pid;
      } else {
        // Fallback: match by cwd from payload
        const cwd = (payload.cwd as string) || '';
        if (cwd) {
          const cwdSession = sessionWatcher.getByCwd(cwd);
          if (cwdSession) {
            pid = cwdSession.pid;
            sessionWatcher.setActiveSessionId(cwdSession.pid, sessionId);
          }
        }
      }
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

    // Hook → MetricsStore bridge
    const toolKey = `${pid ?? sessionId}:${(payload.tool_name as string) || 'unknown'}`;
    if (type === 'pre-tool-use') {
      if (toolStartTimes.size >= MAX_TOOL_START_ENTRIES) {
        const firstKey = toolStartTimes.keys().next().value;
        if (firstKey !== undefined) toolStartTimes.delete(firstKey);
      }
      toolStartTimes.set(toolKey, Date.now());
    } else if (type === 'post-tool-use') {
      const toolName = (payload.tool_name as string) || 'unknown';
      const startTime = toolStartTimes.get(toolKey);
      const durationMs = startTime ? Date.now() - startTime : 0;
      toolStartTimes.delete(toolKey);
      const hasError = !!(payload.error || (payload.tool_response as Record<string, unknown>)?.error);
      metricsStore.recordToolExecution({ toolName, durationMs, success: !hasError });
      if (hasError) {
        const errType = (payload.error as string) || 'tool_error';
        metricsStore.recordApiError({ model: 'unknown', errorType: errType, statusCode: 0 });
      }
    }

    res.json({ ok: true, id: event.id });
  });

  // File reader (for viewing .md files in harness)
  app.get('/api/file', (req: Request, res: Response) => {
    const filePath = String(req.query.path || '');
    if (!filePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const resolved = path.resolve(filePath);
    if (!provider.isFileReadAllowed(resolved)) {
      res.status(403).json({ error: 'Only .md files in config directories are allowed' });
      return;
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      res.json({ path: resolved, content });
    } catch (err: any) {
      res.status(404).json({ error: `File not found: ${err.message}` });
    }
  });

  // File writer (for editing .md files)
  app.put('/api/file', (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content are required' });
    try {
      provider.writeFile(filePath, content, currentProject);
      const config = parseProjectConfig(provider, currentProject);
      config.projectRoot = currentProject;
      config.projectName = path.basename(currentProject);
      res.json({ ok: true, config });
    } catch (err: any) {
      res.status(err.code === 'EPERM' ? 403 : 500).json({ error: err.message });
    }
  });

  // Skills CRUD
  app.post('/api/skills', (req, res) => {
    const { name, description, userInvocable, content } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      provider.createSkill(currentProject, name, { description, userInvocable, content });
      const config = parseProjectConfig(provider, currentProject);
      config.projectRoot = currentProject;
      config.projectName = path.basename(currentProject);
      res.json({ ok: true, config });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/skills/:name', (req, res) => {
    const { description, userInvocable, content } = req.body;
    try {
      provider.updateSkill(currentProject, req.params.name, { description, userInvocable, content });
      const config = parseProjectConfig(provider, currentProject);
      config.projectRoot = currentProject;
      config.projectName = path.basename(currentProject);
      res.json({ ok: true, config });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/skills/:name', (req, res) => {
    try {
      provider.deleteSkill(currentProject, req.params.name);
      const config = parseProjectConfig(provider, currentProject);
      config.projectRoot = currentProject;
      config.projectName = path.basename(currentProject);
      res.json({ ok: true, config });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Token usage
  app.get('/api/tokens', (req: Request, res: Response) => {
    try {
      const { from, to } = req.query as { from?: string; to?: string };
      const usage = getTokenUsage(provider, tokenStore, { from: from || null, to: to || null });
      (usage as any).realtime = metricsStore.getCostTimeline(60000);
      (usage as any).realtimeLatency = metricsStore.getApiLatencyStats(3600000);
      res.json(usage);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cache health per session
  app.get('/api/tokens/cache-health', (_req: Request, res: Response) => {
    try {
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const data = tokenStore.queryAggregated({ from: cutoff24h });
      const sessions = data.sessions.slice(0, 20);

      const result = sessions.map((s) => {
        const trend = tokenStore.getSessionCacheTrend(s.sessionId);
        const status = computeCacheHealth(trend);
        return { sessionId: s.sessionId, status };
      });

      res.json({ sessions: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Hook management
  app.get('/api/hooks/status', (_req: Request, res: Response) => {
    try {
      const status = provider.getMonitorStatus(currentProject);
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hooks/install', (req: Request, res: Response) => {
    try {
      const options = req.body || {};
      const result = installHooks(provider, currentProject, port, options);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hooks/uninstall', (req: Request, res: Response) => {
    try {
      const options = req.body || {};
      const result = uninstallHooks(provider, currentProject, options);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Statusline usage receiver ---

  app.post('/api/statusline', (req: Request, res: Response) => {
    const data = (req.body || {}) as Record<string, unknown>;
    const sessionId = data.session_id as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'session_id required' });
      return;
    }

    // Resolve PID and update activeSessionId mapping
    const cwd = (data.cwd as string) || '';
    let session = sessionWatcher.getBySessionId(sessionId);
    if (!session && cwd) {
      session = sessionWatcher.getByCwd(cwd);
      if (session) {
        sessionWatcher.setActiveSessionId(session.pid, sessionId);
      }
    }

    // Preserve last valid context_window values when new data has nulls
    const ctx = data.context_window as Record<string, unknown> | null | undefined;
    if (ctx && ctx.used_percentage == null) {
      const prev = getUsageBySession.get(sessionId) as { data: string } | undefined;
      if (prev) {
        const prevData = JSON.parse(prev.data) as Record<string, unknown>;
        const prevCtx = prevData.context_window as Record<string, unknown> | null | undefined;
        if (prevCtx && prevCtx.used_percentage != null) {
          ctx.used_percentage = prevCtx.used_percentage;
          ctx.remaining_percentage = prevCtx.remaining_percentage;
          ctx.current_usage = prevCtx.current_usage;
        }
      }
    }

    // Microcompaction detection: ctx% drops >50pp compared to previous value
    const newCtxPct = ctx?.used_percentage as number | null | undefined;
    if (newCtxPct != null) {
      const prevEntry = getUsageBySession.get(sessionId) as { data: string } | undefined;
      if (prevEntry) {
        const prevCtx = (JSON.parse(prevEntry.data) as Record<string, unknown>)?.context_window as
          | Record<string, unknown>
          | null
          | undefined;
        const prevPct = prevCtx?.used_percentage as number | null | undefined;
        if (prevPct != null && prevPct - newCtxPct > 50) {
          eventStore.add({
            type: 'context-compacted',
            payload: { from: prevPct, to: newCtxPct, session_id: sessionId },
            sessionId,
            pid: session?.pid ?? null,
          });
        }
      }
    }

    upsertUsage.run(sessionId, JSON.stringify(data), Date.now());
    res.json({ ok: true });
  });

  app.get('/api/usage', (_req: Request, res: Response) => {
    const rows = selectUsage.all() as { data: string; received_at: number }[];
    const entries = rows.map((r) => ({
      ...(JSON.parse(r.data) as Record<string, unknown>),
      _receivedAt: r.received_at,
    }));
    res.json(entries);
  });

  // --- OTLP HTTP/JSON receiver ---

  app.post('/v1/logs', (req: Request, res: Response) => {
    otelReceiver.ingestLogs(req.body);
    res.json({});
  });

  app.post('/v1/metrics', (req: Request, res: Response) => {
    otelReceiver.ingestMetrics(req.body);
    res.json({});
  });

  app.post('/v1/traces', (req: Request, res: Response) => {
    otelReceiver.ingestTraces(req.body);
    res.json({});
  });

  // --- Metrics query API ---

  app.get('/api/metrics', (req: Request, res: Response) => {
    const window = parseInt(String(req.query.window)) || 3600000;
    res.json(metricsStore.getSummary(window));
  });

  app.get('/api/metrics/latency', (req: Request, res: Response) => {
    const window = parseInt(String(req.query.window)) || 3600000;
    res.json(metricsStore.getApiLatencyStats(window));
  });

  app.get('/api/metrics/tools', (req: Request, res: Response) => {
    const window = parseInt(String(req.query.window)) || 3600000;
    res.json(metricsStore.getToolStats(window));
  });

  app.get('/api/metrics/cost-timeline', (req: Request, res: Response) => {
    const bucket = parseInt(String(req.query.bucket)) || 60000;
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
    return new Promise<import('node:http').Server>((resolve) => {
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
