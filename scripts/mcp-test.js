/**
 * MCP server (phase 1): protocol (2026-07-28 stateless and the legacy
 * initialize era), auth with personal access tokens and the opt-in
 * mcp.connect scope, scope-filtered tools, every tool's happy path, stale
 * expected_version, audit, rate limits and the MCP_ENABLED switch.
 *
 * Runs the real Worker (api/worker.js) against in-memory SQLite built from the
 * real schema and migrations, with the production version-bump triggers.
 * All fixtures are invented. Run: node scripts/mcp-test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '..');
const ORIGIN = 'https://ride.incitat.io';
const MODERN = '2026-07-28';

function d1(db) {
  const statement = (sql) => {
    const stmt = {
      values: [],
      bind(...values) { stmt.values = values; return stmt; },
      async first() { return db.prepare(sql).get(...stmt.values) ?? null; },
      async all() { return { results: db.prepare(sql).all(...stmt.values) }; },
      async run() { const r = db.prepare(sql).run(...stmt.values); return { meta: { changes: Number(r.changes) } }; }
    };
    return stmt;
  };
  return {
    prepare: statement,
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = []; for (const s of statements) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}

function kv() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const value = map.has(key) ? map.get(key) : null;
      return value !== null && type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { map.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { map.delete(key); }
  };
}

/** Real schema_v2 plus the migrations a fresh database needs, as on D1. */
function buildDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(repo, 'api/schema_v2.sql'), 'utf8'));
  db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  for (const file of ['2026-06-13_alternative_routes.sql', '2026-06-14_active_route_index.sql', '2026-06-18_ride_logs.sql',
    '2026-10-17_saved_places.sql', '2026-10-17_tokens_fuel_checkins.sql']) {
    db.exec(fs.readFileSync(path.join(repo, 'api/migrations', file), 'utf8'));
  }
  // 2026-06-18_route_steps.sql adds steps to route_data (already in schema_v2) and alternative_routes.
  db.exec("ALTER TABLE alternative_routes ADD COLUMN steps TEXT DEFAULT '[]'");
  db.exec(`
    INSERT INTO users (id, email, name, provider, provider_id) VALUES
      ('owner', 'owner@example.test', 'Owner Example', 'google', 'g-owner'),
      ('other', 'other@example.test', 'Other Example', 'microsoft', 'm-other'),
      ('paused', 'paused@example.test', 'Paused Example', 'google', 'g-paused');
    UPDATE users SET status = 'paused' WHERE id = 'paused';
  `);
  return db;
}

async function seed(db, RideItinerary) {
  const plan = RideItinerary.recalculate({
    version: 1, startDate: '2026-03-02', fuel: { litresPer100Km: 10, pricePerLitre: 2.5 },
    fuelPlan: { tankLitres: 80, jerryLitres: 20 },
    stops: [
      { id: 'alpha', name: 'Alpha Creek', waypointId: 'wp-a', minNights: 1, plannedNights: 2, maxNights: 4 },
      { id: 'beta', name: 'Beta Flats', waypointId: 'wp-b', minNights: 1, plannedNights: 2, maxNights: 3, leg: { distanceKm: 240, durationHours: 3 } },
      { id: 'gamma', name: 'Gamma Point', waypointId: 'wp-c', minNights: 0, plannedNights: 0, maxNights: 1, leg: { distanceKm: 120, durationHours: 1.5 } }
    ]
  }).itinerary;
  db.prepare(`INSERT INTO trips (id, user_id, name, description, settings, short_code) VALUES
    ('trip-1', 'owner', 'Invented loop', 'A made-up trip', ?, 'abc123'),
    ('trip-2', 'other', 'Someone else', '', '{}', 'xyz789')`).run(JSON.stringify({ itinerary: plan, keep: 'me' }));
  db.exec(`INSERT INTO waypoints (id, trip_id, name, lat, lng, sort_order, type) VALUES
    ('wp-a', 'trip-1', 'Alpha Creek', -31.1, 150.1, 0, 'stop'), ('wp-b', 'trip-1', 'Beta Flats', -31.5, 150.5, 1, 'lodging'),
    ('wp-c', 'trip-1', 'Gamma Point', -31.9, 150.9, 2, 'scenic'), ('wp-x', 'trip-2', 'Elsewhere', -33.1, 151.1, 0, 'stop');
    INSERT INTO journal_entries (id, trip_id, title, content, is_private) VALUES ('note-1', 'trip-1', 'Day one', 'Invented note', 1);
    INSERT INTO route_data (id, trip_id, coordinates, steps, distance, duration) VALUES ('route-1', 'trip-1', '[]', '[]', 360000, 16200);`);
  const track = Array.from({ length: 2500 }, (_, i) => ({ lat: -31.1 - i * 0.0001, lng: 150.1 + i * 0.0001, t: 1772400000000 + i * 1000 }));
  db.prepare(`INSERT INTO ride_logs (id, trip_id, started_at, ended_at, distance_meters, duration_seconds, track) VALUES
    ('log-1', 'trip-1', '2026-03-02T00:00:00Z', '2026-03-02T00:41:39Z', 42500, 2499, ?)`).run(JSON.stringify(track));
  db.prepare(`INSERT INTO saved_places (id, user_id, name, type, lat, lng, tags) VALUES
    ('place-1', 'owner', 'Quiet camp', 'campsite', -31.11, 150.11, '["free"]'),
    ('place-2', 'owner', 'Far shower', 'shower', -35.0, 149.0, '[]'),
    ('place-x', 'other', 'Not yours', 'food', -31.11, 150.11, '[]')`).run();
  return plan;
}

const sessions = {
  'owner-session': { user: { id: 'owner', email: 'owner@example.test' }, expiresAt: Date.now() + 600000 },
  'paused-session': { user: { id: 'paused' }, expiresAt: Date.now() + 600000 }
};

const ALL_SCOPES = ['trips:read', 'itinerary:write', 'waypoints:rw', 'places:rw', 'fuel:rw', 'checkins:rw', 'ridelogs:read', 'journal:write', 'account.read', 'mcp.connect'];

