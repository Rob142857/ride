// PAT/MCP gate (verifyPat) and optionalAuth: only 'active' accounts act as themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPat, generateTokenSecret, sha256Hex } from '../api/api-tokens.js';
import { optionalAuth } from '../api/utils.js';

async function patEnv(status, { hasStatusColumn = true } = {}) {
  const secret = generateTokenSecret();
  const hash = await sha256Hex(secret);
  const tokenRow = { id: 't1', user_id: 'u1', token_hash: hash, scopes: '["mcp.connect"]', expires_at: new Date(Date.now() + 86400000).toISOString(), revoked_at: null };
  const user = hasStatusColumn ? { id: 'u1', status } : { id: 'u1' };
  const env = { RIDE_TRIP_PLANNER_DB: { prepare: (sql) => ({ bind: () => ({ first: async () => (/api_tokens/.test(sql) ? tokenRow : user) }) }) } };
  return { env, secret };
}

test('verifyPat: active owner is accepted with scopes', async () => {
  const { env, secret } = await patEnv('active');
  const r = await verifyPat(env, secret);
  assert.equal(r.status, undefined);
  assert.deepEqual(r.scopes, ['mcp.connect']);
});

for (const s of ['blocked', 'banned', 'paused', 'suspended', 'inactive', 'Active', '']) {
  test(`verifyPat: owner status ${JSON.stringify(s)} is refused 403`, async () => {
    const { env, secret } = await patEnv(s);
    assert.equal((await verifyPat(env, secret)).status, 403);
  });
}

test('verifyPat: old database without a status column still works; bad token 401', async () => {
  const { env, secret } = await patEnv(null, { hasStatusColumn: false });
  assert.equal((await verifyPat(env, secret)).status, undefined);
  assert.equal((await verifyPat(env, 'ride_pat_short')).status, 401);
});

function optCtx(status, { dbThrows = false, noRow = false } = {}) {
  return {
    request: new Request('https://ride.incitat.io/api/attachments/a1', { headers: { Cookie: 'ride_session=tok' } }),
    env: {
      RIDE_TRIP_PLANNER_SESSIONS: { get: async () => ({ user: { id: 'u1' }, expiresAt: Date.now() + 60000 }) },
      RIDE_TRIP_PLANNER_DB: { prepare: () => ({ bind: () => ({ first: async () => { if (dbThrows) throw new Error('db'); return noRow ? null : { status }; } }) }) },
    },
  };
}

test('optionalAuth: active user is recognised', async () => {
  const c = optCtx('active');
  await optionalAuth(c);
  assert.equal(c.user.id, 'u1');
});

for (const s of ['blocked', 'paused', 'banned', 'suspended', 'inactive']) {
  test(`optionalAuth: ${s} user is treated as anonymous`, async () => {
    const c = optCtx(s);
    await optionalAuth(c);
    assert.equal(c.user, null);
  });
}

test('optionalAuth: database error is anonymous (fail closed)', async () => {
  const c = optCtx(null, { dbThrows: true });
  await optionalAuth(c);
  assert.equal(c.user, null);
});
