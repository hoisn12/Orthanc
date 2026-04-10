import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectConfig } from '../src/config-parser.js';
import path from 'node:path';

const PROJECT_ROOT = '/Users/hongyeolchae/skelterlabs/project/DoosanElectronics/chatClient';

describe('parseProjectConfig', () => {
  it('parses skills from chatClient', () => {
    const config = parseProjectConfig(PROJECT_ROOT);
    assert.ok(config.skills.length >= 8, `Expected 8+ skills, got ${config.skills.length}`);

    const bugfix = config.skills.find((s) => s.name === 'bugfix');
    assert.ok(bugfix, 'bugfix skill should exist');
    assert.equal(bugfix.active, true);

    const apiChangelog = config.skills.find((s) => s.name === 'api-changelog');
    assert.ok(apiChangelog, 'api-changelog skill should exist');
  });

  it('parses agents', () => {
    const config = parseProjectConfig(PROJECT_ROOT);
    assert.ok(config.agents.length >= 1, 'Should have at least 1 agent');

    const names = config.agents.map((a) => a.name);
    assert.ok(names.includes('api-designer'), 'api-designer should exist');
  });

  it('parses rules', () => {
    const config = parseProjectConfig(PROJECT_ROOT);
    assert.ok(config.rules.length >= 12, `Expected 12+ rules, got ${config.rules.length}`);
  });

  it('parses hooks from settings.json', () => {
    const config = parseProjectConfig(PROJECT_ROOT);
    assert.ok(config.hooks.PreToolUse, 'Should have PreToolUse hooks');
    assert.ok(config.hooks.PostToolUse, 'Should have PostToolUse hooks');
  });

  it('parses env vars', () => {
    const config = parseProjectConfig(PROJECT_ROOT);
    assert.equal(config.env.TICKET_SYSTEM, 'jira');
    assert.equal(config.env.CREATE_TICKET_BEFORE_ACT, 'true');
  });
});
