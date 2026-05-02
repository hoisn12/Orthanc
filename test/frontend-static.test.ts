import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('frontend token filters', () => {
  it('does not show unsupported tool filtering controls for token usage', () => {
    const appJs = fs.readFileSync('public/app.js', 'utf8');
    assert.equal(appJs.includes('data-filter="tool"'), false);
    assert.equal(appJs.includes('state.tokenFilter.tool'), false);
  });
});
