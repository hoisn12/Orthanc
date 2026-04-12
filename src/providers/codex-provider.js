import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Provider } from './provider.js';

const MONITOR_MARKER = '__claude_monitor__';

const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart',
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__']);
const MAX_DEPTH = 5;

// Codex CLI uses OpenAI models
const MODEL_PRICING = {
  'o4-mini':  { input: 1.10, output: 4.40,  cache_read: 0.275, cache_create: 1.10 },
  'o3':       { input: 2,    output: 8,      cache_read: 0.50,  cache_create: 2    },
  'gpt-4.1':  { input: 2,    output: 8,      cache_read: 0.50,  cache_create: 2    },
  'gpt-4.1-mini': { input: 0.40, output: 1.60, cache_read: 0.10, cache_create: 0.40 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40, cache_read: 0.025, cache_create: 0.10 },
};
const DEFAULT_PRICING = { input: 2, output: 8, cache_read: 0.50, cache_create: 2 };

export class CodexProvider extends Provider {
  get name() { return 'codex'; }
  get displayName() { return 'Codex CLI'; }

  // ── Sessions ──────────────────────────────────────────────

  getSessionsDir() {
    return path.join(os.homedir(), '.codex', 'sessions');
  }

  listSessionFiles() {
    const dir = this.getSessionsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  }

  parseSessionFile(filePath) {
    // Codex sessions are JSONL — read the first line for metadata
    const content = fs.readFileSync(filePath, 'utf-8');
    const firstLine = content.split('\n').find((l) => l.trim());
    if (!firstLine) return null;

    const data = JSON.parse(firstLine);
    return {
      pid: data.pid,
      sessionId: data.session_id || data.sessionId || path.basename(filePath, '.jsonl'),
      cwd: data.cwd || data.working_directory,
      startedAt: data.started_at ? new Date(data.started_at).getTime() : data.startedAt,
      kind: data.kind || 'interactive',
      name: data.name || `codex-${data.pid}`,
      entrypoint: data.entrypoint || 'codex',
    };
  }

  // ── Hooks ─────────────────────────────────────────────────

  getHookEvents() { return HOOK_EVENTS; }

  installHooks(projectRoot, port = 7432, options = {}) {
    const { hooks = true, otel = true } = options;
    const codexDir = path.join(projectRoot, '.codex');
    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }

    let installedCount = 0;
    const hooksPath = path.join(codexDir, 'hooks.json');

    if (hooks) {
      const hooksData = readJsonSafe(hooksPath);
      for (const event of HOOK_EVENTS) {
        if (!hooksData[event]) hooksData[event] = [];
        const existing = hooksData[event].find((h) => h._marker === MONITOR_MARKER);
        if (existing) continue;
        hooksData[event].push({
          type: 'http',
          url: `http://localhost:${port}/api/events/${kebab(event)}`,
          timeout: 5,
          _marker: MONITOR_MARKER,
        });
      }
      fs.writeFileSync(hooksPath, JSON.stringify(hooksData, null, 2) + '\n');
      installedCount = HOOK_EVENTS.length;
    }

    let otelResult = false;
    if (otel) {
      otelResult = this._installOtelConfig(port);
    }

