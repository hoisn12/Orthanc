import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('frontend token filters', () => {
  it('does not show unsupported tool filtering controls for token usage', () => {
    const appJs = fs.readFileSync('public/app.js', 'utf8');
    assert.equal(appJs.includes('data-filter="tool"'), false);
    assert.equal(appJs.includes('state.tokenFilter.tool'), false);
  });

  it('hides export controls when analytics reuses the token filter bar', () => {
    const appJs = fs.readFileSync('public/app.js', 'utf8');
    assert.match(appJs, /function renderDateFilter\(\{ showExport = true \} = \{\}\)/);
    assert.match(appJs, /renderDateFilter\(\{ showExport: false \}\)/);
  });

  it('guards analytics fetches against stale responses', () => {
    const appJs = fs.readFileSync('public/app.js', 'utf8');
    assert.match(appJs, /analyticsRequestId: 0/);
    assert.match(appJs, /const requestId = \+\+state\.analyticsRequestId/);
    assert.match(appJs, /if \(requestId !== state\.analyticsRequestId\) return/);
  });
});
