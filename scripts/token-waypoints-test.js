/**
 * Waypoint routes by access token (waypoints:rw) and the "Update this
 * itinerary" preview/apply API (itinerary:write). Runs the real Worker router
 * against in-memory SQLite with the production trip-version triggers, and
 * checks the API preview against the Ride UI's own preview code.
 * All fixtures are invented.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));

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

// An invented itinerary on invented waypoints.
const basePlan = {
  version: 1, startDate: '2026-03-02', fuel: { litresPer100Km: 10, pricePerLitre: 2.5 },
  stops: [
    { id: 'alpha', name: 'Alpha Creek', waypointId: 'wp-a', minNights: 1, plannedNights: 2, maxNights: 4,
      outreach: [{ id: 'post-1', title: 'Community post', status: 'draft', leadDays: 3, text: 'See you soon' }] },
    { id: 'beta', name: 'Beta Flats', waypointId: 'wp-b', minNights: 1, plannedNights: 2, maxNights: 3, fixedDate: '2026-03-05', anchorMode: 'withinStay', leg: { distanceKm: 240, durationHours: 3 } },
    { id: 'gamma', name: 'Gamma Point', waypointId: 'wp-c', minNights: 0, plannedNights: 0, maxNights: 1, leg: { distanceKm: 120, durationHours: 1.5 } }
  ]
};

function buildDatabase(storedPlan) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE trips (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT, description TEXT, settings TEXT, short_code TEXT, is_public INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE waypoints (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL, address TEXT DEFAULT '', lat REAL NOT NULL, lng REAL NOT NULL, type TEXT NOT NULL DEFAULT 'stop',
      notes TEXT DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE journal_entries (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      title TEXT, content TEXT, is_private INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  `);
  // The production triggers (api/schema_v2.sql) that bump trips.version.
  const schema = fs.readFileSync(path.join(repo, 'api/schema_v2.sql'), 'utf8');
  for (const name of ['trg_trips_updated', 'trg_waypoints_insert_bump', 'trg_waypoints_update_bump', 'trg_waypoints_delete_bump']) {
    const match = new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}[\\s\\S]*?\\bEND;`).exec(schema);
    assert.ok(match, `trigger ${name} found in schema_v2.sql`);
    db.exec(match[0]);
  }
  db.exec(fs.readFileSync(path.join(repo, 'api/migrations/2026-10-17_tokens_fuel_checkins.sql'), 'utf8'));
  db.prepare(`INSERT INTO users (id, email) VALUES ('owner', 'owner@example.test'), ('other', 'other@example.test')`).run();
  db.prepare(`INSERT INTO trips (id, user_id, name, settings) VALUES ('trip-1', 'owner', 'Invented loop', ?), ('trip-2', 'other', 'Someone else', '{}')`)
    .run(JSON.stringify({ itinerary: storedPlan, keep: 'me' }));
  db.exec(`INSERT INTO waypoints (id, trip_id, name, lat, lng, sort_order) VALUES
    ('wp-a', 'trip-1', 'Alpha Creek', -31.1, 150.1, 0), ('wp-b', 'trip-1', 'Beta Flats', -31.5, 150.5, 1),
    ('wp-c', 'trip-1', 'Gamma Point', -31.9, 150.9, 2), ('wp-x', 'trip-2', 'Elsewhere', -33.1, 151.1, 0);
    INSERT INTO journal_entries (id, trip_id, title) VALUES ('note-1', 'trip-1', 'Note'), ('note-x', 'trip-2', 'Note');`);
  return db;
}

const sessions = {
  'owner-session': { user: { id: 'owner' }, expiresAt: Date.now() + 600000 },
  'other-session': { user: { id: 'other' }, expiresAt: Date.now() + 600000 }
};

/** The Ride UI's planning model and preview, loaded the way the browser loads them. */
function loadUi() {
  const element = () => ({ children: [], textContent: '', disabled: false, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, focus() {}, get childElementCount() { return this.children.length; } });
  const nodes = new Map();
  const context = vm.createContext({
    window: {}, URL,
    document: {
      addEventListener() {},
      createElement: tag => Object.assign(element(), { tag }),
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }
    },
    UI: { openModal() {}, closeModal() {}, showToast() {}, updateTripStats() {} },
    App: { currentUser: { id: 'owner' }, useCloud: true, isSharedView: false, ensureEditable() { return true; } },
    API: { trips: {} }
  });
  for (const file of ['public/js/itinerary.js', 'public/js/itinerary-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, file), 'utf8'), context, { filename: file });
  }
  return { model: context.window.RideItinerary, planner: context.window.RideItineraryUI, context, nodes };
}

