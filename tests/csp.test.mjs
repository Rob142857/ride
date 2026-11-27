import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { CSP, CSP_ADMIN } from '../api/worker.js';

const directive = (policy, name) => policy.split('; ').find(d => d.startsWith(name + ' ')) || '';

test('app pages: scripts only from this origin, unpkg and the Cloudflare beacon; no inline script or handler', () => {
  const scriptSrc = directive(CSP, 'script-src');
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), scriptSrc);
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), scriptSrc);
  assert.match(directive(CSP, 'script-src-attr'), /'none'/);
  assert.match(CSP, /frame-ancestors 'none'/);
});

test('admin page keeps its own policy with inline scripts (it has inline handlers)', () => {
  assert.ok(directive(CSP_ADMIN, 'script-src').includes("'unsafe-inline'"));
  assert.match(CSP_ADMIN, /frame-ancestors 'none'/);
});

test('no public page except admin.html has an inline script block or inline event handler', () => {
  for (const file of readdirSync('public').filter(f => f.endsWith('.html') && f !== 'admin.html')) {
    const html = readFileSync('public/' + file, 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), file + ' has an inline <script>');
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), file + ' has an inline event handler');
  }
});

test('no browser script builds an inline event handler into HTML', () => {
  for (const file of readdirSync('public/js').filter(f => f.endsWith('.js'))) {
    const js = readFileSync('public/js/' + file, 'utf8');
    assert.ok(!/\son(?:click|change|submit|error|load|input|keydown|keyup)=[^ ]/i.test(js), file + ' builds an inline handler');
  }
});
