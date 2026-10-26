/**
 * Personal access tokens, fuel fill-ups, check-ins, the itinerary write and the
 * Companion live API. Runs the real Worker router against in-memory SQLite
 * built from the real migrations. All fixtures are invented.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '..');
const COMPANION = 'https://trip.incitat.io';

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
    CREATE TABLE route_data (id TEXT PRIMARY KEY, trip_id TEXT, coordinates TEXT, steps TEXT, distance REAL, duration REAL);
    CREATE TABLE alternative_routes (id TEXT PRIMARY KEY, trip_id TEXT, route_index INTEGER, name TEXT, summary TEXT, color TEXT,
      distance_meters REAL, duration_seconds REAL, is_selected INTEGER, is_visible INTEGER, coordinates TEXT, steps TEXT, created_at TEXT);
  `);
  for (const file of ['2026-06-18_ride_logs.sql', '2026-10-17_saved_places.sql', '2026-10-17_tokens_fuel_checkins.sql']) {
    db.exec(fs.readFileSync(path.join(repo, 'api/migrations', file), 'utf8'));
  }
  const plan = {
    version: 1, startDate: '2026-01-01', fuel: { litresPer100Km: 10, pricePerLitre: 2.5 },
    fuelPlan: { tankLitres: 80, jerryLitres: 20 },
    stops: [
      { id: 's1', name: 'Testville', waypointId: 'owner-wp1', minNights: 0, plannedNights: 1, maxNights: 2, arrivalDate: '2026-01-01' },
      { id: 's2', name: 'Sampleton', waypointId: 'owner-wp2', minNights: 0, plannedNights: 0, maxNights: 1, arrivalDate: '2026-01-03', leg: { distanceKm: 300 } }
    ]
  };
  db.prepare(`INSERT INTO users (id, email) VALUES ('owner', 'owner@example.test'), ('other', 'other@example.test'), ('blocked', 'blocked@example.test')`).run();
  db.prepare(`UPDATE users SET status = 'banned' WHERE id = 'blocked'`).run();
  db.prepare(`INSERT INTO trips (id, user_id, name, settings) VALUES ('owner-trip', 'owner', 'Sample loop', ?), ('other-trip', 'other', 'Other loop', '{}'), ('blocked-trip', 'blocked', 'Blocked loop', '{}')`).run(JSON.stringify({ itinerary: plan, keep: 'me' }));
  db.exec(`INSERT INTO waypoints (id, trip_id, name, lat, lng) VALUES
    ('owner-wp1', 'owner-trip', 'Testville', -30.1, 150.1), ('owner-wp2', 'owner-trip', 'Sampleton', -30.5, 150.5),
    ('other-wp', 'other-trip', 'Elsewhere', -33.1, 151.1);
    INSERT INTO journal_entries (id, trip_id, title) VALUES ('owner-note', 'owner-trip', 'Note'), ('other-note', 'other-trip', 'Note');`);
  return { db, plan };
}

const sessions = {
  'owner-session': { user: { id: 'owner' }, expiresAt: Date.now() + 600000 },
  'other-session': { user: { id: 'other' }, expiresAt: Date.now() + 600000 },
  'blocked-session': { user: { id: 'blocked' }, expiresAt: Date.now() + 600000 }
};

(async () => {
  const { default: worker } = await import('../api/worker.js');
  const fuel = await import('../api/fuel-fills.js');
  const { db, plan } = buildDatabase();
  const env = {
    RIDE_TRIP_PLANNER_DB: d1(db),
    RIDE_TRIP_PLANNER_SESSIONS: { async get(token) { return sessions[token] || null; }, async delete() {} },
    RIDE_TRIP_PLANNER_ATTACHMENTS: { async delete() {}, async get() { return null; } }
  };
  const ctx = { waitUntil() {} };
  async function call(method, pathName, { token, cookie, body, origin, headers: extra = {} } = {}) {
    const headers = { ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = `ride_session=${cookie}`;
    if (origin) headers.Origin = origin;
    if (body !== undefined) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    const response = await worker.fetch(new Request(`https://ride.incitat.io${pathName}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }), env, ctx);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, json, headers: response.headers, text };
  }
  const count = (sql, ...v) => db.prepare(sql).get(...v).n;
  const ownerSession = { cookie: 'owner-session' };
  const createToken = async (scopes, opts = {}) => {
    const res = await call('POST', '/api/tokens', { ...ownerSession, ...opts, body: { name: opts.name || 'Test agent', scopes, expires_in_days: opts.days ?? 30 } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json;
  };
  // Waypoint routes (waypoints:rw) are covered in scripts/token-waypoints-test.js.
  const ALL = ['trips:read', 'itinerary:write', 'waypoints:rw', 'places:rw', 'fuel:rw', 'checkins:rw', 'ridelogs:read', 'journal:write', 'account.read', 'mcp.connect'];
  const fillPath = '/api/trips/owner-trip/fuel-fills';

  // --- Anonymous: 401 on every new or newly scoped route; nothing written ---
  const anonymousRoutes = [
    ['GET', '/api/tokens'], ['POST', '/api/tokens', { name: 'x', scopes: ['fuel:rw'] }], ['DELETE', '/api/tokens/abc'],
    ['GET', '/api/trips'], ['GET', '/api/trips/owner-trip'], ['PUT', '/api/trips/owner-trip/itinerary', { itinerary: plan }],
    ['GET', fillPath], ['POST', fillPath, { price_per_litre: 2 }], ['GET', `${fillPath}/x`], ['PUT', `${fillPath}/x`, {}], ['DELETE', `${fillPath}/x`],
    ['GET', '/api/trips/owner-trip/fuel-status'], ['GET', '/api/trips/owner-trip/checkins'],
    ['POST', '/api/trips/owner-trip/checkins', { lat: -30, lng: 150 }], ['DELETE', '/api/trips/owner-trip/checkins/x'],
    ['GET', '/api/trips/owner-trip/last-location'], ['GET', '/api/trips/owner-trip/ride-logs'], ['GET', '/api/saved-places'],
    ['GET', '/api/companion/trips/owner-trip/live'], ['GET', '/api/companion/saved-places'],
    ['POST', '/api/companion/trips/owner-trip/fuel-fills', { price_per_litre: 2 }],
    ['POST', '/api/companion/trips/owner-trip/checkins', { lat: -30, lng: 150 }]
  ];
  for (const [method, url, body] of anonymousRoutes) {
    for (const auth of [{}, { cookie: 'forged' }, { token: 'not-a-session' }]) {
      const res = await call(method, url, { ...auth, body, origin: url.startsWith('/api/companion') ? COMPANION : undefined });
      assert.equal(res.status, 401, `${method} ${url} ${JSON.stringify(auth)} must be 401 (got ${res.status})`);
    }
  }
  assert.equal(count('SELECT COUNT(*) AS n FROM fuel_fills'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM checkins'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM api_tokens'), 0);

  // --- Token creation: session cookie only, shown once, only a hash stored ---
  const created = await createToken(['fuel:rw']);
  const fuelToken = created.secret;
  assert.match(fuelToken, /^ride_pat_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.token.scopes.join(), 'fuel:rw');
  assert.equal(created.token.status, 'active');
  assert.equal(JSON.stringify(created.token).includes(fuelToken), false);
  assert.equal(created.token.token_hash, undefined);
  const stored = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(created.token.id);
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(stored).includes(fuelToken), false, 'the token itself is never stored');
  assert.equal(stored.token_hash, require('node:crypto').createHash('sha256').update(fuelToken).digest('hex'));
  const expiresInDays = (Date.parse(stored.expires_at) - Date.now()) / 86400000;
  assert.ok(expiresInDays > 29.9 && expiresInDays <= 30, 'expiry is applied');
  const listed = await call('GET', '/api/tokens', ownerSession);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.tokens.length, 1);
  assert.equal(listed.text.includes(fuelToken), false, 'list never shows the token');
  assert.equal(listed.text.includes(stored.token_hash), false, 'list never shows the hash');
  assert.equal(listed.json.tokens[0].hint, `${fuelToken.slice(0, 13)}…`);

  // Validation on create
  for (const body of [{ name: '', scopes: ['fuel:rw'] }, { name: 'x', scopes: [] }, { name: 'x', scopes: ['admin'] },
    { name: 'x', scopes: ['fuel:rw'], expires_in_days: 0 }, { name: 'x', scopes: ['fuel:rw'], expires_in_days: 366 },
    { name: 'x'.repeat(81), scopes: ['fuel:rw'] }, { name: 'x', scopes: 'fuel:rw' }]) {
    assert.equal((await call('POST', '/api/tokens', { ...ownerSession, body })).status, 400, JSON.stringify(body));
  }
  // CSRF: a foreign Origin can't create a token with the cookie
  assert.equal((await call('POST', '/api/tokens', { ...ownerSession, origin: 'https://evil.example', body: { name: 'x', scopes: ['fuel:rw'] } })).status, 403);
  assert.equal((await call('POST', '/api/tokens', { ...ownerSession, origin: COMPANION, body: { name: 'x', scopes: ['fuel:rw'] } })).status, 403);

  // --- A token can never manage tokens (nor can a Bearer session) ---
  const allToken = (await createToken(ALL, { name: 'All scopes' })).secret;
  for (const token of [fuelToken, allToken, 'owner-session']) {
    assert.equal((await call('GET', '/api/tokens', { token })).status, 403);
    assert.equal((await call('POST', '/api/tokens', { token, body: { name: 'minted', scopes: ALL } })).status, 403);
    assert.equal((await call('DELETE', `/api/tokens/${created.token.id}`, { token })).status, 403);
    // Even with the owner's cookie alongside, a presented token is refused.
    assert.equal((await call('POST', '/api/tokens', { token, ...ownerSession, body: { name: 'minted', scopes: ALL } })).status, 403);
  }
  assert.equal(count('SELECT COUNT(*) AS n FROM api_tokens'), 2, 'no token was minted by a token');

  // --- A token is refused on every non-scoped route (account, auth, writes) ---
  for (const [method, url, body] of [['GET', '/api/auth/me'], ['POST', '/api/user/purge'], ['POST', '/api/trips', { name: 'x' }],
    ['PUT', '/api/trips/owner-trip', { name: 'Hijack' }], ['DELETE', '/api/trips/owner-trip'], ['POST', '/api/trips/owner-trip/share'],
    ['DELETE', '/api/trips/owner-trip/journal/owner-note'], ['GET', '/api/admin/users'], ['GET', '/api/trips/owner-trip/alternatives']]) {
    const res = await call(method, url, { token: allToken, body });
    assert.equal(res.status, 403, `${method} ${url} must refuse a token (got ${res.status})`);
  }
  assert.equal(count("SELECT COUNT(*) AS n FROM trips WHERE id = 'owner-trip' AND name = 'Sample loop'"), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM journal_entries WHERE id = 'owner-note'"), 1, 'a token cannot delete journal entries');

  // --- journal:write: add and edit own entries only; other scopes are refused ---
  const journalPath = '/api/trips/owner-trip/journal';
  const noJournal = (await createToken(['trips:read', 'checkins:rw'], { name: 'No journal' })).secret;
  assert.equal((await call('POST', journalPath, { token: noJournal, body: { title: 'x' } })).status, 403);
  assert.equal((await call('PUT', `${journalPath}/owner-note`, { token: noJournal, body: { title: 'x' } })).status, 403);
  const journalToken = (await createToken(['journal:write'], { name: 'Journal agent' })).secret;
  const addedNote = await call('POST', journalPath, { token: journalToken, body: { title: 'Invented entry', content: 'Invented text' } });
  assert.equal(addedNote.status, 201, JSON.stringify(addedNote.json));
  assert.equal(addedNote.json.entry.is_private, 1, 'token entries default to private');
  assert.equal((await call('POST', journalPath, { token: journalToken, body: { title: { bad: 1 } } })).status, 400);
  const editedNote = await call('PUT', `${journalPath}/${addedNote.json.entry.id}`, { token: journalToken, body: { content: 'Edited' } });
  assert.equal(editedNote.status, 200);
  assert.equal(editedNote.json.entry.content, 'Edited');
  assert.equal((await call('PUT', `${journalPath}/other-note`, { token: journalToken, body: { content: 'Hijack' } })).status, 404, 'another trip\'s entry is not found');
  assert.equal((await call('POST', '/api/trips/other-trip/journal', { token: journalToken, body: { title: 'Hijack' } })).status, 404);
  assert.equal(count("SELECT COUNT(*) AS n FROM journal_entries WHERE content = 'Hijack' OR title = 'Hijack'"), 0);

  // --- Bearer responses carry no CORS; cookie responses keep Ride's own CORS ---
  const viaToken = await call('GET', fillPath, { token: fuelToken, origin: 'https://evil.example' });
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(viaToken.headers.get('Access-Control-Allow-Credentials'), null);
  const viaCookie = await call('GET', fillPath, ownerSession);
  assert.equal(viaCookie.headers.get('Access-Control-Allow-Origin'), 'https://ride.incitat.io');

  // --- Wrong, malformed, expired and revoked tokens: 401 ---
  const wrong = `ride_pat_${'A'.repeat(43)}`;
  for (const token of [wrong, 'ride_pat_short', `${fuelToken}x`, fuelToken.toUpperCase()]) {
    const res = await call('GET', fillPath, { token });
    assert.equal(res.status, 401, `bad token ${token.slice(0, 12)} must be 401`);
    if (token.startsWith('ride_pat_')) assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  const expiring = await createToken(['fuel:rw'], { name: 'Expiring' });
  assert.equal((await call('GET', fillPath, { token: expiring.secret })).status, 200);
  db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expiring.token.id);
  assert.equal((await call('GET', fillPath, { token: expiring.secret })).status, 401, 'expired token');
  const revoking = await createToken(['fuel:rw'], { name: 'Revoking' });
  assert.equal((await call('GET', fillPath, { token: revoking.secret })).status, 200);
  const revoked = await call('DELETE', `/api/tokens/${revoking.token.id}`, ownerSession);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.token.status, 'revoked');
  assert.equal((await call('GET', fillPath, { token: revoking.secret })).status, 401, 'revoked token');
  assert.equal((await call('POST', fillPath, { token: revoking.secret, body: { price_per_litre: 2 } })).status, 401);
  // Another user can't revoke the owner's token
  assert.equal((await call('DELETE', `/api/tokens/${created.token.id}`, { cookie: 'other-session' })).status, 404);
  assert.equal((await call('GET', '/api/tokens', { cookie: 'other-session' })).json.tokens.length, 0);

  // --- Missing scope: 403, per route ---
  for (const [method, url, body] of [['GET', '/api/trips'], ['GET', '/api/trips/owner-trip'], ['GET', '/api/saved-places'],
    ['POST', '/api/saved-places', { name: 'x', lat: 1, lng: 1 }], ['GET', '/api/trips/owner-trip/checkins'],
    ['POST', '/api/trips/owner-trip/checkins', { lat: 1, lng: 1 }], ['GET', '/api/trips/owner-trip/last-location'],
    ['GET', '/api/trips/owner-trip/ride-logs'], ['PUT', '/api/trips/owner-trip/itinerary', { itinerary: plan }]]) {
    const res = await call(method, url, { token: fuelToken, body, headers: { 'If-Match': '0' } });
    assert.equal(res.status, 403, `${method} ${url} without scope must be 403 (got ${res.status})`);
    assert.ok(res.json.required_scope, 'names the missing scope');
  }
  const tripsOnly = (await createToken(['trips:read'], { name: 'Trips only' })).secret;
  assert.equal((await call('GET', '/api/trips', { token: tripsOnly })).status, 200);
  assert.equal((await call('GET', fillPath, { token: tripsOnly })).status, 403);
  assert.equal((await call('POST', fillPath, { token: tripsOnly, body: { price_per_litre: 2 } })).status, 403);
  assert.equal(count('SELECT COUNT(*) AS n FROM fuel_fills'), 0);

  // --- Fuel fill-ups via token: create, audit, planning price, validation ---
  const fillAt = '2026-01-01T22:00:00.000Z'; // 2 Jan in Brisbane
  const add = await call('POST', fillPath, { token: fuelToken, body: {
    filled_at: fillAt, price_per_litre: 2.9, litres: 95.5, full_tank: true, jerry_filled: true, jerry_litres: 20,
    station_name: 'Test Servo', lat: -30.2, lng: 150.2, payment_method: 'Afterpay', odometer_km: 123456, notes: 'Invented fill'
  } });
  assert.equal(add.status, 201, JSON.stringify(add.json));
  assert.equal(add.json.fill.total_cost, 276.95);
  assert.equal(add.json.fill.payment_method, 'afterpay');
  assert.equal(add.json.fill.full_tank, true);
  assert.equal(add.json.fill.user_id, undefined);
  assert.equal(add.json.planning_price_updated, true);
  const tripRow = db.prepare("SELECT settings, version FROM trips WHERE id = 'owner-trip'").get();
  const tripSettings = JSON.parse(tripRow.settings);
  assert.equal(tripSettings.itinerary.fuel.pricePerLitre, 2.9, 'latest price becomes the planning price');
  assert.equal(tripSettings.itinerary.fuel.litresPer100Km, 10, 'consumption kept');
  assert.equal(tripSettings.keep, 'me', 'other settings kept');
  assert.equal(tripRow.version, 1, 'version bumped so an open editor cannot overwrite the price');
  const auditRows = db.prepare("SELECT * FROM api_token_audit WHERE method = 'POST' AND route LIKE '%fuel-fills'").all();
  assert.equal(auditRows.length, 1, 'one audit row per token write');
  assert.equal(auditRows[0].token_id, created.token.id);
  assert.equal(auditRows[0].route, fillPath);
  assert.equal(auditRows[0].status, 201);
  assert.ok(auditRows[0].created_at);
  const auditBefore = count('SELECT COUNT(*) AS n FROM api_token_audit');
  await call('GET', fillPath, { token: fuelToken });
  assert.equal(count('SELECT COUNT(*) AS n FROM api_token_audit'), auditBefore, 'reads are not audited');
  assert.ok(db.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get(created.token.id).last_used_at, 'last used recorded');
  assert.equal(count("SELECT COUNT(*) AS n FROM api_token_audit WHERE method IN ('CREATE', 'REVOKE')") >= 2, true, 'create and revoke audited');

  // Quick 3-tap fill: price only (+ full) works; total stays empty without litres
  const quick = await call('POST', fillPath, { ...ownerSession, body: { price_per_litre: 2.95, full_tank: false, id: 'client-fill-0001' } });
  assert.equal(quick.status, 201);
  assert.equal(quick.json.fill.total_cost, null);
  const retry = await call('POST', fillPath, { ...ownerSession, body: { price_per_litre: 2.95, id: 'client-fill-0001' } });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true, 'a retried client id is not saved twice');
  assert.equal(count("SELECT COUNT(*) AS n FROM fuel_fills WHERE trip_id = 'owner-trip'"), 2);
  assert.equal(JSON.parse(db.prepare("SELECT settings FROM trips WHERE id = 'owner-trip'").get().settings).itinerary.fuel.pricePerLitre, 2.95);
  for (const body of [{}, { price_per_litre: 0 }, { price_per_litre: 25 }, { price_per_litre: 2, litres: -1 }, { price_per_litre: 2, lat: -30 },
    { price_per_litre: 2, payment_method: 'bitcoin' }, { price_per_litre: 2, filled_at: 'yesterday' },
    { price_per_litre: 2, filled_at: '2999-01-01T00:00:00Z' }, { price_per_litre: 2, notes: 'x'.repeat(2001) }, { price_per_litre: 2, id: 'bad id!' }]) {
    assert.equal((await call('POST', fillPath, { token: fuelToken, body })).status, 400, JSON.stringify(body));
  }
  const fillId = add.json.fill.id;
  const edit = await call('PUT', `${fillPath}/${fillId}`, { token: fuelToken, body: { station_name: 'Renamed Servo' } });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.fill.station_name, 'Renamed Servo');
  assert.equal(edit.json.fill.litres, 95.5, 'partial update keeps other fields');
  assert.equal((await call('GET', `${fillPath}/${fillId}`, { token: fuelToken })).json.fill.station_name, 'Renamed Servo');

  // --- Another user's token (all scopes) can't touch the owner's data ---
  const otherCreated = await call('POST', '/api/tokens', { cookie: 'other-session', body: { name: 'Other agent', scopes: ALL } });
  const otherToken = otherCreated.json.secret;
  for (const [method, url, body] of [['GET', '/api/trips/owner-trip'], ['GET', fillPath], ['POST', fillPath, { price_per_litre: 1 }],
    ['GET', `${fillPath}/${fillId}`], ['PUT', `${fillPath}/${fillId}`, { notes: 'Hijack' }], ['DELETE', `${fillPath}/${fillId}`],
    ['GET', '/api/trips/owner-trip/fuel-status'], ['GET', '/api/trips/owner-trip/checkins'],
    ['POST', '/api/trips/owner-trip/checkins', { lat: 1, lng: 1 }], ['GET', '/api/trips/owner-trip/last-location'],
    ['GET', '/api/trips/owner-trip/ride-logs'], ['PUT', '/api/trips/owner-trip/itinerary', { itinerary: plan }]]) {
    const res = await call(method, url, { token: otherToken, body, headers: { 'If-Match': '1' } });
    assert.equal(res.status, 404, `${method} ${url} with another user's token must be 404 (got ${res.status})`);
  }
  assert.equal((await call('GET', '/api/trips', { token: otherToken })).json.trips.every(trip => trip.id !== 'owner-trip'), true);
  // Even a guessed fill id under the other user's own trip can't reach the owner's fill
  assert.equal((await call('GET', `/api/trips/other-trip/fuel-fills/${fillId}`, { token: otherToken })).status, 404);
  assert.equal((await call('POST', '/api/trips/other-trip/fuel-fills', { token: otherToken, body: { price_per_litre: 2, id: 'client-fill-0001' } })).status, 409);
  assert.equal(db.prepare('SELECT notes FROM fuel_fills WHERE id = ?').get(fillId).notes, 'Invented fill');
  // Blocked account's token: 403
  const blockedSecret = 'ride_pat_' + 'b'.repeat(43);
  db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, token_hint, scopes, expires_at) VALUES ('blk', 'blocked', 'b', ?, 'ride_pat_bbbb', ?, ?)")
    .run(require('node:crypto').createHash('sha256').update(blockedSecret).digest('hex'), JSON.stringify(ALL), new Date(Date.now() + 86400000).toISOString());
  assert.equal((await call('GET', '/api/trips/blocked-trip/fuel-fills', { token: blockedSecret })).status, 403);

  // --- Check-ins and last known location ---
  const checkinsToken = (await createToken(['checkins:rw'], { name: 'Check-ins' })).secret;
  const here = await call('POST', '/api/trips/owner-trip/checkins', { token: checkinsToken, body: {
    lat: -30.3, lng: 150.3, accuracy_m: 12.34, recorded_at: '2026-01-02T01:00:00Z', note: 'At camp', source: 'ride'
  } });
  assert.equal(here.status, 201, JSON.stringify(here.json));
  assert.equal(here.json.checkin.source, 'api', 'a token cannot claim to be the Ride app');
  assert.equal(here.json.checkin.accuracy_m, 12.3);
  for (const body of [{ lat: 91, lng: 1 }, { lng: 1 }, { lat: 1, lng: 1, recorded_at: '2999-01-01T00:00:00Z' }, { lat: 1, lng: 1, note: 'x'.repeat(501) }, { lat: 1, lng: 1, accuracy_m: -1 }]) {
    assert.equal((await call('POST', '/api/trips/owner-trip/checkins', { token: checkinsToken, body })).status, 400, JSON.stringify(body));
  }
  let last = await call('GET', '/api/trips/owner-trip/last-location', { token: checkinsToken });
  assert.equal(last.status, 200);
  assert.equal(last.json.last_location.source, 'checkin');
  assert.equal(last.json.last_location.lat, -30.3);
  // A newer ride-log fix wins
  db.prepare(`INSERT INTO ride_logs (id, trip_id, started_at, ended_at, distance_meters, track) VALUES ('log1', 'owner-trip', '2026-01-02T02:00:00Z', '2026-01-02T03:00:00Z', 150000, ?)`)
    .run(JSON.stringify([{ lat: -30.4, lng: 150.4, t: '2026-01-02T02:00:00Z' }, { lat: -30.6, lng: 150.6, t: Date.parse('2026-01-02T03:00:00Z') }]));
  last = await call('GET', '/api/trips/owner-trip/last-location', ownerSession);
  assert.equal(last.json.last_location.source, 'ride-log');
  assert.equal(last.json.last_location.lat, -30.6);
  assert.equal(last.json.last_checkin.note, 'At camp');
  const sessionHere = await call('POST', '/api/trips/owner-trip/checkins', { ...ownerSession, body: { lat: -30.7, lng: 150.7, source: 'ride' } });
  assert.equal(sessionHere.json.checkin.source, 'ride');
  last = await call('GET', '/api/trips/owner-trip/last-location', ownerSession);
  assert.equal(last.json.last_location.source, 'checkin', 'a fresh check-in is newest');
  assert.equal((await call('GET', '/api/trips/owner-trip/checkins', { token: checkinsToken })).json.checkins.length, 2);
  assert.equal((await call('DELETE', `/api/trips/owner-trip/checkins/${sessionHere.json.checkin.id}`, { token: checkinsToken })).status, 200);

  // --- Fuel status and range estimate ---
  const status = await call('GET', '/api/trips/owner-trip/fuel-status', { token: fuelToken });
  assert.equal(status.status, 200);
  assert.equal(status.json.latest_fill.price_per_litre, 2.95);
  assert.equal(status.json.last_full_fill.id, fillId);
  const range = status.json.range;
  assert.equal(range.capacity_litres, 100, 'tank + jerry from the fuel plan');
  assert.equal(range.litres_per_100km, 10);
  assert.equal(range.full_range_km, 1000);
  assert.equal(range.km_logged, 150);
  assert.equal(range.km_planned, 300, 'leg to a stop reached after the fill day');
  assert.equal(range.km_since_full, 300, 'the larger (cautious) distance is used');
  assert.equal(range.km_source, 'planned-route');
  assert.equal(range.est_litres_left, 70);
  assert.equal(range.est_range_left_km, 700);
  // Pure estimator: defaults, part fills add back, no full fill yet
  const est = fuel.estimateRange({ fills: [
    { filled_at: '2026-01-05T00:00:00Z', full_tank: false, litres: 20 },
    { filled_at: '2026-01-04T00:00:00Z', full_tank: true }
  ], rideLogs: [{ started_at: '2026-01-04T01:00:00Z', distance_meters: 500000 }], plan: null, now: new Date('2026-01-06T00:00:00Z') });
  assert.equal(est.capacity_litres, 110);
  assert.equal(est.litres_per_100km, 10.5);
  assert.equal(est.km_since_full, 500);
  assert.equal(est.est_litres_left, Math.round(110 - 52.5 + 20));
  assert.equal(fuel.estimateRange({ fills: [], rideLogs: [], plan: null }).known, false);
  assert.equal(fuel.localDate('2026-01-01T22:00:00Z'), '2026-01-02', 'Brisbane date');

  // --- Itinerary write (settings-only, same guards as the UI import) ---
  const itinToken = (await createToken(['itinerary:write', 'trips:read'], { name: 'Planner' })).secret;
  const itinPath = '/api/trips/owner-trip/itinerary';
  const currentVersion = () => db.prepare("SELECT version FROM trips WHERE id = 'owner-trip'").get().version;
  const nextPlan = { ...plan, notes: 'Updated by agent (invented)' };
  assert.equal((await call('PUT', itinPath, { token: itinToken, body: { itinerary: nextPlan } })).status, 428, 'If-Match required');
  assert.equal((await call('PUT', itinPath, { token: itinToken, body: { itinerary: nextPlan }, headers: { 'If-Match': '0' } })).status, 409, 'stale version');
  const v = String(currentVersion());
  for (const body of [{ itinerary: { ...plan, version: 2 } }, { itinerary: { ...plan, stops: [] } }, { itinerary: nextPlan, is_public: true },
    { itinerary: { ...plan, stops: [{ ...plan.stops[0], waypointId: 'other-wp' }, plan.stops[1]] } },
    { itinerary: { ...plan, stops: [{ ...plan.stops[0], privateJournalRefs: ['other-note'] }, plan.stops[1]] } },
    { itinerary: { ...plan, stops: [plan.stops[0], { ...plan.stops[1], leg: { distanceKm: 1, fromWaypointId: 'other-wp' } }] } }]) {
    assert.equal((await call('PUT', itinPath, { token: itinToken, body, headers: { 'If-Match': v } })).status, 400, JSON.stringify(body).slice(0, 120));
  }
  const saved = await call('PUT', itinPath, { token: itinToken, body: { itinerary: nextPlan }, headers: { 'If-Match': v } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.trip.version, Number(v) + 1);
  const afterSettings = JSON.parse(db.prepare("SELECT settings, is_public FROM trips WHERE id = 'owner-trip'").get().settings);
  assert.equal(afterSettings.itinerary.notes, 'Updated by agent (invented)');
  assert.equal(afterSettings.keep, 'me', 'other settings untouched');
  assert.equal(db.prepare("SELECT is_public FROM trips WHERE id = 'owner-trip'").get().is_public, 0);

  // --- Saved places via token (places:rw) ---
  const placesToken = (await createToken(['places:rw'], { name: 'Places' })).secret;
  const place = await call('POST', '/api/saved-places', { token: placesToken, body: { name: 'Token Creek', type: 'campsite', lat: -30.31, lng: 150.31, notes: 'Invented note' } });
  assert.equal(place.status, 201);
  assert.equal((await call('GET', `/api/saved-places/${place.json.place.id}`, { token: otherToken })).status, 404);
  assert.deepEqual((await call('GET', '/api/saved-places', { token: otherToken })).json.places, []);

  // --- Rate limit per token ---
  const limited = await createToken(['fuel:rw'], { name: 'Limited' });
  const windowStart = Math.floor(Date.now() / 60000) * 60;
  for (const w of [windowStart, windowStart + 60]) db.prepare('INSERT INTO api_token_rate (token_id, window_start, count) VALUES (?, ?, 60)').run(limited.token.id, w);
  const throttled = await call('GET', fillPath, { token: limited.secret });
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get('Retry-After')) > 0);
  assert.equal((await call('GET', fillPath, { token: fuelToken })).status, 200, 'limits are per token');

  // --- Cookie writes from a foreign origin are refused (CSRF) ---
  assert.equal((await call('POST', fillPath, { ...ownerSession, origin: 'https://evil.example', body: { price_per_litre: 2 } })).status, 403);
  assert.equal((await call('POST', fillPath, { ...ownerSession, origin: 'https://maps.incitat.io', body: { price_per_litre: 2 } })).status, 403);
  assert.equal((await call('POST', fillPath, { ...ownerSession, origin: 'https://ride.incitat.io', body: { price_per_litre: 2.99 } })).status, 201);

  // --- Companion live API: trip.incitat.io only, cookie only ---
  const pre = await call('OPTIONS', '/api/companion/trips/owner-trip/live', { origin: COMPANION, headers: { 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), COMPANION);
  assert.equal(pre.headers.get('Access-Control-Allow-Credentials'), 'true');
  const prePost = await call('OPTIONS', '/api/companion/trips/owner-trip/fuel-fills', { origin: COMPANION, headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(prePost.status, 204);
  for (const headers of [{ 'Access-Control-Request-Method': 'GET' }]) {
    for (const origin of ['https://evil.example', 'https://trip.incitat.io.evil.example', 'http://trip.incitat.io']) {
      const bad = await call('OPTIONS', '/api/companion/trips/owner-trip/live', { origin, headers });
      assert.equal(bad.status, 403);
      assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
    }
  }
  assert.equal((await call('OPTIONS', '/api/companion/trips/owner-trip/live', { origin: COMPANION, headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })).status, 403);
  assert.equal((await call('OPTIONS', '/api/companion/trips/owner-trip/live', { origin: COMPANION, headers: { 'Access-Control-Request-Method': 'DELETE' } })).status, 403);
  const live = await call('GET', '/api/companion/trips/owner-trip/live', { ...ownerSession, origin: COMPANION });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  assert.equal(live.headers.get('Access-Control-Allow-Origin'), COMPANION);
  assert.equal(live.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.ok(live.headers.get('Cache-Control').includes('no-store'));
  assert.equal(live.json.fuel.range.known, true);
  assert.equal(live.json.last_checkin.note, 'At camp');
  assert.ok(live.json.last_location);
  const liveEvil = await call('GET', '/api/companion/trips/owner-trip/live', { ...ownerSession, origin: 'https://evil.example' });
  assert.equal(liveEvil.headers.get('Access-Control-Allow-Origin'), null, 'no CORS for other origins');
  assert.equal((await call('GET', '/api/companion/trips/owner-trip/live', { token: allToken, origin: COMPANION })).status, 401, 'tokens are refused');
  assert.equal((await call('GET', '/api/companion/trips/owner-trip/live', { token: allToken, ...ownerSession, origin: COMPANION })).status, 401, 'token + cookie refused');
  assert.equal((await call('GET', '/api/companion/trips/owner-trip/live', { cookie: 'other-session', origin: COMPANION })).status, 404);
  const cplaces = await call('GET', '/api/companion/saved-places', { ...ownerSession, origin: COMPANION });
  assert.equal(cplaces.status, 200);
  assert.equal(cplaces.json.places[0].name, 'Token Creek');
  assert.equal(cplaces.json.places[0].notes, 'Invented note');
  assert.equal(cplaces.json.places[0].user_id, undefined);
  assert.deepEqual((await call('GET', '/api/companion/saved-places', { cookie: 'other-session', origin: COMPANION })).json.places, []);
  // Companion writes: Origin must be exactly Companion, JSON only
  assert.equal((await call('POST', '/api/companion/trips/owner-trip/checkins', { ...ownerSession, body: { lat: -30, lng: 150 } })).status, 403);
  assert.equal((await call('POST', '/api/companion/trips/owner-trip/checkins', { ...ownerSession, origin: 'https://evil.example', body: { lat: -30, lng: 150 } })).status, 403);
  assert.equal((await call('POST', '/api/companion/trips/owner-trip/checkins', { ...ownerSession, origin: COMPANION, body: { lat: -30, lng: 150 }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const cHere = await call('POST', '/api/companion/trips/owner-trip/checkins', { ...ownerSession, origin: COMPANION, body: { lat: -30.8, lng: 150.8, source: 'agent' } });
  assert.equal(cHere.status, 201);
  assert.equal(cHere.json.checkin.source, 'companion');
  assert.equal(cHere.headers.get('Access-Control-Allow-Origin'), COMPANION);
  const cFill = await call('POST', '/api/companion/trips/owner-trip/fuel-fills', { ...ownerSession, origin: COMPANION, body: { price_per_litre: 3.05, full_tank: true } });
  assert.equal(cFill.status, 201);
  assert.equal((await call('POST', '/api/companion/trips/other-trip/fuel-fills', { ...ownerSession, origin: COMPANION, body: { price_per_litre: 3 } })).status, 404);

  // --- Delete via token is audited; purge removes fills/check-ins and revokes tokens ---
  assert.equal((await call('DELETE', `${fillPath}/${fillId}`, { token: fuelToken })).status, 200);
  assert.equal(count("SELECT COUNT(*) AS n FROM api_token_audit WHERE method = 'DELETE' AND status = 200 AND route LIKE '%/fuel-fills/%'"), 1);
  assert.equal((await call('POST', '/api/user/purge', ownerSession)).status, 200);
  assert.equal(count("SELECT COUNT(*) AS n FROM fuel_fills WHERE user_id = 'owner'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM checkins WHERE user_id = 'owner'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = 'owner' AND revoked_at IS NULL"), 0);
  assert.equal((await call('GET', '/api/trips', { token: allToken })).status, 401, 'purged account tokens stop working');
  assert.equal((await call('GET', '/api/trips', { token: otherToken })).status, 200, 'other users are unaffected');

  // --- Front end: pure helpers and API client paths (no DOM needed) ---
  const vm = require('node:vm');
  const sandbox = { window: {}, document: { readyState: 'loading', addEventListener() {} }, console, crypto: globalThis.crypto };
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'public/js/live-ui.js'), 'utf8'), sandbox);
  const ui = sandbox.window.RideLive;
  const now = Date.parse('2026-01-02T12:00:00Z');
  assert.equal(ui.formatAgo('2026-01-02T11:55:00Z', now), '5 min ago');
  assert.equal(ui.formatAgo('2026-01-02T09:00:00Z', now), '3 h ago');
  assert.equal(ui.formatAgo('2025-12-30T12:00:00Z', now), '3 days ago');
  assert.equal(ui.summarizeFuel({ range: { known: true, est_range_left_km: 700, est_litres_left: 70 }, latest_fill: { price_per_litre: 2.95, full_tank: true, filled_at: '2026-01-02T10:00:00Z' } }, now),
    'About 700 km left (~70 L, estimate) · last fill $2.95/L, full 2 h ago');
  assert.match(ui.summarizeFuel({ range: { known: false } }, now), /add a full-tank fill/);
  assert.match(ui.summarizeLocation(null, now), /no check-in yet/);
  assert.equal(ui.summarizeLocation({ last_location: { source: 'checkin', lat: -30.12345, lng: 150.98765, at: '2026-01-02T11:00:00Z', note: 'Camp' } }, now),
    'Last seen 1 h ago by check-in (-30.123, 150.988) · Camp');
  const quickBody = ui.buildFillPayload({ price: '2.95', full: true, litres: '', clientId: 'ride-fill-abc12345' }, { lat: -30, lng: 150, accuracy: 8.6 }).body;
  assert.deepEqual(JSON.parse(JSON.stringify(quickBody)), { price_per_litre: 2.95, full_tank: true, lat: -30, lng: 150, accuracy_m: 9, id: 'ride-fill-abc12345' });
  assert.ok(ui.buildFillPayload({ price: '' }).error);
  assert.ok(ui.buildFillPayload({ price: '2', litres: '-3' }).error);
  assert.deepEqual(Object.keys(ui.SCOPE_LABELS).sort(), [...ALL].sort(), 'UI offers exactly the server scopes');

  const clientCalls = [];
  const apiSandbox = {
    window: { dispatchEvent() {} }, console, URLSearchParams, FormData: class {}, CustomEvent: class {},
    fetch: async (url, config) => {
      clientCalls.push(`${config.method || 'GET'} ${url} ${config.credentials}`);
      return new Response(JSON.stringify({ token: {}, tokens: [], fills: [], checkin: {} }), { status: 200 });
    }
  };
  vm.runInNewContext(`${fs.readFileSync(path.join(repo, 'public/js/api.js'), 'utf8')}\nwindow.API = API;`, apiSandbox);
  const clientApi = apiSandbox.window.API;
  await clientApi.tokens.list();
  await clientApi.tokens.create({ name: 'x', scopes: ['fuel:rw'], expiresInDays: 30 });
  await clientApi.tokens.revoke('id/1');
  await clientApi.fuel.add('trip 1', { price_per_litre: 2 });
  await clientApi.fuel.status('trip1');
  await clientApi.checkins.add('trip1', { lat: 1, lng: 1 });
  await clientApi.checkins.lastLocation('trip1');
  assert.deepEqual(clientCalls, [
    'GET /api/tokens include', 'POST /api/tokens include', 'DELETE /api/tokens/id%2F1 include',
    'POST /api/trips/trip%201/fuel-fills include', 'GET /api/trips/trip1/fuel-status include',
    'POST /api/trips/trip1/checkins include', 'GET /api/trips/trip1/last-location include'
  ]);
  const html = fs.readFileSync(path.join(repo, 'public/index.html'), 'utf8');
  for (const id of ['tripLiveCard', 'liveAddFillBtn', 'liveCheckinBtn', 'fuelFillModal', 'accessTokensModal', 'accessTokensBtn', 'accessTokenSecret']) {
    assert.ok(html.includes(`id="${id}"`), `index.html has #${id}`);
  }
  assert.ok(html.includes('js/live-ui.js'));
  const swSource = fs.readFileSync(path.join(repo, 'public/sw.js'), 'utf8');
  assert.ok(swSource.includes("'/js/live-ui.js'") && swSource.includes("'/css/live.css'"));

  console.log('api-tokens-test: all checks passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
