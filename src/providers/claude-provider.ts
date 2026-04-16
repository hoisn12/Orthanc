import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Provider } from './provider.js';
import type {
  SessionData,
  InstallOptions,
  InstallResult,
  UninstallResult,
  MonitorStatus,
  ModelPricing,
  UsageRecord,
  ProjectConfig,
  SkillInfo,
  AgentInfo,
  RuleInfo,
  HookRule,
  ClaudeMdFile,
  SettingsLayer,
  PermissionsInfo,
} from '../types.js';

const MONITOR_MARKER = '__claude_monitor__';

const HOOK_EVENTS: string[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'Notification',
  'InstructionsLoaded',
];

const MAX_DEPTH = 5;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__']);

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': { input: 15, output: 75, cache_read: 1.5, cache_create: 18.75 },
  'claude-opus-4-5': { input: 15, output: 75, cache_read: 1.5, cache_create: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_create: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_create: 3.75 },
  'claude-haiku-4-5': { input: 0.8, output: 4, cache_read: 0.08, cache_create: 1 },
};
const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cache_read: 0.3, cache_create: 3.75 };

// ── Internal types for richer permission objects ────────────

interface CoreToolPerm {
  name: string;
  pattern: string;
  source: string;
}

interface McpToolPerm {
  server: string;
  tool: string;
  source: string;
}

interface WebAccessPerm {
  type: string;
  constraint: string;
  source: string;
}

interface SkillPerm {
  name: string;
  source: string;
}

interface InternalPermissions {
  coreTools: CoreToolPerm[];
  mcpTools: McpToolPerm[];
  webAccess: WebAccessPerm[];
  skills: SkillPerm[];
}

interface McpServerInfo {
  name: string;
  prefix: string;
  tools: string[];
}

// Hook-related internal types
interface InternalHookDef {
  type: string;
  command?: string;
  url?: string;
  timeout?: number;
  statusMessage?: string;
  _marker?: string;
}

interface InternalHookEntry {
  matcher: string;
  hooks: InternalHookDef[];
  source?: string;
}

// Settings shape used during install/uninstall
interface SettingsJson {
  hooks?: Record<string, InternalHookEntry[]>;
  env?: Record<string, string>;
  statusLine?: {
    type: string;
    command: string;
    refreshInterval: number;
    _marker?: string;
  };
  permissions?: {
    allow?: string[];
  };
  rules?: Array<{ file: string; glob: string }>;
  [key: string]: unknown;
}

// ── Internal skill/agent/rule shapes (richer than exported types) ──

interface InternalSkillInfo {
  name: string;
  filePath: string | null;
  active: boolean;
  symlink: boolean;
  symlinkTarget: string | null;
  description: string;
  userInvocable: boolean;
  hasReferences: boolean;
  source?: string;
}

interface InternalAgentInfo {
  name: string;
  filePath: string;
  symlink: boolean;
  symlinkTarget: string | null;
  description: string;
  tools: string[];
  source?: string;
}

interface InternalRuleInfo {
  name: string;
  filePath: string;
  globs: string[];
  alwaysApply: boolean;
  summary: string | null;
  subRuleCount: number;
  source?: string;
}

export class ClaudeProvider extends Provider {
  get name(): string {
    return 'claude';
  }
  get displayName(): string {
    return 'Claude Code';
  }

  // ── Sessions ──────────────────────────────────────────────

  getSessionsDir(): string {
    return path.join(os.homedir(), '.claude', 'sessions');
  }

  listSessionFiles(): string[] {
    const dir = this.getSessionsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  }

  parseSessionFile(filePath: string): SessionData | null {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, any>;
    return {
      pid: data['pid'] as number,
      sessionId: data['sessionId'] as string,
      cwd: data['cwd'] as string,
      startedAt: data['startedAt'] as number,
      kind: data['kind'] as string | undefined,
      name: (data['name'] as string | undefined) || `session-${data['pid']}`,
      entrypoint: data['entrypoint'] as string | undefined,
    };
  }

