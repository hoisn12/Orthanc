import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Provider } from './provider.js';

const MONITOR_MARKER = '__claude_monitor__';

const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse',
  'SubagentStart', 'SubagentStop',
  'TaskCreated', 'TaskCompleted',
  'Stop', 'Notification',
];

const MAX_DEPTH = 5;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__']);

const MODEL_PRICING = {
  'claude-opus-4-6':   { input: 15,  output: 75,  cache_read: 1.5,   cache_create: 18.75 },
  'claude-opus-4-5':   { input: 15,  output: 75,  cache_read: 1.5,   cache_create: 18.75 },
  'claude-sonnet-4-6': { input: 3,   output: 15,  cache_read: 0.3,   cache_create: 3.75  },
  'claude-sonnet-4-5': { input: 3,   output: 15,  cache_read: 0.3,   cache_create: 3.75  },
  'claude-haiku-4-5':  { input: 0.8, output: 4,   cache_read: 0.08,  cache_create: 1     },
};
const DEFAULT_PRICING = { input: 3, output: 15, cache_read: 0.3, cache_create: 3.75 };

export class ClaudeProvider extends Provider {
  get name() { return 'claude'; }
  get displayName() { return 'Claude Code'; }

  // ── Sessions ──────────────────────────────────────────────

  getSessionsDir() {
    return path.join(os.homedir(), '.claude', 'sessions');
  }

  listSessionFiles() {
    const dir = this.getSessionsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  }

