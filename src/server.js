import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from './event-store.js';
import { parseProjectConfig } from './config-parser.js';
import { SessionWatcher } from './session-watcher.js';
import { installHooks, uninstallHooks } from './hook-installer.js';
import { getTokenUsage } from './token-tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ projectRoot, port = 7432 }) {
  const app = express();
  const eventStore = new EventStore(500);
  let currentProject = projectRoot;
  const sessionWatcher = new SessionWatcher(currentProject, 5000);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- REST API ---

  app.get('/api/config', (req, res) => {
    try {
      const target = req.query.project ? path.resolve(req.query.project) : currentProject;
      const config = parseProjectConfig(target);
      config.projectRoot = target;
      config.projectName = path.basename(target);
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
    sessionWatcher.setProjectFilter(resolved);
    try {
      const config = parseProjectConfig(resolved);
      config.projectRoot = resolved;
      config.projectName = path.basename(resolved);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/sessions', (_req, res) => {
    res.json(sessionWatcher.getSessions());
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
    // Security: only allow reading .md files under .claude/ directories or CLAUDE.md
    const basename = path.basename(resolved);
    const inClaude = resolved.includes('/.claude/') || basename === 'CLAUDE.md' || basename === 'AGENTS.md' || basename === 'ARCHITECTURE.md';
    if (!inClaude || !resolved.endsWith('.md')) {
      return res.status(403).json({ error: 'Only .md files in .claude/ directories are allowed' });
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      res.json({ path: resolved, content });
    } catch (err) {
      res.status(404).json({ error: `File not found: ${err.message}` });
    }
  });

  // Token usage
  app.get('/api/tokens', async (_req, res) => {
    try {
      const usage = await getTokenUsage(currentProject);
      res.json(usage);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Hook management
  app.post('/api/hooks/install', (_req, res) => {
    try {
      const result = installHooks(currentProject, port);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hooks/uninstall', (_req, res) => {
    try {
      const result = uninstallHooks(currentProject);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start
  function start() {
    sessionWatcher.start();
    return new Promise((resolve) => {
      const server = app.listen(port, () => {
        resolve(server);
      });
    });
  }

  function stop() {
    sessionWatcher.stop();
  }

  return { app, start, stop };
}