let worker, mcpTools, schema, db, env, plan, sessionsKv;
const responses = []; // every JSON-RPC body seen, for the error-code policy check
const tokens = {};

async function http(method, pathName, { headers = {}, body, environment = env } = {}) {
  const response = await worker.fetch(new Request(`${ORIGIN}${pathName}`, {
    method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  }), environment, { waitUntil() {} });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (json) responses.push(json);
  return { status: response.status, headers: response.headers, json, text };
}

function modernHeaders(method, name, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method };
  if (name !== undefined) headers['Mcp-Name'] = name;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

const META = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'mcp-test', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
let nextId = 1;

/** A modern (2026-07-28) request. */
async function rpc(method, params = {}, { token = tokens.all, headers = {}, id = nextId++, meta = META, environment } = {}) {
  const name = method === 'tools/call' ? params.name : undefined;
  const body = { jsonrpc: '2.0', id, method, params: meta === null ? params : { ...params, _meta: meta } };
  return http('POST', '/mcp', { headers: { ...modernHeaders(method, name, token), ...headers }, body, environment });
}

async function callTool(name, args = {}, opts = {}) {
  const res = await rpc('tools/call', { name, arguments: args }, opts);
  return res;
}

/** Call a tool that must succeed; checks structuredContent against the tool's outputSchema. */
async function ok(name, args = {}, opts = {}) {
  const res = await callTool(name, args, opts);
  assert.equal(res.status, 200, `${name}: HTTP ${res.status} ${res.text}`);
  const result = res.json.result;
  assert.ok(result, `${name}: result expected, got ${res.text}`);
  assert.equal(result.isError, false, `${name}: ${result.content?.[0]?.text}`);
  assert.equal(result.resultType, 'complete');
  assert.equal(result.content[0].type, 'text');
  const tool = mcpTools.findTool(name);
  const problems = schema.validateSchema(tool.outputSchema, result.structuredContent, 'structuredContent');
  assert.deepEqual(problems, [], `${name}: structuredContent matches outputSchema`);
  return result.structuredContent;
}

async function toolError(name, args = {}, opts = {}) {
  const res = await callTool(name, args, opts);
  assert.equal(res.status, 200, `${name}: HTTP ${res.status} ${res.text}`);
  assert.equal(res.json.result?.isError, true, `${name}: expected a tool error, got ${res.text}`);
  assert.equal(res.json.result.structuredContent, undefined, 'tool errors carry no structuredContent');
  return res.json.result;
}

const version = (id = 'trip-1') => db.prepare('SELECT version FROM trips WHERE id = ?').get(id).version;
const count = (sql, ...v) => db.prepare(sql).get(...v).n;

async function createToken(scopes, name = 'Invented agent', cookie = 'owner-session') {
  const res = await http('POST', '/api/tokens', {
    headers: { Cookie: `ride_session=${cookie}`, 'Content-Type': 'application/json' },
    body: { name, scopes, expires_in_days: 7 }
  });
  assert.equal(res.status, 201, res.text);
  return res.json.secret;
}

test.before(async () => {
  ({ default: worker } = await import('../api/worker.js'));
  mcpTools = await import('../api/mcp-tools.js');
  schema = await import('../api/mcp-schema.js');
  const { RideItinerary } = await import('../api/itinerary-plan.js');
  db = buildDatabase();
  plan = await seed(db, RideItinerary);
  sessionsKv = kv();
  for (const [key, value] of Object.entries(sessions)) sessionsKv.map.set(key, JSON.stringify(value));
  env = {
    RIDE_TRIP_PLANNER_DB: d1(db),
    RIDE_TRIP_PLANNER_SESSIONS: sessionsKv,
    RIDE_TRIP_PLANNER_ATTACHMENTS: { async delete() {}, async get() { return null; } },
    ASSETS: { async fetch() { return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } }); } },
    BASE_URL: ORIGIN,
    MCP_ENABLED: 'true'
  };
  tokens.all = await createToken(ALL_SCOPES, 'Everything');
  tokens.readOnly = await createToken(['trips:read', 'mcp.connect'], 'Trips reader');
  tokens.noMcp = await createToken(['trips:read', 'fuel:rw'], 'REST only');
  tokens.placesOnly = await createToken(['places:rw', 'mcp.connect'], 'Places alias');
  tokens.other = await createToken(['trips:read', 'itinerary:write', 'waypoints:rw', 'mcp.connect'], 'Second agent', 'owner-session');
});

// Each test starts with fresh per-minute counters (the suite makes far more than 60 calls).
test.beforeEach(() => { if (db) db.exec('DELETE FROM api_token_rate'); });

// ------------------------------------------------------------------ switch and transport
test('MCP_ENABLED off (default) leaves /mcp a plain 404, exactly as before', async () => {
  for (const value of [undefined, 'false', '0', '']) {
    const environment = { ...env, MCP_ENABLED: value };
    const res = await http('POST', '/mcp', { headers: modernHeaders('server/discover', undefined, tokens.all), body: { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META } }, environment });
    assert.equal(res.status, 404);
    assert.equal(res.text, 'Not Found', 'falls through to static assets');
    assert.equal((await http('GET', '/mcp', { environment })).status, 404);
  }
  assert.equal((await rpc('server/discover')).status, 200, 'on when MCP_ENABLED is "true"');
});

test('only POST: GET, DELETE, PUT and OPTIONS get 405 with Allow: POST', async () => {
  for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
    const res = await http(method, '/mcp', { headers: { Authorization: `Bearer ${tokens.all}`, 'Mcp-Session-Id': 'ignored' } });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('Allow'), 'POST');
    assert.equal(res.headers.get('Mcp-Session-Id'), null);
  }
});

