// MCP endpoint limits and gates: per-minute, per-hour and write-per-minute caps, body cap, scope and auth gates.
// Invented tokens and a fake database; nothing real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest, readBounded, CALLS_PER_HOUR, WRITES_PER_MINUTE, MAX_MCP_REQUEST_BYTES, HOURLY_RETRY_AFTER_S } from '../api/mcp.js';
import { generateTokenSecret, sha256Hex, RATE_LIMIT_PER_MINUTE } from '../api/api-tokens.js';

async function setup({ scopes = ['mcp.connect', 'waypoints.write'], minuteStart = 0, writeStart = 0, hour = 0 } = {}) {
  const secret = generateTokenSecret();
  const hash = await sha256Hex(secret);
  const tokenRow = { id: 't1', user_id: 'u1', token_hash: hash, scopes: JSON.stringify(scopes), expires_at: new Date(Date.now() + 86400000).toISOString(), revoked_at: null };
  const counts = { t1: minuteStart, 't1:write': writeStart };
  const audits = [];
  const stmt = (sql) => ({
    bind: (...args) => ({
      first: async () => {
        if (/FROM api_tokens/.test(sql)) return tokenRow;
        if (/FROM users/.test(sql)) return { id: 'u1', status: 'active' };
        if (/INSERT INTO api_token_rate/.test(sql)) { counts[args[0]] = (counts[args[0]] || 0) + 1; return { count: counts[args[0]] }; }
        if (/SUM\(count\)/.test(sql)) return { n: hour };
        return null;
      },
      run: async () => { if (/INSERT INTO api_token_audit/.test(sql)) audits.push(args); return {}; },
      all: async () => ({ results: [] }),
    }),
  });
  const env = { BASE_URL: 'https://ride.incitat.io', RIDE_TRIP_PLANNER_DB: { prepare: stmt } };
  const post = (body, headers = {}) => new Request('https://ride.incitat.io/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { env, post, audits, secret };
}
const ctx = { waitUntil: () => {} };
const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

test('limits are the documented ones', () => {
  assert.equal(RATE_LIMIT_PER_MINUTE, 60);
  assert.equal(CALLS_PER_HOUR, 1000);
  assert.equal(WRITES_PER_MINUTE, 20);
  assert.equal(MAX_MCP_REQUEST_BYTES, 16 * 1024 * 1024);
});

test('a normal call is accepted', async () => {
  const { env, post } = await setup();
  const res = await handleMcpRequest(post(list), env, ctx);
  assert.equal(res.status, 200);
});

test('the 61st call in a minute is refused 429 with Retry-After', async () => {
  const { env, post } = await setup({ minuteStart: RATE_LIMIT_PER_MINUTE });
  const res = await handleMcpRequest(post(list), env, ctx);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('Retry-After')) >= 1);
  assert.match((await res.json()).error.message, /Rate limit/i);
});

test('the 60th call in a minute is still accepted', async () => {
  const { env, post } = await setup({ minuteStart: RATE_LIMIT_PER_MINUTE - 1 });
  assert.equal((await handleMcpRequest(post(list), env, ctx)).status, 200);
});

test('more than 1000 calls in an hour is refused 429', async () => {
  const { env, post } = await setup({ hour: CALLS_PER_HOUR + 1 });
  const res = await handleMcpRequest(post(list), env, ctx);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), String(HOURLY_RETRY_AFTER_S), 'an hourly refusal asks for a longer wait than a minute');
});

test('exactly 1000 calls in the hour is still accepted', async () => {
  const { env, post } = await setup({ hour: CALLS_PER_HOUR });
  assert.equal((await handleMcpRequest(post(list), env, ctx)).status, 200);
});

