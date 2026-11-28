import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../api/worker.js';
import { handleHealth, healthRateLimited, HEALTH_DB_TIMEOUT_MS, HEALTH_RATE_PER_MINUTE } from '../api/health.js';

const dbOk = { prepare: () => ({ first: async () => ({ ok: 1 }) }) };
const dbDown = { prepare: () => ({ first: async () => { throw new Error('secret internal detail D1_ERROR'); } }) };
const dbHangs = { prepare: () => ({ first: () => new Promise(() => {}) }) };
const call = (path, init, env) => worker.fetch(new Request('https://ride.incitat.io' + path, init), env, { waitUntil() {} });
const ip = (n) => ({ headers: { 'CF-Connecting-IP': `203.0.113.${n}` } });

test('GET /health: 200 and exactly app, ok, version, db', async () => {
  const res = await call('/health', ip(1), { RIDE_TRIP_PLANNER_DB: dbOk });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['app', 'db', 'ok', 'version']);
  assert.equal(body.app, 'ride');
  assert.equal(body.ok, true);
  assert.equal(body.db, 'ok');
  assert.match(body.version, /^\d{4}-\d{2}-\d{2}T\d{2}$/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Set-Cookie'), null);
});

test('database error: 503, db down, and no error text in the reply', async () => {
  const res = await call('/health', ip(2), { RIDE_TRIP_PLANNER_DB: dbDown });
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.ok(!/secret|D1_ERROR|internal/i.test(text), text);
  const body = JSON.parse(text);
  assert.equal(body.db, 'down');
  assert.equal(body.ok, false);
  assert.deepEqual(Object.keys(body).sort(), ['app', 'db', 'ok', 'version']);
});

test('slow database: gives up at the timeout with 503 instead of hanging', async () => {
  assert.equal(HEALTH_DB_TIMEOUT_MS, 2000);
  const started = Date.now();
  const res = await handleHealth(new Request('https://ride.incitat.io/health', ip(3)), { RIDE_TRIP_PLANNER_DB: dbHangs }, { version: 'v', timeoutMs: 40 });
  assert.equal(res.status, 503);
  assert.ok(Date.now() - started < 1000);
});

test('HEAD answers with the status and no body; POST is 405 with Allow', async () => {
  const head = await call('/health', { method: 'HEAD', ...ip(4) }, { RIDE_TRIP_PLANNER_DB: dbOk });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await call('/health', { method: 'POST', ...ip(4) }, { RIDE_TRIP_PLANNER_DB: dbOk });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
});

test('limiter: one client over the minute limit gets 429 with Retry-After; others are fine', async () => {
  const store = new Map();
  const make = (n) => new Request('https://ride.incitat.io/health', ip(n));
  for (let i = 0; i < HEALTH_RATE_PER_MINUTE; i += 1) {
    assert.equal((await handleHealth(make(50), { RIDE_TRIP_PLANNER_DB: dbOk }, { version: 'v', store })).status, 200);
  }
  const limited = await handleHealth(make(50), { RIDE_TRIP_PLANNER_DB: dbOk }, { version: 'v', store });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
  assert.equal((await handleHealth(make(51), { RIDE_TRIP_PLANNER_DB: dbOk }, { version: 'v', store })).status, 200);
});

test('limiter window rolls over after a minute', () => {
  const store = new Map();
  for (let i = 0; i <= HEALTH_RATE_PER_MINUTE; i += 1) healthRateLimited('c', 1000, store);
  assert.equal(healthRateLimited('c', 1000, store), true);
  assert.equal(healthRateLimited('c', 1000 + 61_000, store), false);
});

test('fail open: a broken limiter store never turns into an error, /health still answers', async () => {
  const brokenStore = { get() { throw new Error('boom'); }, set() { throw new Error('boom'); }, size: 0 };
  assert.equal(healthRateLimited('x', 1, brokenStore), false);
  const res = await handleHealth(new Request('https://ride.incitat.io/health', ip(6)), { RIDE_TRIP_PLANNER_DB: dbOk }, { version: 'v', store: brokenStore });
  assert.equal(res.status, 200);
});

test('/api/_deploy marker follows the deploy stamp, not a stale date', async () => {
  const res = await call('/api/_deploy', {}, { RIDE_TRIP_PLANNER_DB: dbOk });
  const body = await res.json();
  assert.match(body.marker, /^deploy-marker:\d{4}-\d{2}-\d{2}T\d{2}$/);
  assert.ok(!body.marker.includes('2025-12-27'));
});

test('405 and 429 bodies carry the app name and ok:false only (Argus reads 429 as rate limited, not down)', async () => {
  const post = await call('/health', { method: 'POST', ...ip(70) }, { RIDE_TRIP_PLANNER_DB: dbOk });
  assert.deepEqual(await post.json(), { app: 'ride', ok: false });
  const store = new Map();
  const make = () => new Request('https://ride.incitat.io/health', ip(71));
  for (let i = 0; i < HEALTH_RATE_PER_MINUTE; i += 1) await handleHealth(make(), { RIDE_TRIP_PLANNER_DB: dbOk }, { version: 'v', store });
  const limited = await handleHealth(make(), { RIDE_TRIP_PLANNER_DB: dbOk }, { version: 'v', store });
  assert.deepEqual(await limited.json(), { app: 'ride', ok: false });
});

test('missing binding, missing env, a throw inside prepare, a null row and ok:0 all give 503 down, never a 500', async () => {
  const req = (n) => new Request('https://ride.incitat.io/health', ip(n));
  const cases = [
    {},
    undefined,
    { RIDE_TRIP_PLANNER_DB: { prepare: () => { throw new Error('sync boom'); } } },
    { RIDE_TRIP_PLANNER_DB: { prepare: () => ({ first: async () => null }) } },
    { RIDE_TRIP_PLANNER_DB: { prepare: () => ({ first: async () => ({ ok: 0 }) }) } }
  ];
  for (const [index, env] of cases.entries()) {
    const res = await handleHealth(req(80 + index), env, { version: 'v', store: new Map() });
    assert.equal(res.status, 503, 'case ' + index);
    assert.equal((await res.json()).db, 'down');
  }
});