test('Origin and Host checks (DNS rebinding)', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META } };
  const bad = await http('POST', '/mcp', { headers: { ...modernHeaders('server/discover', undefined, tokens.all), Origin: 'https://evil.example' }, body });
  assert.equal(bad.status, 403);
  assert.equal(bad.json.error.code, -32600);
  assert.equal('id' in bad.json, false, 'origin refusal has no id');
  const own = await http('POST', '/mcp', { headers: { ...modernHeaders('server/discover', undefined, tokens.all), Origin: ORIGIN }, body });
  assert.equal(own.status, 200);
  // A request for a foreign host (rebinding) is refused even without Origin.
  const response = await worker.fetch(new Request('https://evil.example/mcp', { method: 'POST', headers: modernHeaders('server/discover', undefined, tokens.all), body: JSON.stringify(body) }), env, { waitUntil() {} });
  assert.equal(response.status, 403);
  // Loopback (wrangler dev) accepts loopback origins only.
  const local = await worker.fetch(new Request('http://127.0.0.1:8787/mcp', { method: 'POST', headers: { ...modernHeaders('server/discover', undefined, tokens.all), Origin: 'http://127.0.0.1:8787' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  assert.equal(local.status, 200);
  const localEvil = await worker.fetch(new Request('http://127.0.0.1:8787/mcp', { method: 'POST', headers: { ...modernHeaders('server/discover', undefined, tokens.all), Origin: 'http://evil.example' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  assert.equal(localEvil.status, 403);
  const localOtherPort = await worker.fetch(new Request('http://127.0.0.1:8787/mcp', { method: 'POST', headers: { ...modernHeaders('server/discover', undefined, tokens.all), Origin: 'http://localhost:18788' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  assert.equal(localOtherPort.status, 200, 'a loopback origin is fine on a loopback host');
  const prodLoopbackOrigin = await http('POST', '/mcp', { headers: { ...modernHeaders('server/discover', undefined, tokens.all), Origin: 'http://127.0.0.1:8787' }, body });
  assert.equal(prodLoopbackOrigin.status, 403, 'but not on the real host');
});

// ------------------------------------------------------------------ auth
test('no token, cookie session, session-as-bearer and junk tokens get 401', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META } };
  const none = await http('POST', '/mcp', { headers: modernHeaders('server/discover'), body });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('WWW-Authenticate'), /^Bearer realm="ride", scope="mcp\.connect trips\.read"$/);
  const cookie = await http('POST', '/mcp', { headers: { ...modernHeaders('server/discover'), Cookie: 'ride_session=owner-session' }, body });
  assert.equal(cookie.status, 401, 'a signed-in browser session never reaches /mcp');
  const sessionBearer = await http('POST', '/mcp', { headers: modernHeaders('server/discover', undefined, 'owner-session'), body });
  assert.equal(sessionBearer.status, 401);
  assert.match(sessionBearer.headers.get('WWW-Authenticate'), /error="invalid_token"/);
  const junk = await http('POST', '/mcp', { headers: modernHeaders('server/discover', undefined, 'ride_pat_' + 'A'.repeat(43)), body });
  assert.equal(junk.status, 401);
  assert.match(junk.headers.get('WWW-Authenticate'), /error="invalid_token"/);
  for (const res of [none, cookie, sessionBearer, junk]) assert.ok(res.json.error.code < -32099 || res.json.error.code > -32000);
});

test('a token without mcp.connect is refused with 403 insufficient_scope', async () => {
  const res = await rpc('server/discover', {}, { token: tokens.noMcp });
  assert.equal(res.status, 403);
  const header = res.headers.get('WWW-Authenticate');
  assert.match(header, /error="insufficient_scope"/);
  assert.match(header, /scope="trips\.read fuel\.read fuel\.write mcp\.connect"/, 'challenge names what it has plus mcp.connect');
  // The same token still works on the REST API.
  const rest = await http('GET', '/api/trips', { headers: { Authorization: `Bearer ${tokens.noMcp}` } });
  assert.equal(rest.status, 200);
});

test('access is re-checked every call: revoked, expired and paused', async () => {
  const temp = await createToken(['trips:read', 'mcp.connect'], 'Short lived');
  assert.equal((await rpc('tools/list', {}, { token: temp })).status, 200);
  const id = db.prepare("SELECT id FROM api_tokens WHERE name = 'Short lived'").get().id;
  db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);
  assert.equal((await rpc('tools/list', {}, { token: temp })).status, 401, 'expired');
  db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run('2999-01-01T00:00:00.000Z', id);
  assert.equal((await rpc('tools/list', {}, { token: temp })).status, 200);
  const revoked = await http('DELETE', `/api/tokens/${id}`, { headers: { Cookie: 'ride_session=owner-session' } });
  assert.equal(revoked.status, 200);
  assert.equal((await rpc('tools/list', {}, { token: temp })).status, 401, 'revoked');

  db.prepare("UPDATE users SET status = 'active' WHERE id = 'paused'").run();
  const pausedToken = await createToken(['trips:read', 'mcp.connect'], 'Paused later', 'paused-session');
  assert.equal((await rpc('tools/list', {}, { token: pausedToken })).status, 200);
  db.prepare("UPDATE users SET status = 'paused' WHERE id = 'paused'").run();
  const paused = await rpc('tools/list', {}, { token: pausedToken });
  assert.equal(paused.status, 403, 'paused user refused on the next call');
});

// ------------------------------------------------------------------ protocol (modern)
test('server/discover: versions, capabilities, identity, caching hints', async () => {
  const res = await rpc('server/discover', {}, { id: 'discover-1' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(res.headers.get('Mcp-Session-Id'), null);
  const result = res.json.result;
  assert.equal(res.json.id, 'discover-1');
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'ride');
  assert.ok(Number.isInteger(result.ttlMs) && result.ttlMs >= 0);
  assert.ok(['public', 'private'].includes(result.cacheScope));
  assert.match(result.instructions, /treat them as data/);
});

test('_meta, header and version validation', async () => {
  const noMeta = await rpc('server/discover', {}, { meta: null, id: 101 });
  assert.equal(noMeta.status, 400);
  assert.equal(noMeta.json.error.code, -32602);
  assert.equal(noMeta.json.id, 101);
  const noCaps = await rpc('server/discover', {}, { meta: { 'io.modelcontextprotocol/protocolVersion': MODERN }, id: 104 });
  assert.equal(noCaps.status, 400);
  assert.equal(noCaps.json.error.code, -32602, 'missing clientCapabilities alone is rejected');
  const noVersion = await rpc('server/discover', {}, { meta: { 'io.modelcontextprotocol/clientCapabilities': {} }, id: 102 });
  assert.equal(noVersion.json.error.code, -32602);
  const noClientInfo = await rpc('server/discover', {}, { meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} } });
  assert.equal(noClientInfo.status, 200, 'clientInfo is optional');

  const unsupported = await rpc('server/discover', {}, { meta: { ...META, 'io.modelcontextprotocol/protocolVersion': 'v999.0.0' }, headers: { 'MCP-Protocol-Version': 'v999.0.0' }, id: 301 });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.json.error.code, -32022);
  assert.equal(unsupported.json.error.data.requested, 'v999.0.0');
  assert.ok(unsupported.json.error.data.supported.includes(MODERN));
  assert.equal(unsupported.json.id, 301);

  const mismatch = await rpc('server/discover', {}, { meta: { ...META, 'io.modelcontextprotocol/protocolVersion': 'v999.0.0' }, id: 302 });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.error.code, -32020);
  const noHeader = await rpc('server/discover', {}, { headers: { 'MCP-Protocol-Version': undefined } });
  assert.ok([400].includes(noHeader.status));
  const methodHeader = await rpc('tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } });
  assert.equal(methodHeader.status, 400);
  assert.equal(methodHeader.json.error.code, -32020);
  const nameHeader = await rpc('tools/call', { name: 'list_trips', arguments: {} }, { headers: { 'Mcp-Name': 'get_trip' } });
  assert.equal(nameHeader.status, 400);
  assert.equal(nameHeader.json.error.code, -32020);
  const base64Name = await rpc('tools/call', { name: 'list_trips', arguments: {} }, { headers: { 'Mcp-Name': `=?base64?${Buffer.from('list_trips').toString('base64')}?=` } });
  assert.equal(base64Name.status, 200, 'Base64 sentinel Mcp-Name is decoded');
});

test('unknown and removed methods give 404 -32601 on the modern wire', async () => {
  for (const method of ['unknown/method', 'initialize', 'ping', 'logging/setLevel', 'resources/subscribe', 'resources/list', 'prompts/list']) {
    const res = await rpc(method, {}, { id: 500 });
    assert.equal(res.status, 404, method);
    assert.equal(res.json.error.code, -32601, method);
    assert.equal(res.json.id, 500);
  }
});

test('bad JSON-RPC bodies', async () => {
  const headers = modernHeaders('tools/list', undefined, tokens.all);
  assert.equal((await http('POST', '/mcp', { headers, body: '{not json' })).json.error.code, -32700);
  assert.equal((await http('POST', '/mcp', { headers, body: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }] })).status, 400);
  assert.equal((await http('POST', '/mcp', { headers, body: { jsonrpc: '1.0', id: 1, method: 'tools/list' } })).json.error.code, -32600);
  assert.equal((await http('POST', '/mcp', { headers, body: { jsonrpc: '2.0', id: null, method: 'tools/list' } })).status, 400);
  assert.equal((await http('POST', '/mcp', { headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  const note = await http('POST', '/mcp', { headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
  assert.equal(note.text, '');
});

// ------------------------------------------------------------------ protocol (legacy)
test('legacy initialize lifecycle (2025-11-25 and 2025-06-18), no session id', async () => {
  for (const legacy of ['2025-11-25', '2025-06-18']) {
    const init = await http('POST', '/mcp', {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.all}` },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: legacy, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } }
    });
    assert.equal(init.status, 200, init.text);
    assert.equal(init.json.result.protocolVersion, legacy);
    assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.json.result.serverInfo.name, 'ride');
    assert.equal(init.json.result.resultType, undefined, 'legacy results keep the legacy shape');
    assert.equal(init.headers.get('Mcp-Session-Id'), null);
    const legacyHeaders = { 'Content-Type': 'application/json', 'MCP-Protocol-Version': legacy, Authorization: `Bearer ${tokens.all}` };
    assert.equal((await http('POST', '/mcp', { headers: legacyHeaders, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
    const listed = await http('POST', '/mcp', { headers: legacyHeaders, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.equal(listed.json.result.tools.length, mcpTools.TOOLS.length);
    const called = await http('POST', '/mcp', { headers: legacyHeaders, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_trips', arguments: {} } } });
    assert.equal(called.json.result.isError, false);
    assert.equal(called.json.result.structuredContent.trips[0].id, 'trip-1');
    assert.deepEqual((await http('POST', '/mcp', { headers: legacyHeaders, body: { jsonrpc: '2.0', id: 4, method: 'ping' } })).json.result, {});
    assert.equal((await http('POST', '/mcp', { headers: legacyHeaders, body: { jsonrpc: '2.0', id: 5, method: 'server/discover' } })).json.error.code, -32601);
  }
  const unknownLegacy = await http('POST', '/mcp', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.all}` }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-01-01', capabilities: {}, clientInfo: { name: 'old', version: '1' } } } });
  assert.equal(unknownLegacy.json.result.protocolVersion, '2025-11-25', 'unknown requested version gets the newest legacy one');
});

// ------------------------------------------------------------------ tools/list
test('tools/list: schemas, annotations, caching hints, deterministic and filtered by scope', async () => {
  const first = await rpc('tools/list');
  const tools = first.json.result.tools;
  assert.equal(first.json.result.cacheScope, 'private');
  assert.ok(Number.isInteger(first.json.result.ttlMs));
  assert.equal(tools.length, 28);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z_]{1,64}$/);
    assert.ok(tool.description && tool.title);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.outputSchema.type, 'object');
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} ${hint}`);
    assert.equal(tool.annotations.openWorldHint, false);
    if (tool.annotations.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false);
  }
  for (const name of ['delete_waypoint', 'delete_fuel_fill', 'delete_checkin', 'delete_saved_place', 'apply_itinerary_update']) {
    assert.equal(tools.find(t => t.name === name).annotations.destructiveHint, true, name);
  }
  const nullable = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  assert.deepEqual(schema.validateSchema(nullable, null), []);
  assert.deepEqual(schema.validateSchema(nullable, 'x'), []);
  assert.equal(schema.validateSchema(nullable, 3).length, 1, 'the validator enforces anyOf');
  const second = await rpc('tools/list');
  assert.deepEqual(second.json.result.tools.map(t => t.name), tools.map(t => t.name), 'same order every time');

  const readOnly = await rpc('tools/list', {}, { token: tokens.readOnly });
  assert.deepEqual(readOnly.json.result.tools.map(t => t.name), ['list_trips', 'get_trip', 'list_waypoints']);
  const places = await rpc('tools/list', {}, { token: tokens.placesOnly });
  assert.deepEqual(places.json.result.tools.map(t => t.name), ['list_saved_places', 'get_saved_place', 'save_place', 'update_saved_place', 'delete_saved_place'], 'places:rw expands to places.read + places.write');
});

test('a tool outside the token scopes gets 403 insufficient_scope naming every scope needed', async () => {
  const auditBefore = count("SELECT COUNT(*) AS n FROM api_token_audit WHERE method = 'MCP' AND status = 403");
  const res = await callTool('add_waypoint', { trip_id: 'trip-1', expected_version: version(), name: 'X', lat: -30, lng: 150 }, { token: tokens.readOnly });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, -31003);
  assert.deepEqual(res.json.error.data.required_scopes, ['waypoints.write']);
  const header = res.headers.get('WWW-Authenticate');
  assert.match(header, /error="insufficient_scope"/);
  assert.match(header, /scope="trips\.read waypoints\.write mcp\.connect"/);
  assert.equal(count("SELECT COUNT(*) AS n FROM waypoints WHERE name = 'X'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM api_token_audit WHERE method = 'MCP' AND status = 403"), auditBefore + 1, 'denied call audited');
  const unknown = await callTool('drop_database', {});
  assert.equal(unknown.json.error.code, -32602);
});

// ------------------------------------------------------------------ tools: trips and waypoints
test('trips: list_trips and get_trip', async () => {
  const listed = await ok('list_trips');
  assert.deepEqual(listed.trips.map(t => t.id), ['trip-1'], 'only the owner\'s trips');
  assert.equal(listed.trips[0].waypoint_count, 3);
  assert.equal(listed.trips[0].stop_count, 3);
  assert.equal(listed.trips[0].start_date, '2026-03-02');
  assert.equal(listed.next_cursor, null);
  const paged = await ok('list_trips', { limit: 1, cursor: Buffer.from('o:1').toString('base64') });
  assert.deepEqual(paged, { trips: [], next_cursor: null }, 'past the end');
  assert.equal((await toolError('list_trips', { cursor: 'nonsense!' })).content[0].text.includes('cursor'), true);

  const trip = await ok('get_trip', { trip_id: 'trip-1' });
  assert.equal(trip.trip.version, version());
  assert.deepEqual(trip.waypoints.map(w => w.id), ['wp-a', 'wp-b', 'wp-c']);
  assert.equal(trip.itinerary.stops.length, 3);
  assert.equal(trip.journal, undefined);
  const full = await ok('get_trip', { trip_id: 'trip-1', include: ['journal', 'route_summary'] });
  assert.equal(full.journal[0].title, 'Day one');
  assert.deepEqual(full.route_summary, { distance_km: 360, duration_min: 270 });
  assert.equal(full.waypoints, undefined);
  const foreign = await toolError('get_trip', { trip_id: 'trip-2' });
  assert.match(foreign.content[0].text, /not found/i, 'another user\'s trip looks missing');
  assert.match((await toolError('get_trip', {})).content[0].text, /trip_id is required/);
  assert.match((await toolError('get_trip', { trip_id: 'trip-1', extra: 1 })).content[0].text, /not an allowed field/);
});

test('waypoints: list, add, update, reorder, delete with expected_version', async () => {
  const listed = await ok('list_waypoints', { trip_id: 'trip-1' });
  assert.equal(listed.trip_version, version());
  const readOnlyList = await ok('list_waypoints', { trip_id: 'trip-1' }, { token: tokens.readOnly });
  assert.equal(readOnlyList.waypoints.length, 3, 'trips.read also lists waypoints');

  const added = await ok('add_waypoint', { trip_id: 'trip-1', expected_version: listed.trip_version, name: 'Delta Rest', lat: -32.2, lng: 151.2, type: 'fuel', notes: 'Invented' });
  assert.equal(added.waypoint.name, 'Delta Rest');
  assert.equal(added.trip_version, version());
  const updated = await ok('update_waypoint', { trip_id: 'trip-1', expected_version: added.trip_version, waypoint_id: added.waypoint.id, name: 'Delta Rest Area' });
  assert.equal(updated.waypoint.name, 'Delta Rest Area');
  const order = [added.waypoint.id, 'wp-c', 'wp-b', 'wp-a'];
  const reordered = await ok('reorder_waypoints', { trip_id: 'trip-1', expected_version: updated.trip_version, order });
  assert.deepEqual(db.prepare("SELECT id FROM waypoints WHERE trip_id = 'trip-1' ORDER BY sort_order").all().map(r => r.id), order);
  const deleted = await ok('delete_waypoint', { trip_id: 'trip-1', expected_version: reordered.trip_version, waypoint_id: added.waypoint.id });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.warnings, []);
  assert.equal(count('SELECT COUNT(*) AS n FROM waypoints WHERE id = ?', added.waypoint.id), 0);
  await ok('reorder_waypoints', { trip_id: 'trip-1', expected_version: deleted.trip_version, order: ['wp-a', 'wp-b', 'wp-c'] });

  // Foreign or missing waypoint ids look missing and nothing is echoed.
  const foreign = await toolError('update_waypoint', { trip_id: 'trip-1', expected_version: version(), waypoint_id: 'wp-x', name: 'Hijack' });
  assert.match(foreign.content[0].text, /not found/i);
  assert.doesNotMatch(foreign.content[0].text, /Elsewhere/);
  assert.equal(db.prepare("SELECT name FROM waypoints WHERE id = 'wp-x'").get().name, 'Elsewhere');
  // The REST route behind it no longer echoes another trip's waypoint either.
  const rest = await http('PUT', '/api/trips/trip-1/waypoints/wp-x', { headers: { Authorization: `Bearer ${tokens.all}`, 'Content-Type': 'application/json', 'If-Match': String(version()) }, body: { name: 'Hijack' } });
  assert.equal(rest.status, 404);
  assert.equal(rest.text.includes('Elsewhere'), false);
  assert.match((await toolError('delete_waypoint', { trip_id: 'trip-1', expected_version: version(), waypoint_id: 'wp-x' })).content[0].text, /not found/i);
  assert.match((await toolError('update_waypoint', { trip_id: 'trip-1', expected_version: version(), waypoint_id: 'wp-a' })).content[0].text, /at least 4 fields/, 'an update needs a field to change');
  assert.match((await toolError('add_waypoint', { trip_id: 'trip-1', expected_version: version(), name: 'Bad', lat: 91, lng: 0 })).content[0].text, /lat must be at most 90/);
});

test('stale expected_version is a recoverable tool error and nothing is written', async () => {
  const before = version();
  const stale = await toolError('update_waypoint', { trip_id: 'trip-1', expected_version: before - 1, waypoint_id: 'wp-a', name: 'Renamed' });
  assert.match(stale.content[0].text, /Conflict/);
  assert.match(stale.content[0].text, /get_trip/);
  assert.deepEqual(stale._meta['io.incitat.ride/conflict'], { conflict: true, trip_version: before, trip_updated_at: db.prepare("SELECT updated_at FROM trips WHERE id = 'trip-1'").get().updated_at });
  assert.equal(db.prepare("SELECT name FROM waypoints WHERE id = 'wp-a'").get().name, 'Alpha Creek');
  for (const [name, args] of [
    ['add_waypoint', { name: 'Late', lat: -30, lng: 150 }],
    ['delete_waypoint', { waypoint_id: 'wp-c' }],
    ['reorder_waypoints', { order: ['wp-c', 'wp-b', 'wp-a'] }]
  ]) {
    const res = await toolError(name, { trip_id: 'trip-1', expected_version: before + 5, ...args });
    assert.match(res.content[0].text, /Conflict/, name);
  }
  assert.equal(version(), before, 'no stale write changed the trip');
  assert.match((await toolError('add_waypoint', { trip_id: 'trip-1', name: 'No version', lat: -30, lng: 150 })).content[0].text, /expected_version is required/);
});

// ------------------------------------------------------------------ tools: itinerary
test('itinerary: preview, apply, expired or foreign preview, conflict after a change', async () => {
  const file = { rideTripId: 'trip-1', itinerary: JSON.parse(JSON.stringify(plan)), waypoints: [{ id: 'wp-a' }, { id: 'wp-b' }, { id: 'wp-c' }] };
  file.itinerary.stops[0].plannedNights = 1;
  const before = version();
  const preview = await ok('preview_itinerary_update', { trip_id: 'trip-1', planning_file: file });
  assert.equal(preview.can_apply, true);
  assert.equal(preview.trip_version, before);
  assert.match(preview.preview_id, /^[0-9a-f]{32}$/);
  assert.equal(version(), before, 'preview never writes');
  assert.ok(preview.stop_changes.length >= 1);

  // Another token cannot use this preview handle.
  const stolen = await toolError('apply_itinerary_update', { trip_id: 'trip-1', preview_id: preview.preview_id, expected_version: before }, { token: tokens.other });
  assert.match(stolen.content[0].text, /expired or does not belong/);
  assert.match((await toolError('apply_itinerary_update', { trip_id: 'trip-1', preview_id: 'f'.repeat(32), expected_version: before })).content[0].text, /expired/);
  assert.match((await toolError('apply_itinerary_update', { trip_id: 'trip-1', preview_id: preview.preview_id, expected_version: before + 1 })).content[0].text, /trip_version/);

  const applied = await ok('apply_itinerary_update', { trip_id: 'trip-1', preview_id: preview.preview_id, expected_version: preview.trip_version });
  assert.equal(applied.trip_version, version());
  assert.ok(applied.trip_version > before);
  const saved = JSON.parse(db.prepare("SELECT settings FROM trips WHERE id = 'trip-1'").get().settings);
  assert.equal(saved.itinerary.stops[0].plannedNights, 1);
  assert.equal(saved.keep, 'me', 'other settings kept');
  assert.match((await toolError('apply_itinerary_update', { trip_id: 'trip-1', preview_id: preview.preview_id, expected_version: preview.trip_version })).content[0].text, /expired/, 'a preview applies once');

  // The trip changes between preview and apply: refused, nothing saved.
  file.itinerary = saved.itinerary;
  file.itinerary.stops[0].plannedNights = 2;
  const second = await ok('preview_itinerary_update', { trip_id: 'trip-1', planning_file: file });
  await ok('update_waypoint', { trip_id: 'trip-1', expected_version: second.trip_version, waypoint_id: 'wp-a', notes: 'moved on' });
  const conflict = await toolError('apply_itinerary_update', { trip_id: 'trip-1', preview_id: second.preview_id, expected_version: second.trip_version });
  assert.match(conflict.content[0].text, /Conflict/);
  assert.match(conflict.content[0].text, /preview_itinerary_update again/);
  assert.equal(JSON.parse(db.prepare("SELECT settings FROM trips WHERE id = 'trip-1'").get().settings).itinerary.stops[0].plannedNights, 1);

  const guard = await toolError('preview_itinerary_update', { trip_id: 'trip-1', planning_file: { ...file, rideTripId: 'trip-2' } });
  assert.match(guard.content[0].text, /trip ID must match/);
  assert.match((await toolError('preview_itinerary_update', { trip_id: 'trip-2', planning_file: { ...file, rideTripId: 'trip-2' } })).content[0].text, /not found/i);
});

// ------------------------------------------------------------------ tools: fuel, check-ins, ride logs
test('fuel: add (idempotent by id), status, list, update, delete', async () => {
  const added = await ok('add_fuel_fill', { trip_id: 'trip-1', id: 'fill-test-0001', price_per_litre: 2.199, litres: 40, full_tank: true, payment_method: 'card', station_name: 'Invented Fuel' });
  assert.equal(added.fill.id, 'fill-test-0001');
  assert.equal(added.duplicate, false);
  assert.equal(added.planning_price_updated, true);
  const again = await ok('add_fuel_fill', { trip_id: 'trip-1', id: 'fill-test-0001', price_per_litre: 2.199 });
  assert.equal(again.duplicate, true, 'retry with the same id does not duplicate');
  const status = await ok('get_fuel_status', { trip_id: 'trip-1' });
  assert.equal(status.latest_fill.id, 'fill-test-0001');
  assert.equal(status.range.known, true);
  const listed = await ok('list_fuel_fills', { trip_id: 'trip-1', limit: 10 });
  assert.equal(listed.fills.length, 1);
  const updated = await ok('update_fuel_fill', { trip_id: 'trip-1', fill_id: 'fill-test-0001', litres: 41.5 });
  assert.equal(updated.fill.litres, 41.5);
  assert.match((await toolError('add_fuel_fill', { trip_id: 'trip-1', price_per_litre: 2, payment_method: 'bitcoin' })).content[0].text, /payment_method/);
  assert.match((await toolError('get_fuel_status', { trip_id: 'trip-2' })).content[0].text, /not found/i);
  assert.equal((await ok('delete_fuel_fill', { trip_id: 'trip-1', fill_id: 'fill-test-0001' })).deleted, true);
  assert.match((await toolError('delete_fuel_fill', { trip_id: 'trip-1', fill_id: 'fill-test-0001' })).content[0].text, /not found/i);
});

test('check-ins: add (source agent), last location, list, delete', async () => {
  const added = await ok('add_checkin', { trip_id: 'trip-1', id: 'checkin-test-01', lat: -31.2, lng: 150.2, note: 'Invented stop', recorded_at: '2026-03-03T09:00:00+10:00' });
  assert.equal(added.checkin.source, 'agent');
  assert.equal((await ok('add_checkin', { trip_id: 'trip-1', id: 'checkin-test-01', lat: -31.2, lng: 150.2 })).duplicate, true);
  const last = await ok('get_last_location', { trip_id: 'trip-1' });
  assert.equal(last.last_checkin.id, 'checkin-test-01');
  assert.ok(last.last_location);
  assert.equal((await ok('list_checkins', { trip_id: 'trip-1' })).checkins.length, 1);
  assert.equal((await ok('delete_checkin', { trip_id: 'trip-1', checkin_id: 'checkin-test-01' })).deleted, true);
  assert.match((await toolError('add_checkin', { trip_id: 'trip-1', lat: 200, lng: 0 })).content[0].text, /lat/);
});

test('journal: add (private by default), update, not found, read back with get_trip', async () => {
  const before = version();
  const added = await ok('add_journal_entry', { trip_id: 'trip-1', title: 'Invented day', content: 'Invented text', tags: ['test'], location: { lat: -31.2, lng: 150.2 } });
  assert.equal(added.entry.is_private, true, 'agent entries are private unless asked');
  assert.deepEqual(added.entry.tags, ['test']);
  assert.ok(version() > before, 'journal insert bumps the trip version');
  const shared = await ok('add_journal_entry', { trip_id: 'trip-1', title: 'Shared day', is_private: false });
  assert.equal(shared.entry.is_private, false);
  const updated = await ok('update_journal_entry', { trip_id: 'trip-1', entry_id: added.entry.id, content: 'Edited text' });
  assert.equal(updated.entry.content, 'Edited text');
  assert.equal(updated.entry.title, 'Invented day');
  assert.match((await toolError('update_journal_entry', { trip_id: 'trip-1', entry_id: 'no-such-entry', content: 'x' })).content[0].text, /not found/i);
  assert.match((await toolError('update_journal_entry', { trip_id: 'trip-1', entry_id: 'note-1', title: '' })).content[0].text, /title/i);
  assert.match((await toolError('add_journal_entry', { trip_id: 'trip-2', title: 'Not mine' })).content[0].text, /not found/i);
  const read = await ok('get_trip', { trip_id: 'trip-1', include: ['journal'] });
  assert.ok(read.journal.some(entry => entry.id === added.entry.id && entry.content === 'Edited text'));
  const denied = await callTool('add_journal_entry', { trip_id: 'trip-1', title: 'X' }, { token: tokens.readOnly });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.json.error.data.required_scopes, ['journal.write']);
  assert.equal(count("SELECT COUNT(*) AS n FROM journal_entries WHERE title = 'X'"), 0);
});

test('ride logs: list summaries without tracks, get one simplified or full', async () => {
  const listed = await ok('list_ride_logs', { trip_id: 'trip-1' });
  assert.deepEqual(listed.logs, [{ id: 'log-1', started_at: '2026-03-02T00:00:00Z', ended_at: '2026-03-02T00:41:39Z', distance_km: 42.5, duration_min: 41.7, point_count: 2500, journal_entry_id: null }]);
  assert.equal(listed.next_cursor, null);
  assert.equal(JSON.stringify(listed).includes('"lat"'), false, 'no coordinates in the list');
  const simple = await ok('get_ride_log', { trip_id: 'trip-1', log_id: 'log-1' });
  assert.equal(simple.log.simplified, true);
  assert.ok(simple.log.track.length <= 2000);
  assert.deepEqual(simple.log.track.at(-1), { lat: -31.1 - 2499 * 0.0001, lng: 150.1 + 2499 * 0.0001, t: 1772400000000 + 2499 * 1000 }, 'last point kept');
  const full = await ok('get_ride_log', { trip_id: 'trip-1', log_id: 'log-1', full: true });
  assert.equal(full.log.track.length, 2500);
  assert.match((await toolError('get_ride_log', { trip_id: 'trip-1', log_id: 'nope' })).content[0].text, /not found/i);
});

// ------------------------------------------------------------------ tools: places and account
test('saved places: list with filters, get, save, update, delete; colon alias token works', async () => {
  const all = await ok('list_saved_places', {}, { token: tokens.placesOnly });
  assert.deepEqual(all.places.map(p => p.id).sort(), ['place-1', 'place-2'], 'only the owner\'s places');
  const near = await ok('list_saved_places', { near: { lat: -31.1, lng: 150.1, radius_m: 5000 } });
  assert.deepEqual(near.places.map(p => p.id), ['place-1']);
  assert.ok(near.places[0].distance_m < 5000);
  assert.deepEqual((await ok('list_saved_places', { tag: 'FREE' })).places.map(p => p.id), ['place-1']);
  assert.deepEqual((await ok('list_saved_places', { type: 'shower' })).places.map(p => p.id), ['place-2']);
  assert.equal((await ok('get_saved_place', { place_id: 'place-1' })).place.name, 'Quiet camp');
  assert.match((await toolError('get_saved_place', { place_id: 'place-x' })).content[0].text, /not found/i);
  const saved = await ok('save_place', { name: 'Invented bakery', type: 'food', lat: -31.3, lng: 150.3, tags: ['pies'] }, { token: tokens.placesOnly });
  assert.equal(saved.place.type, 'food');
  const updated = await ok('update_saved_place', { place_id: saved.place.id, rating: 5 });
  assert.equal(updated.place.rating, 5);
  assert.equal((await ok('delete_saved_place', { place_id: saved.place.id })).deleted, true);
});

test('get_my_account', async () => {
  const me = await ok('get_my_account');
  assert.deepEqual(me, { name: 'Owner Example', email: 'owner@example.test', provider: 'google', created_at: me.created_at, status: 'active' });
  const res = await callTool('get_my_account', {}, { token: tokens.readOnly });
  assert.equal(res.status, 403, 'account.read is its own scope');
});

// ------------------------------------------------------------------ audit, limits, error codes
test('audit: one row per tools/call with tool, trip and status, never arguments', async () => {
  const before = count("SELECT COUNT(*) AS n FROM api_token_audit WHERE method = 'MCP'");
  const lastRow = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM api_token_audit').get().n;
  await ok('get_trip', { trip_id: 'trip-1' });
  await toolError('get_trip', { trip_id: 'trip-2' });
  await ok('add_checkin', { trip_id: 'trip-1', lat: -31.25, lng: 150.25, note: 'Secret note text' });
  await rpc('tools/list');
  const rows = db.prepare("SELECT route, status FROM api_token_audit WHERE method = 'MCP' AND rowid > ? ORDER BY rowid").all(lastRow).map(row => ({ ...row }));
  assert.equal(count("SELECT COUNT(*) AS n FROM api_token_audit WHERE method = 'MCP'"), before + 3, 'tools/list is not a tool call');
  assert.deepEqual(rows, [
    { route: '/mcp/tools/call/get_trip?trip=trip-1', status: 200 },
    { route: '/mcp/tools/call/get_trip?trip=trip-2', status: 404 },
    { route: '/mcp/tools/call/add_checkin?trip=trip-1', status: 200 }
  ]);
  const dump = JSON.stringify(db.prepare('SELECT * FROM api_token_audit').all());
  assert.equal(dump.includes('Secret note'), false);
  assert.equal(dump.includes('150.25'), false);
});

test('rate limits: 60 a minute per token, 20 writes a minute', async () => {
  const limited = await createToken(['trips:read', 'checkins:rw', 'mcp.connect'], 'Busy agent');
  const id = db.prepare("SELECT id FROM api_tokens WHERE name = 'Busy agent'").get().id;
  const windowStart = Math.floor(Date.now() / 60000) * 60;
  db.prepare('INSERT INTO api_token_rate (token_id, window_start, count) VALUES (?, ?, 19)').run(`${id}:write`, windowStart);
  assert.equal((await callTool('add_checkin', { trip_id: 'trip-1', lat: -31, lng: 150 }, { token: limited })).json.result.isError, false);
  const writes = await callTool('add_checkin', { trip_id: 'trip-1', lat: -31, lng: 150 }, { token: limited });
  assert.equal(writes.status, 429);
  assert.ok(Number(writes.headers.get('Retry-After')) > 0);
  assert.equal((await callTool('list_trips', {}, { token: limited })).status, 200, 'reads still allowed');
  db.prepare('UPDATE api_token_rate SET count = 60 WHERE token_id = ? AND window_start = ?').run(id, windowStart);
  const minute = await rpc('tools/list', {}, { token: limited });
  assert.equal(minute.status, 429);
  assert.equal(minute.json.error.code, -31029);
});

test('no response uses a legacy error code (-32000..-32019) or an undefined MCP code', () => {
  const codes = responses.filter(body => body?.jsonrpc === '2.0' && body.error).map(body => body.error.code);
  assert.ok(codes.length > 20);
  for (const code of codes) {
    assert.ok(Number.isInteger(code));
    assert.ok(!(code >= -32019 && code <= -32000), `legacy code ${code}`);
    if (code >= -32099 && code <= -32020) assert.ok([-32020, -32021, -32022].includes(code), `undefined MCP code ${code}`);
  }
  for (const body of responses.filter(b => b?.result && b.result.resultType)) {
    assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'ride', 'serverInfo in every modern result');
  }
});