    return { installed: installedCount, path: hooksPath, otel: otelResult };
  }

  uninstallHooks(projectRoot, options = {}) {
    const { hooks = true, otel = true } = options;
    const hooksPath = path.join(projectRoot, '.codex', 'hooks.json');

    let removed = 0;
    if (hooks) {
      const hooksData = readJsonSafe(hooksPath);
      for (const event of Object.keys(hooksData)) {
        const before = hooksData[event].length;
        hooksData[event] = hooksData[event].filter((h) => h._marker !== MONITOR_MARKER);
        removed += before - hooksData[event].length;
        if (hooksData[event].length === 0) delete hooksData[event];
      }
      fs.writeFileSync(hooksPath, JSON.stringify(hooksData, null, 2) + '\n');
    }

    if (otel) {
      this._uninstallOtelConfig();
    }

    return { removed, path: hooksPath };
  }

  getMonitorStatus(projectRoot) {
    const hooksPath = path.join(projectRoot, '.codex', 'hooks.json');
    const hooksData = readJsonSafe(hooksPath);

    let hasHooks = false;
    for (const entries of Object.values(hooksData)) {
      if (Array.isArray(entries) && entries.some((h) => h._marker === MONITOR_MARKER)) {
        hasHooks = true;
        break;
      }
    }

    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    let hasOtel = false;
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      hasOtel = content.includes('__claude_monitor__ OTel');
    } catch { /* ignore */ }

    return { hooks: hasHooks, otel: hasOtel, statusline: false };
  }

  // ── OTel config helpers ────────────────────────────────────

  _installOtelConfig(port) {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf-8'); } catch { /* new file */ }

    const otelBlock = `# __claude_monitor__ OTel config\n[otel]\nexporter = { otlp-http = { endpoint = "http://localhost:${port}" } }`;

    if (content.includes('__claude_monitor__ OTel')) {
      // Replace existing monitor OTel block
      content = content.replace(
        /# __claude_monitor__ OTel config\n\[otel\]\nexporter\s*=\s*\{[^\n]*\}/,
        otelBlock
      );
    } else if (content.includes('[otel]')) {
      // OTel section exists but not ours — don't overwrite user config
      return false;
    } else {
      content = content.trimEnd() + (content ? '\n\n' : '') + otelBlock + '\n';
    }

    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, content);
    return true;
  }

  _uninstallOtelConfig() {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf-8'); } catch { return; }

    if (!content.includes('__claude_monitor__ OTel')) return;

    content = content.replace(
      /\n*# __claude_monitor__ OTel config\n\[otel\]\nexporter\s*=\s*\{[^\n]*\}\n?/,
      ''
    );
    fs.writeFileSync(configPath, content);
  }

  // ── Config ────────────────────────────────────────────────

  getConfigDirName() { return '.codex'; }

  parseProjectConfig(projectRoot) {
    const globalDir = path.join(os.homedir(), '.codex');
    const codexDirs = findConfigDirs(projectRoot, '.codex');
    const allDirs = [globalDir, ...codexDirs];

    return {
      // Codex uses profiles/plugins instead of skills/agents
      skills: [],   // not applicable
      agents: [],   // not applicable
      profiles: mergeProfiles(allDirs),
      plugins: mergePlugins(allDirs),
      rules: [],    // Codex doesn't have rules
      hooks: mergeHooks(allDirs),
      env: mergeEnv(allDirs),
      sources: allDirs.filter((d) => fs.existsSync(d)),
      permissions: { coreTools: [], mcpTools: [], webAccess: [], skills: [] },
      claudeMdFiles: findInstructionFiles(projectRoot),
      settingsLayers: buildSettingsLayers(allDirs),
      mcpServers: [],
    };
  }

  // ── Tokens ────────────────────────────────────────────────

  getProjectsDir() {
    return path.join(os.homedir(), '.codex', 'projects');
  }

  getTokenPricing() { return MODEL_PRICING; }
  getDefaultPricing() { return DEFAULT_PRICING; }

  parseUsageRecord(record) {
    const usage = record.usage || record.message?.usage;
    if (!usage) return null;

    return {
      input: usage.prompt_tokens || usage.input_tokens || 0,
      output: usage.completion_tokens || usage.output_tokens || 0,
      cacheRead: usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || 0,
      model: record.model || record.message?.model || 'unknown',
      timestamp: record.timestamp || '',
    };
  }

  // ── File security ─────────────────────────────────────────

  isFileReadAllowed(resolvedPath) {
    const basename = path.basename(resolvedPath);
    const inCodex = resolvedPath.includes('/.codex/') ||
      basename === 'CODEX.md' || basename === 'AGENTS.md' || basename === 'CLAUDE.md';
    return inCodex && resolvedPath.endsWith('.md');
  }
}

// ============================================================
// Internal helpers
// ============================================================

function findConfigDirs(root, dirName) {
  const results = [];
  walkDirs(root, 0, dirName, results);
  return results;
}

function walkDirs(dir, depth, target, results) {
  if (depth > MAX_DEPTH) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name === target) {
        results.push(path.join(dir, entry.name));
      } else {
        walkDirs(path.join(dir, entry.name), depth + 1, target, results);
      }
    }
  } catch { /* permission errors */ }
}