  parseSessionFile(filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      pid: data.pid,
      sessionId: data.sessionId,
      cwd: data.cwd,
      startedAt: data.startedAt,
      kind: data.kind,
      name: data.name || `session-${data.pid}`,
      entrypoint: data.entrypoint,
    };
  }

  // ── Hooks ─────────────────────────────────────────────────

  getHookEvents() { return HOOK_EVENTS; }

  installHooks(projectRoot, port = 7432, options = {}) {
    const { hooks = true, otel = true, statusline = true } = options;
    const claudeDir = path.join(projectRoot, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    const settings = readJsonSafe(settingsPath);

    const monitorUrlPattern = /^http:\/\/localhost:\d+\/api\/events\//;

    if (hooks) {
      if (!settings.hooks) settings.hooks = {};
      for (const event of HOOK_EVENTS) {
        if (!settings.hooks[event]) settings.hooks[event] = [];
        settings.hooks[event] = settings.hooks[event].filter(
          (e) => !e.hooks?.some((h) => h._marker === MONITOR_MARKER || (h.type === 'http' && monitorUrlPattern.test(h.url)))
        );
        settings.hooks[event].push({
          matcher: '',
          hooks: [{
            type: 'http',
            url: `http://localhost:${port}/api/events/${kebab(event)}`,
            timeout: 5,
            _marker: MONITOR_MARKER,
          }],
        });
      }
    }

    if (otel) {
      if (!settings.env) settings.env = {};
      settings.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      settings.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${port}`;
      settings.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      settings.env.CCM_PORT = String(port);
    }

    if (statusline) {
      const providerFile = new URL(import.meta.url).pathname;
      const projectRootDir = path.dirname(path.dirname(path.dirname(providerFile)));
      const scriptPath = path.join(projectRootDir, 'bin', 'statusline.sh');
      settings.statusLine = {
        type: 'command',
        command: scriptPath,
        refreshInterval: 5,
        _marker: MONITOR_MARKER,
      };
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { installed: hooks ? HOOK_EVENTS.length : 0, path: settingsPath, otel, statusline };
  }

  uninstallHooks(projectRoot, options = {}) {
    const { hooks = true, otel = true, statusline = true } = options;
    const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
    const settings = readJsonSafe(settingsPath);

    const monitorUrlPattern = /^http:\/\/localhost:\d+\/api\/events\//;
    let removed = 0;

    if (hooks && settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter(
          (e) => !e.hooks?.some((h) => h._marker === MONITOR_MARKER || (h.type === 'http' && monitorUrlPattern.test(h.url)))
        );
        removed += before - settings.hooks[event].length;
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }

    if (statusline) {
      if (settings.statusLine?._marker === MONITOR_MARKER || settings.statusLine?.command?.includes('statusline.sh')) {
        delete settings.statusLine;
      }
    }

    if (otel && settings.env) {
      delete settings.env.CLAUDE_CODE_ENABLE_TELEMETRY;
      delete settings.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      delete settings.env.OTEL_EXPORTER_OTLP_PROTOCOL;
      delete settings.env.CCM_PORT;
      if (Object.keys(settings.env).length === 0) delete settings.env;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { removed, path: settingsPath };
  }

  getMonitorStatus(projectRoot) {
    const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
    const settings = readJsonSafe(settingsPath);
    const monitorUrlPattern = /^http:\/\/localhost:\d+\/api\/events\//;

    let hasHooks = false;
    if (settings.hooks) {
      for (const entries of Object.values(settings.hooks)) {
        for (const entry of entries) {
          if (entry.hooks?.some((h) => h._marker === MONITOR_MARKER || (h.type === 'http' && monitorUrlPattern.test(h.url)))) {
            hasHooks = true;
            break;
          }
        }
        if (hasHooks) break;
      }
    }

    const hasOtel = !!(
      settings.env?.CLAUDE_CODE_ENABLE_TELEMETRY &&
      settings.env?.OTEL_EXPORTER_OTLP_ENDPOINT
    );

    const hasStatusline = !!(
      settings.statusLine && (
        settings.statusLine._marker === MONITOR_MARKER ||
        settings.statusLine.command?.includes('statusline.sh')
      )
    );

    return { hooks: hasHooks, otel: hasOtel, statusline: hasStatusline };
  }

  // ── Config ────────────────────────────────────────────────

  getConfigDirName() { return '.claude'; }

  parseProjectConfig(projectRoot) {
    const globalDir = path.join(os.homedir(), '.claude');
    const claudeDirs = findClaudeDirs(projectRoot);
    const allDirs = [globalDir, ...claudeDirs];

    const permissions = mergePermissions(allDirs);

    return {
      skills: mergeSkills(allDirs),
      agents: mergeAgents(allDirs),
      rules: mergeRules(allDirs),
      hooks: mergeHooks(allDirs),
      env: mergeEnv(allDirs),
      sources: allDirs.filter((d) => fs.existsSync(d)),
      permissions,
      claudeMdFiles: findClaudeMdFiles(projectRoot),
      settingsLayers: buildSettingsLayers(allDirs),
      mcpServers: deriveMcpServers(permissions),
    };
  }

  // ── Tokens ────────────────────────────────────────────────

  getProjectsDir() {
    return path.join(os.homedir(), '.claude', 'projects');
  }

  getTokenPricing() { return MODEL_PRICING; }
  getDefaultPricing() { return DEFAULT_PRICING; }

  parseUsageRecord(record) {
    const usage = record.message?.usage;
    if (!usage) return null;

    return {
      messageId: record.message?.id || null,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || 0,
      model: record.message?.model || record.model || 'unknown',
      timestamp: record.timestamp || '',
    };
  }

  // ── File security ─────────────────────────────────────────

  isFileReadAllowed(resolvedPath) {
    const basename = path.basename(resolvedPath);
    const inClaude = resolvedPath.includes('/.claude/') ||
      basename === 'CLAUDE.md' || basename === 'AGENTS.md' || basename === 'ARCHITECTURE.md';
    return inClaude && resolvedPath.endsWith('.md');
  }
}

// ============================================================
// Internal helpers (extracted from config-parser.js)
// ============================================================

function findClaudeDirs(root) {
  const results = [];
  walk(root, 0, results);
  return results;
}

function walk(dir, depth, results) {
  if (depth > MAX_DEPTH) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (SKIP_DIRS.has(name)) continue;
      if (name === '.claude') {
        results.push(path.join(dir, name));
      } else {
        walk(path.join(dir, name), depth + 1, results);
      }
    }
  } catch { /* permission errors */ }
}

function mergeSkills(dirs) {
  const map = new Map();
  for (const claudeDir of dirs) {
    for (const skill of parseSkills(claudeDir)) {
      if (!map.has(skill.name)) {
        skill.source = claudeDir;
        map.set(skill.name, skill);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeAgents(dirs) {
  const map = new Map();
  for (const claudeDir of dirs) {
    for (const agent of parseAgents(claudeDir)) {
      if (!map.has(agent.name)) {
        agent.source = claudeDir;
        map.set(agent.name, agent);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeRules(dirs) {
  const all = [];
  for (const claudeDir of dirs) {
    for (const rule of parseRules(claudeDir)) {
      rule.source = claudeDir;
      all.push(rule);
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

function mergeHooks(dirs) {
  const result = {};
  for (const claudeDir of dirs) {
    const hooks = parseHooks(claudeDir);
    for (const [event, entries] of Object.entries(hooks)) {
      if (!result[event]) result[event] = [];
      for (const entry of entries) {
        entry.source = claudeDir;
        result[event].push(entry);
      }
    }
  }
  return result;
}

function mergeEnv(dirs) {
  const result = {};
  for (const claudeDir of dirs) {
    Object.assign(result, parseEnv(claudeDir));
  }
  return result;
}

function mergePermissions(dirs) {
  const all = { coreTools: [], mcpTools: [], webAccess: [], skills: [] };
  for (const claudeDir of dirs) {
    const perms = parsePermissions(claudeDir);
    all.coreTools.push(...perms.coreTools);
    all.mcpTools.push(...perms.mcpTools);
    all.webAccess.push(...perms.webAccess);
    all.skills.push(...perms.skills);
  }
  return all;
}

function parseSkills(claudeDir) {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => {
      const entryPath = path.join(skillsDir, d.name);
      const skillMd = path.join(entryPath, 'SKILL.md');
      const hasContent = fs.existsSync(skillMd);
      const symlink = isSymlinkSync(entryPath);
      let description = '';
      let userInvocable = false;
      if (hasContent) {
        description = extractFrontmatterField(skillMd, 'description') || '';
        userInvocable = extractFrontmatterField(skillMd, 'user_invocable') === 'true';
      }
      const hasReferences = fs.existsSync(path.join(entryPath, 'references'));
      const symlinkTarget = symlink ? resolveSymlink(entryPath) : null;

      return {
        name: d.name,
        filePath: hasContent ? skillMd : null,
        active: hasContent,
        symlink,
        symlinkTarget,
        description,
        userInvocable,
        hasReferences,
      };
    });
}

function parseAgents(claudeDir) {
  const agentsDir = path.join(claudeDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  return fs.readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const filePath = path.join(agentsDir, f);
      const symlink = isSymlinkSync(filePath);
      const description = extractFrontmatterField(filePath, 'description') || '';
      const tools = extractFrontmatterField(filePath, 'tools') || '';
      const symlinkTarget = symlink ? resolveSymlink(filePath) : null;

      return {
        name: f.replace('.md', ''),
        filePath,
        symlink,
        symlinkTarget,
        description,
        tools: tools ? tools.split(',').map((t) => t.trim()).filter(Boolean) : [],
      };
    });
}

function parseRules(claudeDir) {
  const rulesDir = path.join(claudeDir, 'rules');
  if (!fs.existsSync(rulesDir)) return [];

  const settings = readJsonSafe(path.join(claudeDir, 'settings.json'));
  const ruleGlobs = (settings.rules || []).reduce((map, r) => {
    const fileName = path.basename(r.file);
    if (!map[fileName]) map[fileName] = [];
    map[fileName].push(r.glob);
    return map;
  }, {});

  return collectMdFiles(rulesDir, rulesDir).map((relPath) => {
    const fileName = path.basename(relPath);
    const fullPath = path.join(rulesDir, relPath);
    const alwaysApply = extractFrontmatterField(fullPath, 'alwaysApply') === 'true';
    const summary = extractFirstHeading(fullPath);

    const dirPath = path.join(rulesDir, path.dirname(relPath));
    let subRuleCount = 0;
    if (dirPath !== rulesDir) {
      try {
        subRuleCount = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md')).length;
      } catch { /* ignore */ }
    }

    return {
      name: relPath,
      filePath: fullPath,
      globs: ruleGlobs[fileName] || [],
      alwaysApply,
      summary,
      subRuleCount: subRuleCount > 1 ? subRuleCount : 0,
    };
  });
}

function parseHooks(claudeDir) {
  const settings = readJsonSafe(path.join(claudeDir, 'settings.json'));
  const localSettings = readJsonSafe(path.join(claudeDir, 'settings.local.json'));

  const hooks = settings.hooks || {};
  const localHooks = localSettings.hooks || {};

  const result = {};
  const allEvents = new Set([...Object.keys(hooks), ...Object.keys(localHooks)]);

  for (const event of allEvents) {
    const entries = [...(hooks[event] || []), ...(localHooks[event] || [])];
    result[event] = entries.map((entry) => ({
      matcher: entry.matcher || '*',
      hooks: (entry.hooks || []).map((h) => ({
        type: h.type,
        command: h.command || undefined,
        url: h.url || undefined,
        statusMessage: h.statusMessage || undefined,
        _marker: h._marker || undefined,
      })),
    }));
  }

  return result;
}

function parseEnv(claudeDir) {
  const settings = readJsonSafe(path.join(claudeDir, 'settings.json'));
  return settings.env || {};
}

function parsePermissions(claudeDir) {
  const result = { coreTools: [], mcpTools: [], webAccess: [], skills: [] };
  const localSettings = readJsonSafe(path.join(claudeDir, 'settings.local.json'));
  const allow = localSettings.permissions?.allow || [];

  for (const entry of allow) {
    const mcpMatch = entry.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
    if (mcpMatch) {
      result.mcpTools.push({ server: mcpMatch[1], tool: mcpMatch[2], source: claudeDir });
      continue;
    }

    const toolMatch = entry.match(/^(Bash|Edit|Write|Read|Grep|Glob|Agent)\((.+)\)$/);
    if (toolMatch) {
      result.coreTools.push({ name: toolMatch[1], pattern: toolMatch[2], source: claudeDir });
      continue;
    }

    const webFetchMatch = entry.match(/^WebFetch\((.+)\)$/);
    if (webFetchMatch) {
      result.webAccess.push({ type: 'fetch', constraint: webFetchMatch[1], source: claudeDir });
      continue;
    }

    if (entry === 'WebSearch') {
      result.webAccess.push({ type: 'search', constraint: '', source: claudeDir });
      continue;
    }

    const skillMatch = entry.match(/^Skill\((.+)\)$/);
    if (skillMatch) {
      result.skills.push({ name: skillMatch[1], source: claudeDir });
      continue;
    }

    result.coreTools.push({ name: entry, pattern: '', source: claudeDir });
  }

  return result;
}

function findClaudeMdFiles(projectRoot) {
  const results = [];

  let dir = projectRoot;
  const ancestors = [dir];
  for (let i = 0; i < 3; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    ancestors.push(parent);
    dir = parent;
  }

  for (const d of ancestors.reverse()) {
    const mdPath = path.join(d, 'CLAUDE.md');
    if (fs.existsSync(mdPath)) {
      results.push({
        path: mdPath,
        dir: d,
        level: d === projectRoot ? 'project' : 'parent',
        preview: extractFirstHeading(mdPath) || path.basename(d),
      });
    }
  }

  try {
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const mdPath = path.join(projectRoot, entry.name, 'CLAUDE.md');
      if (fs.existsSync(mdPath)) {
        results.push({
          path: mdPath,
          dir: path.join(projectRoot, entry.name),
          level: 'submodule',
          preview: extractFirstHeading(mdPath) || entry.name,
        });
      }
      for (const special of ['AGENTS.md', 'ARCHITECTURE.md']) {
        const specialPath = path.join(projectRoot, entry.name, special);
        if (fs.existsSync(specialPath)) {
          results.push({
            path: specialPath,
            dir: path.join(projectRoot, entry.name),
            level: 'submodule',
            preview: `${entry.name}/${special}`,
          });
        }
      }
    }
  } catch { /* ignore */ }

  return results;
}

function buildSettingsLayers(dirs) {
  return dirs
    .filter((d) => fs.existsSync(d))
    .map((claudeDir) => {
      const settings = readJsonSafe(path.join(claudeDir, 'settings.json'));
      const localSettings = readJsonSafe(path.join(claudeDir, 'settings.local.json'));
      const isGlobal = claudeDir === path.join(os.homedir(), '.claude');

      return {
        path: claudeDir,
        label: isGlobal ? 'Global (~/.claude)' : path.basename(path.dirname(claudeDir)),
        isGlobal,
        settings: {
          exists: Object.keys(settings).length > 0,
          keys: Object.keys(settings),
        },
        localSettings: {
          exists: Object.keys(localSettings).length > 0,
          keys: Object.keys(localSettings),
        },
      };
    });
}

function deriveMcpServers(permissions) {
  const serverMap = {};
  for (const entry of permissions.mcpTools) {
    const serverKey = entry.server;
    if (!serverMap[serverKey]) {
      const parts = serverKey.split('_');
      const friendlyName = parts[parts.length - 1];
      serverMap[serverKey] = { name: friendlyName, prefix: serverKey, tools: [] };
    }
    serverMap[serverKey].tools.push(entry.tool);
  }
  return Object.values(serverMap).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Shared helpers ──────────────────────────────────────────

function collectMdFiles(dir, baseDir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(fullPath, baseDir));
    } else if (entry.name.endsWith('.md')) {
      results.push(path.relative(baseDir, fullPath));
    }
  }
  return results;
}

function isSymlinkSync(filePath) {
  try { return fs.lstatSync(filePath).isSymbolicLink(); }
  catch { return false; }
}

function resolveSymlink(filePath) {
  try { return fs.readlinkSync(filePath); }
  catch { return null; }
}

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return {}; }
}

function extractFrontmatterField(filePath, field) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const line = match[1].split('\n').find((l) => l.startsWith(`${field}:`));
    if (!line) return null;
    return line.slice(field.length + 1).trim().replace(/^["']|["']$/g, '');
  } catch { return null; }
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
