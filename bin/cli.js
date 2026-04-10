#!/usr/bin/env node

import path from 'node:path';
import { createServer } from '../src/server.js';
import { installHooks } from '../src/hook-installer.js';

const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const idx = args.indexOf(name);
  if (idx === -1) return defaultValue;
  return args[idx + 1];
}

const port = parseInt(getArg('--port', '7432'), 10);
const projectRoot = path.resolve(getArg('--project', process.cwd()));
const shouldInstallHooks = args.includes('--install-hooks');
const noOpen = args.includes('--no-open');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-monitor - Claude Code Process Monitor

Usage:
  claude-monitor [options]

Options:
  --project <path>    Target project directory (default: cwd)
  --port <number>     Server port (default: 7432)
  --install-hooks     Auto-install monitor hooks into settings.local.json
  --no-open           Don't open browser automatically
  --help, -h          Show this help
`);
  process.exit(0);
}

console.log(`\n  Claude Code Monitor`);
console.log(`  Project: ${projectRoot}`);
console.log(`  Port:    ${port}\n`);

if (shouldInstallHooks) {
  try {
    const result = installHooks(projectRoot, port);
    console.log(`  Hooks installed: ${result.installed} events → ${result.path}\n`);
  } catch (err) {
    console.error(`  Failed to install hooks: ${err.message}\n`);
  }
}

const { start, stop } = createServer({ projectRoot, port });

start().then(() => {
  const url = `http://localhost:${port}`;
  console.log(`  Dashboard: ${url}\n`);

  if (!noOpen) {
    import('node:child_process').then(({ exec }) => {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${cmd} ${url}`);
    });
  }
});

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});
