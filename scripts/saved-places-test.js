/**
 * Saved places API checks. Runs the real Worker router against an in-memory
 * SQLite database built from the real migration, so SQL, constraints and
 * owner scoping are exercised end to end. All fixture places are invented.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '..');

/** Minimal D1 binding over node:sqlite. */
function d1(db) {
  const exec = (sql) => db.prepare(sql);
  const statement = (sql) => {
    const stmt = {
      sql,
      values: [],
      bind(...values) { stmt.values = values; return stmt; },
      async first() { return exec(sql).get(...stmt.values) ?? null; },
      async all() { return { results: exec(sql).all(...stmt.values) }; },
      async run() { const r = exec(sql).run(...stmt.values); return { meta: { changes: Number(r.changes) } }; }
    };
    return stmt;
  };
  return {
    prepare: statement,
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

function buildDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE trips (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT);
    CREATE TABLE waypoints (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, trip_id TEXT, storage_key TEXT);
  `);
  db.exec(fs.readFileSync(path.join(repo, 'api/migrations/2026-10-17_saved_places.sql'), 'utf8'));
  db.exec(`
    INSERT INTO users (id, email) VALUES ('owner', 'owner@example.test'), ('other', 'other@example.test'),
      ('blocked', 'blocked@example.test');
    UPDATE users SET status = 'banned' WHERE id = 'blocked';
    INSERT INTO trips (id, user_id, name) VALUES ('owner-trip', 'owner', 'Sample loop'), ('other-trip', 'other', 'Other loop');
    INSERT INTO waypoints (id, trip_id, name, lat, lng) VALUES
      ('owner-wp', 'owner-trip', 'Sample Creek', -31.5, 150.5),
      ('other-wp', 'other-trip', 'Other Creek', -32.5, 151.5);
  `);
  return db;
}

const sessions = {
  'owner-token': { user: { id: 'owner' }, expiresAt: Date.now() + 600000 },
  'other-token': { user: { id: 'other' }, expiresAt: Date.now() + 600000 },
  'blocked-token': { user: { id: 'blocked' }, expiresAt: Date.now() + 600000 },
  'expired-token': { user: { id: 'owner' }, expiresAt: Date.now() - 1000 }
};

const samplePlace = {
  name: 'Test Creek Camp',
  type: 'campsite',
  lat: -31.2345,
  lng: 150.4321,
  address: '1 Example Road, Testville NSW 2999',
  rating: 4,
  notes: 'Quiet riverside spot (invented fixture).',
  tags: ['river', 'free', 'River'],
  cost_amount: 12.5,
  cost_note: 'per night, off-peak',
  cost_seen_on: '2026-09-01',
  facilities: 'toilets, showers, water',
  best_time: 'Autumn weekdays',
  avoid: 'School holidays',
  last_visited_on: '2026-09-02',
  source_links: ['https://example.test/brochure.pdf']
};

(async () => {
  const { default: worker } = await import('../api/worker.js');
  const db = buildDatabase();
  const env = {
    RIDE_TRIP_PLANNER_DB: d1(db),
    RIDE_TRIP_PLANNER_SESSIONS: {
      async get(token) { return sessions[token] || null; },
      async delete() {}
    },
    RIDE_TRIP_PLANNER_ATTACHMENTS: { async delete() {} }
  };
  const ctx = { waitUntil() {} };
  async function call(method, pathName, { token, body, cookie } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = `ride_session=${cookie}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(`https://ride.incitat.io${pathName}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }), env, ctx);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, json, headers: response.headers };
  }
  const ownerRowCount = () => db.prepare("SELECT COUNT(*) AS n FROM saved_places WHERE user_id = 'owner'").get().n;

  // Owner creates a place with every field.
  const created = await call('POST', '/api/saved-places', { token: 'owner-token', body: samplePlace });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const place = created.json.place;
  assert.ok(place.id);
  assert.equal(place.user_id, undefined, 'responses never include user_id');
  assert.deepEqual(place.tags, ['river', 'free'], 'tags are trimmed and de-duplicated');
  assert.deepEqual(place.facilities, ['toilets', 'showers', 'water'], 'comma lists are accepted');
  assert.equal(place.cost_amount, 12.5);
  assert.equal(place.rating, 4);
  assert.equal(created.headers.get('Cache-Control').includes('no-store'), true);
  assert.equal(created.headers.get('Access-Control-Allow-Origin'), 'https://ride.incitat.io');
  const placePath = `/api/saved-places/${encodeURIComponent(place.id)}`;

  // Anonymous and invalid sessions: 401 on every route, nothing changes.
  const routes = [
    ['GET', '/api/saved-places'], ['POST', '/api/saved-places', samplePlace],
    ['GET', '/api/saved-places/export'], ['POST', '/api/saved-places/import', { places: [samplePlace] }],
    ['GET', placePath], ['PUT', placePath, { name: 'Hijacked' }], ['DELETE', placePath]
  ];
  for (const [method, url, body] of routes) {
    for (const auth of [{}, { token: 'not-a-session' }, { token: 'expired-token' }, { cookie: 'forged' }]) {
      const res = await call(method, url, { ...auth, body });
      assert.equal(res.status, 401, `${method} ${url} ${JSON.stringify(auth)} must be 401`);
      assert.equal(JSON.stringify(res.json).includes('Test Creek'), false);
    }
    const blocked = await call(method, url, { token: 'blocked-token', body });
    assert.equal(blocked.status, 403, `${method} ${url} blocked account must be 403`);
  }

  // Another signed-in user can't list, read, edit or delete the owner's place.
  const otherList = await call('GET', '/api/saved-places', { token: 'other-token' });
  assert.equal(otherList.status, 200);
  assert.deepEqual(otherList.json.places, [], 'other user sees none of the owner places');
  const otherExport = await call('GET', '/api/saved-places/export', { token: 'other-token' });
  assert.deepEqual(otherExport.json.places, []);
  assert.equal((await call('GET', placePath, { token: 'other-token' })).status, 404);
  assert.equal((await call('PUT', placePath, { token: 'other-token', body: { name: 'Hijacked' } })).status, 404);
  assert.equal((await call('DELETE', placePath, { token: 'other-token' })).status, 404);
  const otherImport = await call('POST', '/api/saved-places/import', {
    token: 'other-token', body: { places: [{ ...samplePlace, id: place.id, name: 'Import hijack' }] }
  });
  assert.equal(otherImport.status, 200);
  assert.equal(otherImport.json.created, 1, 'a foreign id becomes a new place for the importer');
  assert.equal(otherImport.json.updated, 0);
  const stillOwner = await call('GET', placePath, { token: 'owner-token' });
  assert.equal(stillOwner.status, 200);
  assert.equal(stillOwner.json.place.name, 'Test Creek Camp', 'owner place untouched by other user');
  assert.equal(ownerRowCount(), 1);

  // Waypoint links must belong to the same user.
  const foreignLink = await call('POST', '/api/saved-places', {
    token: 'other-token', body: { ...samplePlace, trip_id: 'owner-trip', waypoint_id: 'owner-wp' }
  });
  assert.equal(foreignLink.status, 404, 'cannot link another user waypoint');
  const ownLink = await call('PUT', placePath, {
    token: 'owner-token', body: { trip_id: 'owner-trip', waypoint_id: 'owner-wp' }
  });
  assert.equal(ownLink.status, 200);
  assert.equal(ownLink.json.place.waypoint_id, 'owner-wp');
  assert.equal((await call('PUT', placePath, {
    token: 'owner-token', body: { trip_id: 'owner-trip', waypoint_id: 'other-wp' }
  })).status, 404, 'cannot link a waypoint from another trip');
  assert.equal((await call('PUT', placePath, { token: 'owner-token', body: { waypoint_id: 'owner-wp', trip_id: null } })).status, 400);

  // Partial update keeps other fields.
  const updated = await call('PUT', placePath, { token: 'owner-token', body: { rating: 5, notes: 'Even better.' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.place.rating, 5);
  assert.equal(updated.json.place.name, 'Test Creek Camp');
  assert.deepEqual(updated.json.place.tags, ['river', 'free']);

  // Validation.
  const invalid = [
    { ...samplePlace, name: '  ' }, { ...samplePlace, type: 'castle' }, { ...samplePlace, lat: 91 },
    { ...samplePlace, lng: 'east' }, { ...samplePlace, rating: 6 }, { ...samplePlace, rating: 2.5 },
    { ...samplePlace, source_links: ['javascript:alert(1)'] }, { ...samplePlace, cost_seen_on: '2026-02-30' },
    { ...samplePlace, cost_amount: -1 }, { ...samplePlace, tags: [1] }, { ...samplePlace, notes: 'x'.repeat(10001) }
  ];
  for (const body of invalid) {
    assert.equal((await call('POST', '/api/saved-places', { token: 'owner-token', body })).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(ownerRowCount(), 1, 'invalid writes store nothing');

  // Export and import round trip: same ids update, new records are created.
  const exported = await call('GET', '/api/saved-places/export', { token: 'owner-token' });
  assert.equal(exported.json.kind, 'ride-saved-places');
  assert.equal(exported.json.schemaVersion, 1);
  assert.equal(exported.json.places.length, 1);
  const file = exported.json;
  file.places[0].notes = 'Edited offline.';
  file.places.push({ name: 'Sample Library Desk', type: 'work', lat: -33.1, lng: 151.2, tags: ['wifi'] });
  const imported = await call('POST', '/api/saved-places/import', { token: 'owner-token', body: file });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  assert.equal(imported.json.updated, 1);
  assert.equal(imported.json.created, 1);
  const afterImport = await call('GET', '/api/saved-places', { token: 'owner-token' });
  assert.equal(afterImport.json.places.length, 2);
  assert.equal(afterImport.json.places.find(p => p.id === place.id).notes, 'Edited offline.');
  const badImport = await call('POST', '/api/saved-places/import', {
    token: 'owner-token', body: { places: [{ name: 'Fine', lat: 0, lng: 0 }, { name: 'Broken', lat: 200, lng: 0 }] }
  });
  assert.equal(badImport.status, 400, 'one bad record rejects the whole import');
  assert.equal(ownerRowCount(), 2, 'rejected import writes nothing');
  assert.equal((await call('POST', '/api/saved-places/import', {
    token: 'owner-token', body: { kind: 'something-else', places: [] }
  })).status, 400);

  // Deleting a linked waypoint or trip leaves the place in place.
  db.exec("DELETE FROM trips WHERE id = 'owner-trip'");
  assert.equal((await call('GET', placePath, { token: 'owner-token' })).status, 200, 'places outlive trips');

  // Owner delete, then it is gone.
  assert.equal((await call('DELETE', placePath, { token: 'owner-token' })).status, 200);
  assert.equal((await call('GET', placePath, { token: 'owner-token' })).status, 404);
  assert.equal((await call('DELETE', placePath, { token: 'owner-token' })).status, 404);

  // Account purge removes the user's saved places and only theirs.
  const otherBefore = db.prepare("SELECT COUNT(*) AS n FROM saved_places WHERE user_id = 'other'").get().n;
  assert.equal((await call('POST', '/api/user/purge', { token: 'owner-token' })).status, 200);
  assert.equal(ownerRowCount(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM saved_places WHERE user_id = 'other'").get().n, otherBefore);

  // Front end: filtering/search and the API client paths (no DOM needed).
  const vm = require('node:vm');
  const sandbox = { window: {}, document: { readyState: 'loading', addEventListener() {} }, console, URL };
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'public/js/saved-places-ui.js'), 'utf8'), sandbox);
  const { filterPlaces, allTags } = sandbox.window.SavedPlaces;
  const fixtures = [
    { id: 'a', name: 'Sample Creek Camp', type: 'campsite', rating: 5, tags: ['river', 'Free'], facilities: ['showers'], notes: 'Quiet' },
    { id: 'b', name: 'Example Pool Showers', type: 'shower', rating: 3, tags: ['hot'], facilities: [], address: 'Testville' },
    { id: 'c', name: 'Demo Library', type: 'work', rating: null, tags: ['wifi', 'free'], facilities: [] }
  ];
  const ids = list => list.map(p => p.id).join(',');
  assert.equal(ids(filterPlaces(fixtures, { type: 'shower' })), 'b');
  assert.equal(ids(filterPlaces(fixtures, { tag: 'free' })), 'a,c', 'tag filter ignores case');
  assert.equal(ids(filterPlaces(fixtures, { query: 'showers' })), 'a,b', 'search covers name and facilities');
  assert.equal(ids(filterPlaces(fixtures, { query: 'quiet creek' })), 'a', 'every search word must match');
  assert.equal(ids(filterPlaces(fixtures, { query: 'testville' })), 'b', 'search covers address');
  assert.equal(ids(filterPlaces(fixtures, { sort: 'rating' })), 'a,b,c');
  assert.equal(ids(filterPlaces(fixtures, { sort: 'name' })), 'c,b,a');
  assert.deepEqual(Array.from(allTags(fixtures)), ['Free', 'hot', 'river', 'wifi']);

  const calls = [];
  const apiSandbox = {
    window: { dispatchEvent() {} }, console, URLSearchParams, FormData: class {}, CustomEvent: class {},
    fetch: async (url, config) => {
      calls.push({ url, method: config.method || 'GET', credentials: config.credentials, body: config.body });
      return new Response(JSON.stringify({ place: { id: 'x' }, places: [] }), { status: 200 });
    }
  };
  vm.runInNewContext(`${fs.readFileSync(path.join(repo, 'public/js/api.js'), 'utf8')}\nwindow.API = API;`, apiSandbox);
  await apiSandbox.window.API.savedPlaces.update('id/with slash', { rating: 4 });
  await apiSandbox.window.API.savedPlaces.remove('abc');
  await apiSandbox.window.API.savedPlaces.importAll({ places: [] });
  assert.deepEqual(calls.map(c => `${c.method} ${c.url} ${c.credentials}`), [
    'PUT /api/saved-places/id%2Fwith%20slash include',
    'DELETE /api/saved-places/abc include',
    'POST /api/saved-places/import include'
  ]);

  console.log('Saved places checks passed: owner CRUD, 401 anonymous/expired/forged, 403 blocked, 404 for other users (list/read/edit/delete/import), owned links only, validation, export/import round trip, places outlive trips, purge.');
})().catch(error => { console.error(error); process.exitCode = 1; });
