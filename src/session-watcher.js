import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class SessionWatcher {
  constructor(projectFilter = null, pollInterval = 5000) {
    this.sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
    this.projectFilter = projectFilter ? path.resolve(projectFilter) : null;
    this.pollInterval = pollInterval;
    this.sessions = new Map();
    this.timer = null;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  poll() {
    if (!fs.existsSync(this.sessionsDir)) return;

    const files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'));
    const currentPids = new Set();

    for (const file of files) {
      try {
        const filePath = path.join(this.sessionsDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const pid = data.pid;
        currentPids.add(pid);

        if (this.projectFilter && data.cwd !== this.projectFilter) continue;

        const alive = isProcessAlive(pid);
        const uptime = alive ? Date.now() - data.startedAt : null;

        this.sessions.set(pid, {
          pid,
          sessionId: data.sessionId,
          cwd: data.cwd,
          startedAt: data.startedAt,
          kind: data.kind,
          name: data.name || `session-${pid}`,
          entrypoint: data.entrypoint,
          alive,
          uptime,
        });
      } catch {
        // skip malformed files
      }
    }

    // mark sessions whose files were removed as dead
    for (const [pid, session] of this.sessions) {
      if (!currentPids.has(pid)) {
        session.alive = false;
        session.uptime = null;
      }
    }
  }

  setProjectFilter(projectPath) {
    this.projectFilter = projectPath ? path.resolve(projectPath) : null;
    this.sessions.clear();
    this.poll();
  }

  getSessions() {
    return Array.from(this.sessions.values())
      .sort((a, b) => {
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        return (b.startedAt || 0) - (a.startedAt || 0);
      });
  }

  getBySessionId(sessionId) {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return null;
  }

  getMostRecentAlive() {
    let best = null;
    for (const session of this.sessions.values()) {
      if (session.alive && (!best || session.startedAt > best.startedAt)) {
        best = session;
      }
    }
    return best;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
