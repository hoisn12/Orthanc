#!/usr/bin/env node

import path from 'node:path';
import { createServer } from '../src/server.js';
import { detectProvider } from '../src/providers/registry.js';

const args = process.argv.slice(2);

function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(name);
  if (idx === -1) return defaultValue;
  return args[idx + 1] || defaultValue;
}

const port = parseInt(getArg('--port', '7432'), 10);
const projectRoot = path.resolve(getArg('--project', process.cwd()));
const providerFlag = getArg('--provider', 'auto');
const shouldInstallHooks = args.includes('--install-hooks');
const noOpen = args.includes('--no-open');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
orthanc - CLI Process Monitor

Usage:
  orthanc [options]

Options:
  --project <path>         Target project directory (default: cwd)
  --port <number>          Server port (default: 7432)
  --provider <name>        Provider: claude, codex, auto (default: auto)
  --install-hooks          Auto-install monitor hooks
  --no-open                Don't open browser automatically
  --help, -h               Show this help
`);
  process.exit(0);
}

const provider = detectProvider({ provider: providerFlag, projectRoot });

console.log(`\n  CLI Monitor`);
console.log(`  Provider: ${provider.displayName}`);
console.log(`  Project:  ${projectRoot}`);
console.log(`  Port:     ${port}\n`);

if (shouldInstallHooks) {
  try {
    const result = provider.installHooks(projectRoot, port);
    console.log(`  Hooks installed: ${result.installed} events → ${result.path}\n`);
  } catch (err: any) {
    console.error(`  Failed to install hooks: ${err.message}\n`);
  }
}

const { start, stop } = createServer({ projectRoot, port, provider });

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