  // ── Hooks ─────────────────────────────────────────────────

  getHookEvents(): string[] {
    return HOOK_EVENTS;
  }

  installHooks(projectRoot: string, port = 7432, options: InstallOptions = {}): InstallResult {
    const { hooks = true, otel = true, statusline = true } = options;
    const claudeDir = path.join(projectRoot, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    const settings = readJsonSafe(settingsPath) as SettingsJson;

    const monitorUrlPattern = /^http:\/\/localhost:\d+\/api\/events\//;

    if (hooks) {
      if (!settings.hooks) settings.hooks = {};
      for (const event of HOOK_EVENTS) {
        if (!settings.hooks[event]) settings.hooks[event] = [];
        const eventHooks = settings.hooks[event]!;
        settings.hooks[event] = eventHooks.filter(
          (e) =>
            !e.hooks?.some(
              (h) => h._marker === MONITOR_MARKER || (h.type === 'http' && monitorUrlPattern.test(h.url ?? '')),
            ),
        );
        settings.hooks[event]!.push({
          matcher: '',
          hooks: [
            {
              type: 'http',
              url: `http://localhost:${port}/api/events/${kebab(event)}`,
              timeout: 5,
              _marker: MONITOR_MARKER,
            },
          ],
        });
      }
    }

    if (otel) {
      if (!settings.env) settings.env = {};
      settings.env['CLAUDE_CODE_ENABLE_TELEMETRY'] = '1';
      settings.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = `http://localhost:${port}`;
      settings.env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/json';
      settings.env['ORTHANC_PORT'] = String(port);
    }

    if (statusline) {
      const providerFile = new URL(import.meta.url).pathname;
      // dist/src/providers/claude-provider.js → 4 levels up to project root
      let projectRootDir = path.dirname(path.dirname(path.dirname(providerFile)));
      if (path.basename(projectRootDir) === 'dist') projectRootDir = path.dirname(projectRootDir);
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

  uninstallHooks(projectRoot: string, options: InstallOptions = {}): UninstallResult {
    const { hooks = true, otel = true, statusline = true } = options;
    const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
    const settings = readJsonSafe(settingsPath) as SettingsJson;

    const monitorUrlPattern = /^http:\/\/localhost:\d+\/api\/events\//;
    let removed = 0;

    if (hooks && settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        const eventHooks = settings.hooks[event];
        if (!eventHooks) continue;
        const before = eventHooks.length;
        settings.hooks[event] = eventHooks.filter(
          (e) =>
            !e.hooks?.some(
              (h) => h._marker === MONITOR_MARKER || (h.type === 'http' && monitorUrlPattern.test(h.url ?? '')),
            ),
        );
        removed += before - settings.hooks[event]!.length;
        if (settings.hooks[event]!.length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }

    if (statusline) {
      if (settings.statusLine?._marker === MONITOR_MARKER || settings.statusLine?.command?.includes('statusline.sh')) {
        delete settings.statusLine;
      }
    }

    if (otel && settings.env) {
      delete settings.env['CLAUDE_CODE_ENABLE_TELEMETRY'];
      delete settings.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      delete settings.env['OTEL_EXPORTER_OTLP_PROTOCOL'];
      delete settings.env['ORTHANC_PORT'];
      if (Object.keys(settings.env).length === 0) delete settings.env;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { removed, path: settingsPath };
  }

  getMonitorStatus(projectRoot: string): MonitorStatus {
    const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
    const settings = readJsonSafe(settingsPath) as SettingsJson;
    const monitorUrlPattern = /^http:\/\/localhost:\d+\/api\/events\//;

    let hasHooks = false;
    if (settings.hooks) {
      for (const entries of Object.values(settings.hooks)) {
        if (!entries) continue;
        for (const entry of entries) {
          if (
            entry.hooks?.some(
              (h) => h._marker === MONITOR_MARKER || (h.type === 'http' && monitorUrlPattern.test(h.url ?? '')),
            )
          ) {
            hasHooks = true;
            break;
          }
        }
        if (hasHooks) break;
      }
    }

    const hasOtel = !!(settings.env?.['CLAUDE_CODE_ENABLE_TELEMETRY'] && settings.env?.['OTEL_EXPORTER_OTLP_ENDPOINT']);

    const hasStatusline = !!(
      settings.statusLine &&
      (settings.statusLine._marker === MONITOR_MARKER || settings.statusLine.command?.includes('statusline.sh'))
    );

    return { hooks: hasHooks, otel: hasOtel, statusline: hasStatusline };
  }

  // ── Config ────────────────────────────────────────────────

  getConfigDirName(): string {
    return '.claude';
  }

  parseProjectConfig(projectRoot: string): ProjectConfig {
    const globalDir = path.join(os.homedir(), '.claude');
    const claudeDirs = findClaudeDirs(projectRoot);
    const allDirs = [globalDir, ...claudeDirs];

    const permissions = mergePermissions(allDirs);

    return {
      skills: mergeSkills(allDirs) as unknown as SkillInfo[],
      agents: mergeAgents(allDirs) as unknown as AgentInfo[],
      rules: mergeRules(allDirs) as unknown as RuleInfo[],
      hooks: mergeHooks(allDirs),
      env: mergeEnv(allDirs),
      sources: allDirs.filter((d) => fs.existsSync(d)),
      permissions: permissions as unknown as PermissionsInfo,
      claudeMdFiles: findClaudeMdFiles(projectRoot),
      settingsLayers: buildSettingsLayers(allDirs),
      mcpServers: deriveMcpServers(permissions) as unknown as ProjectConfig['mcpServers'],
    };
  }

  // ── Tokens ────────────────────────────────────────────────

  getProjectsDir(): string {
    return path.join(os.homedir(), '.claude', 'projects');
  }

  getTokenPricing(): Record<string, ModelPricing> {
    return MODEL_PRICING;
  }
  getDefaultPricing(): ModelPricing {
    return DEFAULT_PRICING;
  }

  parseUsageRecord(record: unknown): UsageRecord | null {
    const rec = record as Record<string, any>;
    const usage = rec['message']?.['usage'] as Record<string, any> | undefined;
    if (!usage) return null;

    return {
      messageId: (rec['message']?.['id'] as string | undefined) ?? null,
      input: (usage['input_tokens'] as number | undefined) ?? 0,
      output: (usage['output_tokens'] as number | undefined) ?? 0,
      cacheRead: (usage['cache_read_input_tokens'] as number | undefined) ?? 0,
      cacheCreate: (usage['cache_creation_input_tokens'] as number | undefined) ?? 0,
      model: (rec['message']?.['model'] as string | undefined) ?? (rec['model'] as string | undefined) ?? 'unknown',
      timestamp: (rec['timestamp'] as string | undefined) ?? '',
    };
  }

  // ── File security ─────────────────────────────────────────

  isFileReadAllowed(resolvedPath: string): boolean {
    const basename = path.basename(resolvedPath);
    const inClaude =
      resolvedPath.includes('/.claude/') ||
      basename === 'CLAUDE.md' ||
      basename === 'AGENTS.md' ||
      basename === 'ARCHITECTURE.md';
    return inClaude && resolvedPath.endsWith('.md');
  }

  // ── CRUD ──────────────────────────────────────────────────

  writeFile(filePath: string, content: string, projectRoot: string): void {
    const resolved = path.resolve(filePath);
    if (!this.isFileWriteAllowed(resolved, projectRoot)) {
      const err: NodeJS.ErrnoException = new Error('Write not allowed: ' + filePath);
      err.code = 'EPERM';
      throw err;
    }
    fs.writeFileSync(resolved, content);
  }

  createSkill(projectRoot: string, name: string, { description = '', userInvocable = false, content = '' } = {}): void {
    validateName(name);
    const skillDir = path.join(projectRoot, '.claude', 'skills', name);
    if (fs.existsSync(skillDir)) throw new Error(`Skill "${name}" already exists`);
    fs.mkdirSync(skillDir, { recursive: true });
    const body = buildSkillMd({ description, userInvocable, content });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body);
  }

  updateSkill(
    projectRoot: string,
    name: string,
    { description, userInvocable, content }: { description?: string; userInvocable?: boolean; content?: string } = {},
  ): void {
    validateName(name);
    const skillMd = path.join(projectRoot, '.claude', 'skills', name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) throw new Error(`Skill "${name}" not found`);

    if (content !== undefined) {
      fs.writeFileSync(skillMd, content);
    } else {
      const existing = parseFrontmatterAndBody(fs.readFileSync(skillMd, 'utf-8'));
      const fm = existing.frontmatter;
      if (description !== undefined) fm.description = description;
      if (userInvocable !== undefined) fm.user_invocable = String(userInvocable);
      const body = buildSkillMd({
        description: fm.description || '',
        userInvocable: fm.user_invocable === 'true',
        content: existing.body,
      });
      fs.writeFileSync(skillMd, body);
    }
  }

  deleteSkill(projectRoot: string, name: string): void {
    validateName(name);
    const skillDir = path.join(projectRoot, '.claude', 'skills', name);
    if (!fs.existsSync(skillDir)) throw new Error(`Skill "${name}" not found`);
    if (isSymlinkSync(skillDir)) throw new Error('Cannot delete symlinked skill');
    fs.rmSync(skillDir, { recursive: true });
  }
}

// ============================================================
// Internal helpers (extracted from config-parser.js)
// ============================================================

function findClaudeDirs(root: string): string[] {
  const results: string[] = [];
  walk(root, 0, results);
  return results;
}

function walk(dir: string, depth: number, results: string[]): void {
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
  } catch {
    /* permission errors */
  }
}

function mergeSkills(dirs: string[]): InternalSkillInfo[] {
  const map = new Map<string, InternalSkillInfo>();
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

function mergeAgents(dirs: string[]): InternalAgentInfo[] {
  const map = new Map<string, InternalAgentInfo>();
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

function mergeRules(dirs: string[]): InternalRuleInfo[] {
  const all: InternalRuleInfo[] = [];
  for (const claudeDir of dirs) {
    for (const rule of parseRules(claudeDir)) {
      rule.source = claudeDir;
      all.push(rule);
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

function mergeHooks(dirs: string[]): Record<string, HookRule[]> {
  const result: Record<string, HookRule[]> = {};
  for (const claudeDir of dirs) {
    const hooks = parseHooks(claudeDir);
    for (const [event, entries] of Object.entries(hooks)) {
      if (!result[event]) result[event] = [];
      for (const entry of entries) {
        (entry as HookRule & { source?: string }).source = claudeDir;
        result[event]!.push(entry);
      }
    }
  }
  return result;
}

function mergeEnv(dirs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const claudeDir of dirs) {
    Object.assign(result, parseEnv(claudeDir));
  }
  return result;
}

function mergePermissions(dirs: string[]): InternalPermissions {
  const all: InternalPermissions = { coreTools: [], mcpTools: [], webAccess: [], skills: [] };
  for (const claudeDir of dirs) {
    const perms = parsePermissions(claudeDir);
    all.coreTools.push(...perms.coreTools);
    all.mcpTools.push(...perms.mcpTools);
    all.webAccess.push(...perms.webAccess);
    all.skills.push(...perms.skills);
  }
  return all;
}

function parseSkills(claudeDir: string): InternalSkillInfo[] {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d): InternalSkillInfo => {
      const entryPath = path.join(skillsDir, d.name);
      const skillMd = path.join(entryPath, 'SKILL.md');
      const hasContent = fs.existsSync(skillMd);
      const symlink = isSymlinkSync(entryPath);
      let description = '';
      let userInvocable = false;
      if (hasContent) {
        description = extractFrontmatterField(skillMd, 'description') ?? '';
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

function parseAgents(claudeDir: string): InternalAgentInfo[] {
  const agentsDir = path.join(claudeDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f): InternalAgentInfo => {
      const filePath = path.join(agentsDir, f);
      const symlink = isSymlinkSync(filePath);
      const description = extractFrontmatterField(filePath, 'description') ?? '';
      const tools = extractFrontmatterField(filePath, 'tools') ?? '';
      const symlinkTarget = symlink ? resolveSymlink(filePath) : null;

      return {
        name: f.replace('.md', ''),
        filePath,
        symlink,
        symlinkTarget,
        description,
        tools: tools
          ? tools
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
      };
    });
}

function parseRules(claudeDir: string): InternalRuleInfo[] {
  const rulesDir = path.join(claudeDir, 'rules');
  if (!fs.existsSync(rulesDir)) return [];

  const settings = readJsonSafe(path.join(claudeDir, 'settings.json')) as SettingsJson;
  const ruleGlobs: Record<string, string[]> = ((settings.rules ?? []) as Array<{ file: string; glob: string }>).reduce<
    Record<string, string[]>
  >((map, r) => {
    const fileName = path.basename(r.file);
    if (!map[fileName]) map[fileName] = [];
    map[fileName]!.push(r.glob);
    return map;
  }, {});

  return collectMdFiles(rulesDir, rulesDir).map((relPath): InternalRuleInfo => {
    const fileName = path.basename(relPath);
    const fullPath = path.join(rulesDir, relPath);
    const alwaysApply = extractFrontmatterField(fullPath, 'alwaysApply') === 'true';
    const summary = extractFirstHeading(fullPath);

    const dirPath = path.join(rulesDir, path.dirname(relPath));
    let subRuleCount = 0;
    if (dirPath !== rulesDir) {
      try {
        subRuleCount = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md')).length;
      } catch {
        /* ignore */
      }
    }

    return {
      name: relPath,
      filePath: fullPath,
      globs: ruleGlobs[fileName] ?? [],
      alwaysApply,
      summary,
      subRuleCount: subRuleCount > 1 ? subRuleCount : 0,
    };
  });
}

function parseHooks(claudeDir: string): Record<string, HookRule[]> {
  const settings = readJsonSafe(path.join(claudeDir, 'settings.json')) as SettingsJson;
  const localSettings = readJsonSafe(path.join(claudeDir, 'settings.local.json')) as SettingsJson;

  const hooks: Record<string, InternalHookEntry[]> = settings.hooks ?? {};
  const localHooks: Record<string, InternalHookEntry[]> = localSettings.hooks ?? {};

  const result: Record<string, HookRule[]> = {};
  const allEvents = new Set([...Object.keys(hooks), ...Object.keys(localHooks)]);

  for (const event of allEvents) {
    const entries = [...(hooks[event] ?? []), ...(localHooks[event] ?? [])];
    result[event] = entries.map(
      (entry): HookRule => ({
        matcher: entry.matcher || '*',
        hooks: (entry.hooks ?? []).map((h) => ({
          type: h.type,
          command: h.command ?? undefined,
          url: h.url ?? undefined,
          statusMessage: h.statusMessage ?? undefined,
          _marker: h._marker ?? undefined,
        })),
      }),
    );
  }

  return result;
}

function parseEnv(claudeDir: string): Record<string, string> {
  const settings = readJsonSafe(path.join(claudeDir, 'settings.json')) as SettingsJson;
  return settings.env ?? {};
}

function parsePermissions(claudeDir: string): InternalPermissions {
  const result: InternalPermissions = { coreTools: [], mcpTools: [], webAccess: [], skills: [] };
  const localSettings = readJsonSafe(path.join(claudeDir, 'settings.local.json')) as SettingsJson;
  const allow: string[] = localSettings.permissions?.allow ?? [];

  for (const entry of allow) {
    const mcpMatch = entry.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
    if (mcpMatch) {
      result.mcpTools.push({ server: mcpMatch[1]!, tool: mcpMatch[2]!, source: claudeDir });
      continue;
    }

    const toolMatch = entry.match(/^(Bash|Edit|Write|Read|Grep|Glob|Agent)\((.+)\)$/);
    if (toolMatch) {
      result.coreTools.push({ name: toolMatch[1]!, pattern: toolMatch[2]!, source: claudeDir });
      continue;
    }

    const webFetchMatch = entry.match(/^WebFetch\((.+)\)$/);
    if (webFetchMatch) {
      result.webAccess.push({ type: 'fetch', constraint: webFetchMatch[1]!, source: claudeDir });
      continue;
    }

    if (entry === 'WebSearch') {
      result.webAccess.push({ type: 'search', constraint: '', source: claudeDir });
      continue;
    }

    const skillMatch = entry.match(/^Skill\((.+)\)$/);
    if (skillMatch) {
      result.skills.push({ name: skillMatch[1]!, source: claudeDir });
      continue;
    }

    result.coreTools.push({ name: entry, pattern: '', source: claudeDir });
  }

  return result;
}

function findClaudeMdFiles(projectRoot: string): ClaudeMdFile[] {
  const results: ClaudeMdFile[] = [];

  let dir = projectRoot;
  const ancestors: string[] = [dir];
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
        preview: extractFirstHeading(mdPath) ?? path.basename(d),
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
          preview: extractFirstHeading(mdPath) ?? entry.name,
        });
      }
      for (const special of ['AGENTS.md', 'ARCHITECTURE.md'] as const) {
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
  } catch {
    /* ignore */
  }

  return results;
}

function buildSettingsLayers(dirs: string[]): SettingsLayer[] {
  return dirs
    .filter((d) => fs.existsSync(d))
    .map((claudeDir): SettingsLayer => {
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

function deriveMcpServers(permissions: InternalPermissions): McpServerInfo[] {
  const serverMap: Record<string, McpServerInfo> = {};
  for (const entry of permissions.mcpTools) {
    const serverKey = entry.server;
    if (!serverMap[serverKey]) {
      const parts = serverKey.split('_');
      const friendlyName = parts[parts.length - 1]!;
      serverMap[serverKey] = { name: friendlyName, prefix: serverKey, tools: [] };
    }
    serverMap[serverKey]!.tools.push(entry.tool);
  }
  return Object.values(serverMap).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Shared helpers ──────────────────────────────────────────

function collectMdFiles(dir: string, baseDir: string): string[] {
  const results: string[] = [];
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

function isSymlinkSync(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveSymlink(filePath: string): string | null {
  try {
    return fs.readlinkSync(filePath);
  } catch {
    return null;
  }
}

function readJsonSafe(filePath: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, any>;
  } catch {
    return {};
  }
}

function extractFrontmatterField(filePath: string, field: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match?.[1]) return null;
    const line = match[1].split('\n').find((l) => l.startsWith(`${field}:`));
    if (!line) return null;
    return line
      .slice(field.length + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  } catch {
    return null;
  }
}

function extractFirstHeading(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const line = content.split('\n').find((l) => l.startsWith('#'));
    return line ? line.replace(/^#+\s*/, '').trim() : null;
  } catch {
    return null;
  }
}

function kebab(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function validateName(name: string): void {
  if (!name || typeof name !== 'string') throw new Error('Name is required');
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Name must only contain letters, numbers, hyphens, underscores');
}

function buildSkillMd({
  description = '',
  userInvocable = false,
  content = '',
}: {
  description?: string;
  userInvocable?: boolean;
  content?: string;
}): string {
  const lines = ['---'];
  if (description) lines.push(`description: "${description}"`);
  lines.push(`user_invocable: ${userInvocable}`);
  lines.push('---');
  lines.push('');
  lines.push(content);
  return lines.join('\n');
}

function parseFrontmatterAndBody(text: string): { frontmatter: Record<string, string>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    fm[key] = val;
  }
  return { frontmatter: fm, body: match[2] ?? '' };
}
