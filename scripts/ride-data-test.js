const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Request, Response, Headers, FormData } = globalThis;

const repo = path.resolve(__dirname, '..');
const apiClientSource = fs.readFileSync(path.join(repo, 'public/js/api.js'), 'utf8');

class RideLogDatabase {
  constructor(count = 257) {
    this.owners = new Map([['private-trip', 'owner-a']]);
    this.logs = Array.from({ length: count }, (_, index) => ({
      id: `log-${String(index).padStart(3, '0')}`,
      trip_id: 'private-trip',
      started_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      ended_at: new Date(Date.UTC(2026, 0, 1, 0, index, 30)).toISOString(),
      distance_meters: 500 + index,
      duration_seconds: 30,
      journal_entry_id: null,
      track: JSON.stringify([{ lat: -25 + index / 100000, lng: 151, t: Date.UTC(2026, 0, 1, 0, index) }])
    }));
    this.pages = [];
    this.requests = [];
  }

  prepare(sql) {
    let values = [];
    const db = this;
    return {
      bind(...args) { values = args; return this; },
      async first() {
        if (sql.includes('FROM trips')) {
          return db.owners.get(values[0]) === values[1] ? { id: values[0] } : null;
        }
        if (sql.includes('FROM journal_entries')) return null;
        if (sql.includes('FROM ride_logs WHERE id')) {
          const row = db.logs.find(item => item.id === values[0]);
          return row ? { id: row.id, trip_id: row.trip_id } : null;
        }
        return null;
      },
      async all() {
        assert.match(sql, /ORDER BY created_at ASC, id ASC LIMIT 101 OFFSET \?/);
        const [tripId, offset] = values;
        const rows = db.logs.filter(row => row.trip_id === tripId).slice(offset, offset + 101);
        db.pages.push({ tripId, offset, returned: Math.min(rows.length, 100) });
        return { results: rows };
      },
      async run() {
        const [id, tripId, journalEntryId, startedAt, endedAt, distance, duration, track] = values;
        if (!db.logs.some(row => row.id === id)) {
          db.logs.push({ id, trip_id: tripId, journal_entry_id: journalEntryId, started_at: startedAt,
            ended_at: endedAt, distance_meters: distance, duration_seconds: duration, track });
        }
        return {};
      }
    };
  }
}

(async function main() {
  const { RideLogsHandler } = await import(pathToFileURL(path.join(repo, 'api/ride-logs.js')).href);
  const db = new RideLogDatabase();
  let authenticatedUserId = 'owner-a';

  async function routeRequest(input, init = {}) {
    const url = new URL(input, 'https://ride.test');
    db.requests.push({ method: init.method || 'GET', url: `${url.pathname}${url.search}` });
    const request = new Request(url, init);
    const match = url.pathname.match(/^\/trips\/([^/]+)\/ride-logs$/);
    assert.ok(match, `unexpected API request ${url.pathname}`);
    const tripId = decodeURIComponent(match[1]);
    return RideLogsHandler[request.method === 'POST' ? 'saveRideLog' : 'listRideLogs'](
      { env: { RIDE_TRIP_PLANNER_DB: db }, user: { id: authenticatedUserId }, params: { tripId }, request }
    );
  }

  const context = {
    fetch: routeRequest,
    window: { dispatchEvent() {} },
    console: { error() {}, warn() {}, log() {} },
    FormData,
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    CustomEvent: class CustomEvent {},
    JSON,
    String,
    Number,
    Array,
    Promise
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(apiClientSource, context, { filename: 'public/js/api.js' });
  vm.runInContext("API.baseUrl = '';", context);

  const logs = await vm.runInContext("API.rideLogs.list('private-trip')", context);
  assert.equal(logs.length, 257, 'the API client should retrieve every historical page');
  assert.deepEqual(Array.from(logs, log => log.id), db.logs.slice(0, 257).map(log => log.id), 'page boundaries must preserve order without gaps or duplicates');
  assert.equal(new Set(logs.map(log => log.id)).size, 257, 'pagination should not duplicate IDs');
  assert.ok(logs.every(log => Array.isArray(log.track) && typeof log.track[0] === 'object'), 'stringified DB tracks should be returned as point arrays');
  assert.deepEqual(db.pages.map(page => page.offset), [0, 100, 200], 'the client should request three sequential offsets');
  assert.ok(db.pages.every(page => page.returned <= 100), 'each server response must be capped at 100 rows');
  assert.equal(db.requests.length, 3, 'pagination should require one request per bounded page');

  authenticatedUserId = 'owner-b';
  await assert.rejects(
    vm.runInContext("API.rideLogs.list('private-trip')", context),
    error => error.status === 404,
    'a different account must not list another owner’s ride tracks'
  );

  authenticatedUserId = 'owner-a';
  const badLog = {
    client_log_id: 'invalid.id',
    track: [{ lat: -25, lng: 151, t: Date.now() }]
  };
  context.badLog = badLog;
  await assert.rejects(
    vm.runInContext("API.rideLogs.save('private-trip', badLog)", context),
    error => error.status === 400,
    'the API should reject malformed client log IDs'
  );

  console.log('Ride data checks passed: 257 logs across bounded pages, no missing/duplicate IDs, parsed tracks, owner isolation, and invalid ID rejection.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