function mergeProfiles(dirs) {
  const map = new Map();
  for (const codexDir of dirs) {
    const profilesDir = path.join(codexDir, 'profiles');
    if (!fs.existsSync(profilesDir)) continue;
    try {
      for (const f of fs.readdirSync(profilesDir)) {
        if (!f.endsWith('.md') && !f.endsWith('.toml')) continue;
        const name = f.replace(/\.(md|toml)$/, '');
        if (!map.has(name)) {
          map.set(name, {
            name,
            filePath: path.join(profilesDir, f),
            source: codexDir,
          });
        }
      }
    } catch { /* ignore */ }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergePlugins(dirs) {
  const map = new Map();
  for (const codexDir of dirs) {
    const pluginsDir = path.join(codexDir, 'plugins');
    if (!fs.existsSync(pluginsDir)) continue;
    try {
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!map.has(entry.name)) {
          map.set(entry.name, {
            name: entry.name,
            path: path.join(pluginsDir, entry.name),
            source: codexDir,
          });
        }
      }
    } catch { /* ignore */ }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeHooks(dirs) {
  const result = {};
  for (const codexDir of dirs) {
    const hooks = readJsonSafe(path.join(codexDir, 'hooks.json'));
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      if (!result[event]) result[event] = [];
      for (const entry of entries) {
        result[event].push({
          matcher: entry.matcher || '*',
          hooks: [{ type: entry.type, url: entry.url, command: entry.command, _marker: entry._marker }],
          source: codexDir,
        });
      }
    }
  }
  return result;
}

function mergeEnv(dirs) {
  const result = {};
  for (const codexDir of dirs) {
    // Codex uses config.toml — try to parse env section
    const configPath = path.join(codexDir, 'config.toml');
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        // Simple TOML env parser: lines under [env] until next section
        const envMatch = content.match(/\[env\]\n([\s\S]*?)(?=\n\[|$)/);
        if (envMatch) {
          for (const line of envMatch[1].split('\n')) {
            const kv = line.match(/^(\w+)\s*=\s*"?([^"]*)"?$/);
            if (kv) result[kv[1]] = kv[2];
          }
        }
      } catch { /* ignore */ }
    }
    // Also check JSON settings as fallback
    const settings = readJsonSafe(path.join(codexDir, 'config.json'));
    if (settings.env) Object.assign(result, settings.env);
  }
  return result;
}

function findInstructionFiles(projectRoot) {
  const results = [];
  // Codex looks for CODEX.md and AGENTS.md
  for (const name of ['CODEX.md', 'CLAUDE.md', 'AGENTS.md']) {
    const mdPath = path.join(projectRoot, name);
    if (fs.existsSync(mdPath)) {
      results.push({
        path: mdPath,
        dir: projectRoot,
        level: 'project',
        preview: extractFirstHeading(mdPath) || name,
      });
    }
  }
  return results;
}

function buildSettingsLayers(dirs) {
  return dirs
    .filter((d) => fs.existsSync(d))
    .map((codexDir) => {
      const config = readJsonSafe(path.join(codexDir, 'config.json'));
      const hooks = readJsonSafe(path.join(codexDir, 'hooks.json'));
      const hasToml = fs.existsSync(path.join(codexDir, 'config.toml'));
      const isGlobal = codexDir === path.join(os.homedir(), '.codex');

      return {
        path: codexDir,
        label: isGlobal ? 'Global (~/.codex)' : path.basename(path.dirname(codexDir)),
        isGlobal,
        settings: {
          exists: Object.keys(config).length > 0 || hasToml,
          keys: [...Object.keys(config), ...(hasToml ? ['config.toml'] : [])],
        },
        localSettings: {
          exists: Object.keys(hooks).length > 0,
          keys: Object.keys(hooks),
        },
      };
    });
}

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return {}; }
}

function extractFirstHeading(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const line = content.split('\n').find((l) => l.startsWith('#'));
    return line ? line.replace(/^#+\s*/, '').trim() : null;
  } catch { return null; }
}

function kebab(str) {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}
