/**
 * Bike trackers: device secrets, management routes, fix ingest, the OsmAnd /
 * Traccar Client protocol and live location. Runs the real Worker router
 * against in-memory SQLite built from the real migrations. All fixtures are
 * invented.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '..');

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

function buildDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE trips (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT, description TEXT, settings TEXT, short_code TEXT, is_public INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE waypoints (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, sort_order INTEGER DEFAULT 0);
    CREATE TABLE journal_entries (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      waypoint_id TEXT, title TEXT, content TEXT, is_private INTEGER DEFAULT 1, tags TEXT, location TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE attachments (id TEXT PRIMARY KEY, trip_id TEXT, storage_key TEXT, created_at TEXT);
  `);
  for (const file of ['2026-06-18_ride_logs.sql', '2026-10-17_saved_places.sql', '2026-10-17_tokens_fuel_checkins.sql', '2026-11-08_devices.sql']) {
    db.exec(fs.readFileSync(path.join(repo, 'api/migrations', file), 'utf8'));
  }
  // Idempotent: running the new migration twice is harmless.
  db.exec(fs.readFileSync(path.join(repo, 'api/migrations/2026-11-08_devices.sql'), 'utf8'));
  db.exec(`INSERT INTO users (id, email) VALUES ('owner', 'owner@example.test'), ('other', 'other@example.test');
    INSERT INTO trips (id, user_id, name, settings) VALUES ('owner-trip', 'owner', 'Sample loop', '{}'), ('owner-trip-2', 'owner', 'Second loop', '{}'), ('other-trip', 'other', 'Other loop', '{}');`);
  return db;
}

const sessions = {
  'owner-session': { user: { id: 'owner' }, expiresAt: Date.now() + 600000 },
  'other-session': { user: { id: 'other' }, expiresAt: Date.now() + 600000 }
};

(async () => {
  const { default: worker } = await import('../api/worker.js');
  const devicesModule = await import('../api/devices.js');
  const { lastKnownLocation } = await import('../api/checkins.js');
  const db = buildDatabase();
  const env = {
    RIDE_TRIP_PLANNER_DB: d1(db),
    RIDE_TRIP_PLANNER_SESSIONS: { async get(token) { return sessions[token] || null; }, async delete() {} },
    RIDE_TRIP_PLANNER_ATTACHMENTS: { async delete() {}, async get() { return null; } }
  };
  const ctx = { waitUntil() {} };
  async function call(method, pathName, { token, cookie, body, rawBody, origin, headers: extra = {} } = {}) {
    const headers = { ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = `ride_session=${cookie}`;
    if (origin) headers.Origin = origin;
    if (body !== undefined) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    const response = await worker.fetch(new Request(`https://ride.incitat.io${pathName}`, {
      method, headers, body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body))
    }), env, ctx);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, json, headers: response.headers, text };
  }
  const count = (sql, ...v) => db.prepare(sql).get(...v).n;
  const owner = { cookie: 'owner-session' };
  const nowS = () => Math.floor(Date.now() / 1000);
  const noCors = res => assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, 'device responses carry no CORS');

  // --- Anonymous: 401 on every management route ---
  for (const [method, url, body] of [['GET', '/api/devices'], ['POST', '/api/devices', { name: 'x' }], ['PUT', '/api/devices/x', { name: 'y' }],
    ['POST', '/api/devices/x/arm'], ['POST', '/api/devices/x/disarm'], ['DELETE', '/api/devices/x'], ['GET', '/api/devices/x/fixes']]) {
    for (const auth of [{}, { cookie: 'forged' }]) {
      assert.equal((await call(method, url, { ...auth, body })).status, 401, `${method} ${url} anonymous`);
    }
  }

  // --- Create: secret format, shown once, only a hash stored ---
  const created = await call('POST', '/api/devices', { ...owner, body: { name: 'Bike tracker', bike_name: 'Test bike', trip_id: 'owner-trip' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const secret = created.json.secret;
  const deviceId = created.json.device.id;
  assert.match(secret, /^ride_dev_[A-Za-z0-9_-]{43}$/);
  assert.match(devicesModule.generateDeviceSecret(), /^ride_dev_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(devicesModule.generateDeviceSecret(), devicesModule.generateDeviceSecret());
  assert.equal(JSON.stringify(created.json.device).includes(secret), false);
  assert.equal(created.json.device.trip_id, 'owner-trip');
  assert.equal(created.json.device.armed, false);
  const stored = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  assert.equal(stored.secret_hash, crypto.createHash('sha256').update(secret).digest('hex'));
  assert.equal(JSON.stringify(stored).includes(secret), false, 'the secret itself is never stored');
  assert.equal(stored.secret_prefix, secret.slice(0, 13));
  const listed = await call('GET', '/api/devices', owner);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.devices.length, 1);
  assert.equal(listed.text.includes(secret) || listed.text.includes(stored.secret_hash), false, 'list never shows the secret or hash');
  assert.equal(listed.json.devices[0].hint, `${secret.slice(0, 13)}…`);

  // Create validation, and a trip the caller does not own
  for (const body of [{ name: '' }, { name: 'x'.repeat(81) }, { name: 'x', bike_name: 5 }, { name: 'x', bike_name: 'y'.repeat(81) }]) {
    assert.equal((await call('POST', '/api/devices', { ...owner, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', '/api/devices', { ...owner, body: { name: 'x', trip_id: 'other-trip' } })).status, 404);
  assert.equal((await call('POST', '/api/devices', { ...owner, origin: 'https://evil.example', body: { name: 'x' } })).status, 403, 'CSRF refused');

  // --- Management routes refuse any Authorization header (device secret, PAT, Bearer session) ---
  const pat = await call('POST', '/api/tokens', { ...owner, body: { name: 'Agent', scopes: ['checkins:rw', 'trips:read'], expires_in_days: 30 } });
  assert.equal(pat.status, 201);
  for (const token of [secret, pat.json.secret, 'owner-session']) {
    for (const [method, url, body] of [['GET', '/api/devices'], ['POST', '/api/devices', { name: 'minted' }], ['PUT', `/api/devices/${deviceId}`, { name: 'Hijack' }],
      ['POST', `/api/devices/${deviceId}/arm`], ['POST', `/api/devices/${deviceId}/disarm`], ['DELETE', `/api/devices/${deviceId}`], ['GET', `/api/devices/${deviceId}/fixes`]]) {
      const res = await call(method, url, { token, body });
      assert.equal(res.status, 403, `${method} ${url} with Bearer must be 403 (got ${res.status})`);
      assert.equal((await call(method, url, { token, ...owner, body })).status, 403, 'Bearer + cookie still refused');
    }
  }
  assert.equal(count('SELECT COUNT(*) AS n FROM devices'), 1, 'no device was minted with a Bearer header');
  assert.equal(db.prepare('SELECT name, revoked_at, armed FROM devices WHERE id = ?').get(deviceId).name, 'Bike tracker');

  // --- Rename, bike, link, arm/disarm; other users cannot touch it ---
  let res = await call('PUT', `/api/devices/${deviceId}`, { ...owner, body: { name: 'Tracker one', bike_name: 'Sample bike' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.device.name, 'Tracker one');
  assert.equal(res.json.device.bike_name, 'Sample bike');
  assert.equal((await call('PUT', `/api/devices/${deviceId}`, { ...owner, body: { trip_id: 'other-trip' } })).status, 404);
  assert.equal((await call('PUT', `/api/devices/${deviceId}`, { ...owner, body: {} })).status, 400);
  assert.equal((await call('PUT', `/api/devices/${deviceId}`, { ...owner, body: { name: '' } })).status, 400);
  res = await call('PUT', `/api/devices/${deviceId}`, { ...owner, body: { trip_id: null } });
  assert.equal(res.json.device.trip_id, null);
  res = await call('PUT', `/api/devices/${deviceId}`, { ...owner, body: { trip_id: 'owner-trip' } });
  assert.equal(res.json.device.trip_id, 'owner-trip');
  res = await call('POST', `/api/devices/${deviceId}/arm`, owner);
  assert.equal(res.status, 200);
  assert.equal(res.json.device.armed, true);
  for (const [method, url, body] of [['PUT', `/api/devices/${deviceId}`, { name: 'Mine now' }], ['POST', `/api/devices/${deviceId}/disarm`],
    ['DELETE', `/api/devices/${deviceId}`], ['GET', `/api/devices/${deviceId}/fixes`]]) {
    assert.equal((await call(method, url, { cookie: 'other-session', body })).status, 404, `other user: ${method} ${url}`);
  }
  assert.equal((await call('GET', '/api/devices', { cookie: 'other-session' })).json.devices.length, 0);

  // --- Ingest: auth failures are a bare 401 with no CORS ---
  const fixesPath = '/api/device/fixes';
  const good = () => [nowS() - 30, -33.8701, 151.2001, 52.5, 90, 6.5, 9, 87, 1];
  for (const token of [undefined, 'ride_dev_short', `ride_dev_${'A'.repeat(43)}`, pat.json.secret, 'owner-session']) {
    res = await call('POST', fixesPath, { token, body: { fixes: [good()] } });
    assert.equal(res.status, 401, `ingest with ${String(token).slice(0, 12)} must be 401`);
    assert.deepEqual(res.json, { error: 'Unauthorized' });
    noCors(res);
  }
  assert.equal((await call('POST', fixesPath, { ...owner, body: { fixes: [good()] } })).status, 401, 'a session cookie cannot post fixes');
  const preflight = await call('OPTIONS', fixesPath, { origin: 'https://evil.example' });
  assert.equal(preflight.status, 204);
  noCors(preflight);

  // --- Ingest: valid batch, reply carries config ---
  const t0 = nowS() - 120;
  res = await call('POST', fixesPath, { token: secret, body: { fixes: [
    [t0, -33.87, 151.2, 40, 359.96, 5, 8, 90, 0],
    [t0 + 60, -33.871, 151.201, 55.55, 180, 4, 10, 88, true],
    [t0 + 90, -33.872, 151.202]
  ] } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  noCors(res);
  assert.deepEqual(res.json, { ok: true, accepted: 3, duplicates: 0, rejected: 0, config: { interval_s: 60, armed: true, calibrate: false } });
  const savedFix = db.prepare('SELECT * FROM device_fixes WHERE device_id = ? AND t = ?').get(deviceId, t0 + 60);
  assert.equal(savedFix.speed_kmh, 55.6);
  assert.equal(savedFix.motion, 1);
  assert.equal(db.prepare('SELECT heading FROM device_fixes WHERE t = ?').get(t0).heading, 0, '360 wraps to 0');
  const touched = db.prepare('SELECT last_seen_at, last_battery FROM devices WHERE id = ?').get(deviceId);
  assert.ok(Date.now() - Date.parse(touched.last_seen_at) < 5000);
  assert.equal(touched.last_battery, 88, 'battery from the newest fix that reported one');
  // Resending the same batch is harmless.
  res = await call('POST', fixesPath, { token: secret, body: { fixes: [[t0, -33.87, 151.2]] } });
  assert.equal(res.json.accepted, 0);
  assert.equal(res.json.duplicates, 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM device_fixes'), 3);

  // --- Ingest validation ---
  const now = nowS();
  const badFixes = [
    'not an array', [now], [now, -33, 151, 1, 2, 3, 4, 5, 6, 7], [now + 0.5, -33, 151], [String(now), -33, 151],
    [now - 8 * 86400, -33, 151], [now + 301, -33, 151], [now, 91, 151], [now, -33, 181], [now, '-33', 151], [now, 0, 0],
    [now, -33, 151, -1], [now, -33, 151, 401], [now, -33, 151, 10, 361], [now, -33, 151, 10, 10, -1], [now, -33, 151, 10, 10, 5, 3.5],
    [now, -33, 151, 10, 10, 5, 65], [now, -33, 151, 10, 10, 5, 6, 101], [now, -33, 151, 10, 10, 5, 6, 50, 2], [now, -33, 151, 'fast']
  ];
  res = await call('POST', fixesPath, { token: secret, body: { fixes: badFixes } });
  assert.equal(res.status, 200);
  assert.equal(res.json.accepted, 0);
  assert.equal(res.json.rejected, badFixes.length, 'every bad fix is rejected');
  assert.equal(count('SELECT COUNT(*) AS n FROM device_fixes'), 3, 'nothing bad was stored');
  assert.ok(devicesModule.parseFix([now + 300, -33, 151], now), 'up to 5 minutes ahead is allowed');
  assert.ok(devicesModule.parseFix([now - 7 * 86400, -33, 151], now), '7 days old is allowed');
  for (const body of [{}, { fixes: [] }, { fixes: 'x' }, [], { fixes: Array.from({ length: 121 }, good) }]) {
    assert.equal((await call('POST', fixesPath, { token: secret, body })).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await call('POST', fixesPath, { token: secret, rawBody: '{not json', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await call('POST', fixesPath, { token: secret, rawBody: 'x'.repeat(70000), headers: { 'Content-Type': 'application/json' } })).status, 413);
  res = await call('POST', fixesPath, { token: secret, body: { fixes: Array.from({ length: 120 }, (_, i) => [now - 3600 + i, -33.9, 151.1]) } });
  assert.equal(res.json.accepted, 120, '120 fixes per post is allowed');

  // --- History: the owner's track, oldest first ---
  res = await call('GET', `/api/devices/${deviceId}/fixes?from=${t0}&to=${t0 + 90}`, owner);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.fixes.map(f => f.t), [t0, t0 + 60, t0 + 90]);
  assert.equal((await call('GET', `/api/devices/${deviceId}/fixes?from=abc`, owner)).status, 400);
  assert.equal((await call('GET', `/api/devices/${deviceId}/fixes?from=10&to=5`, owner)).status, 400);

  // --- lastKnownLocation picks the device fix when it is newest ---
  db.prepare(`INSERT INTO checkins (id, user_id, trip_id, lat, lng, recorded_at, source) VALUES ('c1', 'owner', 'owner-trip', -30, 150, ?, 'ride')`)
    .run(new Date((t0 - 600) * 1000).toISOString());
  let loc = await lastKnownLocation(env, 'owner', 'owner-trip');
  assert.equal(loc.last_location.source, 'device');
  assert.equal(loc.last_location.device_id, deviceId);
  assert.equal(loc.last_location.lat, -33.872);
  assert.equal(loc.last_location.at, new Date((t0 + 90) * 1000).toISOString());
  assert.equal(loc.last_checkin.id, 'c1', 'shape unchanged: last_checkin still returned');
  assert.deepEqual(Object.keys(loc).sort(), ['last_checkin', 'last_location']);
  res = await call('GET', '/api/trips/owner-trip/last-location', { token: pat.json.secret });
  assert.equal(res.json.last_location.source, 'device', 'the REST route (and so the MCP tool) sees the tracker');
  // A newer check-in wins over the device.
  db.prepare(`INSERT INTO checkins (id, user_id, trip_id, lat, lng, recorded_at, source) VALUES ('c2', 'owner', 'owner-trip', -31, 151, ?, 'ride')`)
    .run(new Date((t0 + 100) * 1000).toISOString());
  loc = await lastKnownLocation(env, 'owner', 'owner-trip');
  assert.equal(loc.last_location.source, 'checkin');
  db.prepare("DELETE FROM checkins WHERE id = 'c2'").run();
  // Not linked to that trip: ignored.
  loc = await lastKnownLocation(env, 'owner', 'owner-trip-2');
  assert.equal(loc.last_location, null);
  // Another user's device linked to... their own trip cannot leak into owner's trip.
  loc = await lastKnownLocation(env, 'other', 'owner-trip');
  assert.equal(loc.last_location, null);
  // A database without the device tables still answers (check-in only).
  const bare = new DatabaseSync(':memory:');
  bare.exec('CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE trips (id TEXT PRIMARY KEY, user_id TEXT);');
  bare.exec(fs.readFileSync(path.join(repo, 'api/migrations/2026-06-18_ride_logs.sql'), 'utf8'));
  bare.exec(fs.readFileSync(path.join(repo, 'api/migrations/2026-10-17_tokens_fuel_checkins.sql'), 'utf8'));
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await lastKnownLocation({ RIDE_TRIP_PLANNER_DB: d1(bare) }, 'owner', 'owner-trip')).last_location, null);
  } finally {
    console.error = quiet;
  }

  // --- OsmAnd / Traccar Client protocol ---
  const q = new URLSearchParams({ id: 'ride_dev_x', lat: '-33.5', lon: '151.5', timestamp: '1700000000', speed: '10', bearing: '45', accuracy: '7', batt: '64' });
  const parsedQuery = devicesModule.osmandQueryToFix(q, 1700000100);
  assert.equal(parsedQuery.secret, 'ride_dev_x');
  assert.deepEqual(parsedQuery.fix, [1700000000, -33.5, 151.5, 18.52, 45, 7, null, 64, null], '10 knots is 18.52 km/h');
  assert.equal(devicesModule.osmandSeconds('1700000000000'), 1700000000, 'milliseconds');
  assert.equal(devicesModule.osmandSeconds('2026-11-08T01:02:03Z'), Date.parse('2026-11-08T01:02:03Z') / 1000);
  assert.equal(devicesModule.osmandSeconds('2026-11-08 01:02:03'), Date.parse('2026-11-08T01:02:03Z') / 1000, 'plain date is UTC');
  assert.ok(Number.isNaN(devicesModule.osmandSeconds('yesterday')));
  assert.equal(devicesModule.osmandQueryToFix(new URLSearchParams({ deviceid: 'abc', heading: '12' }), 5).fix[0], 5, 'missing timestamp is now');
  const parsedJson = devicesModule.osmandJsonToFix({ device_id: 'ride_dev_y', location: { timestamp: '2026-11-08T01:02:03.000Z', is_moving: true,
    coords: { latitude: -34, longitude: 150, speed: 10, heading: -1, accuracy: 3 }, battery: { level: 0.5 } } });
  assert.equal(parsedJson.secret, 'ride_dev_y');
  assert.deepEqual(parsedJson.fix, [Date.parse('2026-11-08T01:02:03Z') / 1000, -34, 150, 36, null, 3, null, 50, true], '10 m/s is 36 km/h; heading -1 is unknown');

  const stamp = nowS() - 10;
  const osmandQuery = `id=${encodeURIComponent(secret)}&lat=-33.6&lon=151.6&timestamp=${stamp}&speed=20&bearing=10&accuracy=5&batt=70`;
  res = await call('GET', `/api/device/osmand?${osmandQuery}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  noCors(res);
  assert.equal(res.json.accepted, 1);
  assert.equal(db.prepare('SELECT speed_kmh FROM device_fixes WHERE device_id = ? AND t = ?').get(deviceId, stamp).speed_kmh, 37);
  res = await call('POST', `/api/device/osmand?id=${encodeURIComponent(secret)}`, {
    rawBody: `lat=-33.61&lon=151.61&timestamp=${stamp + 1}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  assert.equal(res.json.accepted, 1, 'form-encoded POST');
  res = await call('POST', '/api/device/osmand', { body: { device_id: secret, location: { timestamp: new Date((stamp + 2) * 1000).toISOString(),
    coords: { latitude: -33.62, longitude: 151.62, speed: 5, heading: 90, accuracy: 4 }, battery: { level: 0.66 }, is_moving: false } } });
  assert.equal(res.json.accepted, 1, 'Traccar Client v9 JSON');
  assert.equal(db.prepare('SELECT speed_kmh, battery, motion FROM device_fixes WHERE t = ?').get(stamp + 2).speed_kmh, 18);
  assert.equal(db.prepare('SELECT last_battery FROM devices WHERE id = ?').get(deviceId).last_battery, 66);
  assert.equal((await call('GET', '/api/device/osmand?id=ride_dev_nope&lat=1&lon=1')).status, 401);
  assert.equal((await call('GET', `/api/device/osmand?lat=-33&lon=151&timestamp=${stamp}`)).status, 401, 'no id');
  assert.equal((await call('GET', `/api/device/osmand?id=${encodeURIComponent(secret)}&lat=200&lon=151`)).status, 400, 'bad position');
  assert.equal((await call('POST', '/api/device/osmand', { rawBody: '{bad', headers: { 'Content-Type': 'application/json' } })).status, 400);

  // --- Rate limit: at most 60 posts a minute per device ---
  const second = await call('POST', '/api/devices', { ...owner, body: { name: 'Rate test' } });
  const rateSecret = second.json.secret;
  // Start well inside a minute window so the test never straddles two windows.
  if (Date.now() % 60000 > 50000) await require('node:timers/promises').setTimeout(60000 - (Date.now() % 60000) + 50);
  const statuses = [];
  for (let i = 0; i < 61; i++) statuses.push((await call('POST', fixesPath, { token: rateSecret, body: { fixes: [[nowS() - i - 1, -33.7, 151.7]] } })).status);
  assert.equal(statuses.filter(s => s === 200).length, 60);
  assert.equal(statuses[60], 429);
  res = await call('GET', `/api/device/osmand?id=${encodeURIComponent(rateSecret)}&lat=-33&lon=151`);
  assert.equal(res.status, 429, 'OsmAnd shares the same per-device limit');
  assert.ok(Number(res.headers.get('Retry-After')) >= 1);
  noCors(res);
  res = await call('POST', fixesPath, { token: secret, body: { fixes: [[nowS() - 5, -33.7, 151.7]] } });
  assert.equal(res.status, 200, 'limit is per device');
  assert.equal(count("SELECT COUNT(*) AS n FROM api_token_rate WHERE token_id LIKE 'dev:%'") >= 1, true, 'device counters are prefixed');

  // --- Revoke: the secret stops working at once; revoked devices leave live location ---
  res = await call('DELETE', `/api/devices/${deviceId}`, owner);
  assert.equal(res.status, 200);
  assert.equal(res.json.device.status, 'revoked');
  assert.equal(res.json.device.armed, false);
  assert.equal((await call('POST', fixesPath, { token: secret, body: { fixes: [good()] } })).status, 401);
  assert.equal((await call('GET', `/api/device/osmand?${osmandQuery}`)).status, 401);
  assert.equal((await call('POST', `/api/devices/${deviceId}/arm`, owner)).status, 409);
  assert.equal((await call('PUT', `/api/devices/${deviceId}`, { ...owner, body: { name: 'Back' } })).status, 409);
  loc = await lastKnownLocation(env, 'owner', 'owner-trip');
  assert.equal(loc.last_location.source, 'checkin', 'revoked device no longer counts');

  // --- Purge removes devices and fixes ---
  assert.equal((await call('POST', '/api/user/purge', owner)).status, 200);
  assert.equal(count("SELECT COUNT(*) AS n FROM devices WHERE user_id = 'owner'"), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM device_fixes'), 0);
  assert.equal((await call('POST', fixesPath, { token: rateSecret, body: { fixes: [good()] } })).status, 401);

  // --- Front end: API client paths, describeDevice, markup ---
  const vm = require('node:vm');
  const clientCalls = [];
  const apiSandbox = {
    window: { dispatchEvent() {} }, console, URLSearchParams, FormData: class {}, CustomEvent: class {},
    fetch: async (url, config) => {
      clientCalls.push(`${config.method || 'GET'} ${url} ${config.body || ''}`.trim());
      return new Response(JSON.stringify({ device: {}, devices: [] }), { status: 200 });
    }
  };
  vm.runInNewContext(`${fs.readFileSync(path.join(repo, 'public/js/api.js'), 'utf8')}\nwindow.API = API;`, apiSandbox);
  const clientApi = apiSandbox.window.API;
  await clientApi.devices.list();
  await clientApi.devices.create({ name: 'T', bikeName: '', tripId: 't1' });
  await clientApi.devices.update('id/1', { trip_id: null });
  await clientApi.devices.setArmed('d1', true);
  await clientApi.devices.setArmed('d1', false);
  await clientApi.devices.revoke('d1');
  assert.deepEqual(clientCalls, [
    'GET /api/devices', 'POST /api/devices {"name":"T","bike_name":null,"trip_id":"t1"}', 'PUT /api/devices/id%2F1 {"trip_id":null}',
    'POST /api/devices/d1/arm', 'POST /api/devices/d1/disarm', 'DELETE /api/devices/d1'
  ]);
  const sandbox = { window: {}, document: { readyState: 'loading', addEventListener() {} }, console };
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'public/js/devices-ui.js'), 'utf8'), sandbox);
  const { describeDevice } = sandbox.window.RideDevices;
  assert.equal(describeDevice({ bike_name: 'Test bike', last_seen_at: 'x', last_battery: 86.6, status: 'active', armed: true }, () => '5 min ago'),
    'Test bike · last seen 5 min ago · battery 87% · armed');
  assert.equal(describeDevice({ last_seen_at: null, last_battery: null, status: 'revoked' }, () => ''), 'not seen yet');
  const liveSandbox = { window: {}, document: { readyState: 'loading', addEventListener() {} }, console };
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'public/js/live-ui.js'), 'utf8'), liveSandbox);
  assert.match(liveSandbox.window.RideLive.summarizeLocation({ last_location: { source: 'device', lat: -30, lng: 150, at: new Date().toISOString() } }), /by tracker/);
  const html = fs.readFileSync(path.join(repo, 'public/index.html'), 'utf8');
  for (const id of ['devicesBtn', 'devicesModal', 'deviceForm', 'deviceSecret', 'deviceSecretCopy', 'deviceList']) {
    assert.ok(html.includes(`id="${id}"`), `index.html has #${id}`);
  }
  assert.ok(html.includes('js/devices-ui.js'));
  assert.ok(fs.readFileSync(path.join(repo, 'public/sw.js'), 'utf8').includes("'/js/devices-ui.js'"));
  const fixtures = fs.readFileSync(path.join(repo, 'e2e/mobile/fixtures.mjs'), 'utf8');
  assert.ok(fixtures.includes("path === '/devices'"), 'mobile suite stubs GET /api/devices');

  console.log('devices-test: all checks passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
