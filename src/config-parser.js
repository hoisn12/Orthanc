import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_DEPTH = 5;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__']);

export function parseProjectConfig(projectRoot) {
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

// ============================================================
// Find all .claude/ directories recursively
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

// ============================================================
// Merge across all .claude dirs
// ============================================================

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

// ============================================================
// Per-directory parsers
// ============================================================

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

    // Count sub-rule files if this is a directory-based rule
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

    // Unknown permission format — treat as core tool
    result.coreTools.push({ name: entry, pattern: '', source: claudeDir });
  }

  return result;
}

// ============================================================
// New top-level parsers
// ============================================================

function findClaudeMdFiles(projectRoot) {
  const results = [];

  // Walk up to 3 parent levels
  let dir = projectRoot;
  const ancestors = [dir];
  for (let i = 0; i < 3; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    ancestors.push(parent);
    dir = parent;
  }

  // Check each ancestor (reverse so root is first)
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

  // Check immediate subdirectories
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
      // Also check AGENTS.md, ARCHITECTURE.md
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
      // Derive friendly name: "claude_ai_Figma" -> "Figma"
      const parts = serverKey.split('_');
      const friendlyName = parts[parts.length - 1];
      serverMap[serverKey] = { name: friendlyName, prefix: serverKey, tools: [] };
    }
    serverMap[serverKey].tools.push(entry.tool);
  }
  return Object.values(serverMap).sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================
// Helpers
// ============================================================

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
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveSymlink(filePath) {
  try {
    return fs.readlinkSync(filePath);
  } catch {
    return null;
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function extractFrontmatterField(filePath, field) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const line = match[1].split('\n').find((l) => l.startsWith(`${field}:`));
    if (!line) return null;
    return line.slice(field.length + 1).trim().replace(/^["']|["']$/g, '');
  } catch {
    return null;
  }
}

function extractFirstHeading(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const line = content.split('\n').find((l) => l.startsWith('#'));
    return line ? line.replace(/^#+\s*/, '').trim() : null;
  } catch {
    return null;
  }
}
