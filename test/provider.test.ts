import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeProvider } from '../src/providers/claude-provider.js';
import { CodexProvider } from '../src/providers/codex-provider.js';
import { detectProvider, createProvider, listProviders } from '../src/providers/registry.js';
import path from 'node:path';
import os from 'node:os';

describe('Provider interface', () => {
  it('ClaudeProvider has correct name and displayName', () => {
    const p = new ClaudeProvider();
    assert.equal(p.name, 'claude');
    assert.equal(p.displayName, 'Claude Code');
  });

  it('CodexProvider has correct name and displayName', () => {
    const p = new CodexProvider();
    assert.equal(p.name, 'codex');
    assert.equal(p.displayName, 'Codex CLI');
  });

  it('ClaudeProvider sessions dir points to ~/.claude/sessions', () => {
    const p = new ClaudeProvider();
    assert.equal(p.getSessionsDir(), path.join(os.homedir(), '.claude', 'sessions'));
  });

  it('CodexProvider sessions dir points to ~/.codex/sessions', () => {
    const p = new CodexProvider();
    assert.equal(p.getSessionsDir(), path.join(os.homedir(), '.codex', 'sessions'));
  });

  it('ClaudeProvider has 12 hook events', () => {
    const p = new ClaudeProvider();
    assert.equal(p.getHookEvents().length, 12);
  });

  it('CodexProvider has 5 hook events', () => {
    const p = new CodexProvider();
    assert.equal(p.getHookEvents().length, 5);
  });

  it('ClaudeProvider config dir is .claude', () => {
    const p = new ClaudeProvider();
    assert.equal(p.getConfigDirName(), '.claude');
  });

  it('CodexProvider config dir is .codex', () => {
    const p = new CodexProvider();
    assert.equal(p.getConfigDirName(), '.codex');
  });

  it('ClaudeProvider parseUsageRecord extracts Claude usage', () => {
    const p = new ClaudeProvider();
    const record = {
      timestamp: '2026-04-10T12:00:00Z',
      message: {
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      },
    };
    const result = p.parseUsageRecord(record);
    assert.ok(result);
    assert.equal(result.input, 100);
    assert.equal(result.output, 50);
    assert.equal(result.cacheRead, 10);
    assert.equal(result.cacheCreate, 5);
    assert.equal(result.model, 'claude-sonnet-4-5');
  });

  it('CodexProvider parseUsageRecord extracts OpenAI usage', () => {
    const p = new CodexProvider();
    const record = {
      timestamp: '2026-04-10T12:00:00Z',
      model: 'o4-mini',
      usage: { prompt_tokens: 200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 20 } },
    };
    const result = p.parseUsageRecord(record);
    assert.ok(result);
    assert.equal(result.input, 200);
    assert.equal(result.output, 80);
    assert.equal(result.cacheRead, 20);
    assert.equal(result.model, 'o4-mini');
  });

  it('ClaudeProvider token pricing includes opus and sonnet', () => {
    const p = new ClaudeProvider();
    const pricing = p.getTokenPricing();
    assert.ok(pricing['claude-opus-4-6']);
    assert.ok(pricing['claude-sonnet-4-5']);
  });

  it('CodexProvider token pricing includes o4-mini and gpt-4.1', () => {
    const p = new CodexProvider();
    const pricing = p.getTokenPricing();
    assert.ok(pricing['o4-mini']);
    assert.ok(pricing['gpt-4.1']);
  });
});

describe('Registry', () => {
  it('createProvider creates correct instances', () => {
    assert.equal(createProvider('claude').name, 'claude');
    assert.equal(createProvider('codex').name, 'codex');
  });

  it('createProvider throws for unknown provider', () => {
    assert.throws(() => createProvider('unknown'), /Unknown provider/);
  });

  it('listProviders returns both', () => {
    const names = listProviders();
    assert.ok(names.includes('claude'));
    assert.ok(names.includes('codex'));
  });

  it('detectProvider returns a valid provider for auto', () => {
    const p = detectProvider({ provider: 'auto', projectRoot: '/tmp/nonexistent-' + Date.now() });
    assert.ok(['claude', 'codex'].includes(p.name), `Expected claude or codex, got ${p.name}`);
  });

  it('detectProvider respects explicit provider', () => {
    assert.equal(detectProvider({ provider: 'codex' }).name, 'codex');
    assert.equal(detectProvider({ provider: 'claude' }).name, 'claude');
  });
});

describe('ClaudeProvider file security', () => {
  it('allows .md files in .claude/', () => {
    const p = new ClaudeProvider();
    assert.ok(p.isFileReadAllowed('/project/.claude/rules/test.md'));
  });

  it('allows CLAUDE.md', () => {
    const p = new ClaudeProvider();
    assert.ok(p.isFileReadAllowed('/project/CLAUDE.md'));
  });

  it('rejects non-.md files', () => {
    const p = new ClaudeProvider();
    assert.equal(p.isFileReadAllowed('/project/.claude/settings.json'), false);
  });

  it('rejects .md files outside .claude/', () => {
    const p = new ClaudeProvider();
    assert.equal(p.isFileReadAllowed('/project/src/readme.md'), false);
  });
});
