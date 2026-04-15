import path from 'node:path';
import type { Provider } from './providers/provider.js';
import type { SessionInfo } from './types.js';

export class SessionWatcher {
  provider: Provider;
  projectFilter: string | null;
  pollInterval: number;
  sessions: Map<number, SessionInfo>;
  timer: ReturnType<typeof setInterval> | null;

  constructor(provider: Provider, projectFilter: string | null = null, pollInterval = 5000) {
    this.provider = provider;
    this.projectFilter = projectFilter ? path.resolve(projectFilter) : null;
    this.pollInterval = pollInterval;
    this.sessions = new Map();
    this.timer = null;
  }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  poll(): void {
    const files = this.provider.listSessionFiles();
    if (files.length === 0) return;

    const sessionsDir = this.provider.getSessionsDir();
    const currentPids = new Set<number>();

    for (const file of files) {
      try {
        const filePath = path.join(sessionsDir, file);
        const data = this.provider.parseSessionFile(filePath);
        if (!data) continue;
        const pid = data.pid;
        currentPids.add(pid);

        if (this.projectFilter && !isSubpath(data.cwd, this.projectFilter)) continue;

        const alive = isProcessAlive(pid);
        if (!alive) continue;

        const uptime = Date.now() - data.startedAt;

        this.sessions.set(pid, {
          pid,
          sessionId: data.sessionId,
          cwd: data.cwd,
          startedAt: data.startedAt,
          kind: data.kind,
          name: data.name,
          entrypoint: data.entrypoint,
          alive,
          uptime,
        });
      } catch {
        // skip malformed files
      }
    }

    // remove dead sessions (file removed or process not alive)
    for (const [pid] of this.sessions) {
      if (!currentPids.has(pid) || !isProcessAlive(pid)) {
        this.sessions.delete(pid);
      }
    }
  }

  setProjectFilter(projectPath: string | null): void {
    this.projectFilter = projectPath ? path.resolve(projectPath) : null;
    this.sessions.clear();
    this.poll();
  }

  getSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  getBySessionId(sessionId: string): SessionInfo | null {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return null;
  }

  getMostRecentAlive(): SessionInfo | null {
    let best: SessionInfo | null = null;
    for (const session of this.sessions.values()) {
      if (session.alive && (!best || session.startedAt > best.startedAt)) {
        best = session;
      }
    }
    return best;
  }
}

function isSubpath(child: string, parent: string): boolean {
  const normalizedChild = child.endsWith('/') ? child : child + '/';
  const normalizedParent = parent.endsWith('/') ? parent : parent + '/';
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
