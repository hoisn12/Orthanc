import path from 'node:path';
import type {
  SessionData,
  MonitorStatus,
  InstallOptions,
  InstallResult,
  UninstallResult,
  ModelPricing,
  UsageRecord,
  ProjectConfig,
} from '../types.js';

/**
 * Base Provider interface.
 * Each CLI adapter (Claude Code, Codex CLI, etc.) extends this class.
 */
export abstract class Provider {
  /** Short identifier, e.g. 'claude' or 'codex' */
  abstract get name(): string;

  /** Human-readable name, e.g. 'Claude Code' or 'Codex CLI' */
  abstract get displayName(): string;

  // ── Sessions ──────────────────────────────────────────────

  /** Absolute path to the directory containing session files */
  abstract getSessionsDir(): string;

  /** List session file names (without directory) */
  abstract listSessionFiles(): string[];

  /**
   * Parse a single session file and return a normalized object.
   */
  abstract parseSessionFile(filePath: string): SessionData | null;

  // ── Hooks ─────────────────────────────────────────────────

  /** Return array of hook event names supported by this CLI */
  abstract getHookEvents(): string[];

  /** Install monitoring hooks. Returns { installed, path } */
  abstract installHooks(projectRoot: string, port?: number, options?: InstallOptions): InstallResult;

  /** Uninstall monitoring hooks. Returns { removed, path } */
  abstract uninstallHooks(projectRoot: string, options?: InstallOptions): UninstallResult;

  /** Check which monitor components are installed. Returns { hooks, otel, statusline } */
  getMonitorStatus(_projectRoot: string): MonitorStatus {
    return { hooks: false, otel: false, statusline: false };
  }

  // ── Config ────────────────────────────────────────────────

  /** Config directory name, e.g. '.claude' or '.codex' */
  abstract getConfigDirName(): string;

  /** Parse project configuration from the given root. */
  abstract parseProjectConfig(projectRoot: string): ProjectConfig;

  // ── Tokens ────────────────────────────────────────────────

  /** Absolute path to the projects directory (for token logs) */
  abstract getProjectsDir(): string;

  /** Return model pricing table */
  abstract getTokenPricing(): Record<string, ModelPricing>;

  /** Default pricing for unknown models */
  abstract getDefaultPricing(): ModelPricing;

  /**
   * Given a parsed JSONL record, extract usage info.
   * Returns null if no usage in this record.
   */
  abstract parseUsageRecord(record: unknown): UsageRecord | null;

  // ── File security ─────────────────────────────────────────

  /** Check if a resolved file path is allowed to be read via the API */
  isFileReadAllowed(resolvedPath: string): boolean {
    const basename = path.basename(resolvedPath);
    return (
      resolvedPath.endsWith('.md') &&
      (resolvedPath.includes(`/${this.getConfigDirName()}/`) ||
        basename === 'CLAUDE.md' ||
        basename === 'AGENTS.md' ||
        basename === 'ARCHITECTURE.md')
    );
  }

  /** Check if a resolved file path is allowed to be written via the API */
  isFileWriteAllowed(resolvedPath: string, projectRoot: string): boolean {
    if (resolvedPath !== path.resolve(resolvedPath)) return false;
    if (!resolvedPath.endsWith('.md')) return false;

    const configDir = path.join(projectRoot, this.getConfigDirName()) + '/';
    if (resolvedPath.startsWith(configDir)) return true;

    const basename = path.basename(resolvedPath);
    if (basename === 'CLAUDE.md') {
      const parentDir = path.dirname(projectRoot);
      return resolvedPath.startsWith(parentDir);
    }

    return false;
  }

  // ── CRUD ──────────────────────────────────────────────────

  /** Write content to an allowed .md file */
  writeFile(_filePath: string, _content: string, _projectRoot: string): void {
    throw new Error('not implemented');
  }

  createSkill(
    _projectRoot: string,
    _name: string,
    _opts?: { description?: string; userInvocable?: boolean; content?: string },
  ): void {
    throw new Error('not implemented');
  }

  updateSkill(
    _projectRoot: string,
    _name: string,
    _opts?: { description?: string; userInvocable?: boolean; content?: string },
  ): void {
    throw new Error('not implemented');
  }

  deleteSkill(_projectRoot: string, _name: string): void {
    throw new Error('not implemented');
  }
}
