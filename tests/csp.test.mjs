import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../api/worker.js';
import { buildCsp, makeNonce } from '../api/csp.js';

const CSP = buildCsp({ nonce: makeNonce() });
const CSP_ADMIN = buildCsp({ admin: true });
const assets = { fetch: async () => new Response('<!doctype html><title>t</title>', { headers: { 'Content-Type': 'text/html' } }) };
const page = async (path) => worker.fetch(new Request('https://ride.incitat.io' + path), { ASSETS: assets, RIDE_TRIP_PLANNER_DB: {} }, { waitUntil() {} });

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

test('nonce: two responses for the same page carry different nonces, 128 bits, in the header only', async () => {
  const one = (await page('/')).headers.get('Content-Security-Policy');
  const two = (await page('/')).headers.get('Content-Security-Policy');
  const pick = (policy) => (policy.match(/'nonce-([A-Za-z0-9+/=]+)'/) || [])[1];
  assert.ok(pick(one) && pick(two), 'nonce present');
  assert.notEqual(pick(one), pick(two));
  assert.ok(pick(one).length >= 22, 'at least 128 bits of base64');
  assert.equal(new Set(Array.from({ length: 200 }, makeNonce)).size, 200);
});

test('nonce is in script-src of app pages, still no unsafe-inline or unsafe-eval there', async () => {
  const policy = (await page('/privacy')).headers.get('Content-Security-Policy');
  const scriptSrc = directive(policy, 'script-src');
  assert.match(scriptSrc, /'nonce-/);
  assert.ok(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"), scriptSrc);
  assert.match(directive(policy, 'script-src-attr'), /'none'/);
});

test('admin page gets NO nonce (a nonce would switch off its unsafe-inline) and keeps unsafe-inline', async () => {
  for (const path of ['/admin', '/admin.html']) {
    const policy = (await page(path)).headers.get('Content-Security-Policy');
    assert.ok(!policy.includes('nonce-'), policy);
    assert.ok(directive(policy, 'script-src').includes("'unsafe-inline'"));
  }
});

test('apart from the nonce, the app policy is the policy live since 28 Nov', () => {
  const withoutNonce = buildCsp({ nonce: '' });
  assert.equal(withoutNonce, "default-src 'self'; script-src 'self' https://unpkg.com https://static.cloudflareinsights.com; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://server.arcgisonline.com https://ride.incitat.io https://lh3.googleusercontent.com https://*.microsoft.com; connect-src 'self' https://ride.incitat.io https://maps.incitat.io https://unpkg.com https://events.rmesolutions.com.au; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com https://login.microsoftonline.com");
  assert.equal(buildCsp({ nonce: 'AAAA' }).replace(" 'nonce-AAAA'", ''), withoutNonce);
});

test('the shared-trip page (/<code>) also gets a fresh nonce and no unsafe-inline', async () => {
  const row = { id: 't1', name: 'Invented loop', description: 'x', public_title: null, public_description: null, cover_image_url: null, cover_focus_x: 50, cover_focus_y: 50, waypoint_count: 3, cover_attachment_id: null, distance: 100000 };
  const db = { prepare: () => ({ bind: () => ({ first: async () => row, run: async () => ({}), all: async () => ({ results: [] }) }), first: async () => row, run: async () => ({}) }) };
  const env = { ASSETS: { fetch: async () => new Response('<!doctype html><meta name="description" content="x"><title>t</title>', { headers: { 'Content-Type': 'text/html' } }) }, RIDE_TRIP_PLANNER_DB: db };
  const get = () => worker.fetch(new Request('https://ride.incitat.io/abc123'), env, { waitUntil() {} });
  const first = await get();
  assert.match(await first.text(), /Invented loop/, 'the share-page branch ran (meta injected)');
  const a = first.headers.get('Content-Security-Policy');
  const b = (await get()).headers.get('Content-Security-Policy');
  assert.match(a, /'nonce-[A-Za-z0-9+/=]+'/);
  assert.notEqual(a, b);
  assert.ok(!directive(a, 'script-src').includes("'unsafe-inline'"));
});
