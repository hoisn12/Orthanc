import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';

const providers = {
  claude: ClaudeProvider,
  codex: CodexProvider,
};

/**
 * Create a provider by explicit name.
 * @param {'claude'|'codex'} name
 * @returns {import('./provider.js').Provider}
 */
export function createProvider(name) {
  const Ctor = providers[name];
  if (!Ctor) throw new Error(`Unknown provider: ${name}`);
  return new Ctor();
}

/**
 * Auto-detect which CLI is in use.
 * Priority:
 * 1. Explicit choice (if provided)
 * 2. Project has .codex/ → codex
 * 3. Project has .claude/ → claude
 * 4. ~/.codex/sessions/ has active sessions → codex
 * 5. Default: claude
 *
 * @param {{ provider?: string, projectRoot?: string }} opts
 * @returns {import('./provider.js').Provider}
 */
export function detectProvider({ provider, projectRoot } = {}) {
  // 1. Explicit
  if (provider && provider !== 'auto') {
    return createProvider(provider);
  }

  const root = projectRoot || process.cwd();

  // 2. Project has .codex/
  if (fs.existsSync(path.join(root, '.codex'))) {
    return new CodexProvider();
  }

  // 3. Project has .claude/
  if (fs.existsSync(path.join(root, '.claude'))) {
    return new ClaudeProvider();
  }

  // 4. Active codex sessions
  const codexSessions = path.join(os.homedir(), '.codex', 'sessions');
  if (fs.existsSync(codexSessions)) {
    try {
      const files = fs.readdirSync(codexSessions);
      if (files.length > 0) return new CodexProvider();
    } catch { /* ignore */ }
  }

  // 5. Default
  return new ClaudeProvider();
}

/** List all available provider names */
export function listProviders() {
  return Object.keys(providers);
}
