import path from 'node:path';

/**
 * Base Provider interface.
 * Each CLI adapter (Claude Code, Codex CLI, etc.) extends this class.
 */
export class Provider {
  /** Short identifier, e.g. 'claude' or 'codex' */
  get name() { throw new Error('not implemented'); }

  /** Human-readable name, e.g. 'Claude Code' or 'Codex CLI' */
  get displayName() { throw new Error('not implemented'); }

  // ── Sessions ──────────────────────────────────────────────

  /** Absolute path to the directory containing session files */
  getSessionsDir() { throw new Error('not implemented'); }

  /** List session file names (without directory) */
  listSessionFiles() { throw new Error('not implemented'); }

  /**
   * Parse a single session file and return a normalized object:
   * { pid, sessionId, cwd, startedAt, kind, name, entrypoint }
   */
  parseSessionFile(_filePath) { throw new Error('not implemented'); }

  // ── Hooks ─────────────────────────────────────────────────

  /** Return array of hook event names supported by this CLI */
  getHookEvents() { throw new Error('not implemented'); }

  /** Install monitoring hooks. options: { hooks, otel, statusline } (all true by default). Returns { installed, path } */
  installHooks(_projectRoot, _port, _options) { throw new Error('not implemented'); }

  /** Uninstall monitoring hooks. options: { hooks, otel, statusline } (all true by default). Returns { removed, path } */
  uninstallHooks(_projectRoot, _options) { throw new Error('not implemented'); }

  /** Check which monitor components are installed. Returns { hooks, otel, statusline } */
  getMonitorStatus(_projectRoot) { return { hooks: false, otel: false, statusline: false }; }

  // ── Config ────────────────────────────────────────────────

  /** Config directory name, e.g. '.claude' or '.codex' */
  getConfigDirName() { throw new Error('not implemented'); }

  /** Parse project configuration from the given root. */
  parseProjectConfig(_projectRoot) { throw new Error('not implemented'); }

  // ── Tokens ────────────────────────────────────────────────

  /** Absolute path to the projects directory (for token logs) */
  getProjectsDir() { throw new Error('not implemented'); }

  /** Return model pricing table: { [modelId]: { input, output, cache_read, cache_create } } */
  getTokenPricing() { throw new Error('not implemented'); }

  /** Default pricing for unknown models */
  getDefaultPricing() { throw new Error('not implemented'); }

  /**
   * Given a parsed JSONL record, extract usage info.
   * Returns null if no usage in this record, otherwise:
   * { input, output, cacheRead, cacheCreate, model, timestamp }
   */
  parseUsageRecord(_record) { throw new Error('not implemented'); }

  // ── File security ─────────────────────────────────────────

  /** Check if a resolved file path is allowed to be read via the API */
  isFileReadAllowed(resolvedPath) {
    const basename = path.basename(resolvedPath);
    return resolvedPath.endsWith('.md') && (
      resolvedPath.includes(`/${this.getConfigDirName()}/`) ||
      basename === 'CLAUDE.md' || basename === 'AGENTS.md' || basename === 'ARCHITECTURE.md'
    );
  }
}
