import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeProvider } from '../src/providers/claude-provider.js';

const provider = new ClaudeProvider();
let fixtureRoot: string;

before(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orthanc-test-'));
  const claudeDir = path.join(fixtureRoot, '.claude');

  // skills
  const skillDir = path.join(claudeDir, 'skills', 'test-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\ndescription: A test skill\nuser_invocable: true\n---\n# Test Skill\nBody.',
  );

  // agents
  const agentsDir = path.join(claudeDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'helper.md'), '---\ndescription: helper agent\n---\n# Helper');

  // rules
  const rulesDir = path.join(claudeDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'style.md'), '# Style rule\nUse 2-space indent.');

  // settings.json (hooks + env)
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo pre' }] }],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo post' }] }],
      },
      env: { MY_VAR: 'hello', ANOTHER: 'world' },
    }),
  );

  // CLAUDE.md
  fs.writeFileSync(path.join(fixtureRoot, 'CLAUDE.md'), '# Test Project\nInstructions here.');
});

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('parseProjectConfig', () => {
  it('parses skills', () => {
    const config = provider.parseProjectConfig(fixtureRoot);
    assert.ok(config.skills.length >= 1, `Expected 1+ skills, got ${config.skills.length}`);

    const testSkill = config.skills.find((s) => s.name === 'test-skill');
    assert.ok(testSkill, 'test-skill should exist');
    assert.equal(testSkill.active, true);
  });

  it('parses agents', () => {
    const config = provider.parseProjectConfig(fixtureRoot);
    assert.ok(config.agents.length >= 1, 'Should have at least 1 agent');

    const names = config.agents.map((a) => a.name);
    assert.ok(names.includes('helper'), 'helper agent should exist');
  });

  it('parses rules', () => {
    const config = provider.parseProjectConfig(fixtureRoot);
    assert.ok(config.rules.length >= 1, `Expected 1+ rules, got ${config.rules.length}`);
  });

  it('parses hooks from settings.json', () => {
    const config = provider.parseProjectConfig(fixtureRoot);
    assert.ok(config.hooks.PreToolUse, 'Should have PreToolUse hooks');
    assert.ok(config.hooks.PostToolUse, 'Should have PostToolUse hooks');
  });

  it('parses env vars', () => {
    const config = provider.parseProjectConfig(fixtureRoot);
    assert.equal(config.env.MY_VAR, 'hello');
    assert.equal(config.env.ANOTHER, 'world');
  });
});