test('a write tool over the per-minute write cap is refused 429 and the refusal is audited', async () => {
  const { env, post, audits } = await setup({ writeStart: WRITES_PER_MINUTE });
  const res = await handleMcpRequest(post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_waypoint', arguments: {} } }), env, ctx);
  assert.equal(res.status, 429);
  assert.equal(audits.length, 1);
  assert.equal(audits[0][3], 'MCP');
  assert.match(String(audits[0][4]), /delete_waypoint/);
  assert.equal(audits[0][5], 429);
});

test('a read tool is not subject to the write cap', async () => {
  const { env, post } = await setup({ writeStart: WRITES_PER_MINUTE + 5, scopes: ['mcp.connect', 'trips.read'] });
  const res = await handleMcpRequest(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_trips', arguments: {} } }), env, ctx);
  assert.equal(res.status, 200);
});

test('a body declared over the cap is refused 413 before it is read', async () => {
  const { env, post } = await setup();
  const res = await handleMcpRequest(post(list, { 'Content-Length': String(MAX_MCP_REQUEST_BYTES + 1) }), env, ctx);
  assert.equal(res.status, 413);
});

test('wrong content type 415; batch refused; bad JSON 400', async () => {
  const a = await setup();
  assert.equal((await handleMcpRequest(a.post(list, { 'Content-Type': 'text/plain' }), a.env, ctx)).status, 415);
  const b = await setup();
  assert.equal((await handleMcpRequest(b.post([list]), b.env, ctx)).status, 400);
  const c = await setup();
  assert.equal((await handleMcpRequest(c.post('{not json'), c.env, ctx)).status, 400);
});

test('no Authorization 401; a token without mcp.connect 403; a foreign Origin 403', async () => {
  const a = await setup();
  const none = new Request('https://ride.incitat.io/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) });
  assert.equal((await handleMcpRequest(none, a.env, ctx)).status, 401);
  const b = await setup({ scopes: ['trips.read'] });
  assert.equal((await handleMcpRequest(b.post(list), b.env, ctx)).status, 403);
  const c = await setup();
  assert.equal((await handleMcpRequest(c.post(list, { Origin: 'https://evil.example' }), c.env, ctx)).status, 403);
});

test('GET is refused 405', async () => {
  const { env } = await setup();
  const res = await handleMcpRequest(new Request('https://ride.incitat.io/mcp', { method: 'GET' }), env, ctx);
  assert.equal(res.status, 405);
});

test('a chunked body over the cap with no Content-Length is cut off and refused 413', async () => {
  const { env, secret } = await setup();
  const chunk = new Uint8Array(1024 * 1024).fill(32); // 1 MB of spaces
  let sent = 0;
  const stream = new ReadableStream({ pull(controller) { if (sent > MAX_MCP_REQUEST_BYTES / (1024 * 1024) + 2) { controller.close(); return; } sent += 1; controller.enqueue(chunk); } });
  const req = new Request('https://ride.incitat.io/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
  const res = await handleMcpRequest(req, env, ctx);
  assert.equal(res.status, 413);
  assert.ok(sent <= MAX_MCP_REQUEST_BYTES / (1024 * 1024) + 2, 'stopped reading early');
});

test('a body just under the cap is read in full', async () => {
  const { env, post } = await setup();
  const res = await handleMcpRequest(post(JSON.stringify({ ...list, padding: 'x'.repeat(1_000_000) })), env, ctx);
  assert.equal(res.status, 200);
});

test('readBounded: empty body, multibyte text split across chunks, and cancel on overflow', async () => {
  assert.equal(await readBounded(new Request('https://ride.incitat.io/mcp', { method: 'POST' }), 10), '');
  const bytes = new TextEncoder().encode('café ☃ ok'); // multibyte characters
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 2) c.enqueue(bytes.slice(i, i + 2)); c.close(); } });
  const req = new Request('https://ride.incitat.io/mcp', { method: 'POST', body: stream, duplex: 'half' });
  assert.equal(await readBounded(req, 1000), 'café ☃ ok');
  let cancelled = false;
  const big = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } });
  const over = new Request('https://ride.incitat.io/mcp', { method: 'POST', body: big, duplex: 'half' });
  assert.equal(await readBounded(over, 450), null);
  assert.equal(cancelled, true, 'the stream is cancelled once the cap is passed');
});

test('a body that fails mid-read gives 400, not an uncaught error', async () => {
  const { env, secret } = await setup();
  const stream = new ReadableStream({ pull(c) { c.error(new Error('client went away')); } });
  const req = new Request('https://ride.incitat.io/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' });
  const res = await handleMcpRequest(req, env, ctx);
  assert.equal(res.status, 400);
});
