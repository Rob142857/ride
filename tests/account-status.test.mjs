// Account-status path: display normaliser + the requireAuth access gate. Run: npm run test:api
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdminStatus } from '../api/auth.js';
import { requireAuth } from '../api/utils.js';

test('normalizeAdminStatus: known values and legacy aliases', () => {
  assert.equal(normalizeAdminStatus('active'), 'active');
  assert.equal(normalizeAdminStatus('paused'), 'paused');
  assert.equal(normalizeAdminStatus('blocked'), 'blocked');
  assert.equal(normalizeAdminStatus('suspended'), 'paused');
  assert.equal(normalizeAdminStatus('banned'), 'blocked');
});

test('normalizeAdminStatus: unknown or missing is never shown as active', () => {
  for (const v of ['inactive', 'Blocked ', '', null, undefined, 'xyz']) {
    assert.equal(normalizeAdminStatus(v), 'unknown', String(v));
  }
});

// Minimal fake bindings: one session in KV, one user row in D1.
function ctx(status, { noRow = false, dbThrows = false } = {}) {
  const env = {
    RIDE_TRIP_PLANNER_SESSIONS: { get: async () => ({ user: { id: 'u1' }, expiresAt: Date.now() + 60000 }), delete: async () => {} },
    RIDE_TRIP_PLANNER_DB: { prepare: () => ({ bind: () => ({ first: async () => { if (dbThrows) throw new Error('no column'); return noRow ? null : { status }; } }) }) },
  };
  const request = new Request('https://ride.incitat.io/api/trips', { headers: { Authorization: 'Bearer tok' } });
  return { request, env };
}

test('gate: active user passes', async () => {
  const c = ctx('active');
  assert.equal(await requireAuth(c), undefined);
  assert.equal(c.user.id, 'u1');
});

for (const s of ['blocked', 'banned']) {
  test(`gate: ${s} user is refused 403`, async () => {
    const r = await requireAuth(ctx(s));
    assert.equal(r.status, 403);
  });
}

for (const s of ['paused', 'suspended']) {
  test(`gate: ${s} user is refused 403`, async () => {
    const r = await requireAuth(ctx(s));
    assert.equal(r.status, 403);
  });
}

test('gate: no token is 401; missing user row passes', async () => {
  const c = ctx('active');
  c.request = new Request('https://ride.incitat.io/api/trips');
  assert.equal((await requireAuth(c)).status, 401);
  assert.equal(await requireAuth(ctx(null, { noRow: true })), undefined);
});

for (const s of ['inactive', 'Active', 'active ', '', null, 'xyz']) {
  test(`gate: unrecognised status ${JSON.stringify(s)} is refused 403 (fail closed)`, async () => {
    const r = await requireAuth(ctx(s));
    assert.equal(r.status, 403);
  });
}

test('gate: database error fails closed with 503', async () => {
  const r = await requireAuth(ctx(null, { dbThrows: true }));
  assert.equal(r.status, 503);
});
