import fs from 'node:fs';
import path from 'node:path';

const MONITOR_MARKER = '__claude_monitor__';
const DEFAULT_PORT = 7432;

const HOOK_EVENTS = [
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
];

export function installHooks(projectRoot, port = DEFAULT_PORT) {
  const claudeDir = path.join(projectRoot, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  const settings = readJsonSafe(settingsPath);

  if (!settings.hooks) settings.hooks = {};

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // skip if already installed
    const existing = settings.hooks[event].find(
      (e) => e.hooks?.some((h) => h._marker === MONITOR_MARKER)
    );
    if (existing) continue;

    settings.hooks[event].push({
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

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { installed: HOOK_EVENTS.length, path: settingsPath };
}

export function uninstallHooks(projectRoot) {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
  const settings = readJsonSafe(settingsPath);

  if (!settings.hooks) return { removed: 0, path: settingsPath };

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(
      (e) => !e.hooks?.some((h) => h._marker === MONITOR_MARKER)
    );
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { removed, path: settingsPath };
}

function kebab(str) {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

// CLI mode: node src/hook-installer.js --install|--uninstall --project /path [--port 7432]
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf('--project');
  const portIdx = args.indexOf('--port');
  const project = projectIdx >= 0 ? args[projectIdx + 1] : process.cwd();
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : DEFAULT_PORT;

  if (args.includes('--uninstall')) {
    const result = uninstallHooks(project);
    console.log(`Removed ${result.removed} monitor hooks from ${result.path}`);
  } else if (args.includes('--install')) {
    const result = installHooks(project, port);
    console.log(`Installed ${result.installed} monitor hooks to ${result.path}`);
  } else {
    console.log('Usage: node src/hook-installer.js --install|--uninstall --project /path [--port 7432]');
  }
}
