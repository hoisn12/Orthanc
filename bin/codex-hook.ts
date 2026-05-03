#!/usr/bin/env node

import process from 'node:process';

interface Args {
  port: string;
  event: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.port || !args.event) return;

  const input = await readStdin();
  let payload: Record<string, unknown> = {};
  if (input.trim()) {
    try {
      payload = JSON.parse(input) as Record<string, unknown>;
    } catch {
      payload = { raw: input };
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(`http://localhost:${args.port}/api/events/${kebab(args.event)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Monitoring must never block the Codex workflow.
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv: string[]): Partial<Args> {
  const result: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') result.port = argv[++i];
    else if (arg === '--event') result.event = argv[++i];
  }
  return result;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function kebab(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

void main();
