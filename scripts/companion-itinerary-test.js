const assert = require('node:assert/strict');

(async () => {
  const { default: worker } = await import('../api/worker.js');
  const tripId = 'trip-owner-123';
  const origin = 'https://trip.incitat.io';
  const key = `private-itineraries/${tripId}/trip-companion-itinerary.json`;
  const freshSnapshot = () => ({
    schemaVersion: 1,
    sourceSha256: 'a'.repeat(64),
    publishedAt: '2026-10-14T00:00:00.000Z',
    itinerary: {
      id: tripId,
      name: 'Example private plan',
      rideTripId: tripId,
      isPublic: false,
      is_public: false,
      settings: { itinerary: { version: 1, startDate: '2026-10-14', stops: [{ id: 'sample', name: 'Sample stop' }] } },
      waypoints: [],
      journal: []
    }
  });
  let snapshot = freshSnapshot();
  let snapshotPresent = true;
  let ownerMatches = true;
  let r2Reads = 0;
  let lastR2Key = null;
  const env = {
    RIDE_TRIP_PLANNER_SESSIONS: {
      async get(token) {
        if (token === 'owner-token') return { user: { id: 'owner' }, expiresAt: Date.now() + 60000 };
        if (token === 'other-token') return { user: { id: 'other' }, expiresAt: Date.now() + 60000 };
        return null;
      },
      async delete() {}
    },
    RIDE_TRIP_PLANNER_DB: {
      prepare(sql) {
        return { bind(...values) { return { async first() {
          if (sql.includes('SELECT status FROM users')) return { status: 'active' };
          if (sql.includes('FROM trips WHERE id = ? AND user_id = ?')) {
            if (!ownerMatches || values[1] !== 'owner' || values[0] !== tripId) return null;
            return { id: tripId, user_id: 'owner', is_public: 1 };
          }
          return null;
        } }; } };
      }
    },
    RIDE_TRIP_PLANNER_ATTACHMENTS: {
      async get(requestedKey) {
        r2Reads++;
        lastR2Key = requestedKey;
        if (!snapshotPresent) return null;
        const text = JSON.stringify(snapshot);
        return { size: Buffer.byteLength(text), async json() { return JSON.parse(text); } };
      }
    }
  };
  const ctx = { waitUntil() {} };
  const request = (path, { token, requestOrigin = origin, method = 'GET', headers = {} } = {}) => {
    const requestHeaders = new Headers({ Origin: requestOrigin, ...headers });
    if (token) requestHeaders.set('Cookie', `ride_session=${token}`);
    return new Request(`https://ride.incitat.io${path}`, { method, headers: requestHeaders });
  };
  const get = (token, requestOrigin = origin) => worker.fetch(
    request(`/api/trips/${tripId}/companion-itinerary`, { token, requestOrigin }), env, ctx
  );

  let response = await get(null);
  assert.equal(response.status, 401, 'anonymous requests require login');
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.match(response.headers.get('cache-control'), /no-store/);

  response = await get('other-token');
  assert.equal(response.status, 404, 'another owner cannot read this trip');
  assert.equal(r2Reads, 0, 'ownership is checked before looking up the private object');

  ownerMatches = true;
  response = await get('owner-token');
  assert.equal(response.status, 200);
  assert.equal(lastR2Key, key);
  assert.deepEqual(await response.json(), snapshot);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');

  snapshot = freshSnapshot();
  delete snapshot.itinerary.id;
  delete snapshot.itinerary.is_public;
  response = await get('owner-token');
  assert.equal(response.status, 200, 'the full Companion export shape needs only rideTripId and isPublic:false');

  snapshotPresent = false;
  response = await get('owner-token');
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /available for this trip yet/i);
  snapshotPresent = true;

  const invalidCases = [
    value => { value.schemaVersion = 2; },
    value => { value.sourceSha256 = 'bad'; },
    value => { value.publishedAt = 'yesterday'; },
    value => { value.itinerary.rideTripId = 'another-trip'; },
    value => { value.itinerary.id = 'another-trip'; },
    value => { value.itinerary.isPublic = true; },
    value => { value.itinerary.is_public = 1; },
    value => { value.itinerary.settings.itinerary.version = 2; },
    value => { value.itinerary.settings.itinerary.stops = Array(501).fill({ id: 'x' }); },
    value => { delete value.itinerary.waypoints; },
    value => { value.itinerary.journal = {}; },
  ];
  for (const mutate of invalidCases) {
    snapshot = freshSnapshot();
    mutate(snapshot);
    response = await get('owner-token');
    assert.equal(response.status, 500, 'corrupt or mismatched snapshots are rejected');
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }

  snapshot = freshSnapshot();
  response = await get('owner-token', 'https://untrusted.example');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null, 'other origins do not receive CORS access');

  response = await worker.fetch(request(`/api/trips/${tripId}/companion-itinerary`, {
    method: 'OPTIONS',
    headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'content-type, authorization' }
  }), env, ctx);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');

  response = await worker.fetch(request(`/api/trips/${tripId}/companion-itinerary`, {
    requestOrigin: 'https://untrusted.example', method: 'OPTIONS',
    headers: { 'Access-Control-Request-Method': 'GET' }
  }), env, ctx);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);

  response = await worker.fetch(request(`/api/trips/${tripId}`, { requestOrigin: origin }), env, ctx);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://ride.incitat.io', 'CORS change stays scoped to this route');

  console.log('Companion itinerary checks passed: owner auth, isolation, schema, CORS, and no-store.');
})().catch(error => { console.error(error); process.exitCode = 1; });