(async () => {
  const { default: worker } = await import('../api/worker.js');
  const ui = loadUi();
  const storedPlan = ui.model.recalculate(basePlan).itinerary;
  const db = buildDatabase(storedPlan);
  const env = {
    RIDE_TRIP_PLANNER_DB: d1(db),
    RIDE_TRIP_PLANNER_SESSIONS: { async get(token) { return sessions[token] || null; }, async delete() {} },
    RIDE_TRIP_PLANNER_ATTACHMENTS: { async delete() {}, async get() { return null; } }
  };
  const ctx = { waitUntil() {} };
  async function call(method, pathName, { token, cookie, body, origin, ifMatch } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = `ride_session=${cookie}`;
    if (origin) headers.Origin = origin;
    if (ifMatch !== undefined) headers['If-Match'] = String(ifMatch);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(`https://ride.incitat.io${pathName}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }), env, ctx);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, json, headers: response.headers, text };
  }
  const version = (id = 'trip-1') => db.prepare('SELECT version FROM trips WHERE id = ?').get(id).version;
  const count = (sql, ...v) => db.prepare(sql).get(...v).n;
  const auditCount = () => count('SELECT COUNT(*) AS n FROM api_token_audit');
  const createToken = async (scopes, name = 'Invented agent') => {
    const res = await call('POST', '/api/tokens', { cookie: 'owner-session', body: { name, scopes, expires_in_days: 7 } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json;
  };
  const wp = '/api/trips/trip-1/waypoints';

  // ===================== 1. Waypoints by token =====================
  const wpToken = (await createToken(['waypoints:rw'])).secret;
  const readOnly = (await createToken(['trips:read', 'itinerary:write'], 'No waypoint scope')).secret;

  // Without the scope: 403 on every waypoint route, nothing written, nothing audited.
  const v0 = version();
  const audit0 = auditCount();
  for (const [method, url, body] of [['POST', wp, { name: 'X', lat: -30, lng: 150 }], ['PUT', `${wp}/wp-a`, { name: 'Renamed' }],
    ['DELETE', `${wp}/wp-a`], ['PUT', `${wp}/reorder`, { order: ['wp-c', 'wp-b', 'wp-a'] }]]) {
    const res = await call(method, url, { token: readOnly, body, ifMatch: v0 });
    assert.equal(res.status, 403, `${method} ${url} without waypoints:rw must be 403 (got ${res.status})`);
    assert.equal(res.json.required_scope, 'waypoints:rw');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(version(), v0, 'no write without the scope');
  assert.equal(count("SELECT COUNT(*) AS n FROM waypoints WHERE trip_id = 'trip-1'"), 3);
  assert.equal(auditCount(), audit0, 'refused requests are not audited as writes');

  // If-Match: missing 428, stale 409 (Ride's version-conflict status), both with nothing written.
  assert.equal((await call('POST', wp, { token: wpToken, body: { name: 'X', lat: -30, lng: 150 } })).status, 428);
  const stale = await call('PUT', `${wp}/wp-a`, { token: wpToken, body: { name: 'Renamed' }, ifMatch: v0 - 1 });
  assert.equal(stale.status, 409, 'stale If-Match is refused');
  assert.equal(stale.json.conflict, true);
  assert.equal(stale.json.trip_version, v0);
  assert.equal(db.prepare("SELECT name FROM waypoints WHERE id = 'wp-a'").get().name, 'Alpha Creek');

  // Create
  const created = await call('POST', wp, { token: wpToken, body: { name: 'Delta Rest', lat: -32.2, lng: 151.2, type: 'fuel', notes: 'Invented' }, ifMatch: version() });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.waypoint.name, 'Delta Rest');
  assert.equal(created.json.waypoint.sort_order, 3);
  assert.equal(created.json.trip_version, version(), 'response carries the new trip version');
  assert.equal(created.headers.get('Access-Control-Allow-Origin'), null, 'token responses carry no CORS');
  const newId = created.json.waypoint.id;

  // Update
  const updated = await call('PUT', `${wp}/${newId}`, { token: wpToken, body: { name: 'Delta Rest Area', notes: 'Changed' }, ifMatch: created.json.trip_version });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.waypoint.name, 'Delta Rest Area');
  assert.equal(updated.json.trip_version, version());

  // Reorder (the fixed /reorder path is no longer swallowed by /:id)
  const order = [newId, 'wp-c', 'wp-b', 'wp-a'];
  const reordered = await call('PUT', `${wp}/reorder`, { token: wpToken, body: { order }, ifMatch: updated.json.trip_version });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.json));
  assert.equal(reordered.json.success, true);
  assert.deepEqual(db.prepare("SELECT id FROM waypoints WHERE trip_id = 'trip-1' ORDER BY sort_order").all().map(r => r.id), order);
  assert.deepEqual(JSON.parse(db.prepare("SELECT settings FROM trips WHERE id = 'trip-1'").get().settings).waypoint_order, order);
  assert.equal(count("SELECT COUNT(*) AS n FROM waypoints WHERE id = 'reorder'"), 0);
  assert.equal((await call('PUT', `${wp}/reorder`, { token: wpToken, body: { order: ['wp-a'] }, ifMatch: version() })).status, 400, 'partial order refused');

  // Delete
  const deleted = await call('DELETE', `${wp}/${newId}`, { token: wpToken, ifMatch: reordered.json.trip_version });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.equal(count('SELECT COUNT(*) AS n FROM waypoints WHERE id = ?', newId), 0);

  // Ownership: a token for 'owner' cannot touch someone else's trip.
  const foreign = await call('PUT', '/api/trips/trip-2/waypoints/wp-x', { token: wpToken, body: { name: 'Hijack' }, ifMatch: version('trip-2') });
  assert.equal(foreign.status, 404);
  assert.equal(db.prepare("SELECT name FROM waypoints WHERE id = 'wp-x'").get().name, 'Elsewhere');

  // Audit: one row per token write, with route and status.
  const rows = db.prepare("SELECT method, route, status FROM api_token_audit WHERE method <> 'CREATE' ORDER BY created_at, rowid").all();
  const writes = rows.map(r => `${r.method} ${r.route} ${r.status}`);
  for (const expected of [`POST ${wp} 201`, `PUT ${wp}/${newId} 200`, `PUT ${wp}/reorder 200`, `DELETE ${wp}/${newId} 200`,
    `POST ${wp} 428`, `PUT ${wp}/wp-a 409`, 'PUT /api/trips/trip-2/waypoints/wp-x 404']) {
    assert.ok(writes.includes(expected), `audited: ${expected} (have ${writes.join(' | ')})`);
  }

  // ===================== 2. Session users unchanged =====================
  const auditBeforeSession = auditCount();
  const sCreate = await call('POST', wp, { cookie: 'owner-session', origin: 'https://ride.incitat.io', body: { name: 'Session stop', lat: -30.3, lng: 150.3 }, ifMatch: version() });
  assert.equal(sCreate.status, 201);
  assert.equal(sCreate.headers.get('Access-Control-Allow-Origin'), 'https://ride.incitat.io', 'cookie responses keep Ride CORS');
  const sId = sCreate.json.waypoint.id;
  assert.equal((await call('PUT', `${wp}/${sId}`, { cookie: 'owner-session', body: { name: 'Session stop 2' }, ifMatch: version() })).status, 200);
  assert.equal((await call('PUT', `${wp}/${sId}`, { cookie: 'owner-session', body: { name: 'x' }, ifMatch: 0 })).status, 409);
  assert.equal((await call('PUT', `${wp}/${sId}`, { cookie: 'owner-session', body: { name: 'x' } })).status, 428);
  const sOrder = ['wp-a', 'wp-b', 'wp-c', sId];
  assert.equal((await call('PUT', `${wp}/reorder`, { cookie: 'owner-session', body: { order: sOrder }, ifMatch: version() })).status, 200);
  assert.deepEqual(db.prepare("SELECT id FROM waypoints WHERE trip_id = 'trip-1' ORDER BY sort_order").all().map(r => r.id), sOrder);
  assert.equal((await call('DELETE', `${wp}/${sId}`, { cookie: 'owner-session', ifMatch: version() })).status, 200);
  assert.equal((await call('PUT', '/api/trips/trip-2/waypoints/wp-x', { cookie: 'owner-session', body: { name: 'x' }, ifMatch: 0 })).status, 404);
  assert.equal((await call('POST', wp, { body: { name: 'anon', lat: 1, lng: 1 }, ifMatch: version() })).status, 401);
  assert.equal(auditCount(), auditBeforeSession, 'session writes are not token-audited');

  // ===================== 3. Itinerary preview / apply =====================
  const itinToken = (await createToken(['itinerary:write'], 'Planner')).secret;
  const file = { rideTripId: 'trip-1', itinerary: copy(storedPlan), waypoints: [{ id: 'wp-a' }, { id: 'wp-b' }, { id: 'wp-c' }] };
  file.itinerary.stops[0].plannedNights = 1;            // Alpha one night shorter
  file.itinerary.stops[1].plannedNights = 3;            // Beta one longer (still meets its fixed date)
  file.itinerary.stops[1].fixedDate = '2026-03-04';     // fixed commitment moves
  file.itinerary.stops[0].outreach[0].text = 'New draft text';
  file.itinerary.stops.splice(2, 1);                    // Gamma removed from planning
  file.itinerary.stops.push({ id: 'delta', name: 'Delta Rest', waypointId: 'wp-c', minNights: 0, plannedNights: 0, maxNights: 1 });

  const vBefore = version();
  const auditBeforePreview = auditCount();
  const preview = await call('POST', '/api/trips/trip-1/itinerary/preview', { token: itinToken, body: file });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(version(), vBefore, 'preview never writes');
  assert.equal(preview.headers.get('ETag'), `"${vBefore}"`);
  assert.equal(preview.json.trip_version, vBefore);
  assert.equal(preview.json.can_apply, true);
  assert.equal(auditCount(), auditBeforePreview + 1, 'preview (POST) is audited');

  // Same answer as the Ride UI preview for the same trip and file.
  const tripForUi = { id: 'trip-1', version: vBefore, settings: { itinerary: copy(storedPlan) },
    waypoints: [{ id: 'wp-a' }, { id: 'wp-b' }, { id: 'wp-c' }], journal: [{ id: 'note-1' }] };
  const uiResult = ui.planner.prepareFileUpdate(copy(file), tripForUi);
  assert.deepEqual(preview.json.itinerary, copy(uiResult.itinerary), 'same plan as the UI would save');
  assert.deepEqual(preview.json.anchor_changes, copy(uiResult.anchorChanges), 'same fixed-date changes');
  assert.deepEqual(preview.json.draft_changes, copy(ui.planner.draftChanges(tripForUi.settings.itinerary, uiResult.itinerary)), 'same draft changes');
  assert.deepEqual(preview.json.stop_changes, copy(ui.model.stopDateChanges(tripForUi.settings.itinerary, uiResult.itinerary)), 'same stop changes');
  assert.deepEqual(preview.json.warnings, copy(uiResult.warnings));
  assert.deepEqual(preview.json.conflicts, copy(uiResult.conflicts));
  assert.equal(preview.json.summary.nights, uiResult.totals.nights);
  assert.deepEqual(preview.json.stop_changes.map(c => `${c.stopId}:${c.change}`).sort(), ['alpha:changed', 'beta:changed', 'delta:added', 'gamma:removed']);
  assert.equal(preview.json.anchor_changes.length, 1);
  assert.equal(preview.json.draft_changes.length, 1);
  // The UI's rendered preview lists one line per stop change.
  ui.context.App.currentTrip = tripForUi;
  ui.planner.openPreview(uiResult, 'Update this itinerary', { planningFileUpdate: true });
  const body = ui.nodes.get('itineraryPreviewBody');
  const changeList = body.children.find(n => n.tag === 'ul');
  assert.equal(changeList.children.length, preview.json.stop_changes.length, 'UI shows the same number of stop changes');

  // Guards: wrong trip, foreign waypoint, conflicting dates, missing scope, other owner.
  const guard = async (mutate, pattern) => {
    const bad = copy(file); mutate(bad);
    const res = await call('POST', '/api/trips/trip-1/itinerary/preview', { token: itinToken, body: bad });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.guard, true);
    assert.match(res.json.error, pattern);
    assert.throws(() => ui.planner.prepareFileUpdate(copy(bad), tripForUi), pattern, 'UI refuses the same file');
  };
  await guard(f => { f.rideTripId = 'trip-2'; }, /trip ID must match/);
  await guard(f => { f.itinerary.stops[0].waypointId = 'wp-x'; }, /waypoint does not belong/);
  await guard(f => { f.waypoints.push({ id: 'wp-x' }); }, /outside the open Ride trip/);
  await guard(f => { f.itinerary.stops[0].privateJournalRefs = ['note-x']; }, /private note/);
  await guard(f => { f.itinerary.stops[0].plannedNights = 4; }, /must include/);
  assert.equal((await call('POST', '/api/trips/trip-1/itinerary/preview', { token: wpToken, body: file })).status, 403, 'needs itinerary:write');
  assert.equal((await call('POST', '/api/trips/trip-2/itinerary/preview', { token: itinToken, body: { ...file, rideTripId: 'trip-2' } })).status, 404);
  assert.equal((await call('POST', '/api/trips/trip-1/itinerary/preview', { body: file })).status, 401);
  assert.equal(version(), vBefore, 'guards never write');

  // Apply: If-Match required, stale refused, nothing written until it matches.
  const applyPath = '/api/trips/trip-1/itinerary/apply';
  assert.equal((await call('POST', applyPath, { token: itinToken, body: file })).status, 428);
  // Someone else changes the trip after the preview: the old ETag is now stale.
  assert.equal((await call('PUT', `${wp}/wp-a`, { token: wpToken, body: { notes: 'moved on' }, ifMatch: vBefore })).status, 200);
  const staleApply = await call('POST', applyPath, { token: itinToken, body: file, ifMatch: vBefore });
  assert.equal(staleApply.status, 409, 'apply with the stale preview version is refused');
  assert.equal(staleApply.json.conflict, true);
  assert.deepEqual(JSON.parse(db.prepare("SELECT settings FROM trips WHERE id = 'trip-1'").get().settings).itinerary, copy(storedPlan), 'nothing written');

  // Fresh preview, then apply with its ETag.
  const fresh = await call('POST', '/api/trips/trip-1/itinerary/preview', { token: itinToken, body: file });
  const etag = fresh.headers.get('ETag');
  const applied = await call('POST', applyPath, { token: itinToken, body: file, ifMatch: etag });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.ok(applied.json.trip.version > fresh.json.trip_version);
  assert.equal(applied.headers.get('ETag'), `"${applied.json.trip.version}"`);
  assert.deepEqual(applied.json.applied.stop_changes, fresh.json.stop_changes);
  const savedSettings = JSON.parse(db.prepare("SELECT settings FROM trips WHERE id = 'trip-1'").get().settings);
  assert.deepEqual(savedSettings.itinerary, fresh.json.itinerary, 'saves exactly what the preview showed');
  assert.equal(savedSettings.keep, 'me', 'other settings kept');
  assert.equal(count("SELECT COUNT(*) AS n FROM waypoints WHERE trip_id = 'trip-1'"), 3, 'waypoints untouched');
  assert.ok(count(`SELECT COUNT(*) AS n FROM api_token_audit WHERE method = 'POST' AND route = '${applyPath}' AND status = 200`) === 1, 'apply audited');
  assert.ok(count(`SELECT COUNT(*) AS n FROM api_token_audit WHERE method = 'POST' AND route = '${applyPath}' AND status = 409`) === 1, 'refused apply audited');
  // Re-applying with the now-old ETag is refused.
  assert.equal((await call('POST', applyPath, { token: itinToken, body: file, ifMatch: etag })).status, 409);

  // Session cookie can use preview too (owner session = all scopes); foreign origin refused.
  assert.equal((await call('POST', '/api/trips/trip-1/itinerary/preview', { cookie: 'owner-session', body: file })).status, 200);
  assert.equal((await call('POST', '/api/trips/trip-1/itinerary/preview', { cookie: 'owner-session', origin: 'https://evil.example', body: file })).status, 403);

  console.log('token-waypoints-test: all checks passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
